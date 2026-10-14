"""
Script de Extração e Otimização de Dados para o Frontend Web (Vercel)
Lê o relatório censitário nacional (CSV/MD), calcula o traçado poli-linhal real das rodovias (sub-km a cada 2 km)
e extrai parâmetros preditivos SARIMAX para alimentar o Observatório Nacional e o Simulador.
"""
import os
import sys
import json
import time
from pathlib import Path
import pandas as pd
import numpy as np
import joblib
from sqlalchemy import create_engine, text

# Caminhos base
DIR_ATUAL = Path(__file__).resolve().parent
DIR_TCC = DIR_ATUAL.parent / "TCC"
CSV_RESULTADOS = DIR_TCC / "resultado_meso_todos_estados_20km.csv"
MODELS_DIR = DIR_TCC / "models" / "meso"
JSON_SAIDA = DIR_ATUAL / "dados_meso_nacional.json"
JS_SAIDA = DIR_ATUAL / "dados_meso_nacional.js"

sys.path.append(str(DIR_TCC / "src"))
from config import DB_URI

print("[1/5] Lendo resultado_meso_todos_estados_20km.csv...")
df_res = pd.read_csv(CSV_RESULTADOS)
print(f"       -> Carregados {len(df_res)} registros do CSV.")

# Cache de baselines existentes para evitar reprocessamento pesado de 3.000 joblibs
baselines_cache = {}
if JSON_SAIDA.exists():
    try:
        with open(JSON_SAIDA, 'r', encoding='utf-8') as f_exist:
            d_exist = json.load(f_exist)
            for t in d_exist.get('trechos', []):
                if 'baseline' in t:
                    baselines_cache[t['id']] = t['baseline']
        print(f"       -> {len(baselines_cache)} baselines reaproveitados do cache existente.")
    except Exception as e:
        print(f"       -> Aviso: não foi possível ler cache existente: {e}")

from processar_geometrias_snv import SNVIndex, haversine_km, rdp_simplify, normalizar_br

print("[2/5] Reconstruindo traçados curvilíneos reais via DNIT SNV e fallback topológico...")
engine = create_engine(DB_URI)
query_coords = """
    SELECT 
        br, uf,
        FLOOR(CAST(REPLACE(NULLIF(TRIM(km), ''), ',', '.') AS REAL) / 20.0) * 20.0 as km_inicio,
        CAST(REPLACE(NULLIF(TRIM(km), ''), ',', '.') AS REAL) as km_real,
        CAST(REPLACE(latitude, ',', '.') AS REAL) as lat,
        CAST(REPLACE(longitude, ',', '.') AS REAL) as lon
    FROM prf_accidents
    WHERE data_inversa BETWEEN '2020-01-01' AND '2024-12-31'
      AND km IS NOT NULL AND TRIM(km) != ''
      AND br IS NOT NULL AND TRIM(br) != ''
      AND CAST(REPLACE(latitude, ',', '.') AS REAL) BETWEEN -35 AND 6
      AND CAST(REPLACE(longitude, ',', '.') AS REAL) BETWEEN -75 AND -30;
"""
t0 = time.time()
with engine.connect() as conn:
    df_prf = pd.read_sql(text(query_coords), conn)
print(f"       -> {len(df_prf):,} sinistros carregados da PRF em {time.time() - t0:.2f}s.")

# Indexação rápida dos acidentes da PRF
df_prf['br_clean'] = df_prf['br'].apply(normalizar_br)
prf_groups = {(uf, br, km): grp for (uf, br, km), grp in df_prf.groupby(['uf', 'br_clean', 'km_inicio'])}

# Inicializa índice do DNIT SNV
DIR_CACHE_SNV = DIR_ATUAL / "cache_dnit_snv"
snv = SNVIndex(DIR_CACHE_SNV)

def fallback_topologico_prf(sub_acidentes):
    """
    Quando o SNV não cobre o trecho, gera polilinha monotônica
    projetada ao longo do eixo principal de dispersão (PCA) com remoção de reversões.
    """
    if sub_acidentes is None or len(sub_acidentes) == 0:
        return None
    pts = sub_acidentes[['lat', 'lon']].values
    if len(pts) < 2:
        return [[round(float(pts[0][0]), 5), round(float(pts[0][1]), 5)]]
        
    med = np.median(pts, axis=0)
    dists = np.sqrt((pts[:, 0] - med[0])**2 + (pts[:, 1] - med[1])**2)
    valid_pts = pts[dists < 0.12] # tolerância de ~12 km
    if len(valid_pts) < 2:
        valid_pts = pts
        
    coords_centered = valid_pts - np.mean(valid_pts, axis=0)
    cov = np.cov(coords_centered, rowvar=False)
    if cov.shape == (2, 2):
        evals, evecs = np.linalg.eigh(cov)
        principal_axis = evecs[:, np.argmax(evals)]
        scores = np.dot(coords_centered, principal_axis)
        sorted_indices = np.argsort(scores)
        ordered_pts = valid_pts[sorted_indices]
    else:
        ordered_pts = valid_pts
        
    n_bins = min(10, len(ordered_pts))
    bins = np.array_split(ordered_pts, n_bins)
    smooth_pts = []
    for b in bins:
        if len(b) > 0:
            m = np.median(b, axis=0)
            smooth_pts.append([round(float(m[0]), 5), round(float(m[1]), 5)])
            
    filtered = [smooth_pts[0]]
    for i in range(1, len(smooth_pts)):
        p_curr = smooth_pts[i]
        if i >= 2:
            v1 = np.array(filtered[-1]) - np.array(filtered[-2])
            v2 = np.array(p_curr) - np.array(filtered[-1])
            len1 = np.linalg.norm(v1)
            len2 = np.linalg.norm(v2)
            if len1 > 0.001 and len2 > 0.001:
                cos_ang = np.dot(v1, v2) / (len1 * len2)
                if cos_ang < -0.2:
                    continue
        filtered.append(p_curr)
    return filtered

coords_map = {}
origens_stats = {'DNIT_SNV': 0, 'PRF_TOPOLOGICO': 0, 'CENTRO_DF': 0}

for _, r in df_res.iterrows():
    br_clean = normalizar_br(r['rodovia'])
    uf_clean = str(r['uf']).strip().upper()
    km_ini = float(r['km_inicio'])
    km_fim = float(r['km_fim'])
    chave = f"{br_clean.upper()}_{uf_clean}_{km_ini}"
    
    # 1. Tenta fatiar da malha oficial do DNIT SNV
    pts_snv = snv.fatiar_trecho(br_clean, uf_clean, km_ini, km_fim)
    sub_prf = prf_groups.get((uf_clean, br_clean, km_ini))
    
    usar_snv = False
    if pts_snv and len(pts_snv) >= 2:
        c_snv = np.mean(pts_snv, axis=0)
        if sub_prf is not None and len(sub_prf) > 0:
            med_prf = [sub_prf['lat'].median(), sub_prf['lon'].median()]
            d_centro = haversine_km([c_snv[1], c_snv[0]], [med_prf[1], med_prf[0]])
            if d_centro < 35.0:
                usar_snv = True
            else:
                usar_snv = False
        else:
            usar_snv = True
            
    if usar_snv:
        coords_map[chave] = {
            'lat': round(float(np.mean([p[0] for p in pts_snv])), 5),
            'lon': round(float(np.mean([p[1] for p in pts_snv])), 5),
            'pts': pts_snv,
            'origem': 'DNIT_SNV'
        }
        origens_stats['DNIT_SNV'] += 1
    else:
        pts_fallback = fallback_topologico_prf(sub_prf)
        if pts_fallback and len(pts_fallback) > 0:
            coords_map[chave] = {
                'lat': round(float(np.mean([p[0] for p in pts_fallback])), 5),
                'lon': round(float(np.mean([p[1] for p in pts_fallback])), 5),
                'pts': pts_fallback,
                'origem': 'PRF_TOPOLOGICO'
            }
            origens_stats['PRF_TOPOLOGICO'] += 1
        else:
            coords_map[chave] = {
                'lat': -15.78, 'lon': -47.92,
                'pts': [[-15.78, -47.92]],
                'origem': 'CENTRO_DF'
            }
            origens_stats['CENTRO_DF'] += 1

print(f"       -> {origens_stats['DNIT_SNV']:,} trechos gerados via DNIT SNV oficial ({origens_stats['DNIT_SNV']/len(df_res)*100:.1f}%).")
print(f"       -> {origens_stats['PRF_TOPOLOGICO']:,} trechos gerados via Fallback Topológico Monotônico.")

print("[3/5] Compilando métricas agregadas por Estado e Macrorregião...")
estados_list = []
ufs_unicas = sorted(df_res['uf'].unique())

for uf in ufs_unicas:
    sub = df_res[df_res['uf'] == uf]
    trechos = len(sub)
    sinistros = int(sub['total_acidentes'].sum())
    regiao = sub['regiao'].iloc[0] if 'regiao' in sub.columns else 'N/A'
    esparsidade = float(sub['esparsidade_total_pct'].mean())
    mae = float(sub['mae'].mean())
    rmse = float(sub['rmse'].mean())
    ruido_branco_pct = float((sub['residuos_ruido_branco'] == True).mean() * 100)
    chuva_sig_pct = float((sub['chuva_significativa'] == True).mean() * 100)
    feriado_sig_pct = float((sub['feriado_significativo'] == True).mean() * 100)
    
    estados_list.append({
        'uf': uf,
        'regiao': regiao,
        'trechos': trechos,
        'sinistros': sinistros,
        'esparsidade': round(esparsidade, 1),
        'mae': round(mae, 4),
        'rmse': round(rmse, 4),
        'ruido_branco_pct': round(ruido_branco_pct, 1),
        'chuva_sig_pct': round(chuva_sig_pct, 1),
        'feriado_sig_pct': round(feriado_sig_pct, 1)
    })

estados_list.sort(key=lambda x: x['sinistros'], reverse=True)

# Agregação por Macrorregião
regioes_dict = {}
for e in estados_list:
    reg = e['regiao']
    if reg not in regioes_dict:
        regioes_dict[reg] = {
            'regiao': reg, 'ufs_count': 0, 'trechos': 0, 'sinistros': 0,
            'esparsidade_sum': 0, 'mae_sum': 0, 'rmse_sum': 0,
            'ruido_sum': 0, 'chuva_sum': 0, 'feriado_sum': 0
        }
    regioes_dict[reg]['ufs_count'] += 1
    regioes_dict[reg]['trechos'] += e['trechos']
    regioes_dict[reg]['sinistros'] += e['sinistros']
    regioes_dict[reg]['esparsidade_sum'] += e['esparsidade'] * e['trechos']
    regioes_dict[reg]['mae_sum'] += e['mae'] * e['trechos']
    regioes_dict[reg]['rmse_sum'] += e['rmse'] * e['trechos']
    regioes_dict[reg]['ruido_sum'] += e['ruido_branco_pct'] * e['trechos']
    regioes_dict[reg]['chuva_sum'] += e['chuva_sig_pct'] * e['trechos']
    regioes_dict[reg]['feriado_sum'] += e['feriado_sig_pct'] * e['trechos']

macrorregioes_list = []
for reg, r in regioes_dict.items():
    t = r['trechos']
    macrorregioes_list.append({
        'regiao': reg,
        'ufs_count': r['ufs_count'],
        'trechos': t,
        'sinistros': r['sinistros'],
        'esparsidade': round(r['esparsidade_sum'] / t, 1),
        'mae': round(r['mae_sum'] / t, 4),
        'rmse': round(r['rmse_sum'] / t, 4),
        'ruido_branco_pct': round(r['ruido_sum'] / t, 1),
        'chuva_sig_pct': round(r['chuva_sum'] / t, 1),
        'feriado_sig_pct': round(r['feriado_sum'] / t, 1)
    })
macrorregioes_list.sort(key=lambda x: x['sinistros'], reverse=True)

# Top 50 trechos críticos
df_top50 = df_res.sort_values(by='total_acidentes', ascending=False).head(50)
top50_list = []
for pos, (_, r) in enumerate(df_top50.iterrows(), start=1):
    br_num = str(r['rodovia']).replace('BR-', '').replace('br-', '').strip()
    chave = f"{br_num.upper()}_{str(r['uf']).strip().upper()}_{float(r['km_inicio'])}"
    c = coords_map.get(chave, {'lat': -15.78, 'lon': -47.92, 'pts': [[-15.78, -47.92]]})
    top50_list.append({
        'posicao': pos,
        'rodovia': f"BR-{br_num}",
        'uf': str(r['uf']).strip(),
        'segmento': f"km {int(r['km_inicio'])}–{int(r['km_fim'])}",
        'sinistros': int(r['total_acidentes']),
        'esparsidade': round(float(r['esparsidade_total_pct']), 1),
        'order': str(r['order']),
        'seasonal': str(r['seasonal_order']),
        'mae': round(float(r['mae']), 4),
        'rmse': round(float(r['rmse']), 4),
        'beta_chuva': round(float(r['beta_chuva']), 4),
        'p_chuva': float(r['p_valor_chuva']) if pd.notnull(r['p_valor_chuva']) else 1.0,
        'chuva_sig': bool(r['chuva_significativa']),
        'beta_feriado': round(float(r['beta_feriado']), 4),
        'p_feriado': float(r['p_valor_feriado']) if pd.notnull(r['p_valor_feriado']) else 1.0,
        'feriado_sig': bool(r['feriado_significativo']),
        'ljung_box_p': round(float(r['ljung_box_p_valor']), 4) if pd.notnull(r['ljung_box_p_valor']) else 0.0,
        'ruido_branco': bool(r['residuos_ruido_branco']),
        'coords': c
    })

print("[4/5] Processando os 3.019 trechos com traçados curvos e parâmetros SARIMAX...")
trechos_list = []
X_zero = pd.DataFrame({'x_chuva': [0.0]*7, 'x_feriado': [0]*7, 'x_feriado_prolongado': [0]*7})

for idx, (_, r) in enumerate(df_res.iterrows()):
    br_clean = str(r['rodovia']).replace('BR-', '').replace('br-', '').strip()
    uf_clean = str(r['uf']).strip().upper()
    km_ini = float(r['km_inicio'])
    km_fim = float(r['km_fim'])
    trecho_id = f"BR{br_clean}_{uf_clean}_{int(km_ini)}"
    
    chave = f"{br_clean.upper()}_{uf_clean}_{km_ini}"
    c = coords_map.get(chave, None)
    if not c:
        c = {'lat': -15.78, 'lon': -47.92, 'pts': [[-15.78, -47.92]]}

    # Baseline: reaproveita do cache de alta precisão existente
    baseline_7d = baselines_cache.get(trecho_id)
    if baseline_7d is None:
        nome_arquivo = str(r['arquivo_modelo']).strip()
        caminho_mod = MODELS_DIR / nome_arquivo
        if caminho_mod.exists():
            try:
                m = joblib.load(caminho_mod)
                p = m.predict(7, X=X_zero)
                baseline_7d = [round(float(val), 4) for val in p]
            except Exception:
                baseline_7d = None

    if baseline_7d is None:
        taxa_diaria = float(r['acidentes_ano_media']) / 365.25
        fatores = [0.95, 0.90, 0.92, 0.98, 1.10, 1.25, 1.15]
        baseline_7d = [round(max(0.0, taxa_diaria * f), 4) for f in fatores]

    p_chuva_val = float(r['p_valor_chuva']) if pd.notnull(r['p_valor_chuva']) else 1.0
    p_feriado_val = float(r['p_valor_feriado']) if pd.notnull(r['p_valor_feriado']) else 1.0
    p_prolongado_val = float(r['p_valor_prolongado']) if pd.notnull(r['p_valor_prolongado']) else 1.0

    trechos_list.append({
        'id': trecho_id,
        'br': f"BR-{br_clean}",
        'uf': uf_clean,
        'regiao': str(r['regiao']).strip(),
        'km_inicio': int(km_ini),
        'km_fim': int(km_fim),
        'acidentes': int(r['total_acidentes']),
        'esparsidade': round(float(r['esparsidade_total_pct']), 1),
        'mae': round(float(r['mae']), 4),
        'rmse': round(float(r['rmse']), 4),
        'order': str(r['order']),
        'seasonal': str(r['seasonal_order']),
        'beta_chuva': round(float(r['beta_chuva']), 5),
        'p_chuva': p_chuva_val,
        'chuva_sig': bool(r['chuva_significativa']),
        'beta_feriado': round(float(r['beta_feriado']), 5),
        'p_feriado': p_feriado_val,
        'feriado_sig': bool(r['feriado_significativo']),
        'beta_prolongado': round(float(r['beta_prolongado']), 5),
        'p_prolongado': p_prolongado_val,
        'prolongado_sig': bool(r['prolongado_significativo']),
        'ruido_branco': bool(r['residuos_ruido_branco']),
        'coords': c,
        'baseline': baseline_7d
    })

print(f"       -> {len(trechos_list)} trechos processados com sucesso.")

# -------------------------------------------------------------------------
# [4.1/5] Tratamento Cartográfico: Deduplicação de Trechos Coincidentes e BR-0
# -------------------------------------------------------------------------
br0_ocultados = 0
for t in trechos_list:
    t['trechos_unificados'] = []
    if t['br'] in ['BR-0', 'BR-00', 'BR-000'] or t['id'].startswith('BR0_'):
        t['is_br0'] = True
        t['ocultar_mapa'] = True
        t['ocultar_simulador'] = True
        t['ocultar_tabela'] = True
        t['motivo_ocultacao'] = "Código genérico PRF (BR-0)"
        br0_ocultados += 1
    else:
        t['is_br0'] = False
        t['ocultar_mapa'] = False
        t['ocultar_simulador'] = False
        t['ocultar_tabela'] = False

# 1. Deduplicação de trechos da MESMA rodovia sobrepostos no mesmo espaço físico (< 3.5 km)
mesma_rodovia_ocultados = 0
by_road = {}
for t in trechos_list:
    if t['ocultar_mapa']:
        continue
    by_road.setdefault((t['uf'], t['br']), []).append(t)

for (uf, br), group in by_road.items():
    if len(group) < 2:
        continue
    for i in range(len(group)):
        t1 = group[i]
        if t1['ocultar_mapa']:
            continue
        c1 = t1.get('coords', {})
        lat1, lon1 = c1.get('lat'), c1.get('lon')
        if lat1 is None or (lat1 == -15.78 and lon1 == -47.92):
            continue
        for j in range(i + 1, len(group)):
            t2 = group[j]
            if t2['ocultar_mapa']:
                continue
            c2 = t2.get('coords', {})
            lat2, lon2 = c2.get('lat'), c2.get('lon')
            if lat2 is None or (lat2 == -15.78 and lon2 == -47.92):
                continue
            
            dist = haversine_km([lon1, lat1], [lon2, lat2])
            if dist < 3.5 and abs(t1['km_inicio'] - t2['km_inicio']) >= 20:
                if t1['acidentes'] >= t2['acidentes']:
                    manter, ocultar = t1, t2
                else:
                    manter, ocultar = t2, t1
                
                if not ocultar.get('ocultar_mapa'):
                    ocultar['ocultar_mapa'] = True
                    ocultar['sobreposto_com'] = manter['id']
                    ocultar['motivo_ocultacao'] = f"Sobreposto fisicamente com {manter['br']} km {manter['km_inicio']}–{manter['km_fim']} (distância: {dist:.2f} km)"
                    manter['trechos_unificados'].append({
                        'id': ocultar['id'],
                        'km_inicio': ocultar['km_inicio'],
                        'km_fim': ocultar['km_fim'],
                        'acidentes': ocultar['acidentes']
                    })
                    mesma_rodovia_ocultados += 1

# 2. Deduplicação de rodovias DIFERENTES coincidentes (< 2.0 km)
coincidentes_ocultados = 0
pares_coincidentes = []
for i in range(len(trechos_list)):
    t1 = trechos_list[i]
    if t1['ocultar_mapa']:
        continue
    c1 = t1.get('coords', {})
    lat1, lon1 = c1.get('lat'), c1.get('lon')
    if lat1 is None or (lat1 == -15.78 and lon1 == -47.92):
        continue
    for j in range(i + 1, len(trechos_list)):
        t2 = trechos_list[j]
        if t2['ocultar_mapa']:
            continue
        if t1['uf'] != t2['uf'] or t1['br'] == t2['br']:
            continue
        c2 = t2.get('coords', {})
        lat2, lon2 = c2.get('lat'), c2.get('lon')
        if lat2 is None or (lat2 == -15.78 and lon2 == -47.92):
            continue
        
        dist = haversine_km([lon1, lat1], [lon2, lat2])
        if dist < 2.0:
            pares_coincidentes.append((dist, t1, t2))

for dist, t1, t2 in sorted(pares_coincidentes, key=lambda x: x[0]):
    if t1.get('ocultar_mapa') and t2.get('ocultar_mapa'):
        continue
    
    if t1['acidentes'] >= t2['acidentes']:
        manter, ocultar = t1, t2
    else:
        manter, ocultar = t2, t1
    
    if not ocultar.get('ocultar_mapa'):
        ocultar['ocultar_mapa'] = True
        ocultar['sobreposto_com'] = manter['br']
        ocultar['motivo_ocultacao'] = f"Sobreposto fisicamente com {manter['br']} (distância: {dist:.2f} km)"
        coincidentes_ocultados += 1

print(f"       -> [Filtro Cartográfico] {br0_ocultados} trechos BR-0, {mesma_rodovia_ocultados} duplicatas da mesma rodovia e {coincidentes_ocultados} trechos coincidentes marcados com ocultar_mapa: True.")
visiveis_mapa = len([t for t in trechos_list if not t.get('ocultar_mapa')])
print(f"       -> {visiveis_mapa} trechos únicos visíveis no mapa vetorial (de {len(trechos_list)} totais).")

dados_finais = {
    'metadata': {
        'titulo': "Observatório de Tráfego Preditivo - Escala Meso Nacional",
        'data_consolidacao': "13/10/2026",
        'resolucao_km': 20,
        'total_trechos': len(trechos_list),
        'total_sinistros': int(df_res['total_acidentes'].sum()),
        'ufs_cobertas': len(estados_list),
        'esparsidade_global': round(float(df_res['esparsidade_total_pct'].mean()), 2),
        'mae_global': round(float(df_res['mae'].mean()), 4),
        'rmse_global': round(float(df_res['rmse'].mean()), 4),
        'ruido_branco_global': round(float((df_res['residuos_ruido_branco'] == True).mean() * 100), 1),
        'chuva_sig_global': round(float((df_res['chuva_significativa'] == True).mean() * 100), 1),
        'feriado_sig_global': round(float((df_res['feriado_significativo'] == True).mean() * 100), 1)
    },
    'estados': estados_list,
    'macrorregioes': macrorregioes_list,
    'top50': top50_list,
    'trechos': trechos_list
}

print(f"[5/5] Gravando {JSON_SAIDA} e {JS_SAIDA}...")
json_str = json.dumps(dados_finais, ensure_ascii=False)
with open(JSON_SAIDA, 'w', encoding='utf-8') as f:
    f.write(json_str)

with open(JS_SAIDA, 'w', encoding='utf-8') as f:
    f.write('window.DADOS_MESO_NACIONAL = ' + json_str + ';')

tam_mb = JSON_SAIDA.stat().st_size / (1024 * 1024)
print(f"\n[SUCESSO] Arquivos gerados com sucesso: {JSON_SAIDA.name} e {JS_SAIDA.name} ({tam_mb:.2f} MB)")

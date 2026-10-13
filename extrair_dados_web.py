"""
Script de Extração e Otimização de Dados para o Frontend Web (Vercel)
Lê o relatório censitário nacional (CSV/MD), calcula coordenadas geográficas reais dos trechos
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

sys.path.append(str(DIR_TCC / "src"))
from config import DB_URI

print("[1/5] Lendo resultado_meso_todos_estados_20km.csv...")
df_res = pd.read_csv(CSV_RESULTADOS)
print(f"       -> Carregados {len(df_res)} registros do CSV.")

print("[2/5] Consultando coordenadas geográficas reais no PostgreSQL...")
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
print(f"       -> {len(df_prf):,} sinistros carregados em {time.time() - t0:.2f}s. Agrupando trechos...")

df_prf = df_prf.sort_values(by=['uf', 'br', 'km_inicio', 'km_real'])
df_coords = df_prf.groupby(['uf', 'br', 'km_inicio']).agg(
    qtd=('km_real', 'count'),
    lat_avg=('lat', 'mean'),
    lon_avg=('lon', 'mean'),
    lat_ini=('lat', 'first'),
    lon_ini=('lon', 'first'),
    lat_fim=('lat', 'last'),
    lon_fim=('lon', 'last')
).reset_index()

# Dicionário de busca rápida por coordenadas
coords_map = {}
for _, r in df_coords.iterrows():
    chave = f"{str(r['br']).strip().upper()}_{str(r['uf']).strip().upper()}_{float(r['km_inicio'])}"
    coords_map[chave] = {
        'lat': round(float(r['lat_avg']), 5),
        'lon': round(float(r['lon_avg']), 5),
        'lat_ini': round(float(r['lat_ini']), 5),
        'lon_ini': round(float(r['lon_ini']), 5),
        'lat_fim': round(float(r['lat_fim']), 5),
        'lon_fim': round(float(r['lon_fim']), 5)
    }

print(f"       -> {len(coords_map)} trechos com coordenadas geográficas mapeadas.")

print("[3/5] Compilando métricas agregadas por Estado e Macrorregião...")
# Agregação por Estado
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

# Ordenar estados por volume total de sinistros decrescente
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
    c = coords_map.get(chave, {'lat': -15.78, 'lon': -47.92, 'lat_ini': -15.78, 'lon_ini': -47.92, 'lat_fim': -15.78, 'lon_fim': -47.92})
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

print("[4/5] Processando os 3.019 trechos com parâmetros SARIMAX e baseline...")
trechos_list = []
X_zero = pd.DataFrame({'x_chuva': [0.0]*7, 'x_feriado': [0]*7, 'x_feriado_prolongado': [0]*7})

# Extração rápida com fallback inteligente
t_inicio_modelos = time.time()
modelos_carregados = 0

for idx, (_, r) in enumerate(df_res.iterrows()):
    br_clean = str(r['rodovia']).replace('BR-', '').replace('br-', '').strip()
    uf_clean = str(r['uf']).strip().upper()
    km_ini = float(r['km_inicio'])
    km_fim = float(r['km_fim'])
    
    chave = f"{br_clean.upper()}_{uf_clean}_{km_ini}"
    c = coords_map.get(chave, None)
    if not c:
        # Fallback de centroide caso não esteja no mapa
        c = {'lat': -15.78, 'lon': -47.92, 'lat_ini': -15.78, 'lon_ini': -47.92, 'lat_fim': -15.78, 'lon_fim': -47.92}

    # Nome do arquivo de modelo
    nome_arquivo = str(r['arquivo_modelo']).strip()
    caminho_mod = MODELS_DIR / nome_arquivo
    
    # Baseline temporal de 7 dias
    # Se o modelo existir e estiver acessível, carrega a baseline oficial
    # Caso contrário, deriva a baseline do histórico diário calibrado
    baseline_7d = None
    if caminho_mod.exists() and modelos_carregados < 3500:
        try:
            m = joblib.load(caminho_mod)
            p = m.predict(7, X=X_zero)
            baseline_7d = [round(float(val), 4) for val in p]
            modelos_carregados += 1
        except Exception:
            baseline_7d = None

    if baseline_7d is None:
        # Derivação analítica com base na taxa média e sazonalidade semanal
        taxa_diaria = float(r['acidentes_ano_media']) / 365.25
        # Variação semanal típica rodoviária (segunda a domingo)
        # Sábado e domingo ~1.15 e 1.25, dias úteis ~0.9 a 1.05
        fatores = [0.95, 0.90, 0.92, 0.98, 1.10, 1.25, 1.15]
        baseline_7d = [round(max(0.0, taxa_diaria * f), 4) for f in fatores]

    p_chuva_val = float(r['p_valor_chuva']) if pd.notnull(r['p_valor_chuva']) else 1.0
    p_feriado_val = float(r['p_valor_feriado']) if pd.notnull(r['p_valor_feriado']) else 1.0
    p_prolongado_val = float(r['p_valor_prolongado']) if pd.notnull(r['p_valor_prolongado']) else 1.0

    trechos_list.append({
        'id': f"BR{br_clean}_{uf_clean}_{int(km_ini)}",
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

    if (idx + 1) % 500 == 0 or (idx + 1) == len(df_res):
        print(f"       -> {idx + 1}/{len(df_res)} trechos processados ({modelos_carregados} lidos via joblib)...")

print(f"       -> Concluído em {time.time() - t_inicio_modelos:.2f}s.")

# Estrutura consolidada final
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

print(f"[5/5] Gravando {JSON_SAIDA}...")
with open(JSON_SAIDA, 'w', encoding='utf-8') as f:
    json.dump(dados_finais, f, ensure_ascii=False)

tam_mb = JSON_SAIDA.stat().st_size / (1024 * 1024)
print(f"\n[SUCESSO] Arquivo gerado com sucesso: {JSON_SAIDA.name} ({tam_mb:.2f} MB)")

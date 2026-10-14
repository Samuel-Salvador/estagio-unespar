"""
Gerador de Máscaras e Contornos Cartográficos Oficiais por Estado (IBGE)
Baixa as geometrias oficiais dos 27 estados via API de Malhas do IBGE,
cria as máscaras invertidas de isolamento territorial e os contornos estaduais,
e atualiza o arquivo brasil_geo.js.
"""
import urllib.request
import json
import gzip
import time
from pathlib import Path

DIR_ATUAL = Path(__file__).resolve().parent
DIR_DATA = DIR_ATUAL.parent / "data"
ARQ_BRASIL_GEO = DIR_DATA / "brasil_geo.js"

UFS = [
    'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
    'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
    'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'
]

WORLD_BOX = [[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]

print("[1/3] Lendo arquivo brasil_geo.js original...")
with open(ARQ_BRASIL_GEO, 'r', encoding='utf-8') as f:
    conteudo_orig = f.read()

# Extrai BRASIL_MASCARA e BRASIL_CONTORNO originais
linhas = conteudo_orig.split('\n')
linha_mascara_br = ""
linha_contorno_br = ""
for l in linhas:
    if l.startswith('window.BRASIL_MASCARA ='):
        linha_mascara_br = l
    elif l.startswith('window.BRASIL_CONTORNO ='):
        linha_contorno_br = l

print("[2/3] Baixando geometrias oficiais dos 27 estados na API do IBGE...")
ufs_mascaras = {}
ufs_contornos = {}

t0 = time.time()
for uf in UFS:
    url = f"https://servicodados.ibge.gov.br/api/v3/malhas/estados/{uf}?formato=application/vnd.geo+json&qualidade=intermediaria"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip'})
    
    sucesso = False
    for tentativa in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                raw = resp.read()
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
                data = json.loads(raw.decode('utf-8'))
                geom = data['features'][0]['geometry']
                
                # 1. Contorno oficial da UF
                ufs_contornos[uf] = {
                    "type": "Feature",
                    "geometry": geom,
                    "properties": {"uf": uf}
                }
                
                # 2. Máscara invertida da UF
                # Se for Polygon: coordinates = [ [ext_ring], [hole1], ... ]
                # Se for MultiPolygon: coordinates = [ [ [poly1_ext] ], [ [poly2_ext] ] ]
                rings = [WORLD_BOX]
                if geom['type'] == 'Polygon':
                    for r in geom['coordinates']:
                        rings.append(r)
                elif geom['type'] == 'MultiPolygon':
                    for poly in geom['coordinates']:
                        rings.append(poly[0])
                        
                ufs_mascaras[uf] = {
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": rings
                    },
                    "properties": {"uf": uf}
                }
                print(f"       -> [{uf}] OK ({geom['type']})")
                sucesso = True
                break
        except Exception as e:
            print(f"       -> [{uf}] Tentativa {tentativa} falhou: {e}. Repetindo...")
            time.sleep(1)
            
    if not sucesso:
        raise RuntimeError(f"Falha ao obter geometria da UF {uf} no IBGE.")

print(f"\n[3/3] Compilando novo brasil_geo.js com as 27 UFs ({time.time() - t0:.2f}s)...")

novo_js = (
    f"{linha_mascara_br}\n"
    f"{linha_contorno_br}\n"
    f"window.UFS_MASCARA = {json.dumps(ufs_mascaras, ensure_ascii=False)};\n"
    f"window.UFS_CONTORNO = {json.dumps(ufs_contornos, ensure_ascii=False)};\n"
)

with open(ARQ_BRASIL_GEO, 'w', encoding='utf-8') as f:
    f.write(novo_js)

tam_kb = ARQ_BRASIL_GEO.stat().st_size / 1024
print(f"[SUCESSO] brasil_geo.js atualizado com sucesso! Tamanho total: {tam_kb:.1f} KB.")

"""
Módulo de Download e Cache da Malha Rodoviária Oficial do DNIT (SNV)
Baixa as geometrias oficiais vetoriais (vw_snv_rod) para as 27 UFs via WFS GeoServer
e armazena localmente em cache para alimentar os traçados do Observatório.
"""
import os
import sys
import json
import time
import urllib.request
import urllib.parse
from pathlib import Path

DIR_CACHE = Path(__file__).resolve().parent / "cache_dnit_snv"
DIR_CACHE.mkdir(exist_ok=True)

UFS = [
    'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
    'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
    'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'
]

def baixar_snv_uf(uf: str, force: bool = False) -> Path:
    arquivo_cache = DIR_CACHE / f"snv_{uf}.json"
    if arquivo_cache.exists() and not force:
        print(f"[{uf}] Usando cache existente: {arquivo_cache.name}")
        return arquivo_cache
        
    print(f"[{uf}] Consultando DNIT GeoServer WFS...")
    cql = f"Unidade_Federacao='{uf}' AND Versao_SNV='202607A'"
    url = (
        "https://servicos.dnit.gov.br/dnitgeo/geoserver/ows?"
        "service=WFS&version=1.0.0&request=GetFeature&"
        "typeName=vgeo:vw_snv_rod&"
        f"cql_filter={urllib.parse.quote(cql)}&"
        "maxFeatures=2000&outputFormat=application/json"
    )
    
    t0 = time.time()
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    
    sucesso = False
    for tentativa in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                conteudo = resp.read()
                data = json.loads(conteudo.decode('utf-8'))
                features = data.get('features', [])
                
                # Salva em cache
                with open(arquivo_cache, 'w', encoding='utf-8') as f:
                    json.dump(features, f, ensure_ascii=False)
                    
                duracao = time.time() - t0
                print(f"[{uf}] Sucesso! {len(features)} feições baixadas em {duracao:.2f}s ({arquivo_cache.stat().st_size / 1024:.1f} KB).")
                sucesso = True
                break
        except Exception as e:
            print(f"[{uf}] Tentativa {tentativa} falhou: {e}. Aguardando 2s...")
            time.sleep(2)
            
    if not sucesso:
        print(f"[{uf}] AVISO: Não foi possível obter dados para {uf} após 3 tentativas.")
        
    return arquivo_cache

def baixar_todos(force: bool = False):
    print(f"Iniciando download do SNV/DNIT para as {len(UFS)} UFs...")
    t_global = time.time()
    for uf in UFS:
        baixar_snv_uf(uf, force=force)
    print(f"\nConcluído em {time.time() - t_global:.2f}s! Cache disponível em {DIR_CACHE}.")

if __name__ == "__main__":
    baixar_todos(force=False)

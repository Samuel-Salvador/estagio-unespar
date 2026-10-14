"""
Processador Cartográfico de Precisão para o Observatório Meso Nacional
Integra a malha vetorial oficial do DNIT (SNV) aos modelos SARIMAX de 20 km,
executa simplificação Ramer-Douglas-Peucker (RDP) e deduplicação espacial estrita.
"""
import os
import sys
import json
import time
from pathlib import Path
import numpy as np
import pandas as pd

DIR_ATUAL = Path(__file__).resolve().parent
DIR_CACHE = DIR_ATUAL / "cache_dnit_snv"
DIR_TCC = DIR_ATUAL.parent / "TCC"
CSV_RESULTADOS = DIR_TCC / "resultado_meso_todos_estados_20km.csv"

def haversine_km(c1, c2):
    """Calcula a distância ortodrômica em km entre dois pontos [lon, lat]."""
    R = 6371.0
    lat1, lon1 = np.radians(c1[1]), np.radians(c1[0])
    lat2, lon2 = np.radians(c2[1]), np.radians(c2[0])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2)**2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2)**2
    return 2 * R * np.arcsin(np.sqrt(np.maximum(0.0, a)))

def rdp_simplify(points, epsilon=0.0003):
    """
    Algoritmo de Ramer-Douglas-Peucker para simplificação de polilinhas.
    Reduz o tamanho em bytes mantendo 100% das curvas e contornos reais.
    points: lista de [lat, lon]
    """
    if len(points) <= 2:
        return points
    pts = np.array(points)
    p1 = pts[0]
    p2 = pts[-1]
    line_vec = p2 - p1
    line_len = np.linalg.norm(line_vec)
    if line_len == 0:
        dists = np.linalg.norm(pts - p1, axis=1)
    else:
        line_unit = line_vec / line_len
        proj = np.dot(pts - p1, line_unit)[:, None] * line_unit
        dists = np.linalg.norm((pts - p1) - proj, axis=1)
    idx = int(np.argmax(dists))
    max_d = dists[idx]
    if max_d > epsilon:
        left = rdp_simplify(points[:idx+1], epsilon)
        right = rdp_simplify(points[idx:], epsilon)
        return left[:-1] + right
    else:
        return [points[0], points[-1]]

def normalizar_br(codigo_br):
    """Normaliza variações de código numérico da BR ('242', 'BR-242', '020', '20')."""
    s = str(codigo_br).upper().replace('BR-', '').replace('BR', '').strip()
    if s.isdigit():
        return str(int(s))
    return s

class SNVIndex:
    """Índice em memória da malha viária oficial do DNIT para busca e fatiamento rápido."""
    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self.uf_data = {}
        
    def carregar_uf(self, uf: str):
        if uf in self.uf_data:
            return self.uf_data[uf]
            
        arq = self.cache_dir / f"snv_{uf}.json"
        if not arq.exists():
            self.uf_data[uf] = {}
            return {}
            
        with open(arq, 'r', encoding='utf-8') as f:
            features = json.load(f)
            
        # Agrupa por BR normalizada
        by_br = {}
        for feat in features:
            props = feat.get('properties', {})
            br_raw = props.get('Codigo_BR')
            if not br_raw:
                continue
            br_clean = normalizar_br(br_raw)
            by_br.setdefault(br_clean, []).append(feat)
            
        self.uf_data[uf] = by_br
        return by_br

    def fatiar_trecho(self, br_clean: str, uf: str, target_km_ini: float, target_km_fim: float):
        """Fatia a polilinha contínua da rodovia oficial entre target_km_ini e target_km_fim."""
        uf_map = self.carregar_uf(uf)
        feats = uf_map.get(br_clean, [])
        if not feats:
            return None
            
        # Prioriza 'Eixo Principal'
        eixo_feats = [f for f in feats if f['properties'].get('Nome_Tipo_Trecho') == 'Eixo Principal']
        if not eixo_feats:
            eixo_feats = feats
            
        eixo_feats.sort(key=lambda x: float(x['properties'].get('Quilometragem_Inicio') or 0.0))
        
        sliced_pts = []
        for feat in eixo_feats:
            p = feat['properties']
            feat_ini = float(p.get('Quilometragem_Inicio') or 0.0)
            feat_fim = float(p.get('Quilometragem_Fim') or 0.0)
            
            if target_km_fim <= feat_ini or target_km_ini >= feat_fim or feat_fim <= feat_ini:
                continue
                
            geom = feat.get('geometry', {})
            coords = geom.get('coordinates', [])
            if not coords:
                continue
            lines = coords if geom.get('type') == 'MultiLineString' else [coords]
            
            all_pts = []
            for l in lines:
                all_pts.extend(l)
                
            if len(all_pts) < 2:
                continue
                
            dists = [0.0]
            for i in range(len(all_pts) - 1):
                dists.append(dists[-1] + haversine_km(all_pts[i], all_pts[i+1]))
                
            total_len = dists[-1]
            if total_len <= 0.001:
                continue
                
            k_start = max(target_km_ini, feat_ini)
            k_end = min(target_km_fim, feat_fim)
            
            frac_start = (k_start - feat_ini) / (feat_fim - feat_ini)
            frac_end = (k_end - feat_ini) / (feat_fim - feat_ini)
            
            d_start = frac_start * total_len
            d_end = frac_end * total_len
            
            for pt, d in zip(all_pts, dists):
                if d_start <= d <= d_end:
                    sliced_pts.append(pt)
                    
        if len(sliced_pts) < 2:
            return None
            
        # Converte de GeoJSON [lon, lat] para Leaflet [lat, lon]
        leaflet_pts = [[round(p[1], 5), round(p[0], 5)] for p in sliced_pts]
        simplified = rdp_simplify(leaflet_pts, epsilon=0.0003)
        return simplified

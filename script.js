/**
 * Observatório de Tráfego Preditivo — Escala Meso Nacional
 * Lógica do Frontend: Mapa Interativo (Leaflet), Gráficos Dinâmicos (Chart.js),
 * Tabelas com Filtro/Ordenação/Paginação e Motor de Inferência SARIMAX.
 */

// Estado Global da Aplicação
const appState = {
    dados: null,
    secaoAtiva: 'sobre',
    mapa: null,
    camadaMascara: null,
    camadaContorno: null,
    camadaVetorial: null,
    camadaAtiva: 'todos', // 'todos' | 'chuva' | 'feriado' | 'top50'
    ufSelecionada: 'TODAS',
    tabelaAtiva: 'ufs',   // 'ufs' | 'regioes' | 'top50' | 'todos'
    tabelaBusca: '',
    ordenacaoPorTabela: {
        ufs: { coluna: 'sinistros', ordem: 'desc' },
        regioes: { coluna: 'sinistros', ordem: 'desc' },
        top50: { coluna: 'posicao', ordem: 'asc' },
        todos: { coluna: 'sinistros', ordem: 'desc' }
    },
    tabelaPaginaAtual: 1,
    tabelaItensPorPagina: 50,
    chartChuva: null,
    chartFeriado: null,
    chartPrevisao: null,
    trechoSelecionadoPrevisao: null
};

// Mapeamento das 27 UFs Brasileiras para Nome Completo
const NOMES_UFS = {
    'AC': 'Acre',
    'AL': 'Alagoas',
    'AP': 'Amapá',
    'AM': 'Amazonas',
    'BA': 'Bahia',
    'CE': 'Ceará',
    'DF': 'Distrito Federal',
    'ES': 'Espírito Santo',
    'GO': 'Goiás',
    'MA': 'Maranhão',
    'MT': 'Mato Grosso',
    'MS': 'Mato Grosso do Sul',
    'MG': 'Minas Gerais',
    'PA': 'Pará',
    'PB': 'Paraíba',
    'PR': 'Paraná',
    'PE': 'Pernambuco',
    'PI': 'Piauí',
    'RJ': 'Rio de Janeiro',
    'RN': 'Rio Grande do Norte',
    'RS': 'Rio Grande do Sul',
    'RO': 'Rondônia',
    'RR': 'Roraima',
    'SC': 'Santa Catarina',
    'SP': 'São Paulo',
    'SE': 'Sergipe',
    'TO': 'Tocantins'
};

// ==========================================================================
// 1. INICIALIZAÇÃO E NAVEGAÇÃO
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    configurarNavegacao();
    await carregarDados();
});

function configurarNavegacao() {
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.page-section');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = link.getAttribute('data-target');
            trocarAba(targetId);
        });
    });
}

function trocarAba(targetId) {
    appState.secaoAtiva = targetId;

    document.querySelectorAll('.page-section').forEach(sec => sec.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    const sectionEl = document.getElementById(targetId);
    const linkEl = document.querySelector(`.nav-link[data-target="${targetId}"]`);
    
    if (sectionEl) sectionEl.classList.add('active');
    if (linkEl) linkEl.classList.add('active');

    // Ao entrar no Observatório, renderizar mapa e gráficos se necessário
    if (targetId === 'observatorio') {
        setTimeout(() => {
            if (!appState.mapa) {
                inicializarMapa();
            } else {
                appState.mapa.invalidateSize();
            }
            if (!appState.chartChuva) {
                inicializarGraficosObservatorio();
            }
        }, 100);
    }

    // Ao entrar no Simulador de Previsão
    if (targetId === 'previsao') {
        setTimeout(() => {
            if (!appState.chartPrevisao) {
                inicializarGraficoPrevisao();
            }
            if (!appState.trechoSelecionadoPrevisao && appState.dados) {
                inicializarFormularioPrevisao();
            }
        }, 100);
    }
}

// ==========================================================================
// 2. CARREGAMENTO DOS DADOS (Zero-CORS / Vercel Ready)
// ==========================================================================

async function carregarDados() {
    try {
        if (window.DADOS_MESO_NACIONAL) {
            appState.dados = window.DADOS_MESO_NACIONAL;
        } else {
            const resp = await fetch('dados_meso_nacional.json');
            appState.dados = await resp.json();
        }

        popularKpisGlobais();
        configurarFiltrosObservatorio();
        renderizarTabela();
        inicializarFormularioPrevisao();
        
    } catch (err) {
        console.error('Erro ao carregar dados:', err);
    }
}

function popularKpisGlobais() {
    const meta = appState.dados && appState.dados.metadata;
    if (!meta) return;

    const elTrechos = document.getElementById('kpiTrechos');
    const elSinistros = document.getElementById('kpiSinistros');

    if (elTrechos) elTrechos.innerText = meta.total_trechos.toLocaleString('pt-BR');
    if (elSinistros) elSinistros.innerText = meta.total_sinistros.toLocaleString('pt-BR');

    atualizarCardsMetricasEstado(appState.ufSelecionada || 'TODAS');
}

function atualizarCardsMetricasEstado(uf) {
    const meta = appState.dados && appState.dados.metadata;
    const estados = appState.dados && appState.dados.estados;
    if (!meta || !estados) return;

    const tituloEl = document.getElementById('tituloMetricasEstado');
    const regiaoEl = document.getElementById('regiaoMetricasEstado');
    const statsEl = document.getElementById('statsMetricasEstado');
    const elEsparsidade = document.getElementById('kpiEsparsidade');
    const elRuido = document.getElementById('kpiRuido');
    const elChuva = document.getElementById('kpiChuva');
    const elFeriado = document.getElementById('kpiFeriado');

    if (!elEsparsidade || !elRuido || !elChuva || !elFeriado) return;

    if (uf === 'TODAS' || !uf) {
        if (tituloEl) tituloEl.innerHTML = '<i data-lucide="bar-chart-2"></i> Métricas — Brasil Geral';
        if (regiaoEl) regiaoEl.innerHTML = '<i data-lucide="map-pin"></i> <span>27 Unidades Federativas</span>';
        if (statsEl) statsEl.innerText = `${meta.total_trechos.toLocaleString('pt-BR')} trechos | ${meta.total_sinistros.toLocaleString('pt-BR')} acidentes`;

        elEsparsidade.innerText = meta.esparsidade_global + '%';
        elRuido.innerText = meta.ruido_branco_global + '%';
        elChuva.innerText = meta.chuva_sig_global + '%';
        elFeriado.innerText = meta.feriado_sig_global + '%';
    } else {
        const est = estados.find(e => e.uf === uf);
        if (est) {
            if (tituloEl) tituloEl.innerHTML = `<i data-lucide="bar-chart-2"></i> Métricas — ${est.uf}`;
            if (regiaoEl) regiaoEl.innerHTML = `<i data-lucide="map-pin"></i> <span>Região ${est.regiao}</span>`;
            if (statsEl) statsEl.innerText = `${est.trechos.toLocaleString('pt-BR')} trechos | ${est.sinistros.toLocaleString('pt-BR')} acidentes`;

            elEsparsidade.innerText = est.esparsidade + '%';
            elRuido.innerText = est.ruido_branco_pct + '%';
            elChuva.innerText = est.chuva_sig_pct + '%';
            elFeriado.innerText = est.feriado_sig_pct + '%';
        }
    }

    if (window.lucide) {
        lucide.createIcons();
    }
}

// ==========================================================================
// 3. MAPA INTERATIVO (Leaflet.js)
// ==========================================================================

function inicializarMapa() {
    const mapEl = document.getElementById('mapaRodovias');
    if (!mapEl) return;

    // Limites territoriais estritos do Brasil
    const BRAZIL_BOUNDS = L.latLngBounds([
        [-34.5, -74.5],
        [5.5, -34.0]
    ]);

    appState.mapa = L.map('mapaRodovias', {
        center: [-14.5, -53.2],
        zoom: 4,
        minZoom: 4,
        maxZoom: 14,
        maxBounds: BRAZIL_BOUNDS,
        maxBoundsViscosity: 1.0 // Trava o mapa 100% no Brasil
    });

    // Camadas de mapa 100% gratuitas e sem exigência de API Key
    const osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    });

    const esriGray = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
        maxZoom: 16
    });

    // Adiciona OpenStreetMap como camada padrão ativa
    osmLayer.addTo(appState.mapa);

    // Camadas dinâmicas para máscara territorial e contorno oficial IBGE
    appState.camadaMascara = L.layerGroup().addTo(appState.mapa);
    appState.camadaContorno = L.layerGroup().addTo(appState.mapa);

    // Controle para alternar entre OpenStreetMap e Mapa Cinza Sóbrio
    L.control.layers({
        'OpenStreetMap (Padrão)': osmLayer,
        'Mapa Sóbrio (Cinza)': esriGray
    }, null, { position: 'topright' }).addTo(appState.mapa);

    appState.camadaVetorial = L.layerGroup().addTo(appState.mapa);
    appState.mapa.fitBounds(BRAZIL_BOUNDS, { padding: [10, 10] });

    // Eventos dos botões de camada rápida
    document.querySelectorAll('.btn-pill[data-layer]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-pill[data-layer]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.camadaAtiva = btn.getAttribute('data-layer');
            atualizarCamadaMapa();
            atualizarLegendaMapa(appState.camadaAtiva);
        });
    });

    // Evento do filtro de UF
    const selectUf = document.getElementById('filtroUfMapa');
    selectUf.addEventListener('change', (e) => {
        appState.ufSelecionada = e.target.value;
        atualizarMascaraEContorno();
        atualizarCamadaMapa();
        ajustarZoomMapaPorUf(appState.ufSelecionada);
        atualizarGraficosObservatorio();
        atualizarCardsMetricasEstado(appState.ufSelecionada);
    });

    atualizarMascaraEContorno();
    atualizarCamadaMapa();
    atualizarLegendaMapa(appState.camadaAtiva);
}

function configurarFiltrosObservatorio() {
    const selectUf = document.getElementById('filtroUfMapa');
    if (!selectUf) return;
    selectUf.innerHTML = '<option value="TODAS">Brasil Geral (Todas as 27 UFs)</option>';

    // Ordena os estados em ordem alfabética pelo nome completo
    const estadosOrdenados = [...appState.dados.estados].sort((a, b) => {
        const nomeA = NOMES_UFS[a.uf] || a.uf;
        const nomeB = NOMES_UFS[b.uf] || b.uf;
        return nomeA.localeCompare(nomeB, 'pt-BR');
    });

    estadosOrdenados.forEach(est => {
        const opt = document.createElement('option');
        opt.value = est.uf;
        opt.textContent = NOMES_UFS[est.uf] || est.uf;
        selectUf.appendChild(opt);
    });
}

function atualizarCamadaMapa() {
    if (!appState.camadaVetorial || !appState.dados) return;
    appState.camadaVetorial.clearLayers();

    const layerModo = appState.camadaAtiva;
    const ufFiltro = appState.ufSelecionada;

    let trechos = appState.dados.trechos;

    if (ufFiltro !== 'TODAS') {
        trechos = trechos.filter(t => t.uf === ufFiltro);
    }

    // Trechos a desenhar no mapa (ignora sobrepostos coincidentes e códigos genéricos BR-0)
    const trechosDesenho = trechos.filter(t => !t.ocultar_mapa);

    // Texto de status do mapa
    if (layerModo === 'todos') {
        document.getElementById('statusMapaTrechos').innerText = 
            `Exibindo ${trechosDesenho.length.toLocaleString('pt-BR')} trechos desenhados ${ufFiltro !== 'TODAS' ? 'em ' + ufFiltro : 'no Brasil'}`;
    } else if (layerModo === 'chuva') {
        const qtdSig = trechosDesenho.filter(t => t.chuva_sig).length;
        document.getElementById('statusMapaTrechos').innerText = 
            `Exibindo ${qtdSig.toLocaleString('pt-BR')} trechos sensíveis à chuva de ${trechosDesenho.length.toLocaleString('pt-BR')} ${ufFiltro !== 'TODAS' ? 'em ' + ufFiltro : 'no Brasil'}`;
    } else if (layerModo === 'feriado') {
        const qtdSig = trechosDesenho.filter(t => t.feriado_sig).length;
        document.getElementById('statusMapaTrechos').innerText = 
            `Exibindo ${qtdSig.toLocaleString('pt-BR')} trechos sensíveis a feriados de ${trechosDesenho.length.toLocaleString('pt-BR')} ${ufFiltro !== 'TODAS' ? 'em ' + ufFiltro : 'no Brasil'}`;
    }

    trechos.forEach(t => {
        // Ignora trechos coincidentes/duplicados e códigos genéricos da PRF exclusivamente no mapa
        if (t.ocultar_mapa) return;

        const c = t.coords;
        if (!c || isNaN(c.lat) || isNaN(c.lon)) return;

        let cor = '#2563eb';
        let peso = 3.2;
        let opacidade = 0.85;

        if (layerModo === 'todos') {
            // Cor única e uniforme para todas as rodovias
            cor = '#2563eb';
            peso = 3.2;
            opacidade = 0.85;
        } else if (layerModo === 'chuva') {
            if (t.chuva_sig) {
                cor = '#0284c7';
                peso = 4.2;
                opacidade = 0.95;
            } else {
                cor = '#cbd5e1';
                peso = 1.8;
                opacidade = 0.45;
            }
        } else if (layerModo === 'feriado') {
            if (t.feriado_sig) {
                cor = '#ea580c';
                peso = 4.2;
                opacidade = 0.95;
            } else {
                cor = '#cbd5e1';
                peso = 1.8;
                opacidade = 0.45;
            }
        }

        const pts = (c && c.pts && c.pts.length > 0) ? c.pts : (c.lat_ini ? [[c.lat_ini, c.lon_ini], [c.lat_fim, c.lon_fim]] : null);
        let elementoGrafico;

        if (pts && pts.length > 1) {
            elementoGrafico = L.polyline(pts, {
                color: cor,
                weight: peso,
                opacity: opacidade,
                smoothFactor: 1.0,
                lineCap: 'round',
                lineJoin: 'round'
            });
        } else {
            elementoGrafico = L.circleMarker([c.lat, c.lon], {
                radius: Math.min(10, Math.max(4, Math.log10(t.acidentes) * 2.5)),
                fillColor: cor,
                color: '#ffffff',
                weight: 1,
                fillOpacity: opacidade
            });
        }

        // Popup interativo
        const popupHtml = `
            <div class="popup-card">
                <div class="popup-header">
                    <div class="popup-title">${t.br} / ${t.uf}</div>
                    <div style="font-size:0.8rem; color:#64748b;">km ${t.km_inicio} a ${t.km_fim} (Segmento 20 km)</div>
                    <span class="popup-badge" style="background:${cor}20; color:${cor};">
                        ${t.acidentes.toLocaleString('pt-BR')} acidentes em 5 anos
                    </span>
                </div>
                <div class="popup-body">
                    <p><span>Modelo SARIMAX:</span> <strong>${t.order}×${t.seasonal}</strong></p>
                    <p><span>MAE Médio:</span> <strong>${t.mae}</strong></p>
                    <p><span>Ruído Branco:</span> <strong>${t.ruido_branco ? 'Sim (p > 0.05)' : 'Não'}</strong></p>
                    <p><span>&beta; Chuva:</span> <strong>${t.beta_chuva} (${t.chuva_sig ? 'Sig. p < 0.05' : 'Não sig.'})</strong></p>
                    <p><span>&beta; Feriados:</span> <strong>${t.beta_feriado} (${t.feriado_sig ? 'Sig. p < 0.05' : 'Não sig.'})</strong></p>
                    ${t.trechos_unificados && t.trechos_unificados.length > 0 ? `
                        <div style="margin: 8px 0 4px 0; padding: 6px 8px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; font-size: 0.75rem; color: #1e40af;">
                            <div style="font-weight:600; margin-bottom:2px;">📍 Trecho Físico Unificado no Mapa:</div>
                            <div style="font-size:0.7rem; color:#3b82f6; margin-bottom:4px;">Abrange dados sobrepostos de outros modelos da rodovia:</div>
                            ${t.trechos_unificados.map(u => `
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:3px; padding-top:2px; border-top:1px dashed #dbeafe;">
                                    <span>km ${u.km_inicio}–${u.km_fim} (${u.acidentes} acidentes)</span>
                                    <button style="padding:1px 6px; font-size:0.68rem; border-radius:3px; background:#2563eb; color:#fff; border:none; cursor:pointer;" onclick="carregarTrechoNoSimulador('${u.id}')">Simular</button>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
                <button class="btn-popup-action" onclick="carregarTrechoNoSimulador('${t.id}')">
                    Simular Previsão Principal ➔
                </button>
            </div>
        `;

        elementoGrafico.bindPopup(popupHtml);
        appState.camadaVetorial.addLayer(elementoGrafico);
    });
}

// Bounding boxes aproximadas dos estados brasileiros para zoom suave
const UFS_BOUNDS = {
    'PR': [[-26.7, -54.6], [-22.5, -48.0]],
    'SC': [[-29.4, -53.8], [-25.9, -48.3]],
    'RS': [[-33.8, -57.6], [-27.1, -49.7]],
    'SP': [[-25.3, -53.1], [-19.8, -44.2]],
    'RJ': [[-23.4, -44.9], [-20.8, -40.9]],
    'MG': [[-22.9, -51.0], [-14.2, -39.8]],
    'ES': [[-21.3, -41.9], [-17.9, -39.7]],
    'BA': [[-18.3, -46.6], [-8.5, -37.3]],
    'PE': [[-9.5, -41.4], [-7.3, -34.8]],
    'CE': [[-7.9, -41.4], [-2.8, -37.2]],
    'GO': [[-19.5, -53.2], [-12.4, -45.9]],
    'DF': [[-16.1, -48.3], [-15.5, -47.3]],
    'MT': [[-18.0, -61.6], [-7.3, -50.2]],
    'MS': [[-24.1, -58.2], [-17.2, -51.0]],
    'PA': [[-9.9, -58.9], [2.6, -46.1]],
    'RO': [[-13.7, -66.6], [-7.9, -60.0]],
    'MA': [[-10.3, -48.8], [-1.0, -41.8]],
    'PB': [[-8.3, -38.8], [-6.0, -34.8]],
    'RN': [[-6.9, -38.6], [-4.8, -34.9]],
    'AL': [[-10.5, -38.2], [-8.8, -35.1]],
    'SE': [[-11.6, -38.2], [-9.5, -36.4]],
    'PI': [[-10.9, -46.0], [-2.7, -40.4]],
    'TO': [[-13.5, -50.7], [-5.2, -45.7]],
    'AC': [[-11.2, -73.9], [-7.1, -66.6]],
    'AM': [[-9.8, -73.8], [2.2, -56.1]],
    'RR': [[-1.6, -64.8], [5.3, -58.9]],
    'AP': [[-1.2, -54.9], [4.4, -49.9]]
};

function atualizarMascaraEContorno() {
    if (!appState.mapa || !appState.camadaMascara || !appState.camadaContorno) return;
    
    appState.camadaMascara.clearLayers();
    appState.camadaContorno.clearLayers();
    
    const uf = appState.ufSelecionada;
    
    let mascaraGeoJson = null;
    let contornoGeoJson = null;
    
    if (uf === 'TODAS') {
        mascaraGeoJson = window.BRASIL_MASCARA;
        contornoGeoJson = window.BRASIL_CONTORNO;
    } else {
        if (window.UFS_MASCARA && window.UFS_MASCARA[uf]) {
            mascaraGeoJson = window.UFS_MASCARA[uf];
        }
        if (window.UFS_CONTORNO && window.UFS_CONTORNO[uf]) {
            contornoGeoJson = window.UFS_CONTORNO[uf];
        }
    }
    
    if (mascaraGeoJson) {
        L.geoJSON(mascaraGeoJson, {
            style: {
                fillColor: '#f8fafc',
                fillOpacity: 0.94,
                color: '#cbd5e1',
                weight: 1.5
            },
            interactive: false
        }).addTo(appState.camadaMascara);
    }
    
    if (contornoGeoJson) {
        L.geoJSON(contornoGeoJson, {
            style: {
                fillOpacity: 0,
                color: '#334155',
                weight: 2.2,
                dashArray: '4, 4'
            },
            interactive: false
        }).addTo(appState.camadaContorno);
    }
}

function ajustarZoomMapaPorUf(uf) {
    if (!appState.mapa) return;

    if (uf === 'TODAS') {
        const BRAZIL_BOUNDS = L.latLngBounds([[-34.5, -74.5], [5.5, -34.0]]);
        appState.mapa.fitBounds(BRAZIL_BOUNDS, { padding: [10, 10] });
    } else if (window.UFS_CONTORNO && window.UFS_CONTORNO[uf]) {
        // Enquadra perfeitamente pelos limites oficiais do contorno IBGE
        const tempLayer = L.geoJSON(window.UFS_CONTORNO[uf]);
        const bounds = tempLayer.getBounds();
        appState.mapa.fitBounds(bounds, { padding: [30, 30] });
    } else if (UFS_BOUNDS[uf]) {
        const bounds = UFS_BOUNDS[uf];
        appState.mapa.fitBounds(bounds, { padding: [20, 20], maxZoom: 8 });
    }
}

function atualizarLegendaMapa(modo) {
    const container = document.getElementById('conteudoLegendaMapa');
    if (!container) return;

    if (modo === 'todos') {
        container.innerHTML = `
            <div class="legend-item">
                <div class="legend-line" style="background:#2563eb;"></div>
                <span>Trecho monitorado</span>
            </div>
        `;
    } else if (modo === 'chuva') {
        container.innerHTML = `
            <div class="legend-item">
                <div class="legend-line" style="background:#0284c7;"></div>
                <span>Sensibilidade à Chuva (p &lt; 0.05)</span>
            </div>
            <div class="legend-item">
                <div class="legend-line" style="background:#cbd5e1;"></div>
                <span>Sem sensibilidade direta</span>
            </div>
        `;
    } else if (modo === 'feriado') {
        container.innerHTML = `
            <div class="legend-item">
                <div class="legend-line" style="background:#ea580c;"></div>
                <span>Sensibilidade a Feriados (p &lt; 0.05)</span>
            </div>
            <div class="legend-item">
                <div class="legend-line" style="background:#cbd5e1;"></div>
                <span>Sem sensibilidade direta</span>
            </div>
        `;
    }
}

// ==========================================================================
// 4. GRÁFICOS DINÂMICOS DO OBSERVATÓRIO (Chart.js)
// ==========================================================================

function inicializarGraficosObservatorio() {
    atualizarGraficosObservatorio();
}

function atualizarGraficosObservatorio() {
    const ufFiltro = appState.ufSelecionada;
    const ctxChuva = document.getElementById('chartChuva').getContext('2d');
    const ctxFeriado = document.getElementById('chartFeriado').getContext('2d');

    if (appState.chartChuva) appState.chartChuva.destroy();
    if (appState.chartFeriado) appState.chartFeriado.destroy();

    if (ufFiltro === 'TODAS') {
        // Visão Brasil Geral: Ranking das 27 UFs
        document.getElementById('tituloChartChuva').innerText = 'Sensibilidade Pluviométrica Regional (27 UFs)';
        document.getElementById('subtituloChartChuva').innerText = '% de trechos com sensibilidade estatística direta à chuva (p < 0.05)';
        document.getElementById('tituloChartFeriado').innerText = 'Sensibilidade a Feriados e Turismo (27 UFs)';
        document.getElementById('subtituloChartFeriado').innerText = '% de trechos com elevação de risco em feriados nacionais';

        const estadosChuva = [...appState.dados.estados].sort((a, b) => b.chuva_sig_pct - a.chuva_sig_pct);
        const estadosFeriado = [...appState.dados.estados].sort((a, b) => b.feriado_sig_pct - a.feriado_sig_pct);

        // Gráfico de Chuva Brasil
        appState.chartChuva = new Chart(ctxChuva, {
            type: 'bar',
            data: {
                labels: estadosChuva.map(e => e.uf),
                datasets: [{
                    label: '% Trechos com Chuva Sig.',
                    data: estadosChuva.map(e => e.chuva_sig_pct),
                    backgroundColor: estadosChuva.map(e => e.chuva_sig_pct >= 42.7 ? '#0284c7' : '#93c5fd'),
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                scales: {
                    x: { max: 100, title: { display: true, text: 'Trechos Sensíveis (%)' } },
                    y: { ticks: { font: { size: 10, weight: 600 } } }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ${ctx.raw}% dos trechos (${estadosChuva[ctx.dataIndex].trechos} trechos)`
                        }
                    }
                }
            }
        });

        // Gráfico de Feriados Brasil
        appState.chartFeriado = new Chart(ctxFeriado, {
            type: 'bar',
            data: {
                labels: estadosFeriado.map(e => e.uf),
                datasets: [{
                    label: '% Trechos com Feriados Sig.',
                    data: estadosFeriado.map(e => e.feriado_sig_pct),
                    backgroundColor: estadosFeriado.map(e => e.feriado_sig_pct >= 12.2 ? '#ea580c' : '#fdba74'),
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                scales: {
                    x: { max: 35, title: { display: true, text: 'Trechos Sensíveis (%)' } },
                    y: { ticks: { font: { size: 10, weight: 600 } } }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ${ctx.raw}% dos trechos (${estadosFeriado[ctx.dataIndex].trechos} trechos)`
                        }
                    }
                }
            }
        });

    } else {
        // Visão Específica do Estado Selecionado
        const estadoInfo = appState.dados.estados.find(e => e.uf === ufFiltro);
        const trechosUf = appState.dados.trechos.filter(t => t.uf === ufFiltro);

        document.getElementById('tituloChartChuva').innerText = `Sensibilidade à Chuva no Estado de ${ufFiltro}`;
        document.getElementById('subtituloChartChuva').innerText = `${estadoInfo.chuva_sig_pct}% dos trechos significativos (Média Brasil: 42.7%)`;
        document.getElementById('tituloChartFeriado').innerText = `Sensibilidade a Feriados no Estado de ${ufFiltro}`;
        document.getElementById('subtituloChartFeriado').innerText = `${estadoInfo.feriado_sig_pct}% dos trechos significativos (Média Brasil: 12.2%)`;

        const chuvaSigCount = trechosUf.filter(t => t.chuva_sig).length;
        const chuvaNaoSigCount = trechosUf.length - chuvaSigCount;

        const feriadoSigCount = trechosUf.filter(t => t.feriado_sig).length;
        const feriadoNaoSigCount = trechosUf.length - feriadoSigCount;

        // Gráfico Donut de Chuva da UF
        appState.chartChuva = new Chart(ctxChuva, {
            type: 'doughnut',
            data: {
                labels: ['Chuva Significativa (p < 0.05)', 'Sem Sensibilidade Direta'],
                datasets: [{
                    data: [chuvaSigCount, chuvaNaoSigCount],
                    backgroundColor: ['#0284c7', '#e2e8f0'],
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ${ctx.label}: ${ctx.raw} trechos (${((ctx.raw/trechosUf.length)*100).toFixed(1)}%)`
                        }
                    }
                }
            }
        });

        // Gráfico Donut de Feriados da UF
        appState.chartFeriado = new Chart(ctxFeriado, {
            type: 'doughnut',
            data: {
                labels: ['Feriados Significativos (p < 0.05)', 'Sem Sensibilidade Direta'],
                datasets: [{
                    data: [feriadoSigCount, feriadoNaoSigCount],
                    backgroundColor: ['#ea580c', '#e2e8f0'],
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ${ctx.label}: ${ctx.raw} trechos (${((ctx.raw/trechosUf.length)*100).toFixed(1)}%)`
                        }
                    }
                }
            }
        });
    }
}

// ==========================================================================
// 5. TABELA DE DADOS INTERATIVA COM ABAS E BUSCA
// ==========================================================================

function renderizarTabela() {
    if (!appState.dados) return;

    // Configuração dos botões das abas da tabela
    document.querySelectorAll('.table-tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.table-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.tabelaAtiva = btn.getAttribute('data-table');
            appState.tabelaPaginaAtual = 1;
            atualizarConteudoTabela();
        };
    });

    // Input de busca com filtro dinâmico
    const inputBusca = document.getElementById('inputBuscaTabela');
    inputBusca.oninput = (e) => {
        appState.tabelaBusca = e.target.value.toLowerCase().trim();
        appState.tabelaPaginaAtual = 1;
        atualizarConteudoTabela();
    };

    // Controles de paginação
    document.getElementById('btnPagePrev').onclick = () => {
        if (appState.tabelaPaginaAtual > 1) {
            appState.tabelaPaginaAtual--;
            atualizarConteudoTabela();
        }
    };

    document.getElementById('btnPageNext').onclick = () => {
        appState.tabelaPaginaAtual++;
        atualizarConteudoTabela();
    };

    atualizarConteudoTabela();
}

function formatarPValor(p, decimais = 4) {
    if (p === undefined || p === null || isNaN(p)) return '-';
    const num = Number(p);
    if (num < 0.001) return num === 0 ? '0.000' : num.toExponential(2);
    return num.toFixed(decimais);
}

function alternarOrdenacaoTabela(coluna) {
    const modo = appState.tabelaAtiva;
    if (!appState.ordenacaoPorTabela) {
        appState.ordenacaoPorTabela = {};
    }
    if (!appState.ordenacaoPorTabela[modo]) {
        appState.ordenacaoPorTabela[modo] = { coluna: '', ordem: 'desc' };
    }
    const atual = appState.ordenacaoPorTabela[modo];
    if (atual.coluna === coluna) {
        atual.ordem = (atual.ordem === 'asc' ? 'desc' : 'asc');
    } else {
        atual.coluna = coluna;
        const colunasTexto = ['uf', 'regiao', 'rodovia', 'order'];
        atual.ordem = colunasTexto.includes(coluna) ? 'asc' : 'desc';
    }
    if (modo === 'todos') {
        appState.tabelaPaginaAtual = 1;
    }
    atualizarConteudoTabela();
}
window.alternarOrdenacaoTabela = alternarOrdenacaoTabela;

function renderTh(coluna, label, estilo = '') {
    const modo = appState.tabelaAtiva;
    const ordenacao = (appState.ordenacaoPorTabela && appState.ordenacaoPorTabela[modo]) || { coluna: '', ordem: 'desc' };
    const estaAtiva = (ordenacao.coluna === coluna);
    const icone = estaAtiva ? (ordenacao.ordem === 'asc' ? '▲' : '▼') : '↕';
    const classeAtiva = estaAtiva ? 'th-sorted' : '';
    const labelLimpo = label.replace(/<[^>]*>?/gm, '').replace(/&[a-z]+;/g, '');
    return `<th class="th-sortable ${classeAtiva}" style="${estilo}" onclick="alternarOrdenacaoTabela('${coluna}')" title="Clique para ordenar por ${labelLimpo}">
        <span>${label}</span> <span class="sort-icon">${icone}</span>
    </th>`;
}

function compararValores(a, b, ordem) {
    if (a === b) return 0;
    if (a === null || a === undefined || a === '') return 1;
    if (b === null || b === undefined || b === '') return -1;

    let res = 0;
    const numA = typeof a === 'number' ? a : (typeof a === 'string' && a.trim() !== '' && !isNaN(Number(a)) ? Number(a) : NaN);
    const numB = typeof b === 'number' ? b : (typeof b === 'string' && b.trim() !== '' && !isNaN(Number(b)) ? Number(b) : NaN);

    if (!isNaN(numA) && !isNaN(numB)) {
        res = numA - numB;
    } else {
        res = String(a).localeCompare(String(b), 'pt-BR', { sensitivity: 'base', numeric: true });
    }
    return ordem === 'desc' ? -res : res;
}

function atualizarConteudoTabela() {
    const thead = document.getElementById('tabelaHead');
    const tbody = document.getElementById('tabelaBody');
    const paginacaoEl = document.getElementById('paginacaoControles');
    const infoEl = document.getElementById('tabelaInfoContador');

    const modo = appState.tabelaAtiva;
    const busca = appState.tabelaBusca;

    thead.innerHTML = '';
    tbody.innerHTML = '';

    if (modo === 'ufs') {
        paginacaoEl.style.display = 'none';
        let lista = [...appState.dados.estados];
        if (busca) {
            lista = lista.filter(e => e.uf.toLowerCase().includes(busca) || e.regiao.toLowerCase().includes(busca));
        }

        const ord = appState.ordenacaoPorTabela && appState.ordenacaoPorTabela.ufs;
        if (ord && ord.coluna) {
            lista.sort((a, b) => compararValores(a[ord.coluna], b[ord.coluna], ord.ordem));
        }

        infoEl.innerText = `Exibindo ${lista.length} de 27 Unidades Federativas`;

        thead.innerHTML = `
            <tr>
                ${renderTh('uf', 'UF')}
                ${renderTh('regiao', 'Região')}
                ${renderTh('trechos', 'Trechos (20 km)', 'text-align:right;')}
                ${renderTh('sinistros', 'Sinistros', 'text-align:right;')}
                ${renderTh('esparsidade', 'Esparsidade (%)', 'text-align:right;')}
                ${renderTh('mae', 'MAE', 'text-align:right;')}
                ${renderTh('rmse', 'RMSE', 'text-align:right;')}
                ${renderTh('ruido_branco_pct', 'Ruído Branco (%)', 'text-align:right;')}
                ${renderTh('chuva_sig_pct', 'Chuva Sig. (%)', 'text-align:right;')}
                ${renderTh('feriado_sig_pct', 'Feriados Sig. (%)', 'text-align:right;')}
            </tr>
        `;

        lista.forEach(e => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="table-badge badge-uf">${e.uf}</span></td>
                <td>${e.regiao}</td>
                <td style="text-align:right; font-weight:600;">${e.trechos}</td>
                <td style="text-align:right; font-weight:700; color:var(--accent-danger);">${e.sinistros.toLocaleString('pt-BR')}</td>
                <td style="text-align:right;">${e.esparsidade}%</td>
                <td style="text-align:right; font-family:monospace;">${e.mae}</td>
                <td style="text-align:right; font-family:monospace;">${e.rmse}</td>
                <td style="text-align:right; color:var(--accent-success); font-weight:600;">${e.ruido_branco_pct}%</td>
                <td style="text-align:right; color:var(--accent-rain); font-weight:600;">${e.chuva_sig_pct}%</td>
                <td style="text-align:right; color:var(--accent-holiday); font-weight:600;">${e.feriado_sig_pct}%</td>
            `;
            tbody.appendChild(tr);
        });

    } else if (modo === 'regioes') {
        paginacaoEl.style.display = 'none';
        let lista = [...appState.dados.macrorregioes];
        if (busca) {
            lista = lista.filter(r => r.regiao.toLowerCase().includes(busca));
        }

        const ord = appState.ordenacaoPorTabela && appState.ordenacaoPorTabela.regioes;
        if (ord && ord.coluna) {
            lista.sort((a, b) => compararValores(a[ord.coluna], b[ord.coluna], ord.ordem));
        }

        infoEl.innerText = `Exibindo ${lista.length} macrorregiões do Brasil`;

        thead.innerHTML = `
            <tr>
                ${renderTh('regiao', 'Macrorregião')}
                ${renderTh('ufs_count', 'UFs', 'text-align:right;')}
                ${renderTh('trechos', 'Trechos (20 km)', 'text-align:right;')}
                ${renderTh('sinistros', 'Sinistros', 'text-align:right;')}
                ${renderTh('esparsidade', 'Esparsidade Média', 'text-align:right;')}
                ${renderTh('mae', 'MAE', 'text-align:right;')}
                ${renderTh('rmse', 'RMSE', 'text-align:right;')}
                ${renderTh('ruido_branco_pct', 'Ruído Branco (%)', 'text-align:right;')}
                ${renderTh('chuva_sig_pct', 'Chuva Sig. (%)', 'text-align:right;')}
                ${renderTh('feriado_sig_pct', 'Feriados Sig. (%)', 'text-align:right;')}
            </tr>
        `;

        lista.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${r.regiao}</strong></td>
                <td style="text-align:right;">${r.ufs_count}</td>
                <td style="text-align:right; font-weight:600;">${r.trechos}</td>
                <td style="text-align:right; font-weight:700; color:var(--accent-danger);">${r.sinistros.toLocaleString('pt-BR')}</td>
                <td style="text-align:right;">${r.esparsidade}%</td>
                <td style="text-align:right; font-family:monospace;">${r.mae}</td>
                <td style="text-align:right; font-family:monospace;">${r.rmse}</td>
                <td style="text-align:right; color:var(--accent-success); font-weight:600;">${r.ruido_branco_pct}%</td>
                <td style="text-align:right; color:var(--accent-rain); font-weight:600;">${r.chuva_sig_pct}%</td>
                <td style="text-align:right; color:var(--accent-holiday); font-weight:600;">${r.feriado_sig_pct}%</td>
            `;
            tbody.appendChild(tr);
        });

    } else if (modo === 'top50') {
        paginacaoEl.style.display = 'none';
        let lista = [...appState.dados.top50];
        if (busca) {
            lista = lista.filter(t => t.rodovia.toLowerCase().includes(busca) || t.uf.toLowerCase().includes(busca) || t.segmento.toLowerCase().includes(busca));
        }

        const ord = appState.ordenacaoPorTabela && appState.ordenacaoPorTabela.top50;
        if (ord && ord.coluna) {
            lista.sort((a, b) => {
                let valA, valB;
                if (ord.coluna === 'rodovia') {
                    valA = `${a.rodovia} ${a.uf}`;
                    valB = `${b.rodovia} ${b.uf}`;
                } else if (ord.coluna === 'segmento') {
                    valA = parseInt(a.segmento.replace(/\D+/g, '')) || 0;
                    valB = parseInt(b.segmento.replace(/\D+/g, '')) || 0;
                } else {
                    valA = a[ord.coluna];
                    valB = b[ord.coluna];
                }
                return compararValores(valA, valB, ord.ordem);
            });
        }

        infoEl.innerText = `Exibindo Top ${lista.length} trechos mais críticos da malha federal brasileira`;

        thead.innerHTML = `
            <tr>
                ${renderTh('posicao', '#')}
                ${renderTh('rodovia', 'Rodovia / UF')}
                ${renderTh('segmento', 'Trecho (km)')}
                ${renderTh('sinistros', 'Sinistros', 'text-align:right;')}
                ${renderTh('esparsidade', 'Esparsidade', 'text-align:right;')}
                ${renderTh('order', 'Modelo')}
                ${renderTh('mae', 'MAE', 'text-align:right;')}
                ${renderTh('rmse', 'RMSE', 'text-align:right;')}
                ${renderTh('beta_chuva', '&beta; Chuva', 'text-align:right;')}
                ${renderTh('beta_feriado', '&beta; Feriados', 'text-align:right;')}
                ${renderTh('ljung_box_p', 'Ljung-Box', 'text-align:right;')}
                <th>Ação</th>
            </tr>
        `;

        lista.forEach(t => {
            const tr = document.createElement('tr');
            const isBr0 = t.is_br0 || t.rodovia === 'BR-0' || t.rodovia === 'BR-00' || t.rodovia === 'BR-000';
            const msgBr0 = 'Todas as BR-0 são rodovias criadas pela própria PRF quando não se tem um dado concreto, por isso não se pode fazer uma previsão usando estes dados';

            const btnAcao = isBr0 ? `
                <span class="tooltip-container tooltip-btn-disabled">
                    <button class="btn-page" style="padding:0.18rem 0.45rem; font-size:0.72rem;" disabled>
                        Prever
                    </button>
                    <div class="tooltip-bubble">
                        ${msgBr0}
                    </div>
                </span>
            ` : `
                <button class="btn-page" style="padding:0.18rem 0.45rem; font-size:0.72rem;" onclick="carregarTop50NoSimulador('${t.rodovia}', '${t.uf}', '${t.segmento}')">
                    Prever
                </button>
            `;

            tr.innerHTML = `
                <td><strong>${t.posicao}</strong></td>
                <td><strong>${t.rodovia}</strong> / <span class="table-badge badge-uf">${t.uf}</span></td>
                <td>${t.segmento}</td>
                <td style="text-align:right; font-weight:700; color:var(--accent-danger);">${t.sinistros.toLocaleString('pt-BR')}</td>
                <td style="text-align:right;">${t.esparsidade}%</td>
                <td><code style="font-size:0.7rem; background:#f1f5f9; padding:1px 3px; border-radius:3px;">${t.order}</code></td>
                <td style="text-align:right; font-family:monospace;">${t.mae}</td>
                <td style="text-align:right; font-family:monospace;">${t.rmse}</td>
                <td style="text-align:right; font-family:monospace; font-size:0.75rem;">${t.beta_chuva} <span style="font-size:0.68rem; color:var(--text-muted);">(${formatarPValor(t.p_chuva, 3)})</span></td>
                <td style="text-align:right; font-family:monospace; font-size:0.75rem;">${t.beta_feriado} <span style="font-size:0.68rem; color:var(--text-muted);">(${formatarPValor(t.p_feriado, 3)})</span></td>
                <td style="text-align:right; font-family:monospace;">${formatarPValor(t.ljung_box_p, 4)}</td>
                <td>${btnAcao}</td>
            `;
            tbody.appendChild(tr);
        });

    } else if (modo === 'todos') {
        paginacaoEl.style.display = 'flex';
        let lista = [...appState.dados.trechos];
        if (busca) {
            lista = lista.filter(t => t.br.toLowerCase().includes(busca) || t.uf.toLowerCase().includes(busca) || (`km ${t.km_inicio}`).includes(busca));
        }

        const ord = appState.ordenacaoPorTabela && appState.ordenacaoPorTabela.todos;
        if (ord && ord.coluna) {
            lista.sort((a, b) => {
                let valA, valB;
                if (ord.coluna === 'rodovia') {
                    valA = `${a.br} ${a.uf}`;
                    valB = `${b.br} ${b.uf}`;
                } else if (ord.coluna === 'sinistros') {
                    valA = a.acidentes;
                    valB = b.acidentes;
                } else if (ord.coluna === 'km_inicio') {
                    valA = a.km_inicio;
                    valB = b.km_inicio;
                } else {
                    valA = a[ord.coluna];
                    valB = b[ord.coluna];
                }
                return compararValores(valA, valB, ord.ordem);
            });
        }

        const totalItens = lista.length;
        const totalPaginas = Math.ceil(totalItens / appState.tabelaItensPorPagina) || 1;
        if (appState.tabelaPaginaAtual > totalPaginas) appState.tabelaPaginaAtual = totalPaginas;

        const inicio = (appState.tabelaPaginaAtual - 1) * appState.tabelaItensPorPagina;
        const fim = Math.min(inicio + appState.tabelaItensPorPagina, totalItens);
        const paginaItens = lista.slice(inicio, fim);

        infoEl.innerText = `Exibindo ${inicio + 1}–${fim} de ${totalItens.toLocaleString('pt-BR')} trechos modelados`;
        document.getElementById('labelPaginaAtual').innerText = `Página ${appState.tabelaPaginaAtual} de ${totalPaginas}`;
        document.getElementById('btnPagePrev').disabled = (appState.tabelaPaginaAtual === 1);
        document.getElementById('btnPageNext').disabled = (appState.tabelaPaginaAtual === totalPaginas);

        thead.innerHTML = `
            <tr>
                ${renderTh('rodovia', 'Rodovia / UF')}
                ${renderTh('km_inicio', 'Trecho (km)')}
                ${renderTh('sinistros', 'Sinistros', 'text-align:right;')}
                ${renderTh('esparsidade', 'Esparsidade', 'text-align:right;')}
                ${renderTh('order', 'Modelo')}
                ${renderTh('mae', 'MAE', 'text-align:right;')}
                ${renderTh('rmse', 'RMSE', 'text-align:right;')}
                ${renderTh('beta_chuva', '&beta; Chuva', 'text-align:right;')}
                ${renderTh('beta_feriado', '&beta; Feriados', 'text-align:right;')}
                ${renderTh('ljung_box_p', 'Ljung-Box', 'text-align:right;')}
                <th>Ação</th>
            </tr>
        `;

        paginaItens.forEach(t => {
            const tr = document.createElement('tr');
            const isBr0 = t.is_br0 || t.br === 'BR-0' || t.br === 'BR-00' || t.br === 'BR-000' || (t.id && t.id.startsWith('BR0_'));
            const msgBr0 = 'Todas as BR-0 são rodovias criadas pela própria PRF quando não se tem um dado concreto, por isso não se pode fazer uma previsão usando estes dados';

            const btnAcao = isBr0 ? `
                <span class="tooltip-container tooltip-btn-disabled">
                    <button class="btn-page" style="padding:0.18rem 0.45rem; font-size:0.72rem;" disabled>
                        Prever
                    </button>
                    <div class="tooltip-bubble">
                        ${msgBr0}
                    </div>
                </span>
            ` : `
                <button class="btn-page" style="padding:0.18rem 0.45rem; font-size:0.72rem;" onclick="carregarTrechoNoSimulador('${t.id}')">
                    Prever
                </button>
            `;

            tr.innerHTML = `
                <td><strong>${t.br}</strong> / <span class="table-badge badge-uf">${t.uf}</span></td>
                <td>km ${t.km_inicio}–${t.km_fim}</td>
                <td style="text-align:right; font-weight:700; color:var(--accent-danger);">${t.acidentes.toLocaleString('pt-BR')}</td>
                <td style="text-align:right;">${t.esparsidade}%</td>
                <td><code style="font-size:0.7rem; background:#f1f5f9; padding:1px 3px; border-radius:3px;">${t.order}</code></td>
                <td style="text-align:right; font-family:monospace;">${t.mae}</td>
                <td style="text-align:right; font-family:monospace;">${t.rmse}</td>
                <td style="text-align:right; font-family:monospace; font-size:0.75rem;">${t.beta_chuva} <span style="font-size:0.68rem; color:var(--text-muted);">(${formatarPValor(t.p_chuva, 3)})</span></td>
                <td style="text-align:right; font-family:monospace; font-size:0.75rem;">${t.beta_feriado} <span style="font-size:0.68rem; color:var(--text-muted);">(${formatarPValor(t.p_feriado, 3)})</span></td>
                <td style="text-align:right; font-family:monospace;">${formatarPValor(t.ljung_box_p, 4)}</td>
                <td>${btnAcao}</td>
            `;
            tbody.appendChild(tr);
        });
    }
}

// ==========================================================================
// 6. MOTOR DE PREVISÃO SARIMAX (Inferência em Tempo Real)
// ==========================================================================

function inicializarFormularioPrevisao() {
    if (!appState.dados) return;

    const selectUf = document.getElementById('prevUf');
    const selectBr = document.getElementById('prevRodovia');
    const selectTrecho = document.getElementById('prevTrecho');

    // Popula as UFs
    selectUf.innerHTML = '';
    appState.dados.estados.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.uf;
        opt.textContent = `${e.uf} — ${e.regiao}`;
        selectUf.appendChild(opt);
    });

    // Eventos em cascata
    selectUf.onchange = () => atualizarRodoviasPrevisao();
    selectBr.onchange = () => atualizarTrechosPrevisao();
    selectTrecho.onchange = () => {
        const trechoId = selectTrecho.value;
        appState.trechoSelecionadoPrevisao = appState.dados.trechos.find(t => t.id === trechoId);
        exibirResumoTrechoSelecionado();
        executarPrevisaoSARIMAX();
    };

    document.getElementById('prevCenarioChuva').onchange = () => executarPrevisaoSARIMAX();
    document.getElementById('prevCenarioFeriado').onchange = () => executarPrevisaoSARIMAX();
    document.getElementById('btnExecutarPrevisao').onclick = () => executarPrevisaoSARIMAX();

    // Iniciar com Santa Catarina (BR-101 km 200, segmento mais perigoso do país)
    selectUf.value = 'SC';
    atualizarRodoviasPrevisao();
}

function atualizarRodoviasPrevisao() {
    const uf = document.getElementById('prevUf').value;
    const selectBr = document.getElementById('prevRodovia');
    selectBr.innerHTML = '';

    const rodovias = [...new Set(
        appState.dados.trechos
            .filter(t => t.uf === uf && !t.is_br0 && t.br !== 'BR-0' && t.br !== 'BR-00' && t.br !== 'BR-000')
            .map(t => t.br)
    )].sort();
    rodovias.forEach(br => {
        const opt = document.createElement('option');
        opt.value = br;
        opt.textContent = br;
        selectBr.appendChild(opt);
    });

    atualizarTrechosPrevisao();
}

function atualizarTrechosPrevisao() {
    const uf = document.getElementById('prevUf').value;
    const br = document.getElementById('prevRodovia').value;
    const selectTrecho = document.getElementById('prevTrecho');
    selectTrecho.innerHTML = '';

    const trechos = appState.dados.trechos
        .filter(t => t.uf === uf && t.br === br && !t.is_br0 && t.br !== 'BR-0' && t.br !== 'BR-00' && t.br !== 'BR-000')
        .sort((a, b) => b.acidentes - a.acidentes);
    trechos.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `km ${t.km_inicio}–${t.km_fim} (${t.acidentes.toLocaleString('pt-BR')} sinistros)`;
        selectTrecho.appendChild(opt);
    });

    if (trechos.length > 0) {
        appState.trechoSelecionadoPrevisao = trechos[0];
        exibirResumoTrechoSelecionado();
        executarPrevisaoSARIMAX();
    }
}

function exibirResumoTrechoSelecionado() {
    const t = appState.trechoSelecionadoPrevisao;
    const summaryEl = document.getElementById('prevTrechoSummary');
    if (!t || !summaryEl) return;

    const ruidoAprovado = t.ruido_branco;
    const chuvaSig = t.chuva_sig;
    const feriadoSig = t.feriado_sig;

    summaryEl.innerHTML = `
        <div class="model-summary-header">
            <div class="model-summary-title">
                <i data-lucide="cpu" class="model-summary-icon"></i>
                <span>Modelo Calibrado</span>
            </div>
            <span class="model-badge-order">SARIMAX ${t.order}×${t.seasonal}</span>
        </div>

        <div class="model-summary-meta">
            <span class="model-loc-tag">${t.br}/${t.uf}</span>
            <span class="model-km-tag">km ${t.km_inicio} a ${t.km_fim}</span>
            <span class="model-reg-tag">${t.regiao || ''}</span>
        </div>

        <div class="model-summary-grid">
            <div class="model-stat-item">
                <span class="model-stat-label">Sinistros (5 anos)</span>
                <span class="model-stat-val">${t.acidentes.toLocaleString('pt-BR')} <small>(${(t.acidentes / 5).toFixed(1)}/ano)</small></span>
            </div>

            <div class="model-stat-item">
                <span class="model-stat-label">Esparsidade</span>
                <span class="model-stat-val">${t.esparsidade}% <small>zeros</small></span>
            </div>

            <div class="model-stat-item">
                <span class="model-stat-label">Erro MAE</span>
                <span class="model-stat-val font-mono">${t.mae}</span>
            </div>

            <div class="model-stat-item">
                <span class="model-stat-label">Erro RMSE</span>
                <span class="model-stat-val font-mono">${t.rmse}</span>
            </div>

            <div class="model-stat-item">
                <span class="model-stat-label">Ruído Branco</span>
                <span class="model-stat-val">
                    <span class="model-sub-badge ${ruidoAprovado ? 'badge-ok' : 'badge-warn'}">
                        ${ruidoAprovado ? 'Aprovado ✓' : 'Não Aprovado'}
                    </span>
                </span>
            </div>

            <div class="model-stat-item">
                <span class="model-stat-label">Ljung-Box (p)</span>
                <span class="model-stat-val font-mono">${formatarPValor(t.ljung_box_p, 4)}</span>
            </div>

            <div class="model-stat-item">
                <span class="model-stat-label">&beta; Chuva</span>
                <span class="model-stat-val font-mono">
                    ${t.beta_chuva}
                    <span class="model-sub-badge ${chuvaSig ? 'badge-sig-rain' : 'badge-muted'}">
                        ${chuvaSig ? 'Sig. ✓' : 'Inexpr.'}
                    </span>
                </span>
            </div>

            <div class="model-stat-item">
                <span class="model-stat-label">&beta; Feriados</span>
                <span class="model-stat-val font-mono">
                    ${t.beta_feriado}
                    <span class="model-sub-badge ${feriadoSig ? 'badge-sig-holiday' : 'badge-muted'}">
                        ${feriadoSig ? 'Sig. ✓' : 'Inexpr.'}
                    </span>
                </span>
            </div>
        </div>
    `;

    document.getElementById('badgeModeloOrdem').innerText = `${t.order}×${t.seasonal}`;

    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons({ root: summaryEl });
    }
}

function inicializarGraficoPrevisao() {
    const ctx = document.getElementById('chartPrevisao').getContext('2d');
    appState.chartPrevisao = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Dia 1', 'Dia 2', 'Dia 3', 'Dia 4', 'Dia 5', 'Dia 6', 'Dia 7'],
            datasets: [
                {
                    label: 'Linha de Base (Sem Exógenas)',
                    data: [0, 0, 0, 0, 0, 0, 0],
                    borderColor: '#94a3b8',
                    borderDash: [5, 5],
                    tension: 0.3,
                    pointRadius: 3
                },
                {
                    label: 'Previsão Projetada SARIMAX',
                    data: [0, 0, 0, 0, 0, 0, 0],
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.12)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 5,
                    pointHoverRadius: 7
                },
                {
                    label: 'Limite Superior (IC 95%)',
                    data: [0, 0, 0, 0, 0, 0, 0],
                    borderColor: 'rgba(148, 163, 184, 0.4)',
                    borderDash: [2, 2],
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Acidentes Estimados por Dia' }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw.toFixed(2)} acidentes`
                    }
                }
            }
        }
    });

    executarPrevisaoSARIMAX();
}

function executarPrevisaoSARIMAX() {
    const t = appState.trechoSelecionadoPrevisao;
    if (!t) return;

    // Resgatar parâmetros do cenário
    const cenarioChuva = document.getElementById('prevCenarioChuva').value;
    const cenarioFeriado = document.getElementById('prevCenarioFeriado').value;

    // 1. Datas futuras dinâmicas (próximos 7 dias a partir de amanhã)
    const datas = [];
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const hoje = new Date();
    for (let i = 1; i <= 7; i++) {
        const d = new Date(hoje);
        d.setDate(hoje.getDate() + i);
        datas.push({
            data: d,
            dataStr: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
            diaSemana: diasSemana[d.getDay()],
            dayOfWeek: d.getDay() // 0 = Domingo, 1 = Segunda, 2 = Terça, 3 = Quarta, 4 = Quinta, 5 = Sexta, 6 = Sábado
        });
    }

    // 2. Mapeamento dinâmico de Chuva
    let chuvaMm = [0, 0, 0, 0, 0, 0, 0];
    if (cenarioChuva === 'leve') {
        chuvaMm = [5, 5, 5, 5, 5, 5, 5];
    } else if (cenarioChuva === 'moderada') {
        chuvaMm = [15, 15, 15, 15, 15, 15, 15];
    } else if (cenarioChuva === 'tempestade') {
        chuvaMm = [40, 40, 40, 40, 40, 40, 40];
    } else if (cenarioChuva === 'fim_de_semana') {
        // Chuva concentrada no sábado e domingo reais da janela de 7 dias
        chuvaMm = datas.map(d => (d.dayOfWeek === 6 || d.dayOfWeek === 0) ? 30 : 0);
    }

    // 3. Mapeamento dinâmico de Feriados
    let feriados = [0, 0, 0, 0, 0, 0, 0];
    let prolongados = [0, 0, 0, 0, 0, 0, 0];

    if (cenarioFeriado === 'prolongado' || cenarioFeriado === 'prolongado_sexta') {
        // Feriado Prolongado com feriado oficial na Sexta-feira
        datas.forEach((d, i) => {
            if (d.dayOfWeek === 5) {
                feriados[i] = 1; // Sexta-feira: dia de feriado nacional
                prolongados[i] = 1;
            } else if (d.dayOfWeek === 6 || d.dayOfWeek === 0) {
                prolongados[i] = 1; // Sábado e Domingo: dias de tráfego prolongado
            }
        });
    } else if (cenarioFeriado === 'prolongado_segunda') {
        // Feriado Prolongado com feriado oficial na Segunda-feira
        datas.forEach((d, i) => {
            if (d.dayOfWeek === 1) {
                feriados[i] = 1; // Segunda-feira: dia de feriado nacional
                prolongados[i] = 1;
            } else if (d.dayOfWeek === 6 || d.dayOfWeek === 0) {
                prolongados[i] = 1; // Sábado e Domingo: dias de tráfego prolongado
            }
        });
    } else if (cenarioFeriado === 'meio_semana') {
        // Feriado isolado no meio da semana (Quarta-feira)
        datas.forEach((d, i) => {
            if (d.dayOfWeek === 3) {
                feriados[i] = 1; // Quarta-feira: feriado nacional
                prolongados[i] = 0;
            }
        });
    }

    // Baseline dos 7 dias do modelo real
    const baseline = t.baseline || [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const prevProjetada = [];
    const icInferior = [];
    const icSuperior = [];

    // Margem de incerteza baseada no RMSE do modelo do trecho
    const margemErro = 1.96 * (t.rmse || 0.35);

    let totalBase = 0;
    let totalProjetado = 0;

    for (let i = 0; i < 7; i++) {
        const b = baseline[i] || 0.0;
        const impactoChuva = t.beta_chuva * chuvaMm[i];
        const impactoFeriado = t.beta_feriado * feriados[i];
        const impactoProlongado = (t.beta_prolongado || 0.0) * prolongados[i];

        const pred = Math.max(0.0, b + impactoChuva + impactoFeriado + impactoProlongado);
        const limInf = Math.max(0.0, pred - margemErro);
        const limSup = pred + margemErro;

        prevProjetada.push(Number(pred.toFixed(2)));
        icInferior.push(Number(limInf.toFixed(2)));
        icSuperior.push(Number(limSup.toFixed(2)));

        totalBase += b;
        totalProjetado += pred;
    }

    // Atualizar Cards de Métricas
    document.getElementById('resTotalPrevisto').innerText = totalProjetado.toFixed(1);

    const diffPct = totalBase > 0 ? ((totalProjetado - totalBase) / totalBase) * 100 : 0;
    const impactoEl = document.getElementById('resImpactoExogeno');
    impactoEl.innerText = (diffPct >= 0 ? '+' : '') + diffPct.toFixed(1) + '%';
    impactoEl.style.color = diffPct > 5 ? 'var(--accent-danger)' : (diffPct < -5 ? 'var(--accent-success)' : 'var(--primary)');

    const totalInf = Math.max(0, totalProjetado - (margemErro * Math.sqrt(7)));
    const totalSup = totalProjetado + (margemErro * Math.sqrt(7));
    document.getElementById('resIntervaloConfianca').innerText = `[${totalInf.toFixed(1)} — ${totalSup.toFixed(1)}]`;

    // Atualizar Gráfico Chart.js
    if (appState.chartPrevisao) {
        appState.chartPrevisao.data.labels = datas.map(d => `${d.diaSemana} (${d.dataStr})`);
        appState.chartPrevisao.data.datasets[0].data = baseline.map(v => Number(v.toFixed(2)));
        appState.chartPrevisao.data.datasets[1].data = prevProjetada;
        appState.chartPrevisao.data.datasets[2].data = icSuperior;
        appState.chartPrevisao.update();
    }

    // Atualizar Tabela Detalhada Dia a Dia
    const corpoTabela = document.getElementById('corpoTabelaPrevisao');
    if (corpoTabela) {
        corpoTabela.innerHTML = '';
        datas.forEach((d, i) => {
            const tr = document.createElement('tr');
            const pred = prevProjetada[i];
            const base = baseline[i] || 0.0;
            const diffDia = base > 0 ? ((pred - base) / base) * 100 : 0;

            let tagFeriado = 'Não';
            if (feriados[i]) {
                tagFeriado = '<span class="table-badge badge-holiday">Sim</span>';
            } else if (prolongados[i]) {
                tagFeriado = '<span class="table-badge badge-holiday" style="background:#ffedd5; color:#c2410c; border:1px solid #fed7aa;">Prolongado</span>';
            }

            tr.innerHTML = `
                <td><strong>${d.diaSemana}</strong> <span style="color:#64748b; font-size:0.75rem;">(${d.dataStr})</span></td>
                <td><strong style="color:var(--primary); font-size:1rem;">${pred.toFixed(2)}</strong> <span style="font-size:0.75rem; color:#64748b;">[${icInferior[i].toFixed(1)}–${icSuperior[i].toFixed(1)}]</span></td>
                <td>${chuvaMm[i] > 0 ? `<span class="table-badge badge-rain">${chuvaMm[i]} mm</span>` : '0 mm'}</td>
                <td>${tagFeriado}</td>
                <td><span style="font-weight:600; color:${diffDia > 5 ? 'var(--accent-danger)' : (diffDia < -5 ? 'var(--accent-success)' : 'inherit')};">${diffDia >= 0 ? '+' : ''}${diffDia.toFixed(0)}%</span></td>
            `;
            corpoTabela.appendChild(tr);
        });
    }
}

// Helpers para navegação a partir do mapa ou tabela
window.carregarTrechoNoSimulador = function(trechoId) {
    if (!appState.dados) return;
    const trecho = appState.dados.trechos.find(t => t.id === trechoId);
    if (!trecho) return;

    if (trecho.is_br0 || trecho.br === 'BR-0' || trecho.br === 'BR-00' || trecho.br === 'BR-000') {
        alert("Todas as BR-0 são rodovias criadas pela própria PRF quando não se tem um dado concreto, por isso não se pode fazer uma previsão usando estes dados");
        return;
    }

    trocarAba('previsao');

    const selectUf = document.getElementById('prevUf');
    const selectBr = document.getElementById('prevRodovia');
    const selectTrecho = document.getElementById('prevTrecho');

    selectUf.value = trecho.uf;
    atualizarRodoviasPrevisao();
    selectBr.value = trecho.br;
    atualizarTrechosPrevisao();
    selectTrecho.value = trecho.id;

    appState.trechoSelecionadoPrevisao = trecho;
    exibirResumoTrechoSelecionado();
    executarPrevisaoSARIMAX();
};

window.carregarTop50NoSimulador = function(br, uf, segmento) {
    if (!appState.dados) return;
    if (br === 'BR-0' || br === 'BR-00' || br === 'BR-000') {
        alert("Todas as BR-0 são rodovias criadas pela própria PRF quando não se tem um dado concreto, por isso não se pode fazer uma previsão usando estes dados");
        return;
    }
    const kmIni = parseInt(segmento.split('–')[0].replace('km ', ''));
    const trecho = appState.dados.trechos.find(t => t.br === br && t.uf === uf && t.km_inicio === kmIni);
    if (trecho) {
        carregarTrechoNoSimulador(trecho.id);
    } else {
        trocarAba('previsao');
    }
};

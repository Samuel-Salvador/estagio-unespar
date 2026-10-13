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
    camadaVetorial: null,
    camadaAtiva: 'todos', // 'todos' | 'chuva' | 'feriado' | 'top50'
    ufSelecionada: 'TODAS',
    tabelaAtiva: 'ufs',   // 'ufs' | 'regioes' | 'top50' | 'todos'
    tabelaBusca: '',
    tabelaOrdenacao: { coluna: 'sinistros', ordem: 'desc' },
    tabelaPaginaAtual: 1,
    tabelaItensPorPagina: 50,
    chartChuva: null,
    chartFeriado: null,
    chartPrevisao: null,
    trechoSelecionadoPrevisao: null
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
    const meta = appState.dados.metadata;
    if (!meta) return;

    document.getElementById('kpiTrechos').innerText = meta.total_trechos.toLocaleString('pt-BR');
    document.getElementById('kpiSinistros').innerText = meta.total_sinistros.toLocaleString('pt-BR');
    document.getElementById('kpiEsparsidade').innerText = meta.esparsidade_global + '%';
    document.getElementById('kpiRuido').innerText = meta.ruido_branco_global + '%';
    document.getElementById('kpiChuva').innerText = meta.chuva_sig_global + '%';
    document.getElementById('kpiFeriado').innerText = meta.feriado_sig_global + '%';
}

// ==========================================================================
// 3. MAPA INTERATIVO (Leaflet.js)
// ==========================================================================

function inicializarMapa() {
    const mapEl = document.getElementById('mapaRodovias');
    if (!mapEl) return;

    // Centro geográfico do Brasil
    appState.mapa = L.map('mapaRodovias', {
        center: [-14.235, -51.925],
        zoom: 4,
        minZoom: 3,
        maxZoom: 14
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

    // Controle para alternar entre OpenStreetMap e Mapa Cinza Sóbrio
    L.control.layers({
        'OpenStreetMap (Padrão)': osmLayer,
        'Mapa Sóbrio (Cinza)': esriGray
    }, null, { position: 'topright' }).addTo(appState.mapa);

    appState.camadaVetorial = L.layerGroup().addTo(appState.mapa);

    // Eventos dos botões de camada rápida
    document.querySelectorAll('.btn-pill[data-layer]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-pill[data-layer]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.camadaAtiva = btn.getAttribute('data-layer');
            atualizarCamadaMapa();
        });
    });

    // Evento do filtro de UF
    const selectUf = document.getElementById('filtroUfMapa');
    selectUf.addEventListener('change', (e) => {
        appState.ufSelecionada = e.target.value;
        atualizarCamadaMapa();
        ajustarZoomMapaPorUf(appState.ufSelecionada);
        atualizarGraficosObservatorio();
    });

    atualizarCamadaMapa();
}

function configurarFiltrosObservatorio() {
    const selectUf = document.getElementById('filtroUfMapa');
    selectUf.innerHTML = '<option value="TODAS">Brasil Geral (Todas as 27 UFs)</option>';

    appState.dados.estados.forEach(est => {
        const opt = document.createElement('option');
        opt.value = est.uf;
        opt.textContent = `${est.uf} — ${est.regiao} (${est.trechos} trechos | ${est.sinistros.toLocaleString('pt-BR')} acidentes)`;
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

    if (layerModo === 'chuva') {
        trechos = trechos.filter(t => t.chuva_sig);
    } else if (layerModo === 'feriado') {
        trechos = trechos.filter(t => t.feriado_sig);
    } else if (layerModo === 'top50') {
        const top50Ids = new Set(appState.dados.top50.map(t => `${t.rodovia.replace('BR-','')}_${t.uf}_${parseInt(t.segmento.split('–')[0].replace('km ',''))}`));
        trechos = trechos.filter(t => top50Ids.has(`${t.br.replace('BR-','')}_${t.uf}_${t.km_inicio}`));
    }

    document.getElementById('statusMapaTrechos').innerText = 
        `Exibindo ${trechos.length.toLocaleString('pt-BR')} trechos ${ufFiltro !== 'TODAS' ? 'em ' + ufFiltro : 'no Brasil'}`;

    trechos.forEach(t => {
        const c = t.coords;
        if (!c || isNaN(c.lat) || isNaN(c.lon)) return;

        // Determinar cor e espessura do vetor
        let cor = '#94a3b8'; // Default neutro
        let peso = Math.min(7, Math.max(2.5, Math.log10(Math.max(5, t.acidentes)) * 2));
        let opacidade = 0.75;

        if (layerModo === 'chuva' || t.chuva_sig) {
            cor = '#0284c7';
            opacidade = 0.9;
        }
        if (layerModo === 'feriado' || t.feriado_sig) {
            cor = '#ea580c';
            opacidade = 0.9;
        }
        if (t.acidentes >= 860 || layerModo === 'top50') {
            cor = '#dc2626';
            peso = Math.max(peso, 5);
            opacidade = 0.95;
        }

        const temPontosExtremos = (c.lat_ini !== c.lat_fim || c.lon_ini !== c.lon_fim) && !isNaN(c.lat_ini);
        let elementoGrafico;

        if (temPontosExtremos) {
            elementoGrafico = L.polyline([[c.lat_ini, c.lon_ini], [c.lat_fim, c.lon_fim]], {
                color: cor,
                weight: peso,
                opacity: opacidade
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
                    <p><span>MAE Médio (2024):</span> <strong>${t.mae}</strong></p>
                    <p><span>Ruído Branco:</span> <strong>${t.ruido_branco ? 'Sim (p > 0.05)' : 'Não'}</strong></p>
                    <p><span>&beta; Chuva:</span> <strong>${t.beta_chuva} (${t.chuva_sig ? 'Sig. p < 0.05' : 'Não sig.'})</strong></p>
                    <p><span>&beta; Feriados:</span> <strong>${t.beta_feriado} (${t.feriado_sig ? 'Sig. p < 0.05' : 'Não sig.'})</strong></p>
                </div>
                <button class="btn-popup-action" onclick="carregarTrechoNoSimulador('${t.id}')">
                    Simular Previsão Neste Trecho ➔
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

function ajustarZoomMapaPorUf(uf) {
    if (!appState.mapa) return;

    if (uf === 'TODAS' || !UFS_BOUNDS[uf]) {
        appState.mapa.setView([-14.235, -51.925], 4);
    } else {
        const bounds = UFS_BOUNDS[uf];
        appState.mapa.fitBounds(bounds, { padding: [20, 20], maxZoom: 8 });
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
        let lista = appState.dados.estados;
        if (busca) {
            lista = lista.filter(e => e.uf.toLowerCase().includes(busca) || e.regiao.toLowerCase().includes(busca));
        }

        infoEl.innerText = `Exibindo ${lista.length} de 27 Unidades Federativas`;

        thead.innerHTML = `
            <tr>
                <th>UF</th>
                <th>Região</th>
                <th style="text-align:right;">Trechos (20 km)</th>
                <th style="text-align:right;">Sinistros (5 Anos)</th>
                <th style="text-align:right;">Esparsidade (%)</th>
                <th style="text-align:right;">MAE (2024)</th>
                <th style="text-align:right;">RMSE (2024)</th>
                <th style="text-align:right;">Ruído Branco (%)</th>
                <th style="text-align:right;">Chuva Sig. (%)</th>
                <th style="text-align:right;">Feriados Sig. (%)</th>
            </tr>
        `;

        lista.forEach(e => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="table-badge badge-uf">${e.uf}</span></td>
                <td>${e.regiao}</td>
                <td style="text-align:right; font-weight:600;">${e.trechos}</td>
                <td style="text-align:right; font-weight:700; color:var(--text-heading);">${e.sinistros.toLocaleString('pt-BR')}</td>
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
        let lista = appState.dados.macrorregioes;
        if (busca) {
            lista = lista.filter(r => r.regiao.toLowerCase().includes(busca));
        }

        infoEl.innerText = `Exibindo ${lista.length} macrorregiões do Brasil`;

        thead.innerHTML = `
            <tr>
                <th>Macrorregião</th>
                <th style="text-align:right;">UFs</th>
                <th style="text-align:right;">Trechos (20 km)</th>
                <th style="text-align:right;">Sinistros Totais</th>
                <th style="text-align:right;">Esparsidade Média</th>
                <th style="text-align:right;">MAE (2024)</th>
                <th style="text-align:right;">RMSE (2024)</th>
                <th style="text-align:right;">Ruído Branco (%)</th>
                <th style="text-align:right;">Chuva Sig. (%)</th>
            </tr>
        `;

        lista.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${r.regiao}</strong></td>
                <td style="text-align:right;">${r.ufs_count}</td>
                <td style="text-align:right; font-weight:600;">${r.trechos}</td>
                <td style="text-align:right; font-weight:700;">${r.sinistros.toLocaleString('pt-BR')}</td>
                <td style="text-align:right;">${r.esparsidade}%</td>
                <td style="text-align:right; font-family:monospace;">${r.mae}</td>
                <td style="text-align:right; font-family:monospace;">${r.rmse}</td>
                <td style="text-align:right; color:var(--accent-success); font-weight:600;">${r.ruido_branco_pct}%</td>
                <td style="text-align:right; color:var(--accent-rain); font-weight:600;">${r.chuva_sig_pct}%</td>
            `;
            tbody.appendChild(tr);
        });

    } else if (modo === 'top50') {
        paginacaoEl.style.display = 'none';
        let lista = appState.dados.top50;
        if (busca) {
            lista = lista.filter(t => t.rodovia.toLowerCase().includes(busca) || t.uf.toLowerCase().includes(busca) || t.segmento.toLowerCase().includes(busca));
        }

        infoEl.innerText = `Exibindo Top ${lista.length} segmentos mais críticos da malha federal brasileira`;

        thead.innerHTML = `
            <tr>
                <th>#</th>
                <th>Rodovia / UF</th>
                <th>Segmento</th>
                <th style="text-align:right;">Sinistros (5 Anos)</th>
                <th style="text-align:right;">Esparsidade</th>
                <th>SARIMAX</th>
                <th style="text-align:right;">MAE</th>
                <th style="text-align:right;">&beta; Chuva (p-val)</th>
                <th style="text-align:right;">Ljung-Box (p-val)</th>
                <th>Ação</th>
            </tr>
        `;

        lista.forEach(t => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${t.posicao}</strong></td>
                <td><strong>${t.rodovia}</strong> / <span class="table-badge badge-uf">${t.uf}</span></td>
                <td>${t.segmento}</td>
                <td style="text-align:right; font-weight:700; color:var(--accent-danger);">${t.sinistros.toLocaleString('pt-BR')}</td>
                <td style="text-align:right;">${t.esparsidade}%</td>
                <td><code style="font-size:0.75rem; background:#f1f5f9; padding:2px 4px; border-radius:4px;">${t.order}</code></td>
                <td style="text-align:right; font-family:monospace;">${t.mae}</td>
                <td style="text-align:right; font-family:monospace;">${t.beta_chuva} (${t.p_chuva < 0.001 ? t.p_chuva.toExponential(2) : t.p_chuva.toFixed(3)})</td>
                <td style="text-align:right; font-family:monospace;">${t.ljung_box_p}</td>
                <td>
                    <button class="btn-page" style="padding:0.2rem 0.5rem; font-size:0.75rem;" onclick="carregarTop50NoSimulador('${t.rodovia}', '${t.uf}', '${t.segmento}')">
                        Prever
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

    } else if (modo === 'todos') {
        paginacaoEl.style.display = 'flex';
        let lista = appState.dados.trechos;
        if (busca) {
            lista = lista.filter(t => t.br.toLowerCase().includes(busca) || t.uf.toLowerCase().includes(busca) || (`km ${t.km_inicio}`).includes(busca));
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
                <th>Rodovia</th>
                <th>UF</th>
                <th>Trecho (km)</th>
                <th style="text-align:right;">Sinistros</th>
                <th style="text-align:right;">Esparsidade</th>
                <th>Modelo</th>
                <th style="text-align:right;">MAE</th>
                <th style="text-align:right;">RMSE</th>
                <th>Chuva Sig.?</th>
                <th>Feriados Sig.?</th>
                <th>Ação</th>
            </tr>
        `;

        paginaItens.forEach(t => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${t.br}</strong></td>
                <td><span class="table-badge badge-uf">${t.uf}</span></td>
                <td>km ${t.km_inicio}–${t.km_fim}</td>
                <td style="text-align:right; font-weight:700;">${t.acidentes.toLocaleString('pt-BR')}</td>
                <td style="text-align:right;">${t.esparsidade}%</td>
                <td><code style="font-size:0.75rem;">${t.order}</code></td>
                <td style="text-align:right; font-family:monospace;">${t.mae}</td>
                <td style="text-align:right; font-family:monospace;">${t.rmse}</td>
                <td><span class="table-badge ${t.chuva_sig ? 'badge-rain' : ''}">${t.chuva_sig ? 'Sim' : 'Não'}</span></td>
                <td><span class="table-badge ${t.feriado_sig ? 'badge-holiday' : ''}">${t.feriado_sig ? 'Sim' : 'Não'}</span></td>
                <td>
                    <button class="btn-page" style="padding:0.2rem 0.5rem; font-size:0.75rem;" onclick="carregarTrechoNoSimulador('${t.id}')">
                        Prever
                    </button>
                </td>
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

    const rodovias = [...new Set(appState.dados.trechos.filter(t => t.uf === uf).map(t => t.br))].sort();
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

    const trechos = appState.dados.trechos.filter(t => t.uf === uf && t.br === br).sort((a, b) => b.acidentes - a.acidentes);
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

    summaryEl.innerHTML = `
        <div style="font-size:0.95rem; font-weight:700; color:var(--text-heading); margin-bottom:0.35rem;">
            ${t.br}/${t.uf} — km ${t.km_inicio} a ${t.km_fim}
        </div>
        <div><strong>Histórico (5 anos):</strong> ${t.acidentes.toLocaleString('pt-BR')} sinistros (${(t.acidentes/5).toFixed(1)}/ano)</div>
        <div><strong>Esparsidade:</strong> ${t.esparsidade}% dias nulos | <strong>Ruído Branco:</strong> ${t.ruido_branco ? 'Sim (Aprovado)' : 'Não'}</div>
        <div><strong>SARIMAX:</strong> ${t.order}×${t.seasonal}</div>
        <div><strong>&beta; Chuva:</strong> ${t.beta_chuva} (${t.chuva_sig ? '<span style="color:var(--accent-rain); font-weight:600;">Significativo</span>' : 'Inexpressivo'})</div>
        <div><strong>&beta; Feriados:</strong> ${t.beta_feriado} (${t.feriado_sig ? '<span style="color:var(--accent-holiday); font-weight:600;">Significativo</span>' : 'Inexpressivo'})</div>
    `;

    document.getElementById('badgeModeloOrdem').innerText = `${t.order}×${t.seasonal}`;
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

    let chuvaMm = [0, 0, 0, 0, 0, 0, 0];
    if (cenarioChuva === 'leve') chuvaMm = [5, 5, 5, 5, 5, 5, 5];
    else if (cenarioChuva === 'moderada') chuvaMm = [15, 15, 15, 15, 15, 15, 15];
    else if (cenarioChuva === 'tempestade') chuvaMm = [40, 40, 40, 40, 40, 40, 40];
    else if (cenarioChuva === 'fim_de_semana') chuvaMm = [0, 0, 0, 0, 0, 30, 30];

    let feriados = [0, 0, 0, 0, 0, 0, 0];
    let prolongados = [0, 0, 0, 0, 0, 0, 0];
    if (cenarioFeriado === 'prolongado') {
        feriados[2] = 1; // Sexta-feira
        prolongados[2] = 1;
    } else if (cenarioFeriado === 'meio_semana') {
        feriados[2] = 1; // Quarta-feira
    }

    // Datas futuras (próximos 7 dias)
    const datas = [];
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const hoje = new Date();
    for (let i = 1; i <= 7; i++) {
        const d = new Date(hoje);
        d.setDate(hoje.getDate() + i);
        datas.push({
            dataStr: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
            diaSemana: diasSemana[d.getDay()]
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

            tr.innerHTML = `
                <td><strong>${d.diaSemana}</strong> <span style="color:#64748b; font-size:0.75rem;">(${d.dataStr})</span></td>
                <td><strong style="color:var(--primary); font-size:1rem;">${pred.toFixed(2)}</strong> <span style="font-size:0.75rem; color:#64748b;">[${icInferior[i].toFixed(1)}–${icSuperior[i].toFixed(1)}]</span></td>
                <td>${chuvaMm[i] > 0 ? `<span class="table-badge badge-rain">${chuvaMm[i]} mm</span>` : '0 mm'}</td>
                <td>${feriados[i] ? '<span class="table-badge badge-holiday">Sim</span>' : 'Não'}</td>
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
    const kmIni = parseInt(segmento.split('–')[0].replace('km ', ''));
    const trecho = appState.dados.trechos.find(t => t.br === br && t.uf === uf && t.km_inicio === kmIni);
    if (trecho) {
        carregarTrechoNoSimulador(trecho.id);
    } else {
        trocarAba('previsao');
    }
};

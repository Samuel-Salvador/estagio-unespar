
        lucide.createIcons();

        // Navegação
        const navLinks = document.querySelectorAll('.nav-link');
        const sections = document.querySelectorAll('.page-section');

        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const target = link.getAttribute('data-target');
                
                sections.forEach(sec => sec.classList.remove('active'));
                navLinks.forEach(l => l.classList.remove('active'));

                document.getElementById(target).classList.add('active');
                link.classList.add('active');
            });
        });

        // Configuração do Gráfico Chart.js
        const ctx = document.getElementById('sarimaxChart').getContext('2d');
        let chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Dia 1', 'Dia 2', 'Dia 3', 'Dia 4', 'Dia 5', 'Dia 6', 'Dia 7'],
                datasets: [
                    {
                        label: 'Acidentes Registrados (Histórico)',
                        data: [],
                        borderColor: '#64748b',
                        borderDash: [5, 5],
                        tension: 0.3
                    },
                    {
                        label: 'Previsão SARIMAX (Com Exógenas)',
                        data: [],
                        borderColor: '#2563eb',
                        backgroundColor: 'rgba(37, 99, 235, 0.1)',
                        fill: true,
                        tension: 0.3
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, title: { display: true, text: 'Qtd. de Ocorrências' } }
                }
            }
        });

        function fetchMockData(rodovia, clima, feriado) {
            let baseRate = rodovia === 'br369' ? 12 : 25;
            let climaMult = clima === 'chuva' ? 1.7 : 1.0;
            let feriadoMult = feriado === '1' ? 1.5 : 1.0;

            const hist = Array.from({length: 7}, () => Math.floor(Math.random() * 5 + baseRate));
            const prev = Array.from({length: 7}, (_, i) => {
                let sazonalidade = (i === 5 || i === 6) ? 1.3 : 1.0;
                return Math.floor((baseRate * climaMult * feriadoMult * sazonalidade) + (Math.random() * 4));
            });

            return { historico: hist, previsao: prev };
        }

        function updateChart() {
            const r = document.getElementById('rodovia').value;
            const c = document.getElementById('clima').value;
            const f = document.getElementById('feriado').value;
            
            const data = fetchMockData(r, c, f);
            
            chartInstance.data.datasets[0].data = data.historico;
            chartInstance.data.datasets[1].data = data.previsao;
            chartInstance.update();
        }

        document.getElementById('btnPrever').addEventListener('click', updateChart);
        window.onload = updateChart;

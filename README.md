# Observatório de Tráfego Preditivo — Escala Meso Nacional (TCC UNESPAR)

Aplicação web desenvolvida no âmbito do Trabalho de Conclusão de Curso (TCC) de Ciência da Computação na **Universidade Estadual do Paraná (UNESPAR)** por **Samuel Salvador**.

Integra modelos estatísticos de previsão de séries temporais (**SARIMAX**) aos dados abertos de segurança pública da **Polícia Rodoviária Federal (PRF)** e de telemetria meteorológica do **INMET** em âmbito nacional (todas as 27 Unidades Federativas).

---

## 🚀 Funcionalidades da Aplicação

### 1. Fundamentação Teórica
* Contextualização científica do problema em **Cidades Inteligentes**.
* Detalhamento da base da PRF (332.679 acidentes no quinquênio 2020–2024).
* Formulação matemática rigorosa do algoritmo **SARIMAX** com componentes sazonais semanais ($s=7$) e variáveis exógenas (chuva e feriados).

### 2. Resultados & Mapa Interativo (Escala Meso)
* **Sumário Executivo Nacional**: KPIs com 3.019 trechos modelados, 94,8% de esparsidade, 92,0% de ruído branco (Ljung-Box), 42,7% de sensibilidade à chuva e 12,2% a feriados.
* **Mapa Rodoviário Interativo (Leaflet.js)**: Traçados vetoriais de todas as rodovias federais, com filtros para trechos afetados por chuva (azul), afetados por feriados (laranja) e top 50 segmentos mais perigosos (vermelho). Zoom inteligente por UF e popups detalhados.
* **Gráficos Dinâmicos (Chart.js)**: Comparativo das 27 UFs vs. Média Nacional e detalhamento ao selecionar um estado específico.
* **Tabela de Dados Completa com Abas**: Navegação entre **27 Estados**, **5 Macrorregiões**, **Top 50 Segmentos Críticos** e **Todos os 3.019 Trechos**, com busca em tempo real e ordenação.

### 3. Simulador de Previsão SARIMAX (Inferência Futura Real)
* Permite selecionar qualquer trecho rodoviário das 27 UFs e simular a incidência de acidentes para os próximos 7 dias sob diferentes condições pluviométricas e de feriados.
* Exibe intervalo de confiança de 95%, percentual de risco exógeno adicional e tabela diária detalhada.

---

## 🌐 Deploy na Vercel

A aplicação foi otimizada para execução **100% estática e client-side**, sem necessidade de servidores backend dedicados:
1. Conecte este repositório diretamente no painel da [Vercel](https://vercel.com).
2. Como se trata de uma aplicação estática (HTML/CSS/JS), o deploy é imediato e automático.

---

## 💻 Execução Local

Você pode abrir diretamente o arquivo `index.html` em qualquer navegador moderno, ou iniciar um servidor local:

```bash
# Via Python
python -m http.server 8000

# Acesse no navegador:
# http://localhost:8000
```
/**
 * public/javascripts/grafico.js
 * Chart rendering for tabulation statistics (pie chart using Chart.js).
 * Responsibilities:
 * - Query backend endpoints to fetch tabulation counts per status.
 * - Build a visual pie chart with gradient fills and a side legend.
 * - Auto-refresh data periodically.
 *
 * This file is UI-only: it fetches JSON data and draws using Chart.js. Keep
 * business logic and filtering on the server where possible.
 */
(function () {
  const STATUS_MAP = [
    { key: 'aniversariantes', label: 'Aniversariantes' },
    { key: 'sem-possibilidade', label: 'Sem possibilidade de saque' },
    { key: 'conversa-inativa', label: 'Conversa inativa / sem resposta' },
    { key: 'mudancas-cadastrais', label: 'Mudanças cadastrais' },
    { key: 'negocio-fechado', label: 'Negócio fechado' },
    { key: 'sem-interesse', label: 'Sem interesse na oferta' }
  ];


  // Gradient definitions for chart slices (used to create Canvas gradients)
  // Paired as [startColor, endColor] for each STATUS_MAP entry.
  const COLOR_GRADIENTS = [
    ['#007bff', '#0056b3'], // aniversariantes (azul)
    ['#dc3545', '#a71e2a'], // sem-possibilidade (vermelho)
    ['#ffc107', '#d39e00'], // conversa-inativa (amarelo)
    ['#fd7e14', '#e55a00'], // mudanças cadastrais (laranja)
    ['#28a745', '#1e7e34'], // negócio fechado (verde)
    ['#6c757d', '#495057']  // sem interesse (cinza)
  ];

  // Solid color palette for legend items and fallbacks.
  const SOLID_COLORS = [
    '#007bff',
    '#dc3545',
    '#ffc107',
    '#fd7e14',
    '#28a745',
    '#6c757d'
  ];

  let chartInstance = null;

  // buildLegend(container, counts)
  // - Renders a compact legend with percentage and absolute counts
  // - container: DOM element where legend items will be appended
  // - counts: array of integers aligned with STATUS_MAP
  function buildLegend(container, counts) {
    const total = counts.reduce((a,b)=>a+b,0);
    container.innerHTML = '';
    STATUS_MAP.forEach((s, idx) => {
      const count = counts[idx] || 0;
      const pct = total ? Math.round((count/total)*100) : 0;
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `
        <div class="legend-left">
          <div class="legend-color" style="background:${SOLID_COLORS[idx]};"></div>
          <div class="legend-label">${s.label}</div>
        </div>
        <div class="legend-value">${pct}% (${count})</div>
      `;
      container.appendChild(item);
    });
  }

  // fetchTabulacoesCounts()
  // - Fetches tabulation data from the backend and returns an array of counts
  //   aligned with STATUS_MAP. Handles different URL contexts (admin, team,
  //   impersonation, user) and falls back to the generic endpoint.
  async function fetchTabulacoesCounts() {
    try {
      // Determina a URL de dados conforme contexto (admin/team/user)
      let url = '/whatsapp/tabulacoes'; // fallback (compatibilidade)
      try {
        const uTipo = window.__usuarioTipo || null;
        const uId = window.__usuarioId || null;
        const imp = window.__impersonating || null;
        const path = window.location.pathname || '';

        // Se estiver em /users/grafico:
        // - admin deve ver a opção "Equipe" (scope=team)
        // - usuário comum deve ver seus próprios dados (userId=__usuarioId)
        if (path === '/users/grafico') {
          if (uTipo === 'admin') {
            url = '/users/grafico-data?scope=team';
          } else if (imp && imp.id) {
            url = `/users/grafico-data?userId=${imp.id}`;
          } else if (uId) {
            url = `/users/grafico-data?userId=${uId}`;
          } else {
            url = '/whatsapp/tabulacoes';
          }
        } else {
          // caminho pode ser /users/grafico/:id ou página padrão do usuário
          const m = path.match(/^\/users\/grafico\/(\d+)$/);
          if (m) {
            url = `/users/grafico-data?userId=${m[1]}`;
          } else if (imp && imp.id) {
            // quando admin está impersonando
            url = `/users/grafico-data?userId=${imp.id}`;
          } else if (uTipo === 'admin' && uId) {
            // admin na sua página pessoal: pode pedir dados do próprio usuário
            url = `/users/grafico-data?userId=${uId}`;
          } else if (uId) {
            // usuário comum
            url = `/users/grafico-data?userId=${uId}`;
          }
        }
      } catch (e) {
        console.warn('Erro ao determinar URL de dados do gráfico, usando fallback:', e);
        url = '/whatsapp/tabulacoes';
      }

      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('Erro na requisição: ' + res.status);
      const data = await res.json();
      const tab = data.tabulacoes || {};
      const counts = STATUS_MAP.map(s => Array.isArray(tab[s.key]) ? tab[s.key].length : 0);
      return counts;
    } catch (e) {
      console.error('Falha ao obter tabulações para gráfico:', e);
      return null;
    }
  }

  // renderGrafico()
  // - Orchestrates fetching counts, building legend, creating Chart.js dataset
  //   and rendering the pie chart. Handles empty/error states and refresh.
  async function renderGrafico() {
    const counts = await fetchTabulacoesCounts();
    const emptyDiv = document.getElementById('graficoEmpty');
    const legendContainer = document.getElementById('graficoLegend');
    const ctx = document.getElementById('graficoPizza').getContext('2d');

    if (!counts) {
      if (emptyDiv) { emptyDiv.style.display = 'block'; emptyDiv.textContent = 'Erro ao carregar dados do gráfico.'; }
      if (legendContainer) legendContainer.innerHTML = '';
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      return;
    }

    const total = counts.reduce((a,b)=>a+b,0);
    if (total === 0) {
      if (emptyDiv) { emptyDiv.style.display = 'block'; emptyDiv.textContent = 'Nenhum dado de tabulação disponível.'; }
      if (legendContainer) legendContainer.innerHTML = '';
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      return;
    } else {
      if (emptyDiv) emptyDiv.style.display = 'none';
    }

    buildLegend(legendContainer, counts);

    // antes de criar o dataset, gera gradientes a partir do contexto do canvas
    const bgColors = COLOR_GRADIENTS.map(([c1, c2]) => {
      // altura arbitrária para o gradiente—Chart.js irá desenhar corretamente
      const grad = ctx.createLinearGradient(0, 0, 0, 400);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      return grad;
    });

    const labels = STATUS_MAP.map(s => s.label);
    const data = {
      labels,
      datasets: [{
        data: counts,
        backgroundColor: bgColors,
        borderColor: '#1a1a1a',
        borderWidth: 2,
        hoverOffset: 12
      }]
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              const value = context.raw || 0;
              const pct = total ? ((value/total)*100).toFixed(1) : '0.0';
              return `${context.label}: ${value} (${pct}%)`;
            }
          }
        }
      }
    };

    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, { type: 'pie', data, options });
  }

  document.addEventListener('DOMContentLoaded', function () {
    renderGrafico();
    // atualiza a cada 30s
    setInterval(renderGrafico, 30000);
  });
})();
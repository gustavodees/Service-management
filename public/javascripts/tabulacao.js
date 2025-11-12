let tabulacoesCache = {};
let selectedMonth = null; // YYYY-MM
// Novo: status atual
let currentStatus = 'aniversariantes';
let wsWhatsappTabulacao = null;

function formatarStatus(status) {
  const map = {
    'aniversariantes': 'Aniversariantes',
    'sem-possibilidade': 'Sem possibilidade de saque',
    'conversa-inativa': 'Conversa inativa, sem resposta do cliente',
    'mudancas-cadastrais': 'Mudanças cadastrais',
    'negocio-fechado': 'Negócio fechado',
    'sem-interesse': 'Sem interesse na oferta'
  };
  return map[status] || status;
}

function formatarDataBR(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR');
}

function getInitialStatus() {
  const p = new URLSearchParams(window.location.search);
  return p.get('status') || 'aniversariantes';
}

function getInitialMonth() {
  const p = new URLSearchParams(window.location.search);
  return p.get('mes'); // esperado formato YYYY-MM
}

function toggleMonthFilter(status) {
  const box = document.querySelector('.filtro-aniversariantes');
  if (!box) return;
  box.style.display = (status === 'aniversariantes') ? 'block' : 'none';
}

// Novo: centraliza a mesma regra de filtro usada para render e exportação
function obterItemsFiltrados(status) {
  const sourceItems = (tabulacoesCache[status] || []);
  if (status === 'aniversariantes' && selectedMonth) {
    return sourceItems.filter(item => {
      if (!item.dataAniversariante) return false;
      const ym = String(item.dataAniversariante).slice(0, 7);
      return ym === selectedMonth;
    });
  }
  return sourceItems;
}

function btnReturnHtml(chatId) {
  return `<button class="btn-retornar" data-chatid="${chatId}" style="margin-top:8px; padding:6px 10px; border:none; background:#1f2937; color:#fff; border-radius:6px; cursor:pointer;">
    <i class="fa-solid fa-rotate-left" style="margin-right:6px;"></i> Retornar ao atendimento
  </button>`;
}

function mostrarTabulacao(status) {
  currentStatus = status; // Novo: guarda status atual
  console.log('Mostrando tabulação para status:', status);

  // Mostrar/ocultar filtro de mês conforme status
  toggleMonthFilter(status);

  // Esconde todas as listas
  document.querySelectorAll('.tabulacao-lista').forEach(lista => {
    lista.style.display = 'none';
    lista.innerHTML = '';
  });
  // Ativa botão
  document.querySelectorAll('.btn-status').forEach(btn => {
    btn.classList.toggle('ativo', btn.getAttribute('data-status') === status);
  });

  const lista = document.querySelector(`.tabulacao-lista[data-status="${status}"]`);
  if (!lista) return;

  // Usa os itens filtrados
  const items = obterItemsFiltrados(status);

  if (!items.length) {
    lista.style.display = 'block';
    lista.innerHTML = '<div class="vazio">Nenhum item tabulado aqui.</div>';
    return;
  }

  const html = items.map(item => {
    const numero = (item.chatId || '').replace('@c.us', '');
    const dt = item.timestamp ? new Date(item.timestamp) : null;
    const dtStr = dt ? dt.toLocaleString('pt-BR') : '';
    const dtAniv = formatarDataBR(item.dataAniversariante);
    return `
      <div class="tab-item" style="border:1px solid #ddd; border-radius:8px; padding:10px; margin-bottom:8px;">
        <div style="margin-bottom:6px;">
          <i class="fa-solid fa-mobile-screen"></i>
          <strong style="margin-left:6px;">${numero}</strong>
          ${dtStr ? `<span style="color:#555; margin-left:8px;">${dtStr}</span>` : ''}
        </div>
        <div><strong>Status:</strong> ${formatarStatus(item.tabulacao)}</div>
        ${dtAniv ? `<div><strong>Data do Aniversariante:</strong> ${dtAniv}</div>` : ''}
        <div><strong>Detalhes:</strong> ${item.detalhes ? String(item.detalhes).replace(/\n/g,'<br>') : '-'}</div>
        <div><strong>Observação:</strong> ${item.observacoes ? String(item.observacoes).replace(/\n/g,'<br>') : '-'}</div>
        ${btnReturnHtml(item.chatId)}
      </div>
    `;
  }).join('');

  lista.innerHTML = html;
  lista.style.display = 'block';
}

async function carregarTabulacoes() {
  try {
    const res = await fetch('/whatsapp/tabulacoes');
    const data = await res.json();
    tabulacoesCache = data.success ? (data.tabulacoes || {}) : {};
    mostrarTabulacao(getInitialStatus());
  } catch (error) {
    console.error('Erro ao carregar tabulações:', error);
    tabulacoesCache = {};
    mostrarTabulacao(getInitialStatus());
  }
}

// Novo: exporta para Excel o status atual; se "aniversariantes", exige mês selecionado
function exportarExcel() {
  try {
    if (!window.XLSX) {
      alert('Biblioteca XLSX não carregada.');
      return;
    }

    if (currentStatus === 'aniversariantes' && !selectedMonth) {
      alert('Selecione um mês para exportar os aniversariantes.');
      return;
    }

    // Deduplica por chatId e aplica filtro por mês quando necessário
    const items = obterItemsFiltrados(currentStatus);
    const unique = [];
    const seen = new Set();
    for (const it of items) {
      const id = it.chatId;
      if (id && !seen.has(id)) {
        seen.add(id);
        unique.push(it);
      }
    }

    if (!unique.length) {
      alert('Não há dados para exportar.');
      return;
    }

    const aoa = [];
    if (currentStatus === 'aniversariantes') {
      aoa.push(['Telefone', 'Data de Aniversário']);
      unique.forEach(it => {
        const numero = String(it.chatId || '').replace('@c.us', '');
        const dataBR = formatarDataBR(it.dataAniversariante) || '';
        aoa.push([numero, dataBR]);
      });
    } else {
      aoa.push(['Telefone']);
      unique.forEach(it => {
        const numero = String(it.chatId || '').replace('@c.us', '');
        aoa.push([numero]);
      });
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const statusSlug = currentStatus;
    const mesStr = currentStatus === 'aniversariantes' ? selectedMonth : 'todos';

    const filename = `tabulacao-${statusSlug}-${mesStr}-${stamp}.xlsx`;
    XLSX.writeFile(wb, filename);
  } catch (e) {
    console.error('Erro ao exportar Excel:', e);
    alert('Falha ao exportar o Excel.');
  }
}

function connectTabulacaoWebSocket() {
  wsWhatsappTabulacao = new WebSocket(`ws://${window.location.hostname}:${window.location.port}/ws-atendimento`);
  wsWhatsappTabulacao.onmessage = function(event) {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'chat-returned' && data.contact) {
        // Remove o contato da lista tabulada (de todas as abas)
        let alterou = false;
        Object.keys(tabulacoesCache).forEach(status => {
          const antes = tabulacoesCache[status].length;
          tabulacoesCache[status] = tabulacoesCache[status].filter(item => item.chatId !== data.contact.id);
          if (tabulacoesCache[status].length !== antes) alterou = true;
        });
        if (alterou) mostrarTabulacao(currentStatus);
      }
    } catch (e) {
      console.error('Erro ao processar evento chat-returned na tabulação:', e);
    }
  };
  wsWhatsappTabulacao.onerror = function(e) {
    console.error('Erro no WebSocket da Tabulação:', e);
  };
  wsWhatsappTabulacao.onclose = function() {
    setTimeout(connectTabulacaoWebSocket, 3000);
  };
}

document.addEventListener('DOMContentLoaded', function() {
  // Inicializa selectedMonth a partir da URL
  selectedMonth = getInitialMonth() || null;

  // Bind do input month
  const monthInput = document.getElementById('mes-aniversariantes');
  if (monthInput) {
    if (selectedMonth) monthInput.value = selectedMonth;
    monthInput.addEventListener('change', function () {
      selectedMonth = monthInput.value || null;

      // Atualiza a URL (?mes=YYYY-MM) mantendo o status atual
      const url = new URL(window.location.href);
      if (selectedMonth) url.searchParams.set('mes', selectedMonth);
      else url.searchParams.delete('mes');
      window.history.replaceState({}, '', url);

      // Re-renderiza somente a aba de aniversariantes
      mostrarTabulacao('aniversariantes');
    });
  }

  carregarTabulacoes();

  // Clique nos botões de status
  document.querySelectorAll('.btn-status').forEach(btn => {
    btn.addEventListener('click', function() {
      const status = btn.getAttribute('data-status');
      mostrarTabulacao(status);

      const url = new URL(window.location.href);
      url.searchParams.set('status', status);
      // mantém ?mes quando for aniversariantes; remove quando mudar para outra aba
      if (status !== 'aniversariantes') url.searchParams.delete('mes');
      window.history.replaceState({}, '', url);
    });
  });

  // Novo: clique do botão Exportar Excel
  const btnExport = document.getElementById('btn-export-excel');
  if (btnExport) {
    btnExport.addEventListener('click', exportarExcel);
  }

  // Atualiza periodicamente
  setInterval(carregarTabulacoes, 30000);

  connectTabulacaoWebSocket();
});

// Ação do botão "Retornar ao atendimento"
async function returnToAtendimento(chatId) {
  try {
    const res = await fetch('/whatsapp/tabular/retornar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId })
    }).then(r => r.json());
    if (!res.success) {
      alert(res.message || 'Falha ao retornar ao atendimento.');
      return;
    }
    // Recarrega a lista do status atual
    await carregarTabulacoes();
    alert('Contato retornou ao atendimento.');
  } catch (e) {
    console.error(e);
    alert('Erro ao retornar ao atendimento.');
  }
}

// Delegação de clique para os botões
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.btn-retornar');
  if (btn) {
    const chatId = btn.getAttribute('data-chatid');
    if (chatId) returnToAtendimento(chatId);
  }
});
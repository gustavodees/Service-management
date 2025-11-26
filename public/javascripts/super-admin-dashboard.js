/**
 * Camada de interação do dashboard do super admin: lista empresas aprovadas,
 * funcionários e conexões ativas, consumindo as rotas /admin/api.
 */
document.addEventListener('DOMContentLoaded', () => {
  const empresasContainer = document.getElementById('empresas-container');
  const empresaTemplate = document.getElementById('empresa-template');
  const funcionarioTemplate = document.getElementById('funcionario-template');
  const conexaoTemplate = document.getElementById('conexao-template');
  const conexoesModalBody = document.getElementById('conexoes-lista');

  async function fetchEmpresas() {
    try {
      const response = await fetch('/admin/api/empresas-aprovadas');
      const data = await response.json();

      if (!data.success) throw new Error(data.message);

      empresasContainer.innerHTML = ''; // Limpa o loading

      if (data.empresas.length === 0) {
        empresasContainer.innerHTML = '<p>Nenhuma empresa aprovada encontrada.</p>';
        return;
      }

      data.empresas.forEach(empresa => {
        const card = empresaTemplate.content.cloneNode(true).querySelector('.empresa-card');
        card.querySelector('.empresa-nome').textContent = empresa.nome_fantasia;
        card.querySelector('.empresa-cnpj').textContent = `CNPJ: ${empresa.cnpj}`;
        
        const toggleBtn = card.querySelector('.btn-toggle-funcionarios');
        const funcionariosContainer = card.querySelector('.funcionarios-container');

        card.querySelector('.empresa-header').addEventListener('click', () => {
          const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
          toggleBtn.setAttribute('aria-expanded', !isExpanded);
          funcionariosContainer.style.display = isExpanded ? 'none' : 'block';
          if (!isExpanded && !funcionariosContainer.dataset.loaded) {
            fetchFuncionarios(empresa.id, funcionariosContainer);
          }
        });

        empresasContainer.appendChild(card);
      });

    } catch (error) {
      empresasContainer.innerHTML = `<p class="text-danger">Erro ao carregar empresas: ${error.message}</p>`;
    }
  }

  async function fetchFuncionarios(empresaId, container) {
    try {
      const response = await fetch(`/admin/api/empresa/${empresaId}/funcionarios`);
      const data = await response.json();

      if (!data.success) throw new Error(data.message);

      container.innerHTML = ''; // Limpa o loading
      container.dataset.loaded = 'true';

      if (data.funcionarios.length === 0) {
        container.innerHTML = '<p>Nenhum funcionário encontrado para esta empresa.</p>';
        return;
      }

      data.funcionarios.forEach(func => {
        const item = funcionarioTemplate.content.cloneNode(true).querySelector('.funcionario-item');
        item.querySelector('.funcionario-nome').textContent = func.nome;
        const btnVerConexoes = item.querySelector('.btn-ver-conexoes');
        btnVerConexoes.dataset.userid = func.id;

        btnVerConexoes.addEventListener('click', () => {
          fetchConexoes(func.id);
        });

        container.appendChild(item);
      });

    } catch (error) {
      container.innerHTML = `<p class="text-danger">Erro ao carregar funcionários: ${error.message}</p>`;
    }
  }

  async function fetchConexoes(userId) {
    // Abre o modal e mostra o estado de carregamento
    $('#conexoes-modal').modal('show');
    conexoesModalBody.innerHTML = '<div class="loading-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Carregando conexões...</p></div>';

    try {
      // Busca conexões de WhatsApp e Chatbot para o usuário específico
      const [whatsappRes, chatbotRes] = await Promise.all([
        fetch(`/admin/api/user/${userId}/whatsapp-status`),
        fetch(`/admin/api/user/${userId}/chatbot-status`)
      ]);

      const whatsappData = await whatsappRes.json();
      const chatbotData = await chatbotRes.json();

      conexoesModalBody.innerHTML = '';

      if (!whatsappData.success || !chatbotData.success) {
        throw new Error('Falha ao buscar dados de conexão.');
      }

      const allConexoes = [
        ...whatsappData.devices.map(d => ({ ...d, type: 'whatsapp' })),
        ...chatbotData.bots.map(d => ({ ...d, type: 'chatbot', deviceId: d.deviceIDchatbot }))
      ];

      if (allConexoes.length === 0) {
        conexoesModalBody.innerHTML = '<p>Nenhuma conexão encontrada para este funcionário.</p>';
        return;
      }

      allConexoes.forEach(conn => {
        const item = conexaoTemplate.content.cloneNode(true).querySelector('.conexao-item');
        const statusIndicator = item.querySelector('.status-indicator');
        
        statusIndicator.classList.add(conn.isReady ? 'online' : 'offline');
        statusIndicator.title = conn.isReady ? 'Online' : 'Offline';

        item.querySelector('.conexao-number').textContent = conn.number || conn.deviceId;
        item.querySelector('.conexao-type').textContent = conn.type;

        // Configurar botões de ação (exemplo, a lógica de ação precisa ser implementada)
        item.querySelector('.btn-sincronizar').dataset.deviceid = conn.deviceId;
        item.querySelector('.btn-desconectar').dataset.deviceid = conn.deviceId;

        conexoesModalBody.appendChild(item);
      });

    } catch (error) {
      conexoesModalBody.innerHTML = `<p class="text-danger">Erro ao carregar conexões: ${error.message}</p>`;
    }
  }

  fetchEmpresas();
});
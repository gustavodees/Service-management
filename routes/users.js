const express = require('express');
const router = express.Router();
const whatsapp = require('./whatsapp');
const verificaAutenticacao = require('./verificaAutenticacao');
const Usuario = require('./Usuario');
const Tabulacao = require('./Tabulacao'); // ADICIONE ESTA LINHA

// === ADICIONAR ===
const ChatbotDevice = require('./chatbotDevice'); // remove devices vinculados ao usuário
const sequelizeUser = require('./banco'); // para transações
const chatbotModule = require('./chatbot'); // <<< ADICIONADO
// === FIM ADIÇÃO ===

/* GET users listing. */
router.get('/', verificaAutenticacao, function(req, res, next) {
  res.send('respond with a resource');
});

/* GET Desparo de mensagens page. */
router.get('/disparar', verificaAutenticacao, function(req, res, next) {
  res.render('desparaWhats', { 
    title: 'Disparo de Mensagens - Sistema Service',
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null
  });
});

/* POST para enviar mensagens em lote */
router.post('/despara/enviar', verificaAutenticacao, async (req, res) => {
  try {
    const { numeros, mensagem, deviceId } = req.body;

    if (!numeros || !mensagem) {
      return res.status(400).json({ message: 'Campos obrigatórios não preenchidos', total: 0 });
    }

    // deviceId pode vir no formato "whatsapp:DEVICEID" ou "chatbot:DEVICEID"
    let chosenDeviceType = 'whatsapp';
    let chosenDeviceId = deviceId;
    if (deviceId && typeof deviceId === 'string' && deviceId.includes(':')) {
      const parts = deviceId.split(':');
      chosenDeviceType = parts[0];
      chosenDeviceId = parts.slice(1).join(':');
    }

    const clientsMap = whatsapp.getClients ? whatsapp.getClients() : {};
    const userId = req.session.usuario.id;

    // Se não foi passado deviceId explicitamente, tenta escolher automaticamente entre whatsapp/chatbot
    if (!chosenDeviceId) {
      // prioriza devices whatsapp do usuário
      const readyUserDevices = Object.entries(clientsMap)
        .filter(([, obj]) => obj && obj.userId === userId && obj.isClientReady)
        .map(([id]) => ({ source: 'whatsapp', id }));

      // considera também chatbots prontos (quando houver apenas um disponível)
      const chatbotClients = (chatbotModule && chatbotModule.chatbotClients) ? chatbotModule.chatbotClients : {};
      const readyChatbots = Object.entries(chatbotClients)
        .filter(([, obj]) => obj && obj.isClientReady)
        .map(([id]) => ({ source: 'chatbot', id }));

      if (readyUserDevices.length > 0) {
        chosenDeviceType = 'whatsapp';
        chosenDeviceId = readyUserDevices[0].id;
      } else if (readyChatbots.length === 1) {
        chosenDeviceType = 'chatbot';
        chosenDeviceId = readyChatbots[0].id;
      } else {
        // nenhum device apropriado encontrado
        return res.status(400).json({ message: 'WhatsApp/ChatBot não está conectado!', total: 0 });
      }
    }

    // obtém objeto do client correto
    let clientObj = null;
    if (chosenDeviceType === 'chatbot') {
      const chatbotClients = (chatbotModule && chatbotModule.chatbotClients) ? chatbotModule.chatbotClients : {};
      clientObj = chatbotClients[chosenDeviceId];
    } else {
      clientObj = clientsMap[chosenDeviceId];
    }

    if (!chosenDeviceId || !clientObj) {
      return res.status(400).json({ message: 'Device não encontrado ou não conectado!', total: 0 });
    }

    if (!clientObj.isClientReady || !clientObj.client) {
      return res.status(400).json({ message: 'Device inválido ou não está pronto para envio', total: 0 });
    }

    const numerosArray = numeros
      .split('\n')
      .map(n => n.replace(/\D/g, ''))
      .filter(n => n.length >= 12);

    if (numerosArray.length === 0) {
      return res.status(400).json({ message: 'Nenhum número válido para envio', total: 0 });
    }

    let enviados = 0;
    let pulados = 0;
    const invalidos = [];
    const resultsDetails = []; // <-- novo: detalhes por número (status + timestamp)

    for (const numero of numerosArray) {
      try {
        // Verifica se o número possui WhatsApp
        const wid = await clientObj.client.getNumberId(numero);
        if (!wid) {
          pulados++;
          invalidos.push(numero);
          resultsDetails.push({ number: numero, status: 'not_whatsapp', timestamp: null });
          continue; // pula para o próximo número
        }

        // Envia usando o ID serializado retornado (garantido válido)
        await clientObj.client.sendMessage(wid._serialized, mensagem);

        // Remover da tabulação se existir (use o número serializado!)
        if (whatsapp.chatsTabulados && whatsapp.chatsTabulados.has(wid._serialized)) {
          await whatsapp.removerTabulacaoSeExistir(userId, wid._serialized);
        }

        enviados++;
        const sentAt = new Date().toISOString();
        resultsDetails.push({ number: numero, status: 'sent', timestamp: sentAt, chatId: wid._serialized });

        // Intervalo entre envios para evitar bloqueios
        await new Promise(r => setTimeout(r, 4000));
      } catch (err) {
        console.error(`Erro ao enviar para ${numero}:`, err && err.message ? err.message : err);
        resultsDetails.push({ number: numero, status: 'error', error: err && err.message ? err.message : String(err), timestamp: null });
      }
    }

    // Salva “último disparo” para o device (chama função de cada módulo se existir)
    try {
      const now = new Date();
      const iso = now.toISOString();

      if (chosenDeviceType === 'chatbot') {
        // se o módulo chatbot expõe um setter, prefira usá-lo
        if (chatbotModule && typeof chatbotModule.setLastMassSend === 'function') {
          try { chatbotModule.setLastMassSend(chosenDeviceId, iso); } catch (e) {}
        }

        // atualiza a entrada em chatbotClients (chatbot.js exporta chatbotClients)
        if (chatbotModule && chatbotModule.chatbotClients && chatbotModule.chatbotClients[chosenDeviceId]) {
          try { chatbotModule.chatbotClients[chosenDeviceId].lastMassSend = iso; } catch (e) {}
        }

        // fallback: mapa simples no próprio módulo chatbot
        try {
          chatbotModule.chatbotLastMassSend = chatbotModule.chatbotLastMassSend || {};
          chatbotModule.chatbotLastMassSend[chosenDeviceId] = iso;
        } catch (e) {}
      } else {
        // whatsapp: usa setter se existir
        if (whatsapp && typeof whatsapp.setLastMassSend === 'function') {
          try { whatsapp.setLastMassSend(chosenDeviceId, iso); } catch (e) {}
        }
        // também atualiza o objeto clients caso exista
        try {
          const clientsMap = whatsapp.getClients ? whatsapp.getClients() : {};
          if (clientsMap && clientsMap[chosenDeviceId]) {
            clientsMap[chosenDeviceId].lastMassSend = iso;
          }
        } catch (e) {}
      }
    } catch (e) {
      console.warn('Falha ao gravar lastMassSend (não crítico):', e);
    }

    res.json({
      message: `Mensagens enviadas via device ${chosenDeviceType}:${chosenDeviceId}`,
      total: enviados,
      skipped: pulados,
      invalidNumbers: invalidos,
      results: resultsDetails // <-- novo campo com hora por número
    });
  } catch (error) {
    console.error('Erro no disparo:', error);
    res.status(500).json({ message: 'Erro ao enviar mensagens', total: 0 });
  }
});

/* GET Atendimento page. */
router.get('/atendimento', verificaAutenticacao, function(req, res, next) {
  // Se o admin estava visualizando o atendimento de um funcionário, sair do modo de impersonação
  if (req.session && req.session.impersonateUserId) {
    delete req.session.impersonateUserId;
  }
  res.render('atendimento', { 
    title: 'Atendimento - Sistema Service',
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null
  });
});

/* GET Atendimento page com usuário específico. */
router.get('/atendimento/:id', verificaAutenticacao, async (req, res) => {
  try {
    if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
      return res.status(403).render('error', { message: 'Acesso negado', error: {} });
    }
    const alvoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(alvoId)) {
      return res.status(400).render('error', { message: 'ID inválido', error: {} });
    }
    const alvo = await Usuario.findByPk(alvoId);
    if (!alvo) {
      return res.status(404).render('error', { message: 'Usuário não encontrado', error: {} });
    }

    // Marcar a sessão para impersonar este usuário no atendimento
    req.session.impersonateUserId = alvo.id;

    req.session.save(() => {
      res.render('atendimento', { 
        title: `Atendimento - ${alvo.nome}`,
        usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null,
        impersonating: { id: alvo.id, nome: alvo.nome }
      });
    });
  } catch (e) {
    res.status(500).render('error', { message: 'Erro interno', error: e });
  }
});

/* GET Tabulação page. */
router.get('/tabulacao', verificaAutenticacao, function(req, res, next) {
  // Se o admin estava visualizando a tabulação de um funcionário, sair do modo de impersonação
  if (req.session && req.session.impersonateUserId) {
    delete req.session.impersonateUserId;
  }
  res.render('tabulacao', { 
    title: 'Tabulação de Mensagens - Sistema Service',
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null
  });
});

/* GET Tabulação page com usuário específico (admin impersona) */
router.get('/tabulacao/:id', verificaAutenticacao, async (req, res) => {
  try {
    if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
      return res.status(403).render('error', { message: 'Acesso negado', error: {} });
    }
    const alvoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(alvoId)) {
      return res.status(400).render('error', { message: 'ID inválido', error: {} });
    }
    const alvo = await Usuario.findByPk(alvoId);
    if (!alvo) {
      return res.status(404).render('error', { message: 'Usuário não encontrado', error: {} });
    }

    // Marcar a sessão para impersonar este usuário na tabulação
    req.session.impersonateUserId = alvo.id;

    req.session.save(() => {
      res.render('tabulacao', { 
        title: `Tabulação - ${alvo.nome}`,
        usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null,
        impersonating: { id: alvo.id, nome: alvo.nome }
      });
    });
  } catch (e) {
    res.status(500).render('error', { message: 'Erro interno', error: e });
  }
});

/* GET Gráfico page. */
router.get('/grafico', verificaAutenticacao, function(req, res) {
  // se o admin estava visualizando o gráfico de um funcionário, sair do modo de impersonação
  if (req.session && req.session.impersonateUserId) {
    delete req.session.impersonateUserId;
  }

  // renderiza o gráfico para o usuário atual (ou admin vendo seu próprio gráfico)
  const usuarioTipo = req.session.usuario ? req.session.usuario.tipo : null;
  const usuarioNome = req.session.usuario ? req.session.usuario.nome : null;
  const usuarioId = req.session.usuario ? req.session.usuario.id : null;

  res.render('grafico', { 
    usuarioTipo,
    usuarioNome,
    usuarioId
  });
});

/* GET Gráfico para usuário específico (admin visualiza outro usuário) */
router.get('/grafico/:id', verificaAutenticacao, async (req, res) => {
  try {
    // só admins podem abrir o gráfico de outro usuário
    if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
      return res.status(403).render('error', { message: 'Acesso negado', error: {} });
    }

    const alvoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(alvoId)) {
      return res.status(400).render('error', { message: 'ID inválido', error: {} });
    }

    const alvo = await Usuario.findByPk(alvoId);
    if (!alvo) {
      return res.status(404).render('error', { message: 'Usuário não encontrado', error: {} });
    }

    // Renderiza a view informando que o admin está visualizando o gráfico daquele usuário
    // `impersonating` ficará disponível no client (grafico.pug já expõe window.__impersonating)
    res.render('grafico', {
      usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null,
      usuarioNome: alvo.nome,
      usuarioId: alvo.id,
      impersonating: { id: alvo.id, nome: alvo.nome }
    });
  } catch (e) {
    console.error('Erro ao carregar gráfico por usuário:', e);
    res.status(500).render('error', { message: 'Erro interno', error: e });
  }
});

/* NOVO: endpoint para fornecer dados do gráfico (por usuário ou equipe) */
router.get('/grafico-data', verificaAutenticacao, async (req, res) => {
  try {
    // Permitir ?scope=team para agregação da equipe (apenas admin)
    const scope = req.query.scope || null;
    const userIdParam = req.query.userId ? parseInt(req.query.userId, 10) : null;

    // Se pediram dados da equipe, validar permissão
    if (scope === 'team') {
      if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
        return res.status(403).json({ success: false, message: 'Acesso negado' });
      }
    }

    // Determina o filtro: team (nenhum filtro) ou userId (query / session impersonate / session usuario)
    let filter = {};
    if (scope !== 'team') {
      // prioridade: userIdParam > session.impersonateUserId > session.usuario.id
      const targetId = userIdParam || (req.session.impersonateUserId ? req.session.impersonateUserId : (req.session.usuario ? req.session.usuario.id : null));
      if (!targetId) {
        return res.status(400).json({ success: false, message: 'ID do usuário não identificado' });
      }
      filter.user_id = targetId;
    }

    // Busca tabulações com o filtro (ou todas quando scope=team)
    const rows = await Tabulacao.findAll({ where: filter, raw: true });

    // Monta objeto com arrays por chave esperada pelo frontend
    const keys = [
      'aniversariantes',
      'sem-possibilidade',
      'conversa-inativa',
      'mudancas-cadastrais',
      'negocio-fechado',
      'sem-interesse'
    ];
    const tab = {};
    keys.forEach(k => tab[k] = []);
    rows.forEach(r => {
      const key = r.tabulacao;
      if (keys.includes(key)) {
        // inclui apenas campos úteis para exibição (chatId, timestamp, dataAniversariante, detalhes, observacoes)
        tab[key].push({
          chatId: r.chatId,
          timestamp: r.timestamp,
          dataAniversariante: r.data_aniversariante || r.dataAniversariante || null,
          detalhes: r.detalhes,
          observacoes: r.observacoes,
          user_id: r.user_id
        });
      } else {
        // caso exista um tabulacao livre/novo, coloque em conversa-inativa como fallback
        tab['conversa-inativa'].push({
          chatId: r.chatId,
          timestamp: r.timestamp,
          dataAniversariante: r.data_aniversariante || null,
          detalhes: r.detalhes,
          observacoes: r.observacoes,
          user_id: r.user_id
        });
      }
    });

    res.json({ success: true, tabulacoes: tab });
  } catch (e) {
    console.error('Erro /users/grafico-data:', e);
    res.status(500).json({ success: false, message: 'Erro ao buscar dados do gráfico' });
  }
});

/* DELETE Usuário (remove usuário + tabulações + devices) */
router.delete('/deletar-usuario/:id', verificaAutenticacao, async (req, res) => {
  // Somente admins podem deletar (front já esconde botão, mas validar aqui também)
  if (!req.session || !req.session.usuario || req.session.usuario.tipo !== 'admin') {
    return res.status(403).json({ success: false, message: 'Acesso negado' });
  }

  const alvoId = parseInt(req.params.id, 10);
  if (!Number.isFinite(alvoId)) {
    return res.status(400).json({ success: false, message: 'ID inválido' });
  }

  try {
    await sequelizeUser.transaction(async (t) => {
      // Verifica existência
      const alvo = await Usuario.findByPk(alvoId, { transaction: t });
      if (!alvo) {
        const err = new Error('Usuário não encontrado');
        err.code = 404;
        throw err;
      }

      // Remove tabulações vinculadas
      await Tabulacao.destroy({ where: { user_id: alvoId }, transaction: t });

      // Remove devices/chatbot devices vinculados
      await ChatbotDevice.destroy({ where: { user_id: alvoId }, transaction: t });

      // Aqui: adicionar outras remoções relacionadas se houver mais tabelas (ex.: logs, arquivos, etc.)

      // Remove o usuário
      await Usuario.destroy({ where: { id: alvoId }, transaction: t });
    });

    // Tentativa de limpar estruturas em memória no módulo whatsapp (se a função existir)
    try {
      if (whatsapp && typeof whatsapp.clearTabulationsForUser === 'function') {
        await whatsapp.clearTabulationsForUser(alvoId);
      } else if (whatsapp && typeof whatsapp.removerTabulacoesDoUsuario === 'function') {
        // nomes alternativos de função — chamada segura
        await whatsapp.removerTabulacoesDoUsuario(alvoId);
      } else {
        // sem função específica — tentar limpar estruturas genéricas se existirem
        if (whatsapp && whatsapp.chatsTabulados) {
          // remove entradas que apontem para este userId (não crítico)
          for (const [chatId, uid] of Object.entries(whatsapp.chatsTabulados)) {
            if (uid === String(alvoId) || uid === alvoId) delete whatsapp.chatsTabulados[chatId];
          }
        }
      }
    } catch (memErr) {
      console.warn('Falha ao limpar dados em memória do whatsapp (não crítico):', memErr);
    }

    return res.json({ success: true, message: 'Usuário e dados relacionados removidos.' });
  } catch (err) {
    if (err && err.code === 404) {
      return res.status(404).json({ success: false, message: err.message });
    }
    console.error('Erro ao deletar usuário:', err);
    return res.status(500).json({ success: false, message: 'Erro interno ao deletar usuário.' });
  }
});

module.exports = router;

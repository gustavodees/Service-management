const express = require('express');
const router = express.Router();
const whatsappManager = require('./whatsappManager'); // CORREÇÃO: Usar o gerenciador correto
const verificaAutenticacao = require('./verificaAutenticacao');
const Usuario = require('./Usuario');
const Tabulacao = require('./Tabulacao'); // ADICIONE ESTA LINHA
const { getTabulacoesGrouped } = require('./tabulacaoHelper');
const { Op } = require('sequelize');
const logActivity = require('../utils/logActivity');

// === ADICIONAR ===
const ChatbotDevice = require('./chatbotDevice'); // remove devices vinculados ao usuário
const sequelizeUser = require('./banco'); // para transações
const chatbotModule = require('./chatbot'); // <<< ADICIONADO
// === FIM ADIÇÃO ===

async function getSelectableUsers(sessionUser) {
  if (!sessionUser || !['admin', 'super_admin'].includes(sessionUser.tipo)) {
    return [];
  }

  const whereClause = {};
  if (sessionUser.empresa_id) {
    whereClause.empresa_id = sessionUser.empresa_id;
  }
  if (sessionUser.id) {
    whereClause.id = { [Op.ne]: sessionUser.id };
  }

  return Usuario.findAll({
    where: whereClause,
    attributes: ['id', 'nome'],
    order: [['nome', 'ASC']]
  });
}

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

// =================================================================
// MELHORIA: Função para criar um atraso aleatório entre os envios.
// Isso simula um comportamento mais humano e reduz o risco de banimento.
// =================================================================
function randomDelay(minSeconds, maxSeconds) {
  const delay = Math.random() * (maxSeconds - minSeconds) + minSeconds;
  return new Promise(resolve => setTimeout(resolve, delay * 1000));
}
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

    const userId = req.session.usuario.id;

    // CORREÇÃO: Obter o cliente diretamente do gerenciador correto.
    let client;
    if (chosenDeviceType === 'chatbot') {
      const chatbotClients = chatbotModule.chatbotClients || {};
      const chatbotClientData = chatbotClients[chosenDeviceId];
      client = (chatbotClientData && chatbotClientData.isClientReady) ? chatbotClientData.client : null;
    } else {
      client = whatsappManager.getClient(chosenDeviceId);
    }

    if (!client) {
      return res.status(400).json({ message: 'Dispositivo não encontrado ou não está conectado.', total: 0 });
    }

    const numerosArray = numeros
      .split('\n')
      .map(n => n.replace(/\D/g, ''))
      // MELHORIA: Filtro mais flexível para números brasileiros (com ou sem o 9 extra)
      .filter(n => n.length >= 10 && n.length <= 13);

    if (numerosArray.length === 0) {
      return res.status(400).json({ message: 'Nenhum número válido para envio', total: 0 });
    }

    let enviados = 0;
    let pulados = 0;
    const invalidos = [];
    const resultsDetails = []; // <-- novo: detalhes por número (status + timestamp)

    for (const numero of numerosArray) {
      try {
        // Adiciona o '55' e garante que o formato seja adequado para getNumberId
        const numeroCompleto = numero.startsWith('55') ? numero : `55${numero}`;

        // Verifica se o número possui WhatsApp
        const wid = await client.getNumberId(numeroCompleto);
        if (!wid) {
          pulados++;
          invalidos.push(numero);
          resultsDetails.push({ number: numero, status: 'not_whatsapp', timestamp: null });
          continue; // pula para o próximo número
        }

        // Envia usando o ID serializado retornado (garantido válido)
        await client.sendMessage(wid._serialized, mensagem);

        enviados++;
        const sentAt = new Date().toISOString();
        resultsDetails.push({ number: numero, status: 'sent', timestamp: sentAt, chatId: wid._serialized });

        // MELHORIA: Usa um intervalo aleatório entre 5 e 15 segundos para segurança.
        await randomDelay(5, 15);
      } catch (err) {
        console.error(`Erro ao enviar para ${numero}:`, err && err.message ? err.message : err);
        resultsDetails.push({ number: numero, status: 'error', error: err && err.message ? err.message : String(err), timestamp: null });
      }
    }

    // Salva “último disparo” para o device (chama função de cada módulo se existir)

    await logActivity({
      userId: req.session.usuario.id,
      empresaId: req.session.usuario.empresa_id,
      action: 'MASS_MESSAGE_DISPATCH',
      details: `Disparo (${chosenDeviceType}:${chosenDeviceId}) com ${enviados} enviados, ${pulados} pulados de ${numerosArray.length} números.`,
      ipAddress: req.ip
    });

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
    if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
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

    if (req.session.usuario.tipo === 'admin' && req.session.usuario.empresa_id && alvo.empresa_id !== req.session.usuario.empresa_id) {
      return res.status(403).render('error', { message: 'Acesso negado', error: {} });
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
router.get('/grafico', verificaAutenticacao, async function(req, res) {
  if (req.session && req.session.impersonateUserId) {
    delete req.session.impersonateUserId;
  }

  const usuario = req.session.usuario || {};
  const usuarioTipo = usuario.tipo || null;
  const usuarioNome = usuario.nome || null;
  const usuarioId = usuario.id || null;

  let usuariosDisponiveis = [];
  try {
    usuariosDisponiveis = await getSelectableUsers(usuario);
  } catch (e) {
    console.warn('Falha ao buscar usuários disponíveis para o gráfico:', e && e.message ? e.message : e);
  }

  res.render('grafico', { 
    usuarioTipo,
    usuarioNome,
    usuarioId,
    usuariosDisponiveis
  });
});

/* GET Gráfico para usuário específico (admin visualiza outro usuário) */
router.get('/grafico/:id', verificaAutenticacao, async (req, res) => {
  try {
    if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
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

    if (req.session.usuario.tipo === 'admin' && req.session.usuario.empresa_id && alvo.empresa_id !== req.session.usuario.empresa_id) {
      return res.status(403).render('error', { message: 'Acesso negado', error: {} });
    }

    let usuariosDisponiveis = [];
    try {
      usuariosDisponiveis = await getSelectableUsers(req.session.usuario);
    } catch (e) {
      console.warn('Falha ao buscar usuários disponíveis para o gráfico:', e && e.message ? e.message : e);
    }

    // Renderiza a view informando que o admin está visualizando o gráfico daquele usuário
    // `impersonating` ficará disponível no client (grafico.pug já expõe window.__impersonating)
    res.render('grafico', {
      usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null,
      usuarioNome: alvo.nome,
      usuarioId: alvo.id,
      impersonating: { id: alvo.id, nome: alvo.nome },
      usuariosDisponiveis
    });
  } catch (e) {
    console.error('Erro ao carregar gráfico por usuário:', e);
    res.status(500).render('error', { message: 'Erro interno', error: e });
  }
});

/* NOVO: endpoint para fornecer dados do gráfico (por usuário ou equipe) */
router.get('/grafico-data', verificaAutenticacao, async (req, res) => {
  try {
    const scope = req.query.scope || null;
    const userIdParam = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const sessionUser = req.session.usuario;
    const isAdmin = sessionUser && sessionUser.tipo === 'admin';
    const isSuperAdmin = sessionUser && sessionUser.tipo === 'super_admin';

    if (Number.isNaN(userIdParam)) {
      return res.status(400).json({ success: false, message: 'ID do usuário inválido' });
    }

    if (scope === 'team') {
      if (!isAdmin && !isSuperAdmin) {
        return res.status(403).json({ success: false, message: 'Acesso negado' });
      }
      if (!sessionUser.empresa_id) {
        return res.status(400).json({ success: false, message: 'Associe-se a uma empresa para visualizar o desempenho da equipe.' });
      }
    }

    let empresaIdOverride = null;
    if (userIdParam) {
      const alvo = await Usuario.findByPk(userIdParam, { attributes: ['id', 'empresa_id'] });
      if (!alvo) {
        return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
      }
      if (isAdmin && sessionUser.empresa_id && sessionUser.empresa_id !== alvo.empresa_id) {
        return res.status(403).json({ success: false, message: 'Você não pode visualizar dados de outra empresa.' });
      }
      if (!sessionUser.empresa_id) {
        empresaIdOverride = alvo.empresa_id;
      }
    }

    if (!sessionUser.empresa_id && !empresaIdOverride) {
      return res.status(400).json({ success: false, message: 'Empresa não identificada para coletar dados.' });
    }

    const { tab } = await getTabulacoesGrouped({
      scope,
      userIdParam,
      session: req.session,
      empresaIdOverride
    });

    res.json({ success: true, tabulacoes: tab });
  } catch (e) {
    console.error('Erro /users/grafico-data:', e);
    const status = e.status || 500;
    const message = e.status ? e.message : 'Erro ao buscar dados do gráfico';
    res.status(status).json({ success: false, message });
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
    let deletedUserInfo = null;
    await sequelizeUser.transaction(async (t) => {
      // Verifica existência
      const alvo = await Usuario.findByPk(alvoId, { transaction: t });
      if (!alvo) {
        const err = new Error('Usuário não encontrado');
        err.code = 404;
        throw err;
      }

      deletedUserInfo = {
        id: alvo.id,
        nome: alvo.nome,
        email: alvo.email
      };

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

    await logActivity({
      userId: req.session.usuario.id,
      empresaId: req.session.usuario.empresa_id,
      action: 'USER_DELETED',
      details: deletedUserInfo
        ? `O admin '${req.session.usuario.nome}' deletou o usuário '${deletedUserInfo.nome}' (ID: ${deletedUserInfo.id}, email: ${deletedUserInfo.email}).`
        : `O admin '${req.session.usuario.nome}' deletou um usuário (ID: ${alvoId}).`,
      ipAddress: req.ip
    });

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

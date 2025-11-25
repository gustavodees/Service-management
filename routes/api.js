const express = require('express');
const router = express.Router();
const verificaAutenticacao = require('./verificaAutenticacao');
const Tabulacao = require('./Tabulacao'); // Adicionado
const whatsappManager = require('./whatsappManager'); // Adicionado
const WhatsappMedia = require('./WhatsappMedia'); // Adicionado
const Conversation = require('./Conversation');
const { getTabulacoesGrouped } = require('./tabulacaoHelper');

/**
 * Rota: GET /api/contacts
 *
 * Busca uma lista consolidada de contatos/conversas para a tela de atendimento.
 * Esta rota é otimizada para o carregamento inicial da página.
 * Ela busca a última mensagem de cada conversa diretamente da tabela de mensagens.
 */
router.get('/contacts', verificaAutenticacao, async (req, res) => {
  try {
    if (!req.session || !req.session.usuario || !req.session.usuario.empresa_id) {
      return res.status(401).json({ error: 'Não autorizado ou empresa não identificada.' });
    }

    const empresaId = req.session.usuario.empresa_id;
    const conversations = await Conversation.findAll({
      where: { empresa_id: empresaId },
      order: [['timestamp', 'DESC']]
    });

    const contacts = conversations.map(conv => {
      const timestampValue = conv.timestamp ? new Date(conv.timestamp).getTime() : null;
      const rawId = conv.id || '';
      const fallbackName = rawId.includes('@') ? rawId.split('@')[0] : rawId;
      return {
        id: rawId,
        name: conv.name || fallbackName || 'Contato',
        profilePicUrl: conv.profile_pic_url || null,
        lastMessage: conv.last_message || '',
        timestamp: timestampValue,
        unreadCount: conv.unread_count || 0,
        isGroup: !!conv.is_group,
        archived: !!conv.archived,
        source: conv.source || 'whatsapp',
        deviceId: conv.device_id || null
      };
    });

    res.json(contacts);

  } catch (error) {
    console.error('Erro ao buscar contatos via API:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao buscar contatos.' });
  }
});

/**
 * Rota: GET /api/tabulacoes
 * Busca as tabulações agrupadas por status para o usuário logado ou equipe.
 */
router.get('/tabulacoes', verificaAutenticacao, async (req, res) => {
  try {
    const scope = req.query.scope || null;
    const userIdParam = req.query.userId ? parseInt(req.query.userId, 10) : null;

    if (Number.isNaN(userIdParam)) {
      return res.status(400).json({ success: false, error: 'ID do usuário inválido.' });
    }

    if (scope === 'team') {
      if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
        return res.status(403).json({ success: false, error: 'Acesso negado.' });
      }
    }

    const { tab } = await getTabulacoesGrouped({
      scope,
      userIdParam,
      session: req.session
    });

    res.json({ success: true, tabulacoes: tab });
  } catch (error) {
    console.error('Erro ao buscar tabulações:', error);
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      error: status === 500 ? 'Erro ao buscar tabulações.' : error.message
    });
  }
});

/**
 * Rota: POST /api/tabular
 * Cria um novo registro de tabulação para uma conversa.
 */
router.post('/tabular', verificaAutenticacao, async (req, res) => {
  const { chatId, tabulacao, detalhes, observacoes, aniversarioData } = req.body;
  const { id: userId, empresa_id } = req.session.usuario;

  if (!chatId || !tabulacao) {
    return res.status(400).json({ success: false, error: 'chatId e tabulacao são obrigatórios.' });
  }

  try {
    await Tabulacao.create({
      user_id: userId,
      empresa_id: empresa_id,
      chatId: chatId,
      tabulacao: tabulacao,
      detalhes: detalhes,
      observacoes: observacoes,
      data_aniversariante: aniversarioData,
    });

    // Notifica o frontend que o chat foi tabulado para que a UI possa ser atualizada
    whatsappManager.notifyChatTabulated(chatId, empresa_id);

    res.json({ success: true, message: 'Conversa tabulada com sucesso.' });
  } catch (error) {
    console.error('Erro ao tabular conversa:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

/**
 * Rota: POST /api/tabulacoes/retornar
 * Remove a tabulação de um chat e notifica os clientes em tempo real.
 */
router.post('/tabulacoes/retornar', verificaAutenticacao, async (req, res) => {
  try {
    const { chatId } = req.body;
    const { empresa_id } = req.session.usuario;

    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId é obrigatório.' });
    }
    if (!empresa_id) {
      return res.status(401).json({ success: false, error: 'Empresa não identificada.' });
    }

    await Tabulacao.destroy({ where: { chatId, empresa_id } });

    const contact = await Conversation.findOne({ where: { id: chatId, empresa_id }, raw: true });
    const contactPayload = contact ? {
      id: contact.id,
      name: contact.name,
      profilePicUrl: contact.profile_pic_url,
      lastMessage: contact.last_message,
      deviceId: contact.device_id,
      isGroup: contact.is_group,
      source: contact.source || 'whatsapp'
    } : {
      id: chatId,
      name: (chatId || '').replace('@c.us', ''),
      source: 'whatsapp'
    };

    whatsappManager.notifyChatReturned(contactPayload, empresa_id);

    res.json({ success: true, message: 'Conversa retornada ao atendimento.' });
  } catch (error) {
    console.error('Erro ao retornar tabulação:', error);
    res.status(500).json({ success: false, error: 'Erro ao retornar tabulação.' });
  }
});

/**
 * Rota: GET /api/media
 * Busca o conteúdo de uma mídia sob demanda.
 */
router.get('/media', verificaAutenticacao, async (req, res) => {
  const { messageId } = req.query;
  const { empresa_id } = req.session.usuario;

  if (!messageId) {
    return res.status(400).json({ success: false, error: 'messageId é obrigatório.' });
  }

  try {
    const media = await WhatsappMedia.findOne({ where: { id: messageId, empresa_id } });

    if (media && media.data) {
      res.json({ success: true, data: media.data, mimetype: media.mimetype, filename: media.filename });
    } else {
      res.status(404).json({ success: false, error: 'Mídia não encontrada ou não autorizada.' });
    }
  } catch (error) {
    console.error('Erro ao buscar mídia sob demanda:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

/**
 * Rota: POST /api/conversations/action
 * Executa ações rápidas (arquivar, bloquear, renomear) em conversas do WhatsApp.
 */
router.post('/conversations/action', verificaAutenticacao, async (req, res) => {
  try {
    const { action, chatId, deviceId, newName } = req.body || {};
    const sessionUser = req.session?.usuario;
    const empresaId = sessionUser?.empresa_id;

    if (!empresaId) {
      return res.status(401).json({ success: false, error: 'Empresa não identificada.' });
    }
    if (!chatId || !action) {
      return res.status(400).json({ success: false, error: 'chatId e action são obrigatórios.' });
    }

    const conversation = await Conversation.findOne({ where: { id: chatId, empresa_id: empresaId } });
    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversa não encontrada.' });
    }
    if (conversation.source !== 'whatsapp') {
      return res.status(400).json({ success: false, error: 'Ação disponível apenas para conversas WhatsApp.' });
    }

    const resolvedDeviceId = deviceId || conversation.device_id;
    if (!resolvedDeviceId) {
      return res.status(400).json({ success: false, error: 'Dispositivo não encontrado para a conversa.' });
    }

    let result;
    switch (action) {
      case 'archive':
        result = await whatsappManager.setChatArchiveState(resolvedDeviceId, chatId, true, empresaId);
        break;
      case 'unarchive':
        result = await whatsappManager.setChatArchiveState(resolvedDeviceId, chatId, false, empresaId);
        break;
      case 'block':
        if (conversation.is_group) {
          return res.status(400).json({ success: false, error: 'Não é possível bloquear grupos.' });
        }
        result = await whatsappManager.setContactBlockState(resolvedDeviceId, chatId, true, empresaId);
        break;
      case 'rename':
        result = await whatsappManager.renameConversation(resolvedDeviceId, chatId, newName, empresaId, conversation.toJSON ? conversation.toJSON() : conversation);
        break;
      default:
        return res.status(400).json({ success: false, error: 'Ação inválida.' });
    }

    res.json({ success: true, updates: result?.update || {} });
  } catch (error) {
    console.error('Erro ao executar ação da conversa:', error);
    res.status(500).json({ success: false, error: error.message || 'Erro ao executar ação.' });
  }
});

module.exports = router;
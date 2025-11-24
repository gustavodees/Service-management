const express = require('express');
const router = express.Router();
const sequelize = require('./banco');
const { QueryTypes } = require('sequelize');
const verificaAutenticacao = require('./verificaAutenticacao');
const Tabulacao = require('./Tabulacao'); // Adicionado
const Usuario = require('./Usuario'); // Adicionado
const whatsappManager = require('./whatsappManager'); // Adicionado
const WhatsappMedia = require('./WhatsappMedia'); // Adicionado

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

    // Query otimizada para buscar a última mensagem de cada conversa (chatId)
    // para uma empresa específica.
    const query = `
      SELECT
          m.chatId as id,
          c.name,
          c.profile_pic_url as profilePicUrl,
          m.body as lastMessage,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE chatId = m.chatId AND fromMe = 0 AND empresa_id = :empresaId) as unreadCount,
          c.is_group as isGroup,
          'whatsapp' as source,
          m.deviceId
      FROM
          whatsapp_messages m
      LEFT JOIN
          conversations c ON m.chatId = c.id
      WHERE
          m.id IN (
              SELECT
                  MAX(id)
              FROM
                  whatsapp_messages
              WHERE
                empresa_id = :empresaId
              GROUP BY
                  chatId
          )
      ORDER BY
          m.timestamp DESC;
    `;

    const contacts = await sequelize.query(query, {
      replacements: { empresaId },
      type: QueryTypes.SELECT
    });

    console.log(`[API /contacts] Query retornou ${contacts.length} contatos para a empresa ${empresaId}.`);
    res.json(contacts);

  } catch (error) {
    console.error('Erro ao buscar contatos via API:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao buscar contatos.' });
  }
});

/**
 * Rota: GET /api/tabulacoes
 * Busca todas as conversas tabuladas para a empresa do usuário logado.
 */
router.get('/tabulacoes', verificaAutenticacao, async (req, res) => {
  try {
    const { empresa_id } = req.session.usuario;
    if (!empresa_id) {
      return res.status(401).json({ error: 'Empresa não identificada.' });
    }

    const tabulacoes = await Tabulacao.findAll({
      where: { empresa_id },
      include: [{
        model: Usuario,
        attributes: ['nome'] // Inclui o nome do usuário que tabulou
      }],
      order: [['timestamp', 'DESC']]
    });

    res.json({ success: true, tabulacoes });
  } catch (error) {
    console.error('Erro ao buscar tabulações:', error);
    res.status(500).json({ success: false, error: 'Erro ao buscar tabulações.' });
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

module.exports = router;
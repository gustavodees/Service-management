const express = require('express');
const router = express.Router();
const sequelize = require('./banco');
const { QueryTypes } = require('sequelize');
const verificaAutenticacao = require('./verificaAutenticacao');

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

module.exports = router;
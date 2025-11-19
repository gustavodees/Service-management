const express = require('express');
const router = express.Router();
// CORRIGIDO: Aponta para o arquivo de conexão do banco de dados correto (sequelize)
const db = require('./banco'); 

/**
 * Rota: GET /api/contacts
 * 
 * Busca uma lista consolidada de contatos/conversas para a tela de atendimento.
 * Esta rota é ideal para o carregamento inicial da página.
 * 
 * Retorna um array de objetos de contato, cada um com:
 * - id: Identificador único da conversa (ex: 'whatsapp:5511999998888@c.us')
 * - name: Nome do contato ou do grupo.
 * - profilePicUrl: URL da foto de perfil (pode ser null).
 * - lastMessage: O conteúdo da última mensagem.
 * - timestamp: A data/hora da última mensagem em formato ISO.
 * - unreadCount: Número de mensagens não lidas.
 * - isGroup: Booleano indicando se é um grupo.
 * - source: Origem da conversa ('whatsapp' ou 'chatbot').
 * - deviceId: ID do dispositivo associado (para contatos do WhatsApp).
 */
router.get('/contacts', async (req, res) => {
  try {
    console.log('[API /contacts] Rota acessada.');

    // Validação de autenticação (exemplo)
    if (!req.session || !req.session.usuario || !req.session.usuario.id) {
      console.warn('[API /contacts] Acesso negado: Sessão ou usuário não encontrado.');
      return res.status(401).json({ error: 'Não autorizado' });
    }

    const empresaId = req.session.usuario.empresa_id;
    console.log(`[API /contacts] Buscando contatos para empresa_id: ${empresaId}`);

    // Exemplo de query SQL para buscar contatos.
    // Você precisará adaptar esta query para a estrutura real da sua tabela de contatos/conversas.
    const query = `
      SELECT 
        c.id, 
        c.name, 
        c.profile_pic_url AS profilePicUrl,
        c.last_message AS lastMessage,
        c.timestamp,
        c.unread_count AS unreadCount,
        c.is_group AS isGroup,
        c.source,
        c.device_id AS deviceId
      FROM conversations c
      WHERE c.empresa_id = ?
      ORDER BY c.timestamp DESC
    `;

    // CORRIGIDO: A sintaxe db.promise().query() é para mysql2.
    // A sintaxe correta para executar uma query raw com Sequelize é db.query().
    const [contacts] = await db.query(query, { replacements: [empresaId] });

    console.log(`[API /contacts] Query retornou ${contacts.length} contatos.`);

    res.json(contacts);
  } catch (error) {
    console.error('Erro ao buscar contatos via API:', error);
    res.status(500).json({ error: 'Erro interno do servidor ao buscar contatos.' });
  }
});

module.exports = router;
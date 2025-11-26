/**
 * SCRIPT PARA LIMPEZA DE DADOS DE ATENDIMENTO
 *
 * ATENÇÃO: Este script apagará PERMANENTEMENTE todos os dados das tabelas:
 * - conversations
 * - whatsapp_media
 * - whatsapp_messages
 * - whatsapp_devices
 *
 * Use com cuidado. Faça backup antes de prosseguir e sempre execute com a
 * aplicação parada para evitar corrupção de sessão.
 *
 * Como usar:
 * 1. Pare a aplicação principal (nodemon/node).
 * 2. No terminal, na raiz do projeto, execute: node clear-data.js
 * 3. Aguarde a mensagem de conclusão.
 * 4. Inicie a aplicação novamente.
 */

require('dotenv').config();
const sequelize = require('./routes/banco');

// Importa os modelos para que o Sequelize saiba quais tabelas limpar
const Conversation = require('./routes/Conversation');
const WhatsappDevice = require('./routes/whatsappDevice');
const WhatsappMedia = require('./routes/WhatsappMedia');
const WhatsappMessage = require('./routes/WhatsappMessage');

/**
 * Remove todo o conteúdo das tabelas de atendimento, desabilitando os checkes de
 * chave estrangeira temporariamente para evitar erros de ordem de exclusão.
 * Ideal para resetar ambientes de homologação com grande volume de mensagens.
 */
async function clearTables() {
  console.log('Iniciando a limpeza das tabelas de atendimento...');

  try {
    // Desativa temporariamente a verificação de chaves estrangeiras para evitar erros de ordem
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { raw: true });

    // Limpa as tabelas usando o método truncate, que é mais rápido para apagar todos os dados
    await Conversation.truncate();
    console.log('Tabela "conversations" limpa.');
    await WhatsappMedia.truncate();
    console.log('Tabela "whatsapp_media" limpa.');
    await WhatsappMessage.truncate();
    console.log('Tabela "whatsapp_messages" limpa.');
    await WhatsappDevice.truncate();
    console.log('Tabela "whatsapp_devices" limpa.');

    console.log('\nLimpeza concluída com sucesso!');
  } catch (error) {
    console.error('\nOcorreu um erro durante a limpeza:', error);
  } finally {
    // Reativa a verificação de chaves estrangeiras e fecha a conexão
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { raw: true });
    await sequelize.close();
  }
}

// Executa a função principal quando o script é chamado via CLI
clearTables();
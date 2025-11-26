/**
 * Router placeholder mantido temporariamente por compatibilidade com pontos do
 * código que ainda importam `./whatsapp`. Todos os métodos expostos aqui apenas
 * logam uso legado para facilitar o rastreamento até que o módulo seja removido.
 */
const express = require('express');
const router = express.Router();

console.warn('Legacy whatsapp.js carregado. Remover após migração completa para whatsappManager.');

/**
 * Função no-op utilizada como fallback para APIs antigas.
 */
function doNothing() {
  console.log('Legacy whatsapp.js function called. This should be refactored.');
}

const dummyClients = () => ({});
const dummySet = new Set();
const dummyLastMassSend = {};

router.getClients = dummyClients;
router.chatsTabulados = dummySet;
router.removerTabulacaoSeExistir = doNothing;
router.setLastMassSend = doNothing;
router.clearTabulationsForUser = doNothing;
router.getAllContacts = () => [];
router.getLastMassSend = () => dummyLastMassSend;
/**
 * Upgrade handler legado — apenas alerta quando o fluxo antigo é acionado.
 */
router.handleUpgrade = (request, socket, head, wss) => {
  console.log('Legacy whatsapp.js handleUpgrade called. This indicates a configuration problem.');
};

module.exports = router;

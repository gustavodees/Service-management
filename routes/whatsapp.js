const express = require('express');
const router = express.Router();



console.log('--- WARNING: Legacy whatsapp.js module loaded. This should be removed after refactoring users.js ---');

function doNothing() {
  console.log('Legacy whatsapp.js function called. This should be refactored.');
  return;
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
router.handleUpgrade = (request, socket, head, wss) => {
  // This is intentionally left blank. The upgrade is handled in app.js
  console.log('Legacy whatsapp.js handleUpgrade called. This indicates a configuration problem.');
};

module.exports = router;

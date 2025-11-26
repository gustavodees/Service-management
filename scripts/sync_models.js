/**
 * Script rápido para sincronizar (alter) os principais models relacionados ao
 * WhatsApp. Utilize em migrações leves sem precisar subir toda a aplicação.
 */
const sequelize = require('../routes/banco');
const WhatsappMessage = require('../routes/WhatsappMessage');
const WhatsappMedia = require('../routes/WhatsappMedia');
const WhatsappDevice = require('../routes/whatsappDevice');
const Tabulacao = require('../routes/Tabulacao');

(async () => {
  try {
    await sequelize.authenticate();
    console.log('DB conectado. Sincronizando modelos (alter = true)...');
    await Promise.all([
      WhatsappMessage.sync({ alter: true }),
      WhatsappMedia.sync({ alter: true }),
      WhatsappDevice.sync({ alter: true }),
      Tabulacao.sync({ alter: true })
    ]);
    console.log('Sincronização concluída.');
    process.exit(0);
  } catch (err) {
    console.error('Erro ao sincronizar modelos:', err);
    process.exit(1);
  }
})();
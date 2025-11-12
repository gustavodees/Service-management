const path = require('path');
const sequelize = require('../routes/banco');
const { Op } = require('sequelize');
const WhatsappMessage = require('../routes/WhatsappMessage');
const WhatsappMedia = require('../routes/WhatsappMedia');

async function migrate() {
  console.log('Conectando ao DB...');
  await sequelize.authenticate();

  // Seleciona mensagens media que ainda têm base64 em whatsapp_messages.data
  const msgs = await WhatsappMessage.findAll({
    where: {
      type: 'media',
      data: { [Op.ne]: null }
    },
    order: [['timestamp', 'ASC']]
  });

  console.log(`Encontradas ${msgs.length} mensagens media com base64 em whatsapp_messages.`);

  let moved = 0;
  for (const m of msgs) {
    try {
      const messageId = m.id;
      // verifica se já existe whatsapp_media para essa mensagem
      const exists = await WhatsappMedia.findOne({ where: { messageId, chatId: m.chatId, deviceId: m.deviceId } });
      if (exists) {
        // apenas zerar o campo data na mensagem principal
        await m.update({ data: null });
        continue;
      }

      const base64 = m.data;
      const size = base64 ? Buffer.from(base64, 'base64').length : null;

      await WhatsappMedia.create({
        messageId,
        chatId: m.chatId,
        deviceId: m.deviceId,
        userId: m.userId || 0,
        filename: m.filename || null,
        mimetype: m.mimetype || null,
        size,
        data: base64 || null,
        timestamp: m.timestamp || Math.floor(Date.now() / 1000)
      });

      // remove base64 do whatsapp_messages
      await m.update({ data: null });

      moved++;
      if (moved % 50 === 0) console.log(`Migradas ${moved}/${msgs.length}`);
    } catch (err) {
      console.error('Erro migrando mensagem', m && m.id, err && err.message);
    }
  }

  console.log(`Migração concluída. Movidas: ${moved}`);
  await sequelize.close();
}

migrate().catch(err => {
  console.error('Falha na migração:', err);
  process.exit(1);
});
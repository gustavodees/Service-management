/**
 * Script utilitário que retro preenche `userId` em mensagens e mídias usando o
 * relacionamento registrado nos dispositivos. Execute via `node scripts/fill...`.
 */
const path = require('path');
const sequelize = require('../routes/banco');
const { Op } = require('sequelize');
const WhatsappMessage = require('../routes/WhatsappMessage');
const WhatsappMedia = require('../routes/WhatsappMedia');
const ChatbotDevice = require('../routes/chatbotDevice');
const WhatsappDevice = require('../routes/whatsappDevice');

/**
 * Obtém o usuário dono do device consultando tabelas de chatbot e WhatsApp.
 */
async function findUserIdForDevice(deviceId) {
  if (!deviceId) return null;
  let dev = await ChatbotDevice.findOne({ where: { device_id: deviceId } });
  if (dev && (dev.user_id || dev.userId)) return dev.user_id || dev.userId;
  dev = await WhatsappDevice.findOne({ where: { device_id: deviceId } });
  if (dev && (dev.user_id || dev.userId)) return dev.user_id || dev.userId;
  return null;
}

/**
 * Executa a varredura dos devices pendentes e atualiza as tabelas.
 */
async function run() {
  console.log('Conectando ao DB...');
  await sequelize.authenticate();

  // pega deviceIds distintos nas mensagens onde userId é null ou 0
  const msgs = await WhatsappMessage.findAll({
    where: {
      [Op.or]: [{ userId: null }, { userId: 0 }]
    },
    attributes: ['deviceId'],
    group: ['deviceId'],
    raw: true
  });

  const deviceIds = msgs.map(r => r.deviceId).filter(Boolean);
  console.log(`Encontrados ${deviceIds.length} deviceIds com userId NULL/0`);

  let updatedMessages = 0;
  let updatedMedias = 0;

  for (const deviceId of deviceIds) {
    try {
      const userId = await findUserIdForDevice(deviceId);
      if (!userId) {
        console.log(`Nenhum userId encontrado para deviceId=${deviceId}, pulando.`);
        continue;
      }

      // atualiza whatsapp_messages
      const [countMsg] = await WhatsappMessage.update(
        { userId },
        { where: { deviceId, [Op.or]: [{ userId: null }, { userId: 0 }] } }
      );

      // atualiza whatsapp_media
      const [countMedia] = await WhatsappMedia.update(
        { userId },
        { where: { deviceId, [Op.or]: [{ userId: null }, { userId: 0 }] } }
      );

      updatedMessages += countMsg || 0;
      updatedMedias += countMedia || 0;

      console.log(`deviceId=${deviceId} -> userId=${userId} (mensagens:${countMsg}, midias:${countMedia})`);
    } catch (err) {
      console.error('Erro atualizando deviceId', deviceId, err && err.message);
    }
  }

  console.log(`Atualizado: messages=${updatedMessages}, media=${updatedMedias}`);
  await sequelize.close();
}

run().catch(err => {
  console.error('Erro no script:', err);
  process.exit(1);
});
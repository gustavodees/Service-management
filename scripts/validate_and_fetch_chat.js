// Script: valida um chat transferido e, se faltar histórico, tenta baixar via WhatsApp client e persistir no DB.
// Uso: node scripts/validate_and_fetch_chat.js --chatId=5511xxxxxx@c.us --deviceId=chatbot_xxx --minMessages=5
const path = require('path');
const argv = require('yargs').argv;
const sequelize = require('../routes/banco');
const WhatsappMessage = require('../routes/WhatsappMessage');
const WhatsappMedia = require('../routes/WhatsappMedia');
const ChatbotDevice = require('../routes/chatbotDevice');
const WhatsappDevice = require('../routes/whatsappDevice');
const { Client, LocalAuth } = require('whatsapp-web.js');

const chatId = argv.chatId || null;
const deviceId = argv.deviceId || null;
const minMessages = parseInt(argv.minMessages || 5, 10);

if (!chatId || !deviceId) {
  console.error('Parâmetros obrigatórios faltando. Exemplo: --chatId=5511xxxxxx@c.us --deviceId=chatbot_xxx');
  process.exit(1);
}

function _tsToSeconds(ts) {
  try {
    if (!ts) return Math.floor(Date.now() / 1000);
    const n = Number(ts);
    if (!Number.isFinite(n)) {
      const d = Date.parse(ts);
      return isNaN(d) ? Math.floor(Date.now() / 1000) : Math.floor(d / 1000);
    }
    if (n > 1e11) return Math.floor(n / 1000);
    return Math.floor(n);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

async function findUserIdForDevice(deviceId) {
  if (!deviceId) return 0;
  let dev = await ChatbotDevice.findOne({ where: { device_id: deviceId } });
  if (dev && (dev.user_id || dev.userId)) return dev.user_id || dev.userId;
  dev = await WhatsappDevice.findOne({ where: { device_id: deviceId } });
  if (dev && (dev.user_id || dev.userId)) return dev.user_id || dev.userId;
  return 0;
}

async function saveMessageToDb(chatId, item, deviceIdParam) {
  try {
    const deviceIdFinal = deviceIdParam || item.deviceId || '';
    const ts = _tsToSeconds(item.timestamp || item.ts || Date.now());
    const id = item.id || `${chatId}_${ts}_${(item.role || item.fromMe ? 'a' : 'u')}_${(item.filename || '').slice(0,20)}`.replace(/\s+/g, '_');
    const userId = await findUserIdForDevice(deviceIdFinal);

    if (item.type === 'media' || item.type === 'audio' || item.type === 'video') {
      const exists = await WhatsappMessage.findByPk(id);
      if (!exists) {
        await WhatsappMessage.create({
          id,
          chatId,
          deviceId: deviceIdFinal,
          userId,
          body: item.content || item.body || null,
          fromMe: !!item.fromMe,
          type: 'media',
          mimetype: item.mimetype || null,
          filename: item.filename || null,
          data: null,
          timestamp: ts
        });
      }
      const existsMedia = await WhatsappMedia.findOne({ where: { messageId: id, chatId, deviceId: deviceIdFinal } });
      if (!existsMedia) {
        await WhatsappMedia.create({
          messageId: id,
          chatId,
          deviceId: deviceIdFinal,
          userId,
          filename: item.filename || null,
          mimetype: item.mimetype || null,
          size: item.data ? Buffer.from(item.data, 'base64').length : null,
          data: item.data || null,
          timestamp: ts
        });
      }
      return id;
    } else {
      const existsText = await WhatsappMessage.findByPk(id);
      if (!existsText) {
        await WhatsappMessage.create({
          id,
          chatId,
          deviceId: deviceIdFinal,
          userId,
          body: item.content || item.body || '',
          fromMe: !!item.fromMe || (item.role === 'assistant'),
          type: item.type || 'chat',
          mimetype: null,
          filename: null,
          data: null,
          timestamp: ts
        });
      }
      return id;
    }
  } catch (err) {
    console.warn('saveMessageToDb erro:', err && err.message ? err.message : err);
    return null;
  }
}

async function main() {
  try {
    console.log('Conectando ao DB...');
    await sequelize.authenticate();

    const existingCount = await WhatsappMessage.count({ where: { chatId } });
    console.log(`Mensagens existentes no DB para ${chatId}: ${existingCount}`);

    if (existingCount >= minMessages) {
      console.log('Já há mensagens suficientes no DB. Saindo.');
      await sequelize.close();
      process.exit(0);
    }

    console.log('Inicializando client WhatsApp para device:', deviceId);
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: deviceId }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    let ready = false;
    client.on('ready', () => {
      ready = true;
      console.log('Client pronto.');
    });

    client.on('auth_failure', (msg) => {
      console.error('Auth failure:', msg);
    });

    await client.initialize();

    // espera até 30s por ready
    const waitUntilReady = async (timeoutMs = 30000) => {
      const start = Date.now();
      while (!ready && (Date.now() - start) < timeoutMs) {
        await new Promise(r => setTimeout(r, 500));
      }
      return ready;
    };

    const ok = await waitUntilReady(30000);
    if (!ok) {
      console.error('Client não ficou pronto em 30s. Encerrando client.');
      await client.destroy();
      await sequelize.close();
      process.exit(1);
    }

    // tenta obter o chat
    let chat = null;
    try {
      chat = await client.getChatById(chatId);
    } catch (e) {
      const chats = await client.getChats();
      chat = chats.find(c => c.id && (c.id._serialized === chatId || c.id === chatId));
    }

    if (!chat) {
      console.error('Chat não encontrado no client. Encerrando.');
      await client.destroy();
      await sequelize.close();
      process.exit(1);
    }

    console.log('Buscando mensagens do WhatsApp (limit 500)...');
    const messages = await chat.fetchMessages({ limit: 500 });
    console.log(`Mensagens baixadas: ${messages.length}`);

    // salvar cronologicamente (do mais antigo para o mais novo)
    for (const m of messages.reverse()) {
      try {
        const idSerialized = (m.id && m.id._serialized) ? m.id._serialized : `${chatId}_${m.timestamp}_${m.fromMe}`;
        const hasMedia = m.hasMedia;
        let base64 = null, mimetype = null, filename = null;
        if (hasMedia) {
          try {
            const media = await m.downloadMedia();
            if (media && media.data) {
              base64 = media.data;
              mimetype = media.mimetype || null;
              filename = media.filename || null;
            }
          } catch (err) {
            console.warn('Falha ao baixar mídia para mensagem', idSerialized, err && err.message);
          }
        }
        await saveMessageToDb(chatId, {
          id: idSerialized,
          content: m.body || null,
          type: m.type || (base64 ? 'media' : 'chat'),
          mimetype,
          filename,
          data: base64,
          fromMe: !!m.fromMe,
          timestamp: m.timestamp || Date.now()
        }, deviceId);
      } catch (err) {
        console.error('Erro salvando mensagem:', err && err.message ? err.message : err);
      }
    }

    const finalCount = await WhatsappMessage.count({ where: { chatId } });
    console.log(`Após fetch, mensagens no DB para ${chatId}: ${finalCount}`);

    await client.destroy();
    await sequelize.close();
    console.log('Concluído.');
    process.exit(0);
  } catch (err) {
    console.error('Erro no script:', err && err.message ? err.message : err);
    try { await sequelize.close(); } catch (_) {}
    process.exit(1);
  }
}

main();
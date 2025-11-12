const express = require('express');
const router = express.Router();
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); // <-- já existe Client/LocalAuth, garantir MessageMedia
const WhatsappDevice = require('./whatsappDevice');
const Tabulacao = require('./Tabulacao'); // No topo do arquivo
const WhatsappMessage = require('./WhatsappMessage'); // já existente
const WhatsappMedia = require('./WhatsappMedia'); // << ADICIONE ISTO
const { Op } = require('sequelize'); // adicione no topo
const clients = {}; // { deviceId: { client, isClientReady, userId } }
const connectedSockets = new Set();
const chatsTabulados = new Set();

// Armazenar contatos de todos os devices por device (escopo por usuário via clients[deviceId].userId)
const allDeviceContacts = {}; // { deviceId: [contatos] }
// Histórico de conversas agora particionado por deviceId para evitar vazamento entre usuários
const conversationHistory = {};

// Novo: último disparo por deviceId
const lastMassSend = {}; // { deviceId: ISOString }

// Helper para pegar o userId correto (considerando impersonação/admin)
function getHttpEffectiveUserId(req) {
  try {
    const sess = req.session || {};
    if (sess.usuario && sess.usuario.tipo === 'admin' && sess.impersonateUserId) {
      return sess.impersonateUserId;
    }
    return sess.usuario ? sess.usuario.id : null;
  } catch {
    return null;
  }
}

// Helpers de escopo por usuário
function getUserIdFromRequest(request) {
  // Se admin estiver impersonando um usuário, usar o ID do funcionário
  try {
    const sess = request.session || {};
    if (sess.usuario && sess.usuario.tipo === 'admin' && sess.impersonateUserId) {
      return sess.impersonateUserId;
    }
    return sess.usuario ? sess.usuario.id : null;
  } catch {
    return null;
  }
}
function getUserDeviceIds(userId) {
  return Object.keys(clients).filter(id => clients[id] && clients[id].userId === userId);
}
function getContactsByUser(userId) {
  const deviceIds = getUserDeviceIds(userId);
  return deviceIds.flatMap(id => allDeviceContacts[id] || []);
}
function broadcastToUser(userId, message) {
  connectedSockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws.userId === userId) {
      ws.send(JSON.stringify(message));
    }
  });
}
function broadcastToAtendimento(message, userId = null) {
  connectedSockets.forEach((ws) => {
    if (
      ws.readyState === WebSocket.OPEN &&
      ws.isAtendimento &&
      (userId === null || ws.userId === userId)
    ) {
      ws.send(JSON.stringify(message));
    }
  });
}

// Rota GET da página WhatsApp
router.get('/', (req, res) => {
  res.render('whatsapp', { title: 'Conectar WhatsApp - Sistema Malty' });
});

// Função auxiliar para gerar nomes de arquivo padrão
function getDefaultFilename(mimetype) {
  const timestamp = Date.now();

  if (!mimetype) return `arquivo_${timestamp}`;

  if (mimetype.startsWith('image/')) {
    const ext = mimetype.split('/')[1] || 'jpg';
    return `imagem_${timestamp}.${ext}`;
  } else if (mimetype.startsWith('video/')) {
    const ext = mimetype.split('/')[1] || 'mp4';
    return `video_${timestamp}.${ext}`;
  } else if (mimetype.startsWith('audio/')) {
    const ext = mimetype.split('/')[1] || 'mp3';
    return `audio_${timestamp}.${ext}`;
  } else if (mimetype === 'application/pdf') {
    return `documento_${timestamp}.pdf`;
  } else if (mimetype.includes('word')) {
    return `documento_${timestamp}.docx`;
  } else {
    return `arquivo_${timestamp}`;
  }
}

// Carrega (1x por usuário) os chats já tabulados do BD para o Set em memória
async function ensureUserTabuladosLoaded(userId) {
  try {
    if (!userId) return;
    // Se já houver registros no Set para alguns chats, ok; carregue do BD também
    const rows = await Tabulacao.findAll({ where: { user_id: userId }, attributes: ['chatId'] });
    rows.forEach(r => chatsTabulados.add(r.chatId));
  } catch (e) {
    console.error('Falha ao carregar tabulados do usuário:', e);
  }
}

// Ajuste: garanta que o filtro considere o BD antes de montar os contatos
async function sendChatsToAll(deviceId) {
  try {
    const clientObj = clients[deviceId];
    if (!clientObj) return;

    const userId = clientObj.userId;

    // 1) FAST PATH: montar lista inicial a partir do DB (última mensagem por chat)
    try {
      const rows = await WhatsappMessage.findAll({
        where: { deviceId },
        attributes: ['chatId', 'body', 'timestamp'],
        order: [['timestamp', 'DESC']],
        raw: true,
        limit: 2000
      });

      const latestByChat = new Map();
      for (const r of rows) {
        if (!r.chatId) continue;
        if (chatsTabulados.has(r.chatId)) continue; // manter comportamento original (não mostrar tabulados)
        if (!latestByChat.has(r.chatId)) {
          latestByChat.set(r.chatId, {
            id: r.chatId,
            name: r.chatId.replace('@c.us', ''),
            unreadCount: 0,
            deviceId,
            source: 'whatsapp',
            isGroup: false,
            lastMessage: r.body || 'Conversa ativa',
            timestamp: (r.timestamp || Math.floor(Date.now()/1000)) * 1000,
            history: []
          });
        }
      }

      const cachedList = Array.from(latestByChat.values()).sort((a,b) => (b.timestamp||0) - (a.timestamp||0));
      // envia imediatamente ao dono do device (UI mostra algo rápido)
      if (userId) {
        broadcastToUser(userId, { type: 'ready', status: 'WhatsApp conectado (cache rápido)', chats: cachedList, allContacts: cachedList, deviceId });
        broadcastToAtendimento({ type: 'whatsapp-contacts-updated', allContacts: cachedList, deviceId }, userId);
      }
      allDeviceContacts[deviceId] = cachedList;
    } catch (dbErr) {
      console.warn('sendChatsToAll fast-path DB falhou:', dbErr && dbErr.message ? dbErr.message : dbErr);
    }

    // 2) SLOW PATH (background): busca dados completos do client e broadcast quando pronto
    // não bloquear a resposta anterior
    (async () => {
      try {
        if (!clientObj.isClientReady || !clientObj.client) return;

        const chats = await clientObj.client.getChats();

        // filtrar e montar lista igual à versão original (remover tabulados)
        const chatList = chats
          .filter((chat) => !chatsTabulados.has(chat.id._serialized))
          .map((chat) => ({
            id: chat.id._serialized,
            name: chat.name || chat.formattedTitle || (chat.isGroup ? 'Grupo' : (chat.id && chat.id.user) || chat.id._serialized),
            unreadCount: chat.unreadCount || 0,
            deviceId,
            source: 'whatsapp',
            isGroup: !!chat.isGroup,
            lastMessage: (chat.lastMessage && chat.lastMessage.body) ? chat.lastMessage.body : 'Conversa ativa',
            timestamp: Date.now(),
            history: []
          }));

        allDeviceContacts[deviceId] = chatList;

        // broadcast completo para o usuário e para atendimento
        if (userId) {
          broadcastToUser(userId, { type: 'ready', status: 'WhatsApp conectado com sucesso!', chats: chatList, allContacts: chatList, deviceId });
          broadcastToAtendimento({ type: 'whatsapp-contacts-updated', allContacts: chatList, deviceId }, userId);
        }
      } catch (err) {
        console.error('sendChatsToAll slow-path erro:', err && err.message ? err.message : err);
      }
    })();

  } catch (error) {
    console.error('Erro em sendChatsToAll:', error);
    const userId = clients[deviceId] ? clients[deviceId].userId : null;
    if (userId) {
      broadcastToUser(userId, { type: 'error', status: 'Falha ao buscar chats', deviceId });
    }
  }
}

// Envia mensagem para todos os sockets conectados (apenas para eventos globais não sensíveis)
// Mantemos, mas evitamos usar para dados sensíveis de usuário
function broadcast(message) {
  connectedSockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      connectedSockets.delete(ws);
    }
  });
}

// Processa mídias recebidas e envia somente ao dono do device
async function processReceivedMedia(message, chatId, deviceId) {
  if (!message.hasMedia) return;

  try {
    const media = await message.downloadMedia();
    if (!media || !media.data) return;

    const idSerialized = message.id && message.id._serialized ? message.id._serialized : `${chatId}_${message.timestamp}_${message.fromMe}`;
    const userId = clients[deviceId] ? clients[deviceId].userId : null;

    // Salva/atualiza WhatsappMessage (mantendo data por compatibilidade UI)
    try {
      const existsMsg = await WhatsappMessage.findByPk(idSerialized);
      if (!existsMsg) {
        await WhatsappMessage.create({
          id: idSerialized,
          chatId,
          deviceId,
          userId,
          body: message.body || null,
          fromMe: !!message.fromMe,
          type: message.type || 'media',
          mimetype: media.mimetype || null,
          filename: media.filename || null,
          data: media.data,
          timestamp: normalizeTimestampBackend(message.timestamp || Date.now())
        });
      } else {
        // opcional: atualizar campos se for preciso
        if (!existsMsg.data && media.data) {
          await existsMsg.update({ data: media.data, mimetype: media.mimetype || null, filename: media.filename || null });
        }
      }
    } catch (dbErr) {
      console.error('Erro ao salvar WhatsappMessage para mídia:', dbErr);
    }

    // Salva também no WhatsappMedia (index e vínculo por user/device)
    try {
      // evitar duplicata por messageId + filename + size
      const maybe = await WhatsappMedia.findOne({
        where: {
          messageId: idSerialized,
          deviceId,
          chatId
        }
      });
      if (!maybe) {
        await WhatsappMedia.create({
          messageId: idSerialized,
          chatId,
          deviceId,
          userId,
          filename: media.filename || getDefaultFilename(media.mimetype),
          mimetype: media.mimetype || null,
          size: media.data ? Buffer.from(media.data, 'base64').length : null,
          data: media.data,
          timestamp: normalizeTimestampBackend(message.timestamp || Date.now())
        });
      }
    } catch (mErr) {
      console.error('Erro ao salvar WhatsappMedia:', mErr);
    }

    // broadcast existente
    const userIdMsg = clients[deviceId] ? clients[deviceId].userId : null;
    if (userIdMsg) {
      broadcastToAtendimento({
        type: 'new-message',
        chatId: chatId,
        message: {
          id: idSerialized,
          body: message.body || '',
          fromMe: message.fromMe,
          timestamp: normalizeTimestampBackend(message.timestamp),
          hasMedia: true,
          type: 'media',
          mimetype: media.mimetype,
          filename: media.filename || getDefaultFilename(media.mimetype),
          data: media.data
        },
        customerName: chatId.replace('@c.us', ''),
        deviceId: deviceId
      }, userIdMsg);
    }

  } catch (error) {
    console.error('Erro ao processar mídia recebida:', error);
  }
}

// Inicializa o cliente WhatsApp (associando ao userId)
function initializeWhatsAppClient(deviceId, userId) {
  // Só retorna o client se ele existe E está pronto
  if (clients[deviceId] && clients[deviceId].client && clients[deviceId].isClientReady) {
    return clients[deviceId].client;
  }
  // Se já está inicializando, retorna (evita criar múltiplos)
  if (clients[deviceId] && clients[deviceId].isInitializing) {
    return clients[deviceId].client || null;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: deviceId }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
      ],
      timeout: 60000
    },
  });

  // inicializa estrutura consistente
  clients[deviceId] = clients[deviceId] || {};
  clients[deviceId].client = client;
  clients[deviceId].isClientReady = false;
  clients[deviceId].userId = userId;
  clients[deviceId].isInitializing = true;
  clients[deviceId].qr = null;
  clients[deviceId].hasSession = clients[deviceId].hasSession || false;

  let deviceCreated = false;
  client.on('qr', async (qr) => {
    try {
      // se já autenticado ou pronto, ignorar QR
      const obj = clients[deviceId];
      if (!obj) return;
      if (obj.isClientReady || obj.hasSession) {
        obj.qr = null;
        return;
      }

      if (!deviceCreated) {
        deviceCreated = true;
        const exists = await WhatsappDevice.findOne({ where: { device_id: deviceId } });
        if (!exists) {
          await WhatsappDevice.create({
            device_id: deviceId,
            status: 'connecting',
            last_connected: new Date(),
            created_at: new Date(),
            user_id: userId
          });
        }
      }

      QRCode.toDataURL(
        qr,
        {
          margin: 3,
          scale: 8,
          errorCorrectionLevel: 'M',
          color: { dark: '#128C7E', light: '#FFFFFF' },
        },
        (err, url) => {
          if (err) {
            broadcastToUser(userId, { type: 'error', status: 'Falha ao gerar QR Code', deviceId });
            return;
          }
          // salva QR no objeto para rota /qrcode/:deviceId retornar também
          if (clients[deviceId]) clients[deviceId].qr = url;
          // broadcast para UI via WS (mantido)
          broadcastToUser(userId, {
            type: 'qr',
            qr: url,
            status: 'Escaneie o QR Code com o WhatsApp',
            deviceId
          });
        }
      );
    } catch (e) {
      console.warn('qr handler erro:', e && e.message ? e.message : e);
    }
  });

  client.on('authenticated', () => {
    // aponta que há sessão persistida (não devemos exibir QR depois disso)
    if (!clients[deviceId]) clients[deviceId] = {};
    clients[deviceId].hasSession = true;
    clients[deviceId].qr = null;
    const uid = clients[deviceId].userId;
    if (uid) broadcastToUser(uid, { type: 'authenticated', status: 'WhatsApp autenticado', deviceId });
  });

  client.on('ready', async () => {
    try {
      // marca imediatamente como pronto
      if (!clients[deviceId]) clients[deviceId] = {};
      clients[deviceId].isClientReady = true;
      clients[deviceId].qr = null;
      clients[deviceId].isInitializing = false;
      clients[deviceId].hasSession = true;

      // tenta extrair número/identificador do client (formas comuns)
      let detectedNumber = null;
      try {
        const info = client.info || {};
        detectedNumber = (info.wid && info.wid.user) || (info.me && (info.me._serialized || info.me.user)) || info.number || info.phone || null;
        // normalizar string se vier com sufixo
        if (typeof detectedNumber === 'string') {
          detectedNumber = detectedNumber.replace(/@.*$/,'');
        }
      } catch (e) {
        detectedNumber = null;
      }

      // atualiza cache em memória
      if (detectedNumber) clients[deviceId].number = detectedNumber;

      // broadcast rápido informando conexão
      const quickInfo = client.info || {};
      const quickNumber = detectedNumber || (quickInfo.wid && quickInfo.wid.user) || null;
      const uid = clients[deviceId].userId;
      if (uid) {
        broadcastToUser(uid, {
          type: 'whatsapp-connected',
          status: 'WhatsApp conectado com sucesso!',
          number: quickNumber,
          deviceId
        });
      }

      // salvamento persistente (tenta atualizar DB com o número conhecido)
      (async () => {
        try {
          if (detectedNumber) {
            await WhatsappDevice.update(
              { number: detectedNumber, status: 'connected', last_connected: new Date() },
              { where: { device_id: deviceId } }
            ).catch(()=>{});
          } else {
            await WhatsappDevice.update(
              { status: 'connected', last_connected: new Date() },
              { where: { device_id: deviceId } }
            ).catch(()=>{});
          }

          // sincronização pesada em background
          await sendChatsToAll(deviceId);
        } catch (bgErr) {
          console.error('Background sync após ready falhou:', bgErr && bgErr.message ? bgErr.message : bgErr);
        }
      })();

    } catch (e) {
      console.error('Erro no ready handler:', e && e.message ? e.message : e);
    }
  });

  client.on('auth_failure', (msg) => {
    if (clients[deviceId]) {
      clients[deviceId].isClientReady = false;
      clients[deviceId].isInitializing = false;
      clients[deviceId].qr = null;
    }
    const uid = clients[deviceId] ? clients[deviceId].userId : null;
    if (uid) broadcastToUser(uid, { type: 'auth_failure', status: `Falha na autenticação: ${msg}`, deviceId });
  });

  client.on('disconnected', async (reason) => {
    try {
      if (clients[deviceId]) {
        clients[deviceId].isClientReady = false;
        clients[deviceId].client = null;
        clients[deviceId].qr = null;
        clients[deviceId].isInitializing = false;
        // manter hasSession true para evitar reexibir QR desnecessário
      }
      const uid = clients[deviceId] ? clients[deviceId].userId : null;
      if (uid) broadcastToUser(uid, { type: 'disconnected', status: `WhatsApp desconectado: ${reason}`, deviceId });
      delete allDeviceContacts[deviceId];
      await WhatsappDevice.update({ status: 'disconnected' }, { where: { device_id: deviceId } }).catch(()=>{});
    } catch (e) {
      console.warn('erro no disconnected handler:', e && e.message ? e.message : e);
    }
  });

  client.on('message', async (message) => {
    try {
      const deviceObj = clients[deviceId];
      if (!deviceObj || !deviceObj.isClientReady) return;
      const userId = deviceObj.userId;
      const chatId = message.from || (message.to && message.to.includes('@c.us') ? message.to : null);
      if (!chatId) return;

      // Salva mensagem no banco
      const idSerialized = message.id && message.id._serialized ? message.id._serialized : `${chatId}_${message.timestamp}_${message.fromMe}`;
      let data = null, mimetype = null, filename = null;
      if (message.hasMedia) {
        const media = await message.downloadMedia();
        if (media && media.data) {
          data = media.data;
          mimetype = media.mimetype;
          filename = media.filename || null;
        }
      }

      // Salva no WhatsappMessage
      const exists = await WhatsappMessage.findByPk(idSerialized);
      if (!exists) {
        await WhatsappMessage.create({
          id: idSerialized,
          chatId,
          deviceId,
          userId,
          body: message.body || null,
          fromMe: !!message.fromMe,
          type: message.type || (data ? 'media' : 'chat'),
          mimetype,
          filename,
          data,
          timestamp: normalizeTimestampBackend(message.timestamp || Date.now())
        });
      }

      // Se for mídia, salva também no WhatsappMedia
      if (data) {
        const existsMedia = await WhatsappMedia.findOne({ where: { messageId: idSerialized, deviceId, chatId } });
        if (!existsMedia) {
          await WhatsappMedia.create({
            messageId: idSerialized,
            chatId,
            deviceId,
            userId,
            filename: filename || getDefaultFilename(mimetype),
            mimetype: mimetype || null,
            size: data ? Buffer.from(data, 'base64').length : null,
            data: data,
            timestamp: normalizeTimestampBackend(message.timestamp || Date.now())
          });
        }
      }

      // Remove tabulação se necessário
      await removerTabulacaoSeExistir(userId, chatId);

      // Broadcast para o frontend via WebSocket
      if (userId) {
        broadcastToAtendimento({
          type: 'new-message',
          chatId: chatId,
          message: {
            id: idSerialized,
            body: message.body || '',
            fromMe: message.fromMe,
            timestamp: normalizeTimestampBackend(message.timestamp),
            hasMedia: !!data,
            type: message.type || (data ? 'media' : 'chat'),
            mimetype,
            filename,
            data
          },
          customerName: chatId.replace('@c.us', ''),
          deviceId: deviceId
        }, userId);
      }
    } catch (err) {
      console.error('Erro ao processar mensagem recebida:', err);
    }
  });

  client.initialize();
  return client;
}

// Buscar mensagens com mídias incluídas (agora somente via DB / on-demand)
async function getChatMessages(chatId, limit = 30, deviceId) {
  try {
    if (!deviceId) throw new Error('deviceId obrigatório para buscar mensagens');

    // Primeiro tenta ler do BD
    const dbMessages = await WhatsappMessage.findAll({
      where: { deviceId, chatId },
      order: [['timestamp', 'ASC']],
      limit
    });

    if (dbMessages && dbMessages.length > 0) {
      return dbMessages.map(m => ({
        id: m.id,
        body: m.body,
        fromMe: !!m.fromMe,
        timestamp: m.timestamp,
        hasMedia: !!m.data,
        type: m.type || (m.data ? 'media' : 'chat'),
        mimetype: m.mimetype || null,
        filename: m.filename || null,
        data: m.data || null
      }));
    }

    // Se não houver mensagens no DB, e houver client, tenta buscar do WhatsApp (sem guardar em memória)
    if (clients[deviceId] && clients[deviceId].isClientReady) {
      const client = clients[deviceId].client;
      try {
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit });

        const processed = [];
        for (const m of messages) {
          let messageData = {
            id: m.id && m.id._serialized ? m.id._serialized : `${chatId}_${m.timestamp}_${m.fromMe}`,
            body: m.body,
            fromMe: m.fromMe,
            timestamp: normalizeTimestampBackend(m.timestamp),
            hasMedia: m.hasMedia || false,
          };

          if (m.hasMedia) {
            try {
              const media = await m.downloadMedia();
              if (media && media.data) {
                messageData.type = 'media';
                messageData.mimetype = media.mimetype;
                messageData.filename = media.filename || getDefaultFilename(media.mimetype);
                messageData.data = media.data;
              }
            } catch (error) {
              console.error('Erro ao baixar mídia do histórico (fetch):', error);
            }
          } else {
            messageData.type = 'chat';
          }

          processed.push(messageData);
        }

        processed.sort((a, b) => a.timestamp - b.timestamp);
        return processed.slice(-limit);
      } catch (err) {
        console.error('Erro ao buscar mensagens diretamente do client:', err);
      }
    }

    return [];
  } catch (error) {
    console.error('Erro ao buscar mensagens:', error);
    return [];
  }
}

// Enviar mídia com histórico (por deviceId)
async function sendMediaMessage(chatId, media, deviceId, options = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Tentativa ${attempt} de envio de mídia...`);

      if (!clients[deviceId] || !clients[deviceId].isClientReady) {
        throw new Error(`Cliente ${deviceId} não está conectado`);
      }

      const client = clients[deviceId].client;
      const chat = await client.getChatById(chatId);
      if (!chat) throw new Error('Chat não encontrado');

      const result = await chat.sendMessage(media, options);

      // Salva a mídia enviada no WhatsappMessage (já existente)
      // e também no WhatsappMedia para indexação por usuário/device
      try {
        const userId = clients[deviceId] ? clients[deviceId].userId : null;
        const idSerialized = result.id && result.id._serialized ? result.id._serialized : `${chatId}_${Date.now()}_out`;

        const exists = await WhatsappMessage.findByPk(idSerialized);
        if (!exists) {
          await WhatsappMessage.create({
            id: idSerialized,
            chatId: message.chatId,
            deviceId,
            userId: clients[deviceId].userId,
            body: `[Mídia enviada] ${media.filename || 'arquivo_enviado'}`,
            fromMe: true,
            type: 'media',
            mimetype: media.mimetype || null,
            filename: media.filename || null,
            data: media.data || null,
            timestamp: Math.floor(Date.now() / 1000)
          });
        }

        // WhatsappMedia
        const existsMedia = await WhatsappMedia.findOne({ where: { messageId: idSerialized, deviceId, chatId } });
        if (!existsMedia) {
          await WhatsappMedia.create({
            messageId: idSerialized,
            chatId,
            deviceId,
            userId,
            filename: media.filename || getDefaultFilename(media.mimetype),
            mimetype: media.mimetype || null,
            size: media.data ? Buffer.from(media.data, 'base64').length : null,
            data: media.data || null,
            timestamp: Math.floor(Date.now() / 1000)
          });
        }
      } catch (dbErr) {
        console.error('Erro ao salvar mídia enviada no DB:', dbErr);
      }

      const mediaData = {
        fromMe: true,
        filename: media.filename || 'arquivo_enviado',
        mimetype: media.mimetype,
        data: media.data,
        timestamp: Math.floor(Date.now() / 1000)
      };

      const userId = clients[deviceId].userId;
      broadcastToAtendimento({
        type: 'media-sent-broadcast',
        chatId: chatId,
        message: {
          id: result.id._serialized,
          body: `[Mídia enviada] ${media.filename}`,
          fromMe: true,
          timestamp: Math.floor(Date.now() / 1000),
          hasMedia: true,
          type: 'media',
          mimetype: media.mimetype,
          filename: media.filename,
          data: media.data
        },
        deviceId: deviceId
      }, userId);

      return result;

    } catch (error) {
      console.error(`Erro na tentativa ${attempt}:`, error.message);

      const isVideo = media?.mimetype?.startsWith('video/');
      const alreadyAsDocument = options && options.sendMediaAsDocument === true;

      if (isVideo && !alreadyAsDocument) {
        console.warn('Falha ao enviar como mídia. Tentando enviar como documento...');
        options = { ...(options || {}), sendMediaAsDocument: true };
        continue;
      }

      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Função para remover tabulação ao receber ou enviar mensagem
async function removerTabulacaoSeExistir(userId, chatId) {
  if (!userId || !chatId) return;
  await Tabulacao.destroy({ where: { user_id: userId, chatId } });
  chatsTabulados.delete(chatId);

  // Notifica o front para reexibir no atendimento
  const deviceIds = getUserDeviceIds(userId);
  let chosenDevice = deviceIds.find(id => allDeviceContacts[id]) || deviceIds[0] || null;
  let contactObj = {
    id: chatId,
    name: chatId.replace('@c.us', ''),
    unreadCount: 0,
    deviceId: chosenDevice || null,
    source: 'whatsapp',
    lastMessage: 'Conversa reaberta',
    timestamp: Date.now(),
    history: []
  };
  if (chosenDevice) {
    allDeviceContacts[chosenDevice] = allDeviceContacts[chosenDevice] || [];
    if (!allDeviceContacts[chosenDevice].some(c => c.id === chatId)) {
      allDeviceContacts[chosenDevice].push(contactObj);
    }
  }
  broadcastToAtendimento({ type: 'chat-returned', contact: contactObj }, userId);
}

// Manipulador de upgrade do WebSocket
function handleUpgrade(request, socket, head, wss) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    connectedSockets.add(ws);

    // Anexa userId do socket via sessão
    ws.userId = getUserIdFromRequest(request) || null;

    if (request.url && request.url.includes('atendimento')) {
      ws.isAtendimento = true;

      // Envia apenas contatos do usuário deste socket
      if (ws.userId) {
        const contacts = getContactsByUser(ws.userId);
        if (contacts.length > 0) {
          ws.send(JSON.stringify({
            type: 'all-whatsapp-contacts',
            contacts
          }));
        }
      }
    }

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        let deviceId = message.deviceId;

        const userId = ws.userId;

        switch (message.type) {
          case 'connect': {
            if (!userId) {
              ws.send(JSON.stringify({ type: 'error', status: 'Usuário não autenticado.' }));
              break;
            }
            if (!deviceId) {
              deviceId = Date.now().toString() + Math.floor(Math.random() * 10000);
              ws.send(JSON.stringify({ type: 'device-id', deviceId }));
            }
            // Impede reutilizar um deviceId de outro usuário
            if (clients[deviceId] && clients[deviceId].userId !== userId) {
              ws.send(JSON.stringify({ type: 'error', status: 'Este device pertence a outro usuário.' }));
              break;
            }
            if (!clients[deviceId]) {
              initializeWhatsAppClient(deviceId, userId);
            }
            ws.send(JSON.stringify({ type: 'connect', deviceId }));
            break;
          }

          case 'get-all-contacts': {
            const contacts = userId ? getContactsByUser(userId) : [];
            ws.send(JSON.stringify({
              type: 'all-contacts',
              contacts
            }));
            break;
          }

          case 'disconnect': {
            if (!deviceId) {
              ws.send(JSON.stringify({ type: 'error', status: 'deviceId obrigatório para desconectar.' }));
              break;
            }
            // Autoriza apenas se o device é do usuário
            if (!clients[deviceId] || clients[deviceId].userId !== userId) {
              ws.send(JSON.stringify({ type: 'error', status: 'Sem permissão para desconectar este device.' }));
              break;
            }
            if (clients[deviceId].client) {
              try { await clients[deviceId].client.destroy(); } catch { }
              clients[deviceId].client = null;
              clients[deviceId].isClientReady = false;
              delete allDeviceContacts[deviceId];
              broadcastToUser(userId, { type: 'disconnected', status: 'WhatsApp desconectado', deviceId });
              await WhatsappDevice.update(
                { status: 'disconnected' },
                { where: { device_id: deviceId } }
              );
            }
            break;
          }

          case 'status': {
            const clientObj = deviceId ? clients[deviceId] : null;
            // Garante que o usuário só veja status do seu device
            const allowed = clientObj && clientObj.userId === userId;
            ws.send(JSON.stringify({
              type: 'status',
              isReady: allowed ? clientObj.isClientReady : false,
              status: allowed && clientObj.isClientReady ? 'Conectado' : 'Desconectado',
              deviceId
            }));
            if (allowed && clientObj.isClientReady) {
              await sendChatsToAll(deviceId);
            }
            break;
          }

          case 'get-messages': {
            // Seleciona device do usuário se não informado
            if (!deviceId) {
              const userDevices = getUserDeviceIds(userId).filter(id => clients[id] && clients[id].isClientReady);
              deviceId = userDevices[0];
            }

            const allowed = deviceId && clients[deviceId] && clients[deviceId].userId === userId;
            if (!allowed || !clients[deviceId] || !clients[deviceId].isClientReady) {
              ws.send(JSON.stringify({ type: 'messages', chatId: message.chatId, messages: [], deviceId }));
              break;
            }

            try {
              // parâmetros ajustáveis do front (minMessages, limit)
              const minMessages = (typeof message.minMessages === 'number') ? message.minMessages : 10;
              const limit = (typeof message.limit === 'number') ? message.limit : 50;

              // Função inteligente: retorna do BD se suficiente; caso contrário baixa do WA, salva e retorna
              const msgs = await fetchAndSaveMessagesIfNeeded(deviceId, message.chatId, userId, minMessages, limit);

              // Padroniza payload enviado ao front
              const payload = msgs.map(m => ({
                id: m.id,
                body: m.body,
                fromMe: !!m.fromMe,
                type: m.type,
                mimetype: m.mimetype,
                filename: m.filename,
                data: m.data,
                timestamp: m.timestamp
              }));

              ws.send(JSON.stringify({ type: 'messages', chatId: message.chatId, messages: payload, deviceId }));
            } catch (err) {
              console.error('Erro ao processar get-messages:', err);
              ws.send(JSON.stringify({ type: 'messages', chatId: message.chatId, messages: [], deviceId }));
            }
            break;
          }

          case 'send-message': {
            // Seleciona device do usuário se não informado
            if (!deviceId) {
              const userDevices = getUserDeviceIds(userId).filter(id => clients[id].isClientReady);
              deviceId = userDevices[0];
            }
            if (!deviceId || !clients[deviceId] || clients[deviceId].userId !== userId) {
              ws.send(JSON.stringify({
                type: 'error',
                status: 'WhatsApp não conectado ou device não pertence ao usuário.',
                availableDevices: getUserDeviceIds(userId)
              }));
              break;
            }

            try {
              if (!message.chatId || !message.body) {
                throw new Error('ChatId ou mensagem vazia');
              }

              const sentMessage = await clients[deviceId].client.sendMessage(message.chatId, message.body);

              // Salva mensagem enviada no DB (evita perder histórico)
              try {
                const idSerialized = sentMessage.id && sentMessage.id._serialized ? sentMessage.id._serialized : `${message.chatId}_${Date.now()}_out`;
                const exists = await WhatsappMessage.findByPk(idSerialized);
                if (!exists) {
                  await WhatsappMessage.create({
                    id: idSerialized,
                    chatId: message.chatId,
                    deviceId,
                    userId: clients[deviceId].userId,
                    body: message.body,
                    fromMe: true,
                    type: sentMessage.type || 'chat',
                    mimetype: sentMessage.mimetype || null,
                    filename: sentMessage.filename || null,
                    data: null,
                    timestamp: Math.floor(Date.now() / 1000)
                  });
                }
              } catch (dbErr) {
                console.error('Erro ao salvar mensagem enviada no DB:', dbErr);
              }

              // Se estava tabulado, remove ao disparar mensagem
              if (userId && chatsTabulados.has(message.chatId)) {
                await removerTabulacaoSeExistir(userId, message.chatId);
              }

              ws.send(JSON.stringify({
                type: 'message-sent',
                chatId: message.chatId,
                success: true,
                messageId: sentMessage.id._serialized,
                deviceId
              }));

              // Broadcast para outros atendentes do mesmo usuário
              connectedSockets.forEach((socket) => {
                if (socket.readyState === WebSocket.OPEN && socket.isAtendimento && socket !== ws && socket.userId === userId) {
                  socket.send(JSON.stringify({
                    type: 'message-sent-broadcast',
                    chatId: message.chatId,
                    message: {
                      id: sentMessage.id._serialized,
                      body: message.body,
                      fromMe: true,
                      type: 'chat',
                      timestamp: Math.floor(Date.now() / 1000)
                    },
                    deviceId
                  }));
                }
              });

            } catch (err) {
              console.error('Erro ao enviar mensagem:', err);
              ws.send(JSON.stringify({
                type: 'error',
                status: `Erro ao enviar mensagem: ${err.message}`,
                chatId: message.chatId,
                deviceId
              }));
            }
            break;
          }

          case 'send-audio': {
            if (!deviceId) {
              const userDevices = getUserDeviceIds(userId).filter(id => clients[id].isClientReady);
              deviceId = userDevices[0];
            }
            if (!deviceId || !clients[deviceId] || clients[deviceId].userId !== userId) {
              ws.send(JSON.stringify({
                type: 'error',
                status: 'WhatsApp não conectado ou device não pertence ao usuário.',
                availableDevices: getUserDeviceIds(userId)
              }));
              break;
            }

            try {
              if (!message.chatId || !message.audioData) {
                throw new Error('ChatId ou dados de áudio ausentes');
              }

              const audioMedia = new MessageMedia(
                'audio/ogg; codecs=opus',
                message.audioData,
                'audio_message.ogg'
              );

              const sentMessage = await clients[deviceId].client.sendMessage(message.chatId, audioMedia);

              const audioFileName = `audio_${Date.now()}_${sentMessage.id._serialized.replace(/[^a-zA-Z0-9]/g, '_')}.ogg`;
              const fs = require('fs');
              const path = require('path');

              const audioDir = path.join(__dirname, '..', 'public', 'audio');
              if (!fs.existsSync(audioDir)) {
                fs.mkdirSync(audioDir, { recursive: true });
              }

              const audioPath = path.join(audioDir, audioFileName);
              const audioBuffer = Buffer.from(message.audioData, 'base64');
              fs.writeFileSync(audioPath, audioBuffer);

              ws.send(JSON.stringify({
                type: 'audio-sent',
                chatId: message.chatId,
                success: true,
                messageId: sentMessage.id._serialized,
                audioUrl: `/audio/${audioFileName}`,
                deviceId
              }));

              // Se estava tabulado, remove ao disparar áudio
              if (userId && chatsTabulados.has(message.chatId)) {
                await removerTabulacaoSeExistir(userId, message.chatId);
              }

              // Broadcast para outros atendentes do mesmo usuário
              connectedSockets.forEach((socket) => {
                if (socket.readyState === WebSocket.OPEN && socket.isAtendimento && socket !== ws && socket.userId === userId) {
                  socket.send(JSON.stringify({
                    type: 'audio-sent-broadcast',
                    chatId: message.chatId,
                    message: {
                      id: sentMessage.id._serialized,
                      body: '[Áudio]',
                      fromMe: true,
                      type: 'ptt',
                      timestamp: Math.floor(Date.now() / 1000),
                      audioUrl: `/audio/${audioFileName}`,
                      mimetype: 'audio/ogg; codecs=opus',
                      filename: audioFileName
                    },
                    deviceId
                  }));
                }
              });

            } catch (err) {
              console.error('Erro ao enviar áudio:', err);
              ws.send(JSON.stringify({
                type: 'error',
                status: `Erro ao enviar áudio: ${err.message}`,
                chatId: message.chatId,
                deviceId
              }));
            }
            break;
          }

          case 'send-media': {
            if (!deviceId) {
              const userDevices = getUserDeviceIds(userId).filter(id => clients[id].isClientReady);
              deviceId = userDevices[0];
            }
            if (!deviceId || !clients[deviceId] || clients[deviceId].userId !== userId) {
              ws.send(JSON.stringify({
                type: 'error',
                status: 'WhatsApp não conectado ou device não pertence ao usuário.',
                availableDevices: getUserDeviceIds(userId)
              }));
              break;
            }

            try {
              if (!message.chatId || !message.data) {
                throw new Error('ChatId ou dados de mídia ausentes');
              }

              const supportedTypes = [
                'image/jpeg','image/jpg','image/png','image/gif','image/bmp','image/svg+xml',
                'video/mp4','video/3gpp','video/3gp',
                'application/pdf','application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'audio/mp3','audio/mpeg','audio/ogg',
                'text/csv','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              ];
              if (!supportedTypes.includes(message.mimetype)) {
                throw new Error(`Tipo de arquivo não suportado: ${message.mimetype}`);
              }

              const base64CleanLen = message.data.replace(/[^A-Za-z0-9+/=]/g, '').length;
              const padding = (message.data.endsWith('==') ? 2 : message.data.endsWith('=') ? 1 : 0);
              const bytes = Math.floor(base64CleanLen * 3 / 4) - padding;

              let options = {};
              if (message.mimetype.startsWith('video/')) {
                if (bytes > 64 * 1024 * 1024) {
                  throw new Error('Vídeo acima de 64MB não é suportado pelo WhatsApp Web.');
                }
                const waAllowedVideo = ['video/mp4', 'video/3gpp', 'video/3gp'];
                if (!waAllowedVideo.includes(message.mimetype)) {
                  options.sendMediaAsDocument = true;
                }
                if (bytes > 16 * 1024 * 1024) {
                  options.sendMediaAsDocument = true;
                }
              }

              const media = new MessageMedia(
                message.mimetype,
                message.data,
                message.filename
              );

              const sentMessage = await sendMediaMessage(message.chatId, media, deviceId, options);

              // Após envio, tente recuperar o registro criado no DB para enviar o payload final
              try {
                const messageIdSerialized = sentMessage.id && sentMessage.id._serialized ? sentMessage.id._serialized : null;
                let msgRecord = null;
                if (messageIdSerialized) {
                  msgRecord = await WhatsappMessage.findByPk(messageIdSerialized);
                }
                let payloadMessage = null;
                if (msgRecord) {
                  payloadMessage = {
                    id: msgRecord.id,
                    body: msgRecord.body,
                    fromMe: !!msgRecord.fromMe,
                    type: msgRecord.type || (msgRecord.data ? 'media' : 'chat'),
                    mimetype: msgRecord.mimetype,
                    filename: msgRecord.filename,
                    data: msgRecord.data,
                    timestamp: msgRecord.timestamp
                  };
                } else {
                  // fallback a partir do media enviado (pode ser grande)
                  payloadMessage = {
                    id: sentMessage.id._serialized,
                    body: `[Mídia enviada] ${message.filename || ''}`,
                    fromMe: true,
                    type: 'media',
                    mimetype: message.mimetype || null,
                    filename: message.filename || null,
                    data: message.data || null,
                    timestamp: Math.floor(Date.now() / 1000)
                  };
                }

                // devolve ao cliente o payload completo + tempId recebido (se houver)
                ws.send(JSON.stringify({
                  type: 'media-sent',
                  chatId: message.chatId,
                  success: true,
                  message: payloadMessage,
                  deviceId,
                  tempId: message.tempId || null
                }));
              } catch (dbErr) {
                console.error('Erro ao recuperar/salvar payload pós-envio:', dbErr);
                // enviar resposta simples se falhar
                ws.send(JSON.stringify({
                  type: 'media-sent',
                  chatId: message.chatId,
                  success: true,
                  messageId: sentMessage.id._serialized,
                  deviceId,
                  tempId: message.tempId || null
                }));
              }
            } catch (err) {
              console.error('Erro ao enviar mídia:', err);

              const friendly =
                (String(err.message || err).includes('Evaluation failed') ?
                  'Falha do WhatsApp Web ao enviar. Tente MP4/3GP e/ou envie como documento (até 64MB).' :
                  err.message || 'Erro desconhecido');

              ws.send(JSON.stringify({
                type: 'error',
                status: `Erro ao enviar mídia: ${friendly}`,
                chatId: message.chatId,
                deviceId
              }));
            }
            break;
          }

          // NOVO: Adicionado para o status "Digitando..."
          case 'typing-start': {
            if (!deviceId || !clients[deviceId] || clients[deviceId].userId !== userId || !clients[deviceId].isClientReady) {
              break; // Ignora silenciosamente se o cliente não estiver pronto ou não autorizado
            }
            try {
              const client = clients[deviceId].client;
              const chat = await client.getChatById(message.chatId);
              if (chat) {
                await chat.sendStateTyping();
              }
            } catch (err) {
              console.error(`Erro ao definir status 'digitando' para ${message.chatId}:`, err.message);
            }
            break;
          }

          // NOVO: Adicionado para limpar o status da conversa
          case 'typing-stop':
          case 'recording-stop': { // Unificado, pois ambos limpam o estado
            if (!deviceId || !clients[deviceId] || clients[deviceId].userId !== userId || !clients[deviceId].isClientReady) {
              break; // Ignora
            }
            try {
              const client = clients[deviceId].client;
              const chat = await client.getChatById(message.chatId);
              if (chat) {
                await chat.clearState();
              }
            } catch (err) {
              console.error(`Erro ao limpar status para ${message.chatId}:`, err.message);
            }
            break;
          }

          // NOVO: Adicionado para o status "Gravando áudio..."
          case 'recording-start': {
            if (!deviceId || !clients[deviceId] || clients[deviceId].userId !== userId || !clients[deviceId].isClientReady) {
              break; // Ignora
            }
            try {
              const client = clients[deviceId].client;
              const chat = await client.getChatById(message.chatId);
              if (chat) {
                await chat.sendStateRecording();
              }
            } catch (err) {
              console.error(`Erro ao definir status 'gravando' para ${message.chatId}:`, err.message);
            }
            break;
          }

          case 'list-devices': {
            const devices = getUserDeviceIds(userId).map(id => ({
              deviceId: id,
              isReady: clients[id] ? clients[id].isClientReady : false,
              hasClient: !!clients[id]
            }));
            ws.send(JSON.stringify({
              type: 'device-list',
              devices
            }));
            break;
          }

          default:
            ws.send(JSON.stringify({ type: 'error', status: 'Tipo de mensagem não reconhecido' }));
        }
      } catch (error) {
        console.error('Erro no WebSocket:', error);
        ws.send(JSON.stringify({ type: 'error', status: 'Erro interno do servidor', deviceId: null }));
      }
    });

    ws.on('close', () => {
      connectedSockets.delete(ws);
    });

    ws.on('error', () => {
      connectedSockets.delete(ws);
    });
  });
}

/**
 * Garante que haja mensagens no BD para um chat. Se houver menos que minMessages,
 * baixa as últimas `limit` mensagens do WhatsApp, salva e retorna as mensagens do BD.
 */
async function fetchAndSaveMessagesIfNeeded(deviceId, chatId, userId, minMessages = 10, limit = 50) {
    // Conta mensagens existentes
    const existingCount = await WhatsappMessage.count({ where: { deviceId, chatId } });

    if (existingCount >= minMessages) {
        // Já tem histórico suficiente -> retorna do BD
        const dbMessages = await WhatsappMessage.findAll({
            where: { deviceId, chatId },
            order: [['timestamp', 'ASC']],
            limit: 1000
        });
        return dbMessages.map(m => m.toJSON());
    }

    // Tenta pegar client
    const clientWrapper = clients[deviceId];
    if (!clientWrapper || !clientWrapper.client) {
        // Sem client -> retorna o que tem no BD (mesmo que pouco)
        const dbMessages = await WhatsappMessage.findAll({
            where: { deviceId, chatId },
            order: [['timestamp', 'ASC']]
        });
        return dbMessages.map(m => m.toJSON());
    }
    const client = clientWrapper.client;

    try {
        // Obter chat e mensagens do WhatsApp
        let chat;
        try {
            chat = await client.getChatById(chatId);
        } catch (err) {
            // fallback: buscar em client.getChats()
            const chats = await client.getChats();
            chat = chats.find(c => c.id._serialized === chatId);
        }
        if (!chat) return [];

        const messages = await chat.fetchMessages({ limit });

        for (const m of messages.reverse()) { // reverse para inserir na ordem cronológica
            try {
                // Evitar duplicatas por PK
                const idSerialized = (m.id && m.id._serialized) ? m.id._serialized : `${chatId}_${m.timestamp}_${m.fromMe}`;
                const exists = await WhatsappMessage.findByPk(idSerialized);
                if (exists) continue;

                let dataBase64 = null;
                let mimetype = null;
                let filename = null;
                if (m.hasMedia) {
                    try {
                        const media = await m.downloadMedia();
                        if (media && media.data) {
                            dataBase64 = media.data;
                            mimetype = media.mimetype || null;
                            filename = media.filename || null;
                        }
                    } catch (e) {
                        console.error('Erro ao baixar mídia para mensagem', idSerialized, e);
                    }
                }

                await WhatsappMessage.create({
                    id: idSerialized,
                    chatId,
                    deviceId,
                    userId,
                    body: m.body || null,
                    fromMe: !!m.fromMe,
                    type: m.type || null,
                    mimetype,
                    filename,
                    data: dataBase64,
                    timestamp: normalizeTimestampBackend(m.timestamp || Date.now())
                });
            } catch (e) {
                console.error('Erro ao salvar mensagem inicial:', e);
            }
        }

        // Retorna mensagens agora do BD (ordenadas)
        const dbMessages = await WhatsappMessage.findAll({
            where: { deviceId, chatId },
            order: [['timestamp', 'ASC']]
        });
        return dbMessages.map(m => m.toJSON());

    } catch (err) {
        console.error('Erro ao buscar mensagens do WhatsApp:', err);
        const dbMessages = await WhatsappMessage.findAll({
            where: { deviceId, chatId },
            order: [['timestamp', 'ASC']]
        });
        return dbMessages.map(m => m.toJSON());
    }
}



// Rota para obter contatos apenas do usuário logado
router.get('/all-contacts', (req, res) => {
  const userId = req.session && req.session.usuario ? req.session.usuario.id : null;
  if (!userId) return res.status(401).json({ success: false, message: 'Não autenticado' });
  const contacts = getContactsByUser(userId);
  res.json({ success: true, contacts });
});

// Rota para status de todos os devices do usuário
router.get('/all-status', async (req, res) => {
  try {
    // PEGAR O USUÁRIO LOGADO
    const userId = req.session && req.session.usuario ? req.session.usuario.id : null;
    if (!userId) return res.status(401).json({ success: false, devices: [] });

    // FILTRAR APENAS DEVICES DO USUÁRIO
    const dbDevices = await WhatsappDevice.findAll({ where: { user_id: userId } }).catch(() => []);
    const devices = (dbDevices || []).map(d => {
      const dv = (d && d.dataValues) ? d.dataValues : d || {};
      const deviceId = dv.device_id || dv.deviceId || String(dv.id || '');
      const number = dv.number || dv.numero || dv.telefone || dv.phone || dv.phone_number || dv.last_number || dv.last_known_number || dv.lastNumber || dv.savedNumber || dv.msisdn || dv.whatsapp_number || null;
      const status = dv.status || 'unknown';
      const lastConnected = dv.last_connected || dv.lastConnected || null;
      const isReady = !!(clients[deviceId] && clients[deviceId].isClientReady);
      return { deviceId, number, status, isReady, lastConnected };
    });

    // inclua clients em memória que não estejam no BD, MAS SÓ DO USUÁRIO LOGADO
    for (const id of Object.keys(clients)) {
      if (clients[id] && clients[id].userId === userId && !devices.find(x => x.deviceId === id)) {
        const c = clients[id] || {};
        const inferredNumber = c.number || c.savedNumber || null;
        const inferredStatus = c.isClientReady ? 'connected' : (c.qr ? 'connecting' : 'disconnected');
        devices.push({
          deviceId: id,
          number: inferredNumber,
          status: inferredStatus,
          isReady: !!c.isClientReady,
          lastConnected: null
        });
      }
    }

    // tenta extrair número de client.info se ainda não tiver número
    for (const dev of devices) {
      if (!dev.number) {
        const c = clients[dev.deviceId];
        if (c && c.client && c.client.info) {
          const info = c.client.info;
          const possible = (info.wid && info.wid.user) || (info.me && (info.me._serialized || info.me.user)) || info.number || info.phone || null;
          if (possible) {
            dev.number = String(possible).replace(/@.*$/,'');
            // opcional: persistir no DB para aparecer após restart
            try {
              await WhatsappDevice.update({ number: dev.number }, { where: { device_id: dev.deviceId } }).catch(()=>{});
            } catch (_) {}
          }
        }
      }
    }

    return res.json({ success: true, devices });
  } catch (err) {
    console.error('GET /whatsapp/all-status erro:', err && err.message ? err.message : err);
    return res.json({ success: false, devices: [] });
  }
});

// Rota para remover device (apenas do usuário dono)
router.delete('/remove-device', async (req, res) => {
  const userId = req.session && req.session.usuario ? req.session.usuario.id : null;
  if (!userId) return res.status(401).json({ success: false, message: 'Não autenticado' });

  const { deviceId } = req.query;
  if (!deviceId) return res.json({ success: false, message: 'deviceId obrigatório' });

  try {
    const deviceRow = await WhatsappDevice.findOne({ where: { device_id: deviceId, user_id: userId } });
    if (!deviceRow) {
      return res.status(403).json({ success: false, message: 'Device não pertence ao usuário.' });
    }

    await WhatsappDevice.destroy({ where: { device_id: deviceId, user_id: userId } });

    if (clients[deviceId]) {
      if (clients[deviceId].client) {
        try { await clients[deviceId].client.destroy(); } catch { }
      }
      delete clients[deviceId];
    }
    delete allDeviceContacts[deviceId];
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Rota para buscar áudio específico (sem mudança de escopo; arquivo público por caminho)
router.post('/get-audio', async (req, res) => {
  try {
    const { messageId, chatId } = req.body;

    if (!messageId || !chatId) {
      return res.json({ success: false, error: 'MessageId e ChatId são obrigatórios' });
    }

    const fs = require('fs');
    const path = require('path');

    const audioDir = path.join(__dirname, '..', 'public', 'audio');

    if (!fs.existsSync(audioDir)) {
      return res.json({ success: false, error: 'Diretório de áudios não encontrado' });
    }

    const files = fs.readdirSync(audioDir);
    const audioFile = files.find(file => file.includes(messageId.replace(/[^a-zA-Z0-9]/g, '_')));

    if (audioFile) {
      const audioUrl = `/audio/${audioFile}`;
      res.json({ success: true, audioUrl: audioUrl });
    } else {
      const deviceIds = Object.keys(clients);
      let audioFound = false;

      for (const deviceId of deviceIds) {
        const clientObj = clients[deviceId];
        if (clientObj && clientObj.isClientReady) {
          try {
            const chat = await clientObj.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 50 });
            const targetMessage = messages.find(msg => msg.id._serialized === messageId);

            if (targetMessage && targetMessage.hasMedia && (targetMessage.type === 'ptt' || targetMessage.type === 'audio')) {
              const media = await targetMessage.downloadMedia();
              if (media && media.data) {
                const audioFileName = `audio_${targetMessage.timestamp}_${messageId.replace(/[^a-zA-Z0-9]/g, '_')}.ogg`;
                const audioPath = path.join(audioDir, audioFileName);
                const audioBuffer = Buffer.from(media.data, 'base64');
                fs.writeFileSync(audioPath, audioBuffer);

                const audioUrl = `/audio/${audioFileName}`;
                res.json({ success: true, audioUrl: audioUrl });
                audioFound = true;
                break;
              }
            }
          } catch (error) {
            console.error(`Erro ao buscar áudio do device ${deviceId}:`, error);
          }
        }
      }

      if (!audioFound) {
        res.json({ success: false, error: 'Áudio não encontrado' });
      }
    }

  } catch (error) {
    console.error('Erro ao buscar áudio:', error);
    res.json({ success: false, error: error.message });
  }
});

// GET /whatsapp/tabulacoes -> lista tabulações do usuário logado, agrupadas por status
router.get('/tabulacoes', async (req, res) => {
  try {
    const userId = getHttpEffectiveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Não autenticado' });
    }

    const rows = await Tabulacao.findAll({
      where: { user_id: userId },
      order: [['timestamp', 'DESC']]
    });

    const grouped = {
      'aniversariantes': [],
      'sem-possibilidade': [],
      'conversa-inativa': [],
      'mudancas-cadastrais': [],
      'negocio-fechado': [],
      'sem-interesse': []
    };

    for (const r of rows) {
      const item = {
        chatId: r.chatId,
        tabulacao: r.tabulacao,
        detalhes: r.detalhes,
        observacoes: r.observacoes,
        dataAniversariante: r.data_aniversariante, // usado no front
        timestamp: r.timestamp
      };
      if (!grouped[item.tabulacao]) grouped[item.tabulacao] = [];
      grouped[item.tabulacao].push(item);
    }

    res.json({ success: true, tabulacoes: grouped });
  } catch (e) {
    console.error('Erro ao listar tabulações:', e);
    res.status(500).json({ success: false, message: 'Erro ao listar tabulações' });
  }
});

// GET /whatsapp/media?messageId=...&chatId=...
router.get('/media', async (req, res) => {
  try {
    const { messageId, chatId } = req.query;
    if (!messageId && !chatId) return res.json({ success: false, error: 'messageId ou chatId obrigatório' });

    // Prioriza tabela whatsapp_media
    let mediaRow = null;
    if (messageId) {
      mediaRow = await WhatsappMedia.findOne({ where: { messageId } });
    }
    // fallback por chatId/filename if needed
    if (!mediaRow && messageId) {
      const msg = await WhatsappMessage.findByPk(messageId);
      if (msg && msg.data) {
        return res.json({ success: true, data: msg.data, mimetype: msg.mimetype, filename: msg.filename || `arquivo_${messageId}` });
      }
    }
    if (!mediaRow && chatId) {
      mediaRow = await WhatsappMedia.findOne({ where: { chatId } });
    }
    if (!mediaRow) return res.json({ success: false, error: 'Mídia não encontrada' });

    res.json({ success: true, data: mediaRow.data, mimetype: mediaRow.mimetype, filename: mediaRow.filename });
  } catch (err) {
    console.error('Erro /whatsapp/media:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro interno' });
  }
});

router.handleUpgrade = handleUpgrade;
router.getClients = () => clients;
// Mantém export; se precisar por usuário, use rotas /all-contacts
router.getAllContacts = () => Object.values(allDeviceContacts).flat();

// Novos exports utilitários para último disparo
router.getLastMassSend = () => lastMassSend;
router.setLastMassSend = (deviceId, when) => {
  try {
    lastMassSend[deviceId] = (when instanceof Date) ? when.toISOString() : new Date(when).toISOString();
  } catch {
    lastMassSend[deviceId] = new Date().toISOString();
  }
};

// POST /whatsapp/tabular
router.post('/tabular', async (req, res) => {
  try {
    const userId = getHttpEffectiveUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Não autenticado' });

    const { chatId, tabulacao, detalhes, observacoes, aniversarioData } = req.body || {};
    if (!chatId || !tabulacao) return res.status(400).json({ success: false, message: 'chatId e tabulacao são obrigatórios' });
    if (tabulacao === 'aniversariantes' && !aniversarioData) {
      return res.status(400).json({ success: false, message: 'Data do aniversariante é obrigatória para esta tabulação.' });
    }

    await Tabulacao.create({
      user_id: userId, chatId, tabulacao,
      detalhes: detalhes || null,
      observacoes: observacoes || null,
      data_aniversariante: aniversarioData || null,
      timestamp: new Date()
    });

    // Marcar e remover da memória para o usuário atual (todas as conexões/devices dele)
    chatsTabulados.add(chatId);
    getUserDeviceIds(userId).forEach(id => {
      if (allDeviceContacts[id]) {
        allDeviceContacts[id] = allDeviceContacts[id].filter(c => c.id !== chatId);
      }
    });

    // Notificar telas de atendimento deste usuário para remover o chat
    broadcastToAtendimento({ type: 'chat-tabulated', chatId, tabulacao }, userId);

    res.json({ success: true });
  } catch (e) {
    console.error('Erro ao tabular:', e);
    res.status(500).json({ success: false, message: 'Erro ao tabular conversa' });
  }
});

// Novo: POST /whatsapp/tabular/retornar -> volta chat ao atendimento
router.post('/tabular/retornar', async (req, res) => {
  try {
    const userId = getHttpEffectiveUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Não autenticado' });

    const { chatId } = req.body || {};
    if (!chatId) return res.status(400).json({ success: false, message: 'chatId é obrigatório' });

    // Remove todos os registros deste chat para o usuário (ou adapte para apenas o último)
    await Tabulacao.destroy({ where: { user_id: userId, chatId } });

    // Desmarcar para voltar a aparecer
    chatsTabulados.delete(chatId);

    // Recolocar o contato na lista do primeiro device do usuário (se existir)
    const deviceIds = getUserDeviceIds(userId);
    let chosenDevice = deviceIds.find(id => allDeviceContacts[id]) || deviceIds[0] || null;

    let contactObj = {
      id: chatId,
      name: chatId.replace('@c.us', ''),
      unreadCount: 0,
      deviceId: chosenDevice || null,
      source: 'whatsapp',
      lastMessage: 'Conversa reaberta',
      timestamp: Date.now(),
      history: []
    };

    if (chosenDevice) {
      allDeviceContacts[chosenDevice] = allDeviceContacts[chosenDevice] || [];
      if (!allDeviceContacts[chosenDevice].some(c => c.id === chatId)) {
        allDeviceContacts[chosenDevice].push(contactObj);
      }
    }

    // Notificar telas de atendimento do usuário para re-adicionar
    broadcastToAtendimento({ type: 'chat-returned', contact: contactObj }, userId);

    res.json({ success: true });
  } catch (e) {
    console.error('Erro ao retornar chat ao atendimento:', e);
    res.status(500).json({ success: false, message: 'Erro ao retornar chat ao atendimento' });
  }
});

// Novo: normalização de timestamp para garantir seconds (evita mistura ms/s)
function normalizeTimestampBackend(ts) {
  const n = Number(ts) || 0;
  if (n === 0) return Math.floor(Date.now() / 1000);
  // se parece estar em ms (>= 1e10..1e11), converte para segundos
  if (n > 1e11) return Math.floor(n / 1000);
  if (n > 1e10) return Math.floor(n / 1000);
  return Math.floor(n);
}

// nova função para inicializar cliente (fora do router)
const path = require('path');
const { safeRm } = require('../utils/safeRmSession');

async function initClientForDevice(deviceId) {
  const authDir = path.join(__dirname, '..', '.wwebjs_auth', `session-${deviceId}`);
  // opcional: se detectar necessidade de reset, tente remover com retry
  // await safeRm(authDir);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: String(deviceId) /* nome único por device */ }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  client.on('disconnected', async (reason) => {
    try {
      // tenta destruir e remover sessão com retry quando desconectar
      await client.destroy();
      await safeRm(authDir);
    } catch (e) {
      console.warn('Falha ao remover sessão após disconnect:', e && e.code);
    }
  });

  // Caso seja necessário forçar limpeza manual (logout/reset), use esta rotina:
  async function resetSession() {
    try {
      // tenta destruir o client antes de mexer nos arquivos
      if (!client.info || client.info) {
        // se o client estiver inicializado, tentar destruir
        try { await client.destroy(); } catch (_) { /* ignora */ }
      }
    } catch (_) {}

    try {
      await safeRm(authDir);
    } catch (err) {
      console.warn('resetSession: falha ao remover sessão:', err && err.code ? err.code : err);
      throw err;
    }
  }

  // expõe método utilitário no objeto (útil para chamadas externas)
  client.resetSession = resetSession;

  await client.initialize();
  return client;
}

// Exemplo de uso (adapte ao seu código atual que gerencia múltiplos devices):
// const client = await initClientForDevice(deviceId);
// clientsMap[deviceId] = { client, userId, isClientReady: true };

// Rota QR: inicializa client se necessário e aguarda QR / ready (similar ao chatbot)
router.get('/qrcode/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  try {
    // inicializa client se necessário
    if (!clients[deviceId] || !clients[deviceId].client) {
      // tenta inicializar com o userId associado (se houver)
      const userRow = await WhatsappDevice.findOne({ where: { device_id: deviceId } }).catch(()=>null);
      const userId = userRow ? userRow.user_id : null;
      initializeWhatsAppClient(deviceId, userId);
    }

    const start = Date.now();
    const timeout = 15000;
    const pollInterval = 400;

    while (Date.now() - start < timeout) {
      const c = clients[deviceId];
      if (c) {
        // se já autenticado/ready, não há QR — informe pronto
        if (c.isClientReady) {
          return res.json({ success: true, qr: null, isReady: true });
        }
        // caso seu código produza e envie QR via broadcast, você pode retornar null aqui
        // mas se quiser o QR via rota, você precisaria armazená-lo em clients[deviceId].qr no evento 'qr'
        if (c.qr) {
          return res.json({ success: true, qr: c.qr, isReady: false });
        }
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    const final = clients[deviceId];
    if (final && final.qr) {
      return res.json({ success: true, qr: final.qr, isReady: !!final.isClientReady });
    }
    return res.json({ success: false, qr: null, isReady: !!(final && final.isClientReady) });
  } catch (err) {
    console.error('Erro /whatsapp/qrcode:', err && err.message ? err.message : err);
    return res.json({ success: false, qr: null, error: err && err.message ? err.message : 'erro' });
  }
});
 
// Força inicialização do client para um device (chamada pelo front ao abrir a página)
router.post('/start/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  try {
    if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId obrigatório' });

    // tenta localizar userId associado no BD (se existir)
    let userRow = null;
    try { userRow = await WhatsappDevice.findOne({ where: { device_id: deviceId } }); } catch(_) { userRow = null; }
    const userId = userRow ? userRow.user_id : (clients[deviceId] ? clients[deviceId].userId : null);

    // chama inicialização — função já existente; se já estiver inicializando/ready, ela é idempotente
    initializeWhatsAppClient(deviceId, userId);

    return res.json({ success: true, started: true, deviceId });
  } catch (err) {
    console.error('POST /whatsapp/start erro:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: err && err.message ? err.message : 'erro' });
  }
});

// Cria um novo deviceId e inicia o client (chamada pela UI quando não existe deviceId)
router.post('/new-device', async (req, res) => {
  try {
    const userId = req.session && req.session.usuario ? req.session.usuario.id : null;
    const deviceId = Date.now().toString() + Math.floor(Math.random() * 10000);
    // tenta criar registro no BD (não falha se já existir)

    try {
      await WhatsappDevice.create({
        device_id: deviceId,
        status: 'connecting',
        last_connected: new Date(),
        created_at: new Date(),
        user_id: userId
      });
    } catch (e) {
      // ignora erros de criação (por exemplo se tabela tiver trigger/constraints)
    }
    // inicializa client de forma idempotente
    initializeWhatsAppClient(deviceId, userId);
    return res.json({ success: true, deviceId });
  } catch (err) {
    console.error('POST /whatsapp/new-device erro:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: err && err.message ? err.message : 'erro' });
  }
});

// tenta extrair número de telefone a partir da pasta de sessão do LocalAuth (.wwebjs_auth/session-<deviceId>)
async function extractNumberFromAuthDir(deviceId) {
  try {
    const authRoot = path.join(__dirname, '..', '.wwebjs_auth', `session-${deviceId}`);
    if (!fs.existsSync(authRoot)) return null;

    const files = [];
    (function walk(dir) {
      try {
        const entries = fs.readdirSync(dir);
        for (const e of entries) {
          const p = path.join(dir, e);
          const stat = fs.statSync(p);
          if (stat.isDirectory()) walk(p);
          else files.push(p);
        }
      } catch (e) { /* ignore */ }
    })(authRoot);

    const phoneCandidates = [];
    for (const file of files) {
      if (!file.endsWith('.json') && !file.endsWith('.txt') && !file.endsWith('.data')) continue;
      try {
        const raw = fs.readFileSync(file, 'utf8');
        // 1) tenta parse JSON e procurar propriedades comuns
        let obj = null;
        try { obj = JSON.parse(raw); } catch (_) { obj = null; }
        if (obj) {
          (function scan(o) {
            if (!o) return;
            if (typeof o === 'string') {
              const m = o.match(/(\d{6,15})@c\.us/);
              if (m) phoneCandidates.push(m[1]);
              const mm = o.match(/(\d{6,15})/g);
              if (mm && mm.length) phoneCandidates.push(...mm);
              return;
            }
            if (typeof o === 'object') {
              for (const k of Object.keys(o)) {
                const v = o[k];
                if (typeof v === 'string') {
                  const m = v.replace(/@.*$/,'').match(/(\d{6,15})/);
                  if (m) phoneCandidates.push(m[1]);
                }
                scan(v);
              }
            }
          })(obj);
        } else {
          // 2) fallback regex no conteúdo cru
          let m = raw.match(/(\d{6,15})@c\.us/);
          if (m) phoneCandidates.push(m[1]);
          m = raw.match(/"id"\s*:\s*"(\d{6,15})@c\.us"/);
          if (m) phoneCandidates.push(m[1]);
          const mm = raw.match(/(\d{6,15})/g);
          if (mm && mm.length) phoneCandidates.push(...mm);
               }
      } catch (e) { /* ignore read/parse errors */ }
    }
  
    if (phoneCandidates.length === 0) return null;
    // escolhe o candidato com maior comprimento (mais provável ser o telefone completo)
    const chosen = phoneCandidates.sort((a,b) => b.length - a.length)[0];
    return String(chosen).replace(/[^0-9]/g, '');
  } catch (e) {
    return null;
  }
}

module.exports = router;
module.exports.removerTabulacaoSeExistir = removerTabulacaoSeExistir;
module.exports.chatsTabulados = chatsTabulados;
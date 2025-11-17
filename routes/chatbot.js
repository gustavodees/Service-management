const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const { cpf } = require('cpf-cnpj-validator');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const WhatsappMessage = require('./WhatsappMessage'); // <<< ADICIONADO
const WhatsappMedia = require('./WhatsappMedia');     // <<< ADICIONADO
const ChatbotDevice = require('./chatbotDevice');     // <<< ADICIONADO
const WhatsappDevice = require('./whatsappDevice');   // <<< ADICIONADO
const verificaAutenticacao = require('./verificaAutenticacao'); // <<< ADICIONADO
// cache simples deviceId -> userId para reduzir queries
const deviceIdToUserIdCache = {};

const treinamentoPath = path.join(__dirname, '../ia-treinamento.txt');
const genAI = new GoogleGenerativeAI('AIzaSyAhFBj7_BX-1WYu_v_vr-Nx3ehaJ6G3mvE');
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

let systemPrompt = '';
try {
  if (fs.existsSync(treinamentoPath)) {
    systemPrompt = fs.readFileSync(treinamentoPath, 'utf8');
  }
} catch (err) {
  systemPrompt = '';
}

// Multiconexões
let chatbotClients = {}; // deviceIDchatbot: { client, isClientReady, qr }
const conversationHistory = {};
const blockedContacts = {};
const inactiveClients = {};
const finishedChats = new Set();
const pausedChats = {};
const activeConnections = new Set();

// Mapeamento chatId => deviceIDchatbot
const chatIdToDeviceID = {}

// --- ADICIONADO: Extrair número a partir da pasta LocalAuth (.wwebjs_auth/session-<device>)
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
    const chosen = phoneCandidates.sort((a,b) => b.length - a.length)[0];
    return String(chosen).replace(/[^0-9]/g, '');
  } catch (e) {
    return null;
  }
}
// --- FIM ADIÇÃO ---

// --- NOVO: helper para tratar erros de conexão do bot (puppeteer/target closed)
async function handleBotConnectionError(deviceIDchatbot, err) {
  try {
    console.warn(`chatbot[${deviceIDchatbot}] connection error:`, err && err.message ? err.message : err);
    const bot = chatbotClients[deviceIDchatbot];
    if (bot && bot.client) {
      try {
        if (typeof bot.client.destroy === 'function') await bot.client.destroy();
      } catch (destroyErr) {
        // ignore
      }
    }
    // marca bot em memória como desconectado (não remover abruptamente objeto para evitar undefined race)
    if (chatbotClients[deviceIDchatbot]) {
      chatbotClients[deviceIDchatbot].isClientReady = false;
      chatbotClients[deviceIDchatbot].client = null;
    }
    // tenta atualizar BD para refletir desconexão (não crítico)
    try {
      await ChatbotDevice.update({ status: 'disconnected' }, { where: { device_id: deviceIDchatbot } });
    } catch (dbErr) { /* ignorar erro de BD */ }

    // notifica UIs para atualizarem (opcional)
    try {
      broadcastChatbot({ type: 'bot-error-disconnected', deviceIDchatbot, error: (err && err.message) ? err.message : String(err) });
    } catch (bErr) {}
  } catch (e) {
    console.warn('handleBotConnectionError falhou:', e && e.message ? e.message : e);
  }
}

// Helper simples para executar operações seguras sobre o client do bot
async function safeExecBot(deviceIDchatbot, fn) {
  const bot = chatbotClients[deviceIDchatbot];
  if (!bot || !bot.client || !bot.isClientReady) return null;
  try {
    return await fn(bot);
  } catch (err) {
    // se houver qualquer erro de runtime / protocol (p.ex. Target closed), trata e evita crash
    await handleBotConnectionError(deviceIDchatbot, err);
    return null;
  }
}

// Helper para gerar deviceIDchatbot único
function generateDeviceIDChatbot() {
  return 'chatbot_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
}

// Helper para broadcast via WebSocket
function broadcastChatbot(message) {
  const messageString = JSON.stringify(message);
  activeConnections.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(messageString); } catch (error) { activeConnections.delete(ws); }
    } else { activeConnections.delete(ws); }
  });
}

// Gemini IA
async function getGeminiResponse(userMessage, userName, conversationContext = "") {
  try {
    const fullPrompt = `${systemPrompt}\n\nHistórico da conversa:\n${conversationContext}\n\nCliente (${userName}): ${userMessage}\n\nResponda como o assistente virtual:`;
    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Erro ao obter resposta da Gemini:', error);
    return "Desculpe, estou com dificuldades técnicas no momento. Pode repetir sua pergunta?";
  }
}

// Histórico
function addToHistory(phoneNumber, message, isBot = false) {
  if (!conversationHistory[phoneNumber]) conversationHistory[phoneNumber] = [];
  conversationHistory[phoneNumber].push({
    role: isBot ? 'assistant' : 'user',
    content: message,
    timestamp: new Date().toISOString()
  });
  if (conversationHistory[phoneNumber].length > 15) {
    conversationHistory[phoneNumber] = conversationHistory[phoneNumber].slice(-15);
  }
}

// CPF helpers
function validarCPF(cpfString) {
  const cpfLimpo = cpfString.replace(/\D/g, '');
  if (cpfLimpo.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpfLimpo)) return false;
  return cpf.isValid(cpfLimpo);
}
function formatarCPF(cpfString) {
  const cpfLimpo = cpfString.replace(/\D/g, '');
  return cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}
function detectarCPF(mensagem) {
  const cpfRegex = /\b(?:\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/g;
  const matches = mensagem.match(cpfRegex);
  if (matches) {
    for (const match of matches) {
      const cpfLimpo = match.replace(/\D/g, '');
      if (cpfLimpo.length === 11) return cpfLimpo;
    }
  }
  return null;
}

// Função principal para processar mensagens
async function handleMessage(msg, deviceIDchatbot) {
  // tenta obter o chat, mas não falha o processamento se der errado
  let chat = null;
  try {
    chat = await msg.getChat();
  } catch (getChatErr) {
    console.warn('handleMessage: getChat falhou (continuando):', getChatErr && getChatErr.message);
  }

  try {
    if (msg.fromMe) return;
    const chatId = msg.from;
    if (!chatId) return;
    if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')) return;
    const messageBody = msg.body ? msg.body.trim() : '';

    // Pausa
    if (pausedChats[chatId] && Date.now() < pausedChats[chatId]) {
      if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
      conversationHistory[chatId].push({
        role: 'user',
        content: messageBody,
        timestamp: new Date().toISOString(),
        isAfterPause: true
      });
      broadcastChatbot({
        type: 'paused-chat-message',
        chatId: chatId,
        message: messageBody,
        timestamp: new Date().toISOString(),
        customerName: chatId.replace('@c.us', ''),
        fullHistory: conversationHistory[chatId]
      });
      return;
    }

    // tenta indicar typing (silencioso)
    try {
      if (chat && typeof chat.sendStateTyping === 'function') {
        await chat.sendStateTyping();
      } else if (chat && typeof chat.sendState === 'function') {
        await chat.sendState('typing');
      }
    } catch (e) {
      // não interrompe o fluxo se enviar o typing falhar
      console.warn('handleMessage: send typing falhou (ignorando):', e && e.message);
    }

    // CPF
    const cpfDetectado = detectarCPF(messageBody);
    if (cpfDetectado) {
      if (!validarCPF(cpfDetectado)) {
        const respostaCPFInvalido = `O CPF informado parece estar inválido. Por favor, confirme e envie novamente o seu CPF para prosseguir com a simulação.`;
        try { await msg.reply(respostaCPFInvalido); } catch(e){}
        if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
        conversationHistory[chatId].push({
          role: 'assistant',
          content: respostaCPFInvalido,
          timestamp: new Date().toISOString()
        });
        return;
      }
      const cpfFormatado = formatarCPF(cpfDetectado);
      if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
      conversationHistory[chatId].push({
        role: 'user',
        content: messageBody,
        timestamp: new Date().toISOString(),
        cpf: cpfDetectado
      });
      const respostaCPF = `Perfeito! Recebi o CPF: ${cpfFormatado}
      
Vou realizar uma consulta para verificar as opções disponíveis. Aguarde um momento...

Em seguida, vou transferir você para um de nossos especialistas que poderá te ajudar com as melhores condições e finalizar o processo. 

Aguarde que em breve você será atendido por um consultor especializado! 😊`;
      try { await msg.reply(respostaCPF); } catch(e){}
      conversationHistory[chatId].push({
        role: 'assistant',
        content: respostaCPF,
        timestamp: new Date().toISOString()
      });
      pausedChats[chatId] = Date.now() + (24 * 60 * 60 * 1000);
      finishedChats.add(chatId);
      chatIdToDeviceID[chatId] = deviceIDchatbot;
      try { await saveChatbotHistoryToDb(chatId, deviceIDchatbot); } catch (e) { console.warn('Falha persistir histórico do chatbot:', e && e.message); }
      if (inactiveClients[chatId]) { clearTimeout(inactiveClients[chatId]); delete inactiveClients[chatId]; }
      broadcastChatbot({
        type: 'new-finished-chat',
        chatId: chatId,
        message: 'Novo chat transferido com CPF informado',
        cpf: cpfFormatado,
        customerName: chatId.replace('@c.us', ''),
        lastMessage: messageBody,
        timestamp: Math.floor(Date.now() / 1000),
        source: 'chatbot'
      });
      return;
    }

    // IA (delegar para rotina que tem timeout/erro tratado)
    await processarMensagemIA(msg, chatId, messageBody, deviceIDchatbot, chat);

  } catch (error) {
    console.error('handleMessage erro capturado:', error && error.message ? error.message : error);
    try { await msg.reply('Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente em alguns instantes.'); } catch (e) {}
  } finally {
    // limpa o estado typing/recording sem quebrar se falhar
    try {
      if (chat && typeof chat.clearState === 'function') {
        await chat.clearState();
      } else if (chat && typeof chat.sendState === 'function') {
        await chat.sendState('paused');
      }
    } catch (e) {
      console.warn('handleMessage: clearState falhou (ignorando):', e && e.message);
    }
  }
}

// IA
async function processarMensagemIA(msg, chatId, messageBody, deviceIDchatbot, chat) {
  try {
    if (pausedChats[chatId] && Date.now() < pausedChats[chatId]) return;
    if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
    conversationHistory[chatId].push({
      role: 'user',
      content: messageBody,
      timestamp: new Date().toISOString()
    });

    const contextMessages = conversationHistory[chatId]
      .slice(-10)
      .map(h => `${h.role}: ${h.content}`)
      .join('\n');
    const fullPrompt = `${systemPrompt}\n\nHistórico da conversa:\n${contextMessages}\n\nResposta:`;

    // Timeout/segurança para a chamada à IA (evita hang indefinido)
    const IA_TIMEOUT_MS = 20000; // 20s
    let result;
    try {
      result = await Promise.race([
        model.generateContent(fullPrompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('IA timeout')), IA_TIMEOUT_MS))
      ]);
    } catch (iaErr) {
      console.error('processarMensagemIA: falha/timeout IA:', iaErr && iaErr.message ? iaErr.message : iaErr);
      try { await msg.reply('Desculpe, estou com lentidão na geração da resposta. Um consultor irá te ajudar em breve.'); } catch(e){}
      return;
    }

    const response = result.response;
    let botResponse = '';
    try {
      botResponse = response.text ? response.text() : (typeof response === 'string' ? response : '');
    } catch (e) {
      botResponse = (response && response.toString) ? response.toString() : '';
    }

    // Extrai imagens/medi a e envia se necessário (mesma lógica anterior)
    const imagesToSend = [];
    const imageRegex = /📷\s*(?:Enviando imagem:)?\s*`?("?)([^\n"`]+\.jpeg)\1`?/gi;
    let match;
    while ((match = imageRegex.exec(botResponse)) !== null) {
      const imageName = match[2].trim().replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '');
      imagesToSend.push(imageName);
      botResponse = botResponse.replace(match[0], '');
    }

    if (botResponse && botResponse.trim()) {
      try { await msg.reply(botResponse.trim()); } catch (e) { console.warn('Falha ao enviar reply IA:', e && e.message); }
      let botSavedId = null;
      try {
        botSavedId = await saveChatbotMessageToDb(chatId, { content: botResponse.trim(), type: 'text', timestamp: new Date().toISOString(), role: 'assistant', fromMe: true }, deviceIDchatbot);
      } catch (e) {
        console.warn('save assistant chatbot msg falhou:', e && e.message);
      }
      broadcastChatbot({
        type: 'new-message',
        chatId,
        message: {
          id: botSavedId || `${chatId}_${Math.floor(Date.now() / 1000)}_a`,
          body: botResponse.trim(),
          fromMe: true,
          type: 'text',
          timestamp: Math.floor(Date.now() / 1000)
        },
        customerName: chatId.replace('@c.us', '')
      });
    }

    for (const imageName of imagesToSend) {
      try { await enviarImagem(msg, imageName); } catch (e) { console.warn('enviarImagem falhou:', e && e.message); }
    }

    conversationHistory[chatId].push({
      role: 'assistant',
      content: botResponse.trim(),
      timestamp: new Date().toISOString()
    });

    if (inactiveClients[chatId]) clearTimeout(inactiveClients[chatId]);
    inactiveClients[chatId] = setTimeout(() => { delete inactiveClients[chatId]; }, 10 * 60 * 1000);

  } catch (error) {
    console.error('processarMensagemIA erro geral:', error && error.message ? error.message : error);
    try { await msg.reply('Desculpe, ocorreu um erro interno ao gerar a resposta. Em breve um consultor irá te atender.'); } catch(e){}
  }
}

// Enviar imagem
async function enviarImagem(msg, imageName) {
  try {
    const imagePath = path.join(__dirname, '../public/images', imageName);
    if (fs.existsSync(imagePath)) {
      const media = MessageMedia.fromFilePath(imagePath);
      await msg.reply(media);
    } else {
      await msg.reply('Desculpe, não consegui encontrar a imagem solicitada. Um consultor especializado te ajudará em breve.');
    }
  } catch (error) {
    await msg.reply('Desculpe, ocorreu um erro ao enviar a imagem. Um consultor especializado te ajudará em breve.');
  }
}

// Inicializar cliente WhatsApp do chatbot (multi)
function initializeChatbotClient(deviceIDchatbot) {
  if (chatbotClients[deviceIDchatbot]) return chatbotClients[deviceIDchatbot].client;
  const client = new Client({
    puppeteer: { headless: true, args: ['--no-sandbox'] },
    authStrategy: new LocalAuth({ clientId: deviceIDchatbot })
  });
  chatbotClients[deviceIDchatbot] = { client, isClientReady: false, qr: null };

  client.on('qr', qr => {
    QRCode.toDataURL(qr, {
      margin: 3,
      scale: 8,
      errorCorrectionLevel: 'M',
      color: { dark: '#128C7E', light: '#FFFFFF' },
    }, (err, url) => {
      chatbotClients[deviceIDchatbot].qr = err ? null : url;
    });
  });

  client.on('ready', async () => {
    chatbotClients[deviceIDchatbot].isClientReady = true;
    chatbotClients[deviceIDchatbot].qr = null;
    console.log(`✅ ChatBot WhatsApp conectado! Device: ${deviceIDchatbot}`);
    broadcastChatbot({
      type: 'ready',
      status: 'ChatBot WhatsApp conectado!',
      deviceIDchatbot
    });

    // tenta atualizar BD com número/estado em background (não crítico)
    (async () => {
      try {
        // 1) tenta número via client.info
        let possibleNumber = null;
        try {
          const info = client.info || {};
          possibleNumber = (info.wid && info.wid.user) || (info.me && (info.me._serialized || info.me.user)) || info.number || info.phone || null;
          if (typeof possibleNumber === 'string') possibleNumber = possibleNumber.replace(/@.*$/,'');
        } catch(_) { possibleNumber = null; }

        // 2) fallback: tenta extrair da pasta de sessão se não obteve número
        if (!possibleNumber) {
          try {
            const extracted = await extractNumberFromAuthDir(deviceIDchatbot);
            if (extracted) possibleNumber = extracted;
          } catch (_) {}
        }

        // atualiza DB (se houver registro)
        try {
          const dev = await ChatbotDevice.findOne({ where: { device_id: deviceIDchatbot } });
          if (dev) {
            const updatePayload = { status: 'connected', last_connected: new Date() };
            if (possibleNumber) updatePayload.number = String(possibleNumber);
            await dev.update(updatePayload).catch(()=>{});
          }
        } catch (e) { /* não crítico */ }
      } catch (e) {}
    })();
  });

  client.on('disconnected', () => {
    chatbotClients[deviceIDchatbot].isClientReady = false;
    chatbotClients[deviceIDchatbot].client = null;
    broadcastChatbot({
      type: 'disconnected',
      status: 'ChatBot desconectado',
      deviceIDchatbot
    });
  });

  client.on('message', async msg => {
    const chatId = msg.from;
    try {
      // chama o processador principal (captura erros internamente)
      await handleMessage(msg, deviceIDchatbot);
    } catch (handlerErr) {
      console.error('client.on(message) -> handleMessage erro (continuando):', handlerErr && handlerErr.message ? handlerErr.message : handlerErr);
    }

    // Mesmo que handleMessage tenha falhado parcialmente, tentamos persistir/emitir se o chat foi marcado como finalizado
    try {
      if (finishedChats.has(chatId)) {
        if (!conversationHistory[chatId]) conversationHistory[chatId] = [];

        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            conversationHistory[chatId].push({
              role: 'user',
              type: 'media',
              filename: media.filename || '',
              mimetype: media.mimetype,
              timestamp: new Date().toISOString()
            });
            let savedId = null;
            try {
              savedId = await saveChatbotMessageToDb(chatId, {
                type: 'media',
                mimetype: media.mimetype,
                filename: media.filename,
                data: media.data,
                timestamp: new Date().toISOString(),
                fromMe: false,
                id: (media.id && media.id._serialized) ? media.id._serialized : null
              }, deviceIDchatbot);
            } catch (e) { console.warn('save media chatbot:', e && e.message); }

            broadcastChatbot({
              type: 'new-message',
              chatId,
              message: {
                id: savedId || ((msg.id && msg.id._serialized) ? msg.id._serialized : `${chatId}_${Math.floor(Date.now()/1000)}_m`),
                type: 'media',
                filename: media.filename || '',
                mimetype: media.mimetype,
                data: null,
                fromMe: false,
                timestamp: Math.floor(Date.now() / 1000)
              },
              customerName: chatId.replace('@c.us', '')
            });
          } catch (errMedia) {
            console.warn('Erro ao processar mídia no on(message):', errMedia && errMedia.message);
          }
        } else {
          // texto
          try {
            const textBody = msg.body || '';
            conversationHistory[chatId].push({
              role: 'user',
              content: textBody,
              type: 'text',
              timestamp: new Date().toISOString()
            });
            let savedTextId = null;
            try {
              savedTextId = await saveChatbotMessageToDb(chatId, { content: textBody, type: 'text', timestamp: new Date().toISOString(), fromMe: false }, deviceIDchatbot);
            } catch (e) { console.warn('save text chatbot:', e && e.message); }

            broadcastChatbot({
              type: 'new-message',
              chatId,
              message: {
                id: savedTextId || `${chatId}_${Math.floor(Date.now()/1000)}_u`,
                body: textBody,
                fromMe: false,
                type: 'text',
                timestamp: Math.floor(Date.now() / 1000)
              },
              customerName: chatId.replace('@c.us', '')
            });
          } catch (errText) {
            console.warn('Erro ao processar texto no on(message):', errText && errText.message);
          }
        }
      }
    } catch (e) {
      console.warn('Erro geral pós-handleMessage (não crítico):', e && e.message);
    }
  });

  client.initialize();
  return client;
}

// WebSocket para chatbot multiconexão
function handleChatbotUpgrade(request, socket, head, wss) {
  wss.handleUpgrade(request, socket, head, function done(ws) {
    activeConnections.add(ws);
    ws.send(JSON.stringify({
      type: 'status',
      status: 'WebSocket conectado, aguardando inicialização...'
    }));

    ws.on('message', async function message(data) {
      try {
        const message = JSON.parse(data);
        const deviceIDchatbot = message.deviceIDchatbot;
        
        // NOVO: Para os status, o deviceID do chatbot é determinado pelo chatId da conversa
        const statusDeviceID = chatIdToDeviceID[message.chatId];
        const bot = chatbotClients[deviceIDchatbot] || chatbotClients[statusDeviceID];

        switch (message.type) {
          case 'connect':
            if (!bot) initializeChatbotClient(deviceIDchatbot);
            if (bot && bot.isClientReady) {
              ws.send(JSON.stringify({
                type: 'ready',
                status: 'ChatBot WhatsApp conectado e funcionando!',
                deviceIDchatbot
              }));
            } else {
              ws.send(JSON.stringify({
                type: 'connecting',
                status: 'Conectando ao WhatsApp...',
                deviceIDchatbot
              }));
            }
            break;

          case 'disconnect':
            if (bot && bot.client) {
              bot.client.destroy();
              chatbotClients[deviceIDchatbot] = null;
            }
            ws.send(JSON.stringify({
              type: 'disconnected',
              status: 'ChatBot desconectado',
              deviceIDchatbot
            }));
            break;

          case 'status':
            ws.send(JSON.stringify({
              type: 'status',
              isReady: bot && bot.isClientReady,
              status: bot && bot.isClientReady ? 'ChatBot conectado' : 'ChatBot desconectado',
              deviceIDchatbot
            }));
            break;

          // Suporte via websocket para listar chats transferidos (mesma payload da rota /transferred-chats)
          case 'get-transferred-chats': {
            const chatIds = Array.from(finishedChats);
            const chats = [];
            for (const chatId of chatIds) {
              const deviceIDchatbot = chatIdToDeviceID[chatId] || null;
              await fetchAndSaveChatbotMessagesIfNeeded(deviceIDchatbot, chatId, 1, 200);

              const where = { chatId };
              if (deviceIDchatbot) where.deviceId = deviceIDchatbot;

              const msgs = await WhatsappMessage.findAll({ where, order: [['timestamp','ASC']] });
              let history = [];
              if (msgs && msgs.length > 0) {
                history = msgs.map(m => ({
                  id: m.id,
                  role: m.fromMe ? 'assistant' : 'user',
                  content: m.body,
                  type: m.type,
                  mimetype: m.mimetype,
                  filename: m.filename,
                  data: null,
                  timestamp: new Date(Number(m.timestamp) * 1000).toISOString()
                }));
              } else {
                history = conversationHistory[chatId] || [];
              }
              const cpfMsg = history.find(h => h.cpf);
              const cpf = cpfMsg ? cpfMsg.cpf : null;
              chats.push({
                id: chatId,
                name: chatId.replace('@c.us', ''),
                cpf,
                history,
                lastMessage: history.length > 0 ? (history[history.length - 1].content || '') : '',
                timestamp: history.length > 0 ? _tsToSeconds(history[history.length - 1].timestamp) * 1000 : Date.now(),
                source: 'chatbot',
                isTransferred: true,
                deviceId: deviceIDchatbot
              });
            }
            ws.send(JSON.stringify({ type: 'transferred-chats', chats }));
            break;
          }

          // Carregar histórico de um chat específico - responde SÓ para o socket que pediu
          case 'get-messages': {
            const chatId = message.chatId;
            // prioriza device mapping do chat (se for chat transferido pelo bot)
            const deviceIDchatbot = chatIdToDeviceID[chatId] || message.deviceIDchatbot || null;

            // garantir que o BD tenha histórico (se possível) antes de buscar
            await fetchAndSaveChatbotMessagesIfNeeded(deviceIDchatbot, chatId, 1, 500);

            // busca somente mensagens do device do chatbot quando aplicável
            const where = { chatId };
            if (deviceIDchatbot) where.deviceId = deviceIDchatbot;

            const msgs = await WhatsappMessage.findAll({ where, order: [['timestamp', 'ASC']] });
            let mapped = [];
            if (msgs && msgs.length > 0) {
              mapped = msgs.map(m => {
                const ts = m.timestamp ? Number(m.timestamp) : Math.floor(Date.now() / 1000);
                if (m.type === 'media') {
                  return {
                    id: m.id,
                    type: 'media',
                    data: null, // não retornar base64 aqui
                    mimetype: m.mimetype || null,
                    filename: m.filename || null,
                    fromMe: !!m.fromMe,
                    timestamp: ts
                  };
                }
                return {
                  id: m.id,
                  body: m.body || '',
                  type: m.type || 'text',
                  fromMe: !!m.fromMe,
                  timestamp: ts
                };
              });
            } else {
              const history = conversationHistory[chatId] || [];
              // quando chat transferido pelo bot (deviceIDchatbot existe) não mostramos history local
              const useHistory = deviceIDchatbot ? [] : history;
              mapped = useHistory.map(item => {
                const ts = item.timestamp ? (Date.parse(item.timestamp) ? Math.floor(Date.parse(item.timestamp) / 1000) : item.timestamp) : Math.floor(Date.now() / 1000);
                if (item.type === 'media' || item.type === 'audio' || item.type === 'video') {
                  return {
                    id: item.id || `${chatId}_${ts}_local`,
                    type: 'media',
                    data: null,
                    mimetype: item.mimetype || null,
                    filename: item.filename || null,
                    fromMe: item.role === 'assistant',
                    timestamp: ts
                  };
                }
                return {
                  id: item.id || `${chatId}_${ts}_local`,
                  body: item.content || item.body || '',
                  type: item.type || 'text',
                  fromMe: item.role === 'assistant',
                  timestamp: ts
                };
              });
            }

            ws.send(JSON.stringify({
              type: 'messages',
              chatId,
              messages: mapped
            }));
            break;
          }

          // ATUALIZADO: Adicionado para o status "Digitando..." do ATENDENTE
          case 'typing-start': {
              const targetDeviceID = chatIdToDeviceID[message.chatId];
              if (!targetDeviceID) break;
              await safeExecBot(targetDeviceID, async (bot) => {
                const chat = await bot.client.getChatById(message.chatId);
                if (chat && typeof chat.sendStateTyping === 'function') await chat.sendStateTyping();
              });
              break;
          }

          // Limpar status / parar gravação
          case 'typing-stop':
          case 'recording-stop': {
              const targetDeviceID = chatIdToDeviceID[message.chatId];
              if (!targetDeviceID) break;
              await safeExecBot(targetDeviceID, async (bot) => {
                const chat = await bot.client.getChatById(message.chatId);
                if (chat && typeof chat.clearState === 'function') await chat.clearState();
              });
              break;
          }

          // Gravando áudio
          case 'recording-start': {
              const targetDeviceID = chatIdToDeviceID[message.chatId];
              if (!targetDeviceID) break;
              await safeExecBot(targetDeviceID, async (bot) => {
                const chat = await bot.client.getChatById(message.chatId);
                if (chat && typeof chat.sendStateRecording === 'function') await chat.sendStateRecording();
              });
              break;
          }

        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', status: 'Erro interno do servidor: ' + (error && error.message) }));
      }
    });

    ws.on('close', function close() {
      activeConnections.delete(ws);
    });

    ws.on('error', function error(err) {
      activeConnections.delete(ws);
    });
  });
}

// helpers: normalize timestamp simples (segundos)
function _tsToSeconds(ts) {
  try {
    if (!ts) return Math.floor(Date.now() / 1000);
    const n = Number(ts);
    if (!Number.isFinite(n)) {
      const d = Date.parse(ts);
      return isNaN(d) ? Math.floor(Date.now() / 1000) : Math.floor(d / 1000);
    }
    // se veio em ms
    if (n > 1e11) return Math.floor(n / 1000);
    return Math.floor(n);
  } catch { return Math.floor(Date.now() / 1000); }
}

// salva uma mensagem do chatbot no DB (evita duplicatas checando PK)
// agora retorna o id da mensagem criada (ou existente)
async function saveChatbotMessageToDb(chatId, item, deviceIDchatbot) {
  try {
    if (!chatId || !item) return null;

    // normaliza timestamp em segundos
    const ts = _tsToSeconds(item.timestamp || item.ts || item.time || Date.now());

    // determina deviceId utilizado para persistência (quando passado, usa ele)
    const deviceId = deviceIDchatbot || (chatIdToDeviceID[chatId] || `chatbot-${deviceIDchatbot||'0'}`);

    // tenta reaproveitar id explícito se fornecido (por exemplo m.id._serialized)
    let id = item.id || item.messageId || null;

    // determina caracter de role corretamente (assistant/fromMe => 'a', user => 'u')
    const roleChar = (item.role === 'assistant' || item.fromMe === true) ? 'a' : 'u';

    // se ainda não tem id, gera um id previsível e reproduzível
    if (!id) {
      const safeFilename = (item.filename || '').toString().replace(/\s+/g, '_').slice(0, 20);
      id = `${chatId}_${ts}_${roleChar}_${safeFilename}`.replace(/\s+/g, '_');
    }

    // evita NOT NULL por userId: resolve userId (cached quando possível)
    let userId = null;
    try {
      if (deviceIdToUserIdCache[deviceId] !== undefined) {
        userId = deviceIdToUserIdCache[deviceId];
      } else {
        let dev = null;
        try { dev = await ChatbotDevice.findOne({ where: { device_id: deviceId } }); } catch(e) {}
        if (!dev) {
          try { dev = await WhatsappDevice.findOne({ where: { device_id: deviceId } }); } catch(e) {}
        }
        userId = dev && (dev.user_id || dev.userId) ? (dev.user_id || dev.userId) : null;
        deviceIdToUserIdCache[deviceId] = userId;
      }
    } catch (err) {
      console.warn('saveChatbotMessageToDb: falha ao resolver device->userId', err && err.message);
      userId = null;
    }
    const userIdForInsert = (userId === null || userId === undefined) ? 0 : userId;

    // Checagens para evitar duplicatas:
    // 1) procura por PK
    const existsByPK = await WhatsappMessage.findByPk(id);
    if (existsByPK) return id;

    // 2) procura por (chatId + timestamp + body) quando aplicável
    const bodyToCheck = (item.content || item.body || '').toString().slice(0, 200);
    try {
      const existsSimilar = await WhatsappMessage.findOne({
        where: {
          chatId,
          timestamp: ts,
          body: bodyToCheck ? bodyToCheck : null
        }
      });
      if (existsSimilar) {
        // Se existia, retorna o id existente (evita duplicata)
        return existsSimilar.id;
      }
    } catch (e) {
      // ignore query error (não crítico)
    }

    // se for mídia: grava metadados em whatsapp_messages e base64 em whatsapp_media
    if (item.type === 'media' || item.type === 'audio' || item.type === 'video') {
      try {
        // cria mensagem meta caso não exista
        const exists = await WhatsappMessage.findByPk(id);
        if (!exists) {
          await WhatsappMessage.create({
            id,
            chatId,
            deviceId,
            userId: userIdForInsert,
            body: item.body || null,
            fromMe: !!item.fromMe,
            type: 'media',
            mimetype: item.mimetype || null,
            filename: item.filename || null,
            data: null,
            timestamp: ts
          });
        }

        const existsMedia = await WhatsappMedia.findOne({ where: { messageId: id, chatId, deviceId } });
        if (!existsMedia) {
          await WhatsappMedia.create({
            messageId: id,
            chatId,
            deviceId,
            userId: userIdForInsert,
            filename: item.filename || (item.mimetype ? `media_${ts}` : null),
            mimetype: item.mimetype || null,
            size: item.data ? Buffer.from(item.data, 'base64').length : null,
            data: item.data || null,
            timestamp: ts
          });
        }
        return id;
      } catch (err) {
        console.warn('saveChatbotMessageToDb (media) erro:', err && err.message ? err.message : err);
        return null;
      }
    }

    // texto / assistant / user
    try {
      await WhatsappMessage.create({
        id,
        chatId,
        deviceId,
        userId: userIdForInsert,
        body: item.content || item.body || '',
        fromMe: !!item.fromMe || (item.role === 'assistant'),
        type: item.type || 'chat',
        mimetype: null,
        filename: null,
        data: null,
        timestamp: ts
      });
    } catch (err) {
      // se falhar por duplicidade race (inserido por outro processo), tenta recuperar o registro
      console.warn('saveChatbotMessageToDb create text erro, tentando recuperar:', err && err.message ? err.message : err);
      const existing = await WhatsappMessage.findByPk(id);
      if (existing) return existing.id;
      return null;
    }

    return id;
  } catch (err) {
    console.warn('saveChatbotMessageToDb erro:', err && err.message ? err.message : err);
    return null;
  }
}

// persiste todo o histórico atual de um chat transferido
async function saveChatbotHistoryToDb(chatId, deviceIDchatbot) {
  try {
    const history = conversationHistory[chatId] || [];
    for (let i = 0; i < history.length; i++) {
      await saveChatbotMessageToDb(chatId, history[i], deviceIDchatbot);
    }
  } catch (e) {
    console.error('saveChatbotHistoryToDb erro:', e);
  }
}

// === INSERIR: busca on-demand do histórico do chatbot e popula o BD (similar ao whatsapp.fetchAndSave) ===
async function fetchAndSaveChatbotMessagesIfNeeded(deviceIDchatbot, chatId, minMessages = 10, limit = 50) {
  try {
    if (!chatId) return [];

    // Primeiro conta registros já persistidos para este deviceId+chatId
    const whereCount = deviceIDchatbot ? { deviceId: deviceIDchatbot, chatId } : { chatId };
    const existingCount = await WhatsappMessage.count({ where: whereCount });

    if (existingCount >= minMessages) {
      const dbMessages = await WhatsappMessage.findAll({
        where: whereCount,
        order: [['timestamp', 'ASC']],
        limit: 1000
      });
      return dbMessages.map(m => m.toJSON());
    }

    // Se há um client do chatbot e ele está pronto, tenta baixar do WhatsApp via client
    const botObj = deviceIDchatbot ? chatbotClients[deviceIDchatbot] : null;
    if (!botObj || !botObj.client || !botObj.isClientReady) {
      // Sem client disponível: retorna o que há no BD (mesmo que pouco)
      const dbMessages = await WhatsappMessage.findAll({
        where: whereCount,
        order: [['timestamp', 'ASC']]
      });
      return dbMessages.map(m => m.toJSON());
    }

    // Usa safeExecBot para proteger chamadas contra "Target closed" / ProtocolError
    const messages = await safeExecBot(deviceIDchatbot, async (bot) => {
      let chat;
      try { chat = await bot.client.getChatById(chatId); } catch (e) {
        const chats = await bot.client.getChats();
        chat = chats.find(c => c.id && c.id._serialized === chatId);
      }
      if (!chat) return null;
      return await chat.fetchMessages({ limit });
    });

    if (!messages) {
      // se não foi possível buscar via client, fallback para BD
      const dbMessages = await WhatsappMessage.findAll({ where: whereCount, order: [['timestamp','ASC']] });
      return dbMessages.map(m => m.toJSON());
    }

    // inserir em DB na ordem cronológica (mantém mesma lógica original)
    for (const m of messages.reverse()) {
      try {
        const idSerialized = (m.id && m.id._serialized) ? m.id._serialized : `${chatId}_${m.timestamp}_${m.fromMe}`;
        const exists = await WhatsappMessage.findByPk(idSerialized);
        if (exists) continue;

        let dataBase64 = null, mimetype = null, filename = null;
        if (m.hasMedia) {
          try {
            const media = await m.downloadMedia();
            if (media && media.data) {
              dataBase64 = media.data;
              mimetype = media.mimetype || null;
              filename = media.filename || null;
            }
          } catch (err) {
            console.warn('fetchAndSaveChatbotMessagesIfNeeded: falha ao baixar mídia', idSerialized, err && err.message);
          }
        }

        // usa o helper que já normaliza e cria WhatsappMessage/WhatsappMedia corretamente
        await saveChatbotMessageToDb(chatId, {
          id: idSerialized,
          content: m.body || null,
          type: m.type || (dataBase64 ? 'media' : 'chat'),
          mimetype,
          filename,
          data: dataBase64,
          fromMe: !!m.fromMe,
          timestamp: m.timestamp || Date.now()
        }, deviceIDchatbot);
      } catch (err) {
        console.error('Erro ao persistir mensagem fetchada do chatbot:', err && err.message ? err.message : err);
      }
    }

    // por fim, retorna do BD
    const dbMessages = await WhatsappMessage.findAll({
      where: whereCount,
      order: [['timestamp', 'ASC']]
    });
    return dbMessages.map(m => m.toJSON());
  } catch (err) {
    console.error('fetchAndSaveChatbotMessagesIfNeeded erro:', err);
    // fallback: retornar o histórico em memória se houver
    const history = conversationHistory[chatId] || [];
    return history.map(item => ({
      id: item.id || `${chatId}_${Math.floor(new Date(item.timestamp || Date.now()).getTime() / 1000)}_local`,
      body: item.content || item.body || '',
      fromMe: item.role === 'assistant' || !!item.fromMe,
      type: item.type || (item.data ? 'media' : 'text'),
      mimetype: item.mimetype || null,
      filename: item.filename || null,
      data: null,
      timestamp: _tsToSeconds(item.timestamp || Date.now())
    }));
  }
}
// === FIM INSERÇÃO ===

// Rotas principais

router.get('/', (req, res) => {
  res.render('chatbot', { title: 'Chatbot Service - Sistema Service' });
});

router.post('/create-connection', async (req, res) => {
  try {
    // aceita opcional deviceIDchatbot via body ou query para reutilizar
    let deviceIDchatbot = (req.body && req.body.deviceIDchatbot) || (req.query && req.query.deviceIDchatbot) || null;
    if (!deviceIDchatbot) deviceIDchatbot = generateDeviceIDChatbot();

    const userId = (req.session && req.session.usuario && req.session.usuario.id) ? req.session.usuario.id : null;

    // garante persistência no BD (insere ou atualiza) - não é crítico em caso de erro
    try {
      const exists = await ChatbotDevice.findOne({ where: { device_id: deviceIDchatbot } });
      if (!exists) {
        await ChatbotDevice.create({
          device_id: deviceIDchatbot,
          status: 'connecting',
          last_connected: new Date(),
          created_at: new Date(),
          user_id: userId || 0
        });
      } else {
        await exists.update({ status: 'connecting', last_connected: new Date(), user_id: userId || exists.user_id || 0 });
      }
    } catch (dbErr) {
      console.warn('chatbot create-connection DB (não crítico):', dbErr && dbErr.message ? dbErr.message : dbErr);
    }

    // inicializa client (se já existir a função lida, ela só retorna)
    initializeChatbotClient(deviceIDchatbot);
    res.json({ success: true, deviceIDchatbot });
  } catch (err) {
    console.error('Erro create-connection chatbot:', err && err.message ? err.message : err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});
 
router.get('/all-status', async (req, res) => {
  try {
    const userId = req.session && req.session.usuario ? req.session.usuario.id : null;
    if (!userId) return res.status(401).json({ success: false, message: 'Não autenticado' });

    // pega devices do BD para o usuário (mesmo comportamento do WhatsApp)
    let devicesDb = [];
    try {
      devicesDb = await ChatbotDevice.findAll({ where: { user_id: userId } });
    } catch (dbErr) {
      console.warn('chatbot /all-status DB falhou (não crítico):', dbErr && dbErr.message ? dbErr.message : dbErr);
      devicesDb = [];
    }

    // reconstruir result de forma assíncrona para priorizar número do BD -> client.info -> pasta de sessão
    const result = [];
    for (const device of devicesDb) {
      const botObj = chatbotClients[device.device_id];
      let number = device.number || null;

      // se não houver número no DB, tenta client.info
      if (!number && botObj && botObj.client && botObj.client.info) {
        try {
          const info = botObj.client.info || {};
          const possible = (info.wid && info.wid.user) || (info.me && (info.me._serialized || info.me.user)) || info.number || info.phone || null;
          if (possible) number = String(possible).replace(/@.*$/,'');
        } catch (_) { number = null; }
      }

      // última chance: extrair da pasta de sessão
      if (!number) {
        try {
          const extracted = await extractNumberFromAuthDir(device.device_id);
          if (extracted) number = extracted;
        } catch (_) { /* ignore */ }
      }

      result.push({
        deviceIDchatbot: device.device_id,
        isReady: botObj ? !!botObj.isClientReady : false,
        number: number,
        lastConnected: device.last_connected || null
      });
    }

    // também inclui clients em memória que pertençam ao usuário ou que não estejam no BD (evita perda de info)
    for (const [id, bot] of Object.entries(chatbotClients)) {
      if (!id) continue;
      const already = result.find(r => r.deviceIDchatbot === id);
      if (!already) {
        // tenta resolver user association via ChatbotDevice se existir
        let belongsToUser = false;
        try {
          const devRow = await ChatbotDevice.findOne({ where: { device_id: id } });
          if (devRow && devRow.user_id === userId) belongsToUser = true;
        } catch (e) {
          // ignore DB error
        }
        if (belongsToUser || (bot && bot.userId && bot.userId === userId)) {
          let number = null;
          if (bot && bot.client && bot.client.info) {
            try {
              const info = bot.client.info || {};
              const possible = (info.wid && info.wid.user) || (info.me && (info.me._serialized || info.me.user)) || info.number || info.phone || null;
              if (possible) number = String(possible).replace(/@.*$/,'');
            } catch(_) { number = null; }
          }
          if (!number) {
            try { const extracted = await extractNumberFromAuthDir(id); if (extracted) number = extracted; } catch(_) {}
          }
          result.push({
            deviceIDchatbot: id,
            isReady: !!(bot && bot.isClientReady),
            number: number,
            lastConnected: null
          });
        }
      }
    }

    res.json({ success: true, bots: result });
  } catch (err) {
    console.error('Erro /chatbot/all-status:', err && err.message ? err.message : err);
    res.status(500).json({ success: false, bots: [] });
  }
});
 
router.delete('/remove-device', async (req, res) => {
  try {
    const deviceIDchatbot = req.query.deviceIDchatbot;
    if (!deviceIDchatbot) return res.json({ success: false, message: 'deviceIDchatbot obrigatório' });

    // 1) Destrói client em memória (se houver)
    if (chatbotClients[deviceIDchatbot]) {
      try {
        const c = chatbotClients[deviceIDchatbot].client;
        if (c && typeof c.destroy === 'function') await c.destroy();
      } catch (e) {
        console.warn('Erro ao destruir client chatbot (não crítico):', e && e.message);
      }
      delete chatbotClients[deviceIDchatbot];
    }

    // 2) Remove registro no banco (se existir) para não reaparecer em /chatbot/all-status
    try {
      await ChatbotDevice.destroy({ where: { device_id: deviceIDchatbot } });
    } catch (dbErr) {
      console.warn('Falha ao remover ChatbotDevice do BD (não crítico):', dbErr && dbErr.message);
    }

    // 3) Limpa quaisquer mapeamentos relacionados (chatId -> deviceId)
    const removedChatIds = [];
    Object.keys(chatIdToDeviceID).forEach(k => {
      if (chatIdToDeviceID[k] === deviceIDchatbot) {
        removedChatIds.push(k);
        delete chatIdToDeviceID[k];
        // também remover da lista de chats finalizados e do histórico em memória
        if (finishedChats.has(k)) finishedChats.delete(k);
        if (conversationHistory[k]) delete conversationHistory[k];
      }
    });

    // 4) Broadcast para UIs conectadas via WebSocket (atendimento/chatbot) para atualizarem a lista
    if (removedChatIds.length > 0) {
      broadcastChatbot({
        type: 'removed-transferred-chats',
        deviceIDchatbot,
        chatIds: removedChatIds
      });
    }

    return res.json({ success: true, removedChatIds });
  } catch (err) {
    console.error('Erro /chatbot/remove-device:', err);
    return res.json({ success: false, message: err.message || 'erro interno' });
  }
});

// Rota QR aprimorada: inicializa client se necessário e aguarda QR / ready
router.get('/qrcode/:deviceIDchatbot', async (req, res) => {
  const { deviceIDchatbot } = req.params;
  try {
    // Se não houver entry, inicializa (vai criar chatbotClients[deviceIDchatbot])
    if (!chatbotClients[deviceIDchatbot]) {
      initializeChatbotClient(deviceIDchatbot);
    } else if (!chatbotClients[deviceIDchatbot].client) {
      // já existe entry mas sem client (inicializa)
      initializeChatbotClient(deviceIDchatbot);
    }

    // Se já há sessão autenticada/ready, não mostramos QR
    const existing = chatbotClients[deviceIDchatbot];
    if (existing && (existing.isClientReady || existing.hasSession)) {
      return res.json({ success: true, qr: null, isReady: true });
    }

    // Aguarda QR ou estado ready por até 15s (poll)
    const start = Date.now();
    const timeout = 15000;
    const pollInterval = 400;

    while (Date.now() - start < timeout) {
      const bot = chatbotClients[deviceIDchatbot];
      if (bot) {
        // se já autenticado, não gerar QR
        if (bot.isClientReady || bot.hasSession) {
          return res.json({ success: true, qr: null, isReady: true });
        }
        if (bot.qr) {
          return res.json({ success: true, qr: bot.qr, isReady: !!bot.isClientReady });
        }
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Timeout: devolve o estado atual (se tiver qr retorna, senão false)
    const botFinal = chatbotClients[deviceIDchatbot];
    if (botFinal && botFinal.qr) {
      return res.json({ success: true, qr: botFinal.qr, isReady: !!botFinal.isClientReady });
    }
    return res.json({ success: false, qr: null, isReady: !!(botFinal && botFinal.isClientReady) });
  } catch (err) {
    console.error('Erro /chatbot/qrcode:', err && err.message ? err.message : err);
    return res.json({ success: false, qr: null, error: err && err.message ? err.message : 'erro' });
  }
});

// Inicializar cliente WhatsApp do chatbot (multi) - versão que evita gerar QR após ready/authenticated
function initializeChatbotClient(deviceIDchatbot) {
  try {
    // Se já existe e está pronto, retorna
    if (chatbotClients[deviceIDchatbot] && chatbotClients[deviceIDchatbot].client && chatbotClients[deviceIDchatbot].isClientReady) {
      return chatbotClients[deviceIDchatbot].client;
    }
    // Se já está inicializando, não recriar
    if (chatbotClients[deviceIDchatbot] && chatbotClients[deviceIDchatbot].isInitializing) {
      return chatbotClients[deviceIDchatbot].client || null;
    }

    const existing = chatbotClients[deviceIDchatbot] || {};
    const client = new Client({
      puppeteer: { headless: true, args: ['--no-sandbox'] },
      authStrategy: new LocalAuth({ clientId: deviceIDchatbot })
    });

    // marca objeto inicializando; mantém flags anteriores (hasSession se existir)
    chatbotClients[deviceIDchatbot] = {
      client,
      isClientReady: false,
      qr: null,
      userId: existing.userId || null,
      isInitializing: true,
      hasSession: existing.hasSession || false
    };

    client.on('qr', qr => {
      // Só publica QR se não estivermos autenticados / já prontos
      const bot = chatbotClients[deviceIDchatbot];
      if (!bot) return;
      if (bot.isClientReady || bot.hasSession) {
        // ignorar QR — sessão já autenticada
        bot.qr = null;
        return;
      }
      QRCode.toDataURL(qr, {
        margin: 3,
        scale: 8,
        errorCorrectionLevel: 'M',
        color: { dark: '#128C7E', light: '#FFFFFF' },
      }, (err, url) => {
        if (!chatbotClients[deviceIDchatbot]) return;
        chatbotClients[deviceIDchatbot].qr = err ? null : url;
      });
    });

    client.on('authenticated', () => {
      // sinaliza que há sessão gravada; evita geração futura de QR
      if (!chatbotClients[deviceIDchatbot]) chatbotClients[deviceIDchatbot] = {};
      chatbotClients[deviceIDchatbot].hasSession = true;
      chatbotClients[deviceIDchatbot].qr = null;
    });

    client.on('ready', async () => {
      if (!chatbotClients[deviceIDchatbot]) chatbotClients[deviceIDchatbot] = {};
      chatbotClients[deviceIDchatbot].isClientReady = true;
      chatbotClients[deviceIDchatbot].qr = null;
      chatbotClients[deviceIDchatbot].client = client;
      chatbotClients[deviceIDchatbot].isInitializing = false;
      chatbotClients[deviceIDchatbot].hasSession = true;
      console.log(`✅ ChatBot WhatsApp conectado! Device: ${deviceIDchatbot}`);
      broadcastChatbot({
        type: 'ready',
        status: 'ChatBot WhatsApp conectado!',
        deviceIDchatbot
      });
      // tenta atualizar BD com número/estado (não crítico)
      (async () => {
        try {
          // tenta extrair número via client.info primeiro
          let possibleNumber = null;
          try {
            const info = client.info || {};
            possibleNumber = (info.wid && info.wid.user) || (info.me && (info.me._serialized || info.me.user)) || info.number || info.phone || null;
            if (typeof possibleNumber === 'string') possibleNumber = possibleNumber.replace(/@.*$/,'');
          } catch(_) { possibleNumber = null; }

          // fallback: extrair da pasta de sessão se não obteve número
          if (!possibleNumber) {
            try {
              const extracted = await extractNumberFromAuthDir(deviceIDchatbot);
              if (extracted) possibleNumber = extracted;
            } catch (_) {}
          }

          try {
            const dev = await ChatbotDevice.findOne({ where: { device_id: deviceIDchatbot } });
            if (dev) {
              const updatePayload = { status: 'connected', last_connected: new Date() };
              if (possibleNumber) updatePayload.number = String(possibleNumber);
              await dev.update(updatePayload).catch(()=>{});
            }
          } catch (e) { /* não crítico */ }
        } catch (e) {}
      })();
    });

    client.on('auth_failure', (msg) => {
      console.warn('chatbot auth_failure for', deviceIDchatbot, msg);
      // em falha de auth, liberamos para permitir nova tentativa — mas não removemos sessão flag imediatamente
      if (chatbotClients[deviceIDchatbot]) {
        chatbotClients[deviceIDchatbot].qr = null;
        chatbotClients[deviceIDchatbot].isInitializing = false;
      }
    });

    client.on('disconnected', () => {
      if (chatbotClients[deviceIDchatbot]) {
        chatbotClients[deviceIDchatbot].isClientReady = false;
        chatbotClients[deviceIDchatbot].client = null;
        chatbotClients[deviceIDchatbot].isInitializing = false;
        // manter hasSession = true (se já autenticado anteriormente) so que client caiu
      }
      broadcastChatbot({
        type: 'disconnected',
        status: 'ChatBot desconectado',
        deviceIDchatbot
      });
    });

    // Mensagens do client seguem comportamento já implementado (evento 'message' foi registrado na versão anterior)
    client.initialize();
    return client;
  } catch (err) {
    console.error('initializeChatbotClient erro:', err && err.message ? err.message : err);
    // garantir flag limpa para permitir novas tentativas posteriormente
    if (chatbotClients[deviceIDchatbot]) {
      chatbotClients[deviceIDchatbot].isInitializing = false;
      chatbotClients[deviceIDchatbot].qr = null;
    }
    return null;
  }
}

router.get('/transferred-chats', async (req, res) => {
  try {
    const chatIds = Array.from(finishedChats);
    const chats = [];
    for (const chatId of chatIds) {
      const deviceIDchatbot = chatIdToDeviceID[chatId] || null;
      await fetchAndSaveChatbotMessagesIfNeeded(deviceIDchatbot, chatId, 1, 200);
      const where = { chatId };
      if (deviceIDchatbot) where.deviceId = deviceIDchatbot;
      const msgs = await WhatsappMessage.findAll({ where, order: [['timestamp','ASC']] });
      let history = [];
      if (msgs && msgs.length > 0) {
        history = msgs.map(m => ({
          id: m.id,
          role: m.fromMe ? 'assistant' : 'user',
          content: m.body,
          type: m.type,
          mimetype: m.mimetype,
          filename: m.filename,
          data: null,
          timestamp: new Date(Number(m.timestamp) * 1000).toISOString()
        }));
      } else {
        history = conversationHistory[chatId] || [];
      }
      const cpfMsg = history.find(h => h.cpf);
      const cpf = cpfMsg ? cpfMsg.cpf : null;
      chats.push({
        id: chatId,
        name: chatId.replace('@c.us', ''),
        cpf,
        history,
        lastMessage: history.length > 0 ? (history[history.length - 1].content || '') : '',
        timestamp: history.length > 0 ? _tsToSeconds(history[history.length - 1].timestamp) * 1000 : Date.now(),
        source: 'chatbot',
        isTransferred: true,
        deviceId: deviceIDchatbot
      });
    }
    res.json({ success: true, chats });
  } catch (err) {
    console.error('GET /transferred-chats erro:', err && err.message ? err.message : err);
    res.status(500).json({ success: false, chats: [] });
  }
});

// Exportações
module.exports = router;
module.exports.handleChatbotUpgrade = handleChatbotUpgrade;

// <<< ADICIONADO: expõe o conjunto de clients para uso em outros módulos (uso seguro) >>>
module.exports.chatbotClients = chatbotClients;
module.exports.fetchAndSaveChatbotMessagesIfNeeded = fetchAndSaveChatbotMessagesIfNeeded;



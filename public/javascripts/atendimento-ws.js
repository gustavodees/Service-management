/**
 * atendimento-ws.js
 * Browser client for Atendimento Web UI.
 * Responsibilities:
 * - Manage WebSocket connections for Chatbot (/ws-chatbot) and WhatsApp (/ws-atendimento).
 * - Keep a combined conversations list (chatbot + whatsapp) in memory/localStorage.
 * - Render conversations, messages, media and handle sending (text, files, audio).
 * - Provide helpers for media handling, notifications and UI interactions.
 *
 * Note: this file contains only client-side UI and WS logic. Do not modify executable
 * code here unless you understand the UI/WS contract with the backend.
 */
let wsChatbot = null;
let wsWhatsapp = null;
let selectedChatId = null;
const MAX_FILE_SIZE_MB = 16;

// Variáveis para gravação de áudio
let mediaRecorder = null;
let audioChunks = [];
let recordingTimer = null;
let recordingStartTime = null;
let isRecording = false;
// Variáveis para paginação do histórico
let currentPage = 1;
let isLoadingHistory = false;
let hasMoreHistory = true;

let shouldSendRecording = false;

// Typing indicator timer: sends "typing-stop" after user idle time
let typingTimer = null;

// Recording limits: maximum recording duration (5 minutes)
const MAX_RECORDING_TIME_MS = 5 * 60 * 1000; // 300000 ms

// Configurações de notificação
let notificationVolume = 0.5; // Valor padrão (50%)

// Variável para busca de conversa
let conversationSearchTerm = '';

// Objeto para armazenar contatos do WhatsApp por deviceId
let whatsappContactsByDevice = {};
let allWhatsappContacts = []; // Lista consolidada de todos os contatos
// Adicionar controle da aba atual (contacts | groups | archived)
let currentTab = localStorage.getItem('chatCurrentTab') || 'contacts';

// Current connected device id (persisted in localStorage)
let currentDeviceId = localStorage.getItem('currentDeviceId') || null;

// Função para atualizar histórico local de conversas
function updateLocalChatHistory(chatId, message) {
  if (!window.ultimaListaConversas) return;

  const chatIndex = window.ultimaListaConversas.findIndex(c => c.id === chatId);
  if (chatIndex === -1) return;

  if (!window.ultimaListaConversas[chatIndex].history) {
    window.ultimaListaConversas[chatIndex].history = [];
  }

  // Normaliza timestamp antes de armazenar
  message.timestamp = normalizeTimestamp(message.timestamp);

  // Para mensagens de áudio, garantir que a URL seja preservada
  if (message.type === 'ptt' || message.type === 'audio') {
    if (message.audioUrl) {
      message.body = '[Áudio]';
    } else if (message.data) {
      message.body = '[Áudio]';
    }
  }

  // Evitar duplicatas (com timestamp normalizado)
  const exists = window.ultimaListaConversas[chatIndex].history.find(m =>
    m.id === message.id ||
    (m.body === message.body &&
      m.fromMe === message.fromMe &&
      Math.abs((normalizeTimestamp(m.timestamp) || 0) - (message.timestamp || 0)) < 5)
  );

  if (!exists) {
    window.ultimaListaConversas[chatIndex].history.push(message);

    // Manter apenas as 100 mensagens mais recentes para performance
    if (window.ultimaListaConversas[chatIndex].history.length > 100) {
      window.ultimaListaConversas[chatIndex].history =
        window.ultimaListaConversas[chatIndex].history
          .sort((a, b) => (normalizeTimestamp(a.timestamp) || 0) - (normalizeTimestamp(b.timestamp) || 0))
          .slice(-100);
    }
  }
}

// Função para buscar os chats transferidos do chatbot
async function fetchChatbotTransferredChats() {
  try {
    const res = await fetch('/chatbot/transferred-chats');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.chats) ? data.chats : [];
  } catch (e) {
    console.error('Erro ao buscar chats transferidos:', e);
    return [];
  }
}

// Conectar ao WebSocket do Chatbot
function connectChatbotWebSocket() {
  wsChatbot = new WebSocket(`ws://${window.location.hostname}:${window.location.port}/ws-chatbot`);

  wsChatbot.onopen = async function () {
    console.log('WebSocket chatbot conectado');
    wsChatbot.send(JSON.stringify({ type: 'status' }));

    // Atualizar lista combinada
    await updateCombinedConversations();
  };

  wsChatbot.onmessage = async function (event) {
    const data = JSON.parse(event.data);
    console.log('Mensagem recebida do chatbot:', data);

    switch (data.type) {
      case 'ready':
      case 'status': {
        // atualiza status se necessário (implemente conforme necessidade)
        break;
      }

      case 'transferred-chats': {
        // data.chats === [ { id, name, cpf, history, lastMessage, timestamp, ... } ]
        try {
          const chats = Array.isArray(data.chats) ? data.chats : [];
          // marca origem e normalize timestamps
          const normalized = chats.map(c => ({
            ...c,
            source: 'chatbot',
            isTransferred: true,
            history: Array.isArray(c.history) ? c.history.map(h => ({
              id: h.id || `${c.id}_${Math.floor(Date.now()/1000)}_local`,
              body: h.content || h.body || '',
              fromMe: !!h.fromMe || (h.role === 'assistant'),
              type: h.type || (h.data ? 'media' : 'text'),
              mimetype: h.mimetype || null,
              filename: h.filename || null,
              data: h.data || null,
              timestamp: (typeof h.timestamp === 'string' && !/^\d+$/.test(h.timestamp)) ? Math.floor(new Date(h.timestamp).getTime()/1000) : Number(h.timestamp) || Math.floor(Date.now()/1000)
            })) : []
          }));
          // mescla com lista existente: substitui/insere
          window.ultimaListaConversas = window.ultimaListaConversas || [];
          normalized.forEach(nc => {
            const idx = window.ultimaListaConversas.findIndex(x => x.id === nc.id);
            if (idx === -1) window.ultimaListaConversas.push(nc);
            else window.ultimaListaConversas[idx] = { ...window.ultimaListaConversas[idx], ...nc };
          });
          localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
          renderConversations(window.ultimaListaConversas);
        } catch (err) {
          console.error('Erro ao processar transferred-chats:', err);
        }
        break;
      }

      case 'messages': {
        // payload: { type:'messages', chatId, messages: [...] }
        try {
          const chatId = data.chatId;
          const msgs = Array.isArray(data.messages) ? data.messages : [];
          const mapped = msgs.map(m => ({
            id: m.id || `${chatId}_${m.timestamp || Math.floor(Date.now()/1000)}_local`,
            body: m.body || m.content || '',
            fromMe: !!m.fromMe,
            type: m.type || (m.data ? 'media' : 'text'),
            mimetype: m.mimetype || null,
            filename: m.filename || null,
            data: m.data || null, // normalmente null for chatbot (use /whatsapp/media)
            timestamp: Number(m.timestamp) || Math.floor(Date.now()/1000)
          })).sort((a,b) => (a.timestamp||0) - (b.timestamp||0));

          // Atualiza chat na lista global
          window.ultimaListaConversas = window.ultimaListaConversas || [];
          let chatObj = window.ultimaListaConversas.find(c => c.id === chatId);
          if (!chatObj) {
            chatObj = {
              id: chatId,
              name: chatId.replace('@c.us',''),
              source: 'chatbot',
              isTransferred: true,
              history: mapped,
              lastMessage: mapped.length ? (mapped[mapped.length-1].body || '') : '',
              timestamp: mapped.length ? mapped[mapped.length-1].timestamp * 1000 : Date.now()
            };
            window.ultimaListaConversas.push(chatObj);
          } else {
            chatObj.history = mapped;
            chatObj.lastMessage = mapped.length ? (mapped[mapped.length-1].body || '') : chatObj.lastMessage || '';
            chatObj.timestamp = mapped.length ? mapped[mapped.length-1].timestamp * 1000 : chatObj.timestamp || Date.now();
          }
          localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));

          // Se este chat estiver selecionado, renderiza as mensagens vindas do BD
          if (selectedChatId === chatId) {
            renderMessages(mapped);
          } else {
            renderConversations(window.ultimaListaConversas);
          }
        } catch (err) {
          console.error('Erro ao processar messages do chatbot:', err);
        }
        break;
      }

      case 'new-message': {
        // chegada incremental (metadata): atualiza preview e guarda minimal no history local
        try {
          const chatId = data.chatId;
          const m = data.message || {};
          const mapped = {
            id: m.id || `${chatId}_${Math.floor(Date.now()/1000)}_inc`,
            body: m.body || m.content || '',
            fromMe: !!m.fromMe,
            type: m.type || (m.data ? 'media' : 'text'),
            mimetype: m.mimetype || null,
            filename: m.filename || null,
            data: m.data || null,
            timestamp: Number(m.timestamp) || Math.floor(Date.now()/1000)
          };

          window.ultimaListaConversas = window.ultimaListaConversas || [];
          let chatObj = window.ultimaListaConversas.find(c => c.id === chatId);

          // IMPORTANTE: não criar automaticamente chats "chatbot" a partir de new-message.
          // Só chats transferidos (CPF válido) devem aparecer — o backend envia new-finished-chat
          // ou /chatbot/transferred-chats listará os chats finalizados.
          if (!chatObj) {
            // apenas atualiza preview interna (opcional) e não adiciona à lista de conversas
            console.debug('Ignorando new-message do chatbot para chat não finalizado:', chatId);
            // opcional: armazenar em cache temporário se quiser mostrar preview depois
            // tempChatMessageCache[chatId] = mapped;
            break;
          }

          // Se o chat já existe (transferido), atualiza seu histórico/preview normalmente
          chatObj.history = chatObj.history || [];
          // evita duplicatas simples
          if (!chatObj.history.find(x => x.id === mapped.id)) chatObj.history.push(mapped);
          chatObj.lastMessage = mapped.body || chatObj.lastMessage;
          chatObj.timestamp = mapped.timestamp * 1000;
          if (!mapped.fromMe) {
            chatObj.unreadCount = (chatObj.unreadCount || 0) + 1;
            chatObj.hasNewMessages = true;
          }

          localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
          renderConversations(window.ultimaListaConversas);

          if (selectedChatId === chatId) {
            appendMessage(mapped);
          } else if (!mapped.fromMe) {
            showNotification(`Nova mensagem de ${chatObj.name}`, mapped.body || '[Mídia]', { source: 'chatbot', isGroup: false, chatId });
          }
        } catch (err) {
          console.error('Erro ao processar new-message do chatbot:', err);
        }
        break;
      }

      case 'new-finished-chat': {
        // evento que sinaliza que o chat foi finalizado (CPF válido) e deve aparecer em atendimento
        try {
          const chatId = data.chatId;
          const customerName = data.customerName || (chatId ? chatId.replace('@c.us','') : 'Chatbot');
          const cpf = data.cpf || null;
          const lastMessage = data.lastMessage || data.message || '';
          // evita duplicatas
          window.ultimaListaConversas = window.ultimaListaConversas || [];
          if (!window.ultimaListaConversas.find(c => c.id === chatId)) {
            const newChat = {
              id: chatId,
              name: customerName,
              source: 'chatbot',
              isTransferred: true,
              cpf,
              history: [], // histórico será carregado do DB quando o atendente selecionar (get-messages)
              lastMessage: lastMessage,
              timestamp: data.timestamp ? Number(data.timestamp) * 1000 : Date.now()
            };
            window.ultimaListaConversas.unshift(newChat);
            localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
            renderConversations(window.ultimaListaConversas);
            showNotification('Chat transferido', `Chat de ${customerName} transferido para atendimento.`);
          } else {
            // atualiza preview se já existia
            const existing = window.ultimaListaConversas.find(c => c.id === chatId);
            existing.lastMessage = lastMessage;
            existing.isTransferred = true;
            existing.cpf = existing.cpf || cpf;
            localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
            renderConversations(window.ultimaListaConversas);
          }
        } catch (err) {
          console.error('Erro ao processar new-finished-chat:', err);
        }
        break;
      }

      case 'error': {
        console.error('Erro websocket chatbot:', data);
        break;
      }

      default:
        console.log('Tipo ws chatbot não tratado:', data.type);
    }
  };

  wsChatbot.onerror = function (error) {
    console.error('Erro no WebSocket chatbot:', error);
  };

  wsChatbot.onclose = function () {
    console.log('WebSocket chatbot desconectado. Tentando reconectar...');
    setTimeout(connectChatbotWebSocket, 3000);
  };
}

// Helper: normaliza flag de grupo e mescla contatos sem perder itens existentes
function normalizeIsGroup(chat) {
  if (typeof chat?.isGroup === 'boolean') return !!chat.isGroup;
  const id = chat?.id || '';
  return id.endsWith('@g.us');
}

// Novo helper: detecta contatos do tipo "status" (WhatsApp) para ignorar na listagem
function isStatusContact(chat) {
  if (!chat) return false;
  if (chat.isStatus === true) return true;
  const id = (chat.id || '').toString();
  if (!id) return false;
  // padrões possíveis de status / broadcast de status
  if (id.endsWith('@status') || id === 'status@broadcast' || id.includes('/status')) return true;
  return false;
}

function mergeWhatsappContacts(existing = [], incoming = []) {
  const map = new Map();
  existing.forEach(c => map.set(c.id, { ...c, isGroup: normalizeIsGroup(c) }));
  incoming.forEach(c => {
    const prev = map.get(c.id);
    const next = { ...(prev || {}), ...c };
    next.isGroup = normalizeIsGroup(next);
    map.set(c.id, next);
  });
  return Array.from(map.values());
}

// Conectar ao WebSocket do WhatsApp
function connectWhatsappWebSocket() {
  wsWhatsapp = new WebSocket(`ws://${window.location.hostname}:${window.location.port}/ws-atendimento`);

  wsWhatsapp.onopen = async function () {
    console.log('WebSocket WhatsApp conectado');
    // Solicita os contatos de todos os dispositivos já conectados ao carregar a página
    wsWhatsapp.send(JSON.stringify({ type: 'get-all-contacts' }));
    await updateCombinedConversations();
  };

  wsWhatsapp.onmessage = async function (event) {
    const data = JSON.parse(event.data);
    console.log('Mensagem recebida do WhatsApp:', data);

    switch (data.type) {
      case 'all-whatsapp-contacts':
        // Este evento é acionado na conexão inicial e quando um novo dispositivo se conecta.
        // CORREÇÃO: A lógica foi alterada para armazenar contatos por deviceId,
        // evitando que conversas de dispositivos antigos se misturem com os novos.
        if (Array.isArray(data.contacts) && data.deviceId) {
          console.log(`Recebidos ${data.contacts.length} contatos do dispositivo ${data.deviceId}`);
          
          // Armazena a lista de contatos para este dispositivo específico.
          whatsappContactsByDevice[data.deviceId] = data.contacts.map(c => ({
            ...c,
            source: 'whatsapp',
            deviceId: data.deviceId,
            isGroup: c.isGroup || (c.id && c.id.endsWith('@g.us'))
          }));

          // Consolida as listas de todos os dispositivos ativos.
          const allActiveContacts = Object.values(whatsappContactsByDevice).flat();
          window.ultimaListaConversas = mergeWhatsappContacts(window.ultimaListaConversas || [], allActiveContacts);

          // Salva a lista consolidada e renderiza a interface.
          localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
          renderConversations(window.ultimaListaConversas);
        }
        break;

      case 'whatsapp-contacts-updated': {
        console.log('Contatos WhatsApp atualizados:', data.allContacts);
        const incoming = (data.allContacts || []).map(c => ({ ...c, isGroup: normalizeIsGroup(c) }));
        // Mescla sem perder grupos já existentes
        allWhatsappContacts = mergeWhatsappContacts(allWhatsappContacts, incoming);
        await updateCombinedConversations(allWhatsappContacts);
        break;
      }

      case 'new-whatsapp-contact':
        console.log('Novo contato WhatsApp:', data.contact);
        if (data.contact) {
          const existingIndex = allWhatsappContacts.findIndex(c => c.id === data.contact.id);
          if (existingIndex === -1) {
            allWhatsappContacts.push(data.contact);
            await updateCombinedConversations(allWhatsappContacts);
            showNotification(
              `Novo contato: ${data.contact.name}`,
              'Nova conversa disponível'
            );
          }
        }
        break;

      case 'ready':
        console.log('WhatsApp pronto, chats recebidos:', data.chats);
        if (Array.isArray(data.chats) && data.deviceId) {
          currentDeviceId = data.deviceId;
          localStorage.setItem('currentDeviceId', data.deviceId);

          whatsappContactsByDevice[data.deviceId] = data.chats.map(chat => ({
            ...chat,
            deviceId: data.deviceId,
            isGroup: normalizeIsGroup(chat)
          }));

          const mergedByDevice = Object.values(whatsappContactsByDevice).flat();
          allWhatsappContacts = mergeWhatsappContacts(allWhatsappContacts, mergedByDevice);

          if (Array.isArray(data.allContacts)) {
            allWhatsappContacts = mergeWhatsappContacts(allWhatsappContacts, data.allContacts);
          }
        }
        await updateCombinedConversations(allWhatsappContacts);
        break;

      case 'whatsapp-connected':
        console.log('WhatsApp conectado');
        if (data.deviceId) {
          currentDeviceId = data.deviceId;
          localStorage.setItem('currentDeviceId', data.deviceId);
        }
        wsWhatsapp.send(JSON.stringify({ type: 'get-all-contacts' }));
        break;

      case 'new-message':
        await handleWhatsappMessage(data);
        break;

      case 'messages':
        if (data.chatId) {
          // Garantir estrutura
          if (!window.ultimaListaConversas) window.ultimaListaConversas = [];
          let chatObj = window.ultimaListaConversas.find(c => c.id === data.chatId);
          if (!chatObj) {
            chatObj = { id: data.chatId, name: data.chatId.replace('@c.us',''), history: [], source: 'whatsapp', deviceId: data.deviceId };
            window.ultimaListaConversas.push(chatObj);
          }

          // Mensagens vindas do backend
          const incoming = Array.isArray(data.messages) ? data.messages : [];

          // Mensagens já presentes localmente
          const existing = Array.isArray(chatObj.history) ? chatObj.history : [];

          // Merge deduplicando por id quando existir, senão por (body+timestamp+fromMe)
          const map = new Map();
          const pushToMap = (m) => {
            const key = m.id || `${m.body || ''}__${m.timestamp || 0}__${m.fromMe ? 1 : 0}`;
            if (!map.has(key)) {
              map.set(key, m);
            } else {
              // se já existe, preferir a versão que tem dados/mídia mais completos
              const prev = map.get(key);
              // substitui se o novo contém campos úteis que o anterior não tinha
              if ((!prev.data && m.data) || (!prev.audioUrl && m.audioUrl) || (!prev.filename && m.filename)) {
                map.set(key, { ...prev, ...m });
              }
            }
          };

          // manter ordem cronológica: primeiro existing (mais antigos), depois incoming
          existing.forEach(pushToMap);
          incoming.forEach(pushToMap);

          const merged = Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          chatObj.history = merged;

          // Se o chat está aberto, renderiza com o histórico mesclado
          if (data.chatId === selectedChatId) {
            renderMessages(chatObj.history);
          }

          // Atualiza listagem e storage
          renderConversations(window.ultimaListaConversas);
          localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
        }
        break;

      case 'chat-history': {
        // payload: { type: 'chat-history', chatId, messages: [...], deviceId }
        try {
          const chatId = data.chatId;
          const incoming = Array.isArray(data.messages) ? data.messages : [];

          if (!chatId) break;

          // Ensure global list
          window.ultimaListaConversas = window.ultimaListaConversas || [];

          let chatObj = window.ultimaListaConversas.find(c => c.id === chatId);
          if (!chatObj) {
            chatObj = {
              id: chatId,
              name: chatId.replace('@c.us',''),
              source: 'whatsapp',
              isTransferred: false,
              isGroup: chatId.endsWith('@g.us'),
              deviceId: data.deviceId || currentDeviceId,
              history: [],
              lastMessage: '',
              timestamp: Date.now()
            };
            window.ultimaListaConversas.push(chatObj);
          }

          // Merge incoming with existing history deduping by id (prefer items with data)
          const existing = Array.isArray(chatObj.history) ? chatObj.history : [];
          const map = new Map();
          const pushToMap = (m) => {
            const key = m.id || `${m.body || ''}__${m.timestamp || 0}__${m.fromMe ? 1 : 0}`;
            if (!map.has(key)) map.set(key, m);
            else {
              const prev = map.get(key);
              if ((!prev.data && m.data) || (!prev.audioUrl && m.audioUrl) || (!prev.filename && m.filename)) {
                map.set(key, { ...prev, ...m });
              }
            }
          };

          existing.forEach(pushToMap);
          incoming.forEach(pushToMap);

          const merged = Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          chatObj.history = merged;

          // Update lastMessage/timestamp
          if (merged.length) {
            const last = merged[merged.length - 1];
            chatObj.lastMessage = last.body || chatObj.lastMessage || '';
            chatObj.timestamp = (last.timestamp ? Number(last.timestamp) : Date.now()) * 1000;
          }

          // Persist and render
          localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
          if (selectedChatId === chatId) {
            renderMessages(chatObj.history);
          }
          renderConversations(window.ultimaListaConversas);
        } catch (err) {
          console.error('Erro ao processar chat-history:', err);
        }
        break;
      }

      case 'message-sent':
        console.log('Mensagem enviada com sucesso');
        const loadingMessages = document.querySelectorAll('.message.message-out .loading-message');
        loadingMessages.forEach(msg => {
          const parent = msg.closest('.message');
          if (parent) parent.remove();
        });
        break;

      case 'media-sent':
        console.log('Mídia enviada com sucesso');
        const loadingMediaMessages = document.querySelectorAll('.message.message-out .loading-message');
        loadingMediaMessages.forEach(msg => {
          const parent = msg.closest('.message');
          if (parent) parent.remove();
        });
        break;

      case 'audio-sent':
        console.log('Áudio enviado com sucesso:', data);
        const loadingAudioMessages = document.querySelectorAll('.message.message-out .loading-message');
        loadingAudioMessages.forEach(msg => {
          const parent = msg.closest('.message');
          if (parent) parent.remove();
        });

        if (data.chatId === selectedChatId && data.audioUrl) {
          const audioMessage = {
            id: data.messageId,
            body: '[Áudio]',
            fromMe: true,
            type: 'ptt',
            timestamp: Date.now() / 1000,
            audioUrl: data.audioUrl,
            mimetype: 'audio/ogg; codecs=opus'
          };
          appendMessage(audioMessage);
          updateLocalChatHistory(data.chatId, audioMessage);
        }
        break;

      case 'audio-sent-broadcast': {
        console.log('Broadcast de áudio enviado:', data);
        // Evita duplicar no remetente
        if (data.chatId === selectedChatId && data.message && !data.message.fromMe) {
          appendMessage(data.message);
          updateLocalChatHistory(data.chatId, data.message);
        }
        break;
      }

      case 'message-sent-broadcast': {
        console.log('Broadcast de mensagem enviada:', data);
        // Evita duplicar no remetente
        if (data.chatId === selectedChatId && data.message && !data.message.fromMe) {
          appendMessage(data.message);
          updateLocalChatHistory(data.chatId, data.message);
        }
        break;
      }

      case 'media-sent-broadcast': {
        console.log('Broadcast de mídia enviada:', data);
        // Evita duplicar no remetente (já mostramos o preview ao enviar)
        if (data.chatId === selectedChatId && data.message && !data.message.fromMe) {
          appendMessage(data.message);
          updateLocalChatHistory(data.chatId, data.message);
        }
        break;
      }

      case 'error':
        console.error('Erro WhatsApp:', data.status);
        showNotification('Erro WhatsApp', data.status || 'Erro desconhecido');
        break;

      case 'disconnected':
        // CORREÇÃO: Ao receber um evento de desconexão, removemos os contatos associados
        // a esse deviceId da nossa lista em memória e reconstruímos a lista de conversas.
        if (data.deviceId && whatsappContactsByDevice[data.deviceId]) {
          delete whatsappContactsByDevice[data.deviceId];

          // Reconstrói a lista de conversas ativas a partir dos dispositivos restantes.
          const remainingContacts = Object.values(whatsappContactsByDevice).flat();
          window.ultimaListaConversas = mergeWhatsappContacts([], remainingContacts); // Começa com uma lista vazia para garantir a limpeza

          // Atualiza a interface e o armazenamento local.
          renderConversations(window.ultimaListaConversas);
          localStorage.setItem('ultimaListaConversas', JSON.stringify(window.ultimaListaConversas));
        }
        console.log('WhatsApp desconectado');
        break;

      case 'chat-tabulated':
        if (data.chatId) {
          console.log(`Conversa ${data.chatId} foi tabulada, removendo da lista.`);
          removeChatFromList(data.chatId);
          showNotification('Conversa Tabulada', 'A conversa foi movida para as tabulações.');
        }
        break;

      case 'chat-returned':
        if (data.contact) {
          if (!window.ultimaListaConversas) window.ultimaListaConversas = [];
          // Evita duplicatas
          if (!window.ultimaListaConversas.some(c => c.id === data.contact.id)) {
            window.ultimaListaConversas.push(data.contact);
            renderConversations(window.ultimaListaConversas);
          }
          showNotification('Atendimento', 'Conversa retornou ao atendimento.');
        }
        break;

    }
  };

  wsWhatsapp.onerror = function (error) {
    console.error('Erro no WebSocket WhatsApp:', error);
  };

  wsWhatsapp.onclose = function () {
    console.log('WebSocket WhatsApp desconectado. Tentando reconectar...');
    setTimeout(connectWhatsappWebSocket, 3000);
  };
}

// Função para atualizar lista combinada de conversas
async function updateCombinedConversations(whatsappChats = null) {
  try {
    // Busca os chats já transferidos do chatbot
    const chatbotChats = await fetchChatbotTransferredChats();
    // CORREÇÃO: Usa a lista de conversas já carregada (window.ultimaListaConversas) como base,
    // em vez de começar com uma lista vazia. Isso evita que os contatos iniciais desapareçam.
    let whatsappChatList = whatsappChats || window.ultimaListaConversas || allWhatsappContacts || [];

    console.log('Atualizando conversas:', {
      chatbotChats: chatbotChats.length,
      whatsappChats: whatsappChatList.length
    });

    const combinedChats = [];

    chatbotChats.forEach(chat => {
      combinedChats.push({
        ...chat,
        source: 'chatbot',
        isTransferred: true,
        isGroup: false
      });
    });

    whatsappChatList.forEach(chat => {
      const existingChat = combinedChats.find(c => c.id === chat.id);
      if (!existingChat) {
        combinedChats.push({
          ...chat,
          source: 'whatsapp',
          isTransferred: false,
          isGroup: normalizeIsGroup(chat),
          lastMessage: chat.lastMessage || 'Conversa ativa',
          history: chat.history || []
        });
      }
    });

    window.ultimaListaConversas = combinedChats;
    localStorage.setItem('ultimaListaConversas', JSON.stringify(combinedChats));
    renderConversations(combinedChats);

    console.log('Lista combinada atualizada:', combinedChats.length, 'conversas');

  } catch (error) {
    console.error('Erro ao atualizar conversas combinadas:', error);
  }
}

// Handler para mensagens do chatbot
async function handleChatbotMessage(data) {
  if (!window.ultimaListaConversas) window.ultimaListaConversas = [];
  let chatObj = window.ultimaListaConversas.find(c => c.id === data.chatId);

  if (!chatObj) return; // Só atualiza se já existe

  // Atualiza histórico e última mensagem
  chatObj.history = data.fullHistory || chatObj.history || [];
  chatObj.lastMessage = data.message.body || data.message.content || '';
  chatObj.timestamp = Date.now();
  if (!data.message.fromMe) {
    chatObj.unreadCount = (chatObj.unreadCount || 0) + 1;
    chatObj.hasNewMessages = true;
  }

  renderConversations(window.ultimaListaConversas);

  if (selectedChatId === data.chatId) {
    appendMessage(data.message);
  }
}

// Handler para mensagens do WhatsApp - ATUALIZADO
async function handleWhatsappMessage(data) {
  if (!window.ultimaListaConversas) {
    window.ultimaListaConversas = [];
  }

  if (!data.message || (!data.message.body && !data.message.type && !data.message.data)) {
    console.log('Mensagem vazia recebida do WhatsApp, ignorando...');
    return;
  }

  // CORREÇÃO: O chatId correto é `message.to` para mensagens enviadas e `message.from` para recebidas.
  const effectiveChatId = data.message.fromMe ? data.message.to : data.message.from;

  const isGroup = effectiveChatId && effectiveChatId.endsWith('@g.us');
  let chatIndex = window.ultimaListaConversas.findIndex(c => c.id === effectiveChatId);
  let chatObj;

  let lastMessageText = data.message.body;
  if (!lastMessageText) {
    switch (data.message.type) {
      case 'ptt': case 'audio': lastMessageText = '[Áudio]'; break;
      case 'image': lastMessageText = '[Imagem]'; break;
      case 'video': lastMessageText = '[Vídeo]'; break;
      case 'document': lastMessageText = `[Documento] ${data.message.filename || ''}`; break;
      default: lastMessageText = '[Mídia]';
    }
  }

  if (chatIndex === -1) {
    // Se o chat não existe, cria um novo objeto
    chatObj = {
      id: effectiveChatId,
      name: data.customerName || (isGroup ? 'Grupo' : effectiveChatId.replace('@c.us', '')),
      lastMessage: lastMessageText,
      timestamp: Date.now(),
      history: [],
      unreadCount: data.message.fromMe ? 0 : 1,
      hasNewMessages: !data.message.fromMe,
      source: 'whatsapp',
      isTransferred: false,
      isGroup: isGroup,
      deviceId: data.deviceId || currentDeviceId
    };
    // Adiciona o novo chat no topo da lista
    window.ultimaListaConversas.unshift(chatObj);
  } else {
    // Se o chat já existe, atualiza e move para o topo
    chatObj = window.ultimaListaConversas[chatIndex];
    chatObj.lastMessage = lastMessageText;
    chatObj.timestamp = Date.now();
    if (!data.message.fromMe) {
      chatObj.unreadCount = (chatObj.unreadCount || 0) + 1;
      chatObj.hasNewMessages = true;
    }
    // Remove da posição atual e insere no início
    window.ultimaListaConversas.splice(chatIndex, 1);
    window.ultimaListaConversas.unshift(chatObj);
  }

  // Garante que o contato (incluindo grupo) está na lista consolidada
  allWhatsappContacts = mergeWhatsappContacts(allWhatsappContacts, [chatObj]);

  // Processamento de áudio (lógica existente)
  if ((data.message.type === 'ptt' || data.message.type === 'audio') && data.message.data && effectiveChatId) {
    try {
      fetch('/whatsapp/save-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // CORREÇÃO: Usar o effectiveChatId para garantir que o áudio seja salvo no chat correto.
          chatId: effectiveChatId,
          messageId: data.message.id,
          audioData: data.message.data,
          timestamp: data.message.timestamp
        })
      })
      .then(res => res.json())
      .then(result => {
        if (result.success && result.audioUrl) {
          data.message.audioUrl = result.audioUrl;
          updateLocalChatHistory(effectiveChatId, data.message);
          if (selectedChatId === effectiveChatId) {
            const messageElements = document.querySelectorAll('.message .audio-message');
            messageElements.forEach(audioEl => {
              const messageIdMatch = audioEl.dataset.messageId === data.message.id;
              const hasNoPlayer = !audioEl.querySelector('audio');
              if (hasNoPlayer || messageIdMatch) {
                audioEl.innerHTML = `
                  <audio controls style="max-width: 300px;"><source src="${result.audioUrl}" type="audio/ogg"></audio>
                  <br><small>🎵 Áudio</small>`;
              }
            });
          }
        }
      }).catch(err => console.error('Erro ao salvar áudio:', err));
    } catch (error) {
      console.error('Erro ao processar áudio recebido:', error);
    }
  }

  // Atualiza o histórico e renderiza a lista de conversas atualizada
  updateLocalChatHistory(effectiveChatId, data.message);
  renderConversations(window.ultimaListaConversas);

  // Se o chat estiver aberto, adiciona a nova mensagem
  if (selectedChatId === effectiveChatId) {
    appendMessage(data.message);
  }

  // Mostra notificação para mensagens recebidas
  if (!data.message.fromMe && lastMessageText) {
    showNotification(
      `Nova mensagem de ${chatObj.name}`,
      lastMessageText, 
      { source: 'whatsapp', isGroup: isGroup, chatId: effectiveChatId }
    );
  }
}

// Função principal de conexão
function connectAtendimentoWebSocket() {
  connectChatbotWebSocket();
  connectWhatsappWebSocket();
}

// Função para gravar áudio com qualidade otimizada para MP3
async function startRecording() {
  try {
    console.log('Iniciando gravação de áudio...');

  // When starting a local audio recording, notify the backend for WhatsApp chats
  if (selectedChatId && wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
      const chatObj = window.ultimaListaConversas?.find(c => c.id === selectedChatId);
      if (chatObj && chatObj.source === 'whatsapp') {
        const deviceId = chatObj.deviceId || currentDeviceId;
        wsWhatsapp.send(JSON.stringify({ type: 'recording-start', chatId: selectedChatId, deviceId }));
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 44100,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    let mediaRecorderOptions = {};

    if (MediaRecorder.isTypeSupported('audio/wav')) {
      mediaRecorderOptions = { mimeType: 'audio/wav' };
    } else if (MediaRecorder.isTypeSupported('audio/webm; codecs=pcm')) {
      mediaRecorderOptions = { mimeType: 'audio/webm; codecs=pcm' };
    } else if (MediaRecorder.isTypeSupported('audio/webm')) {
      mediaRecorderOptions = { mimeType: 'audio/webm' };
    }

    mediaRecorder = new MediaRecorder(stream, mediaRecorderOptions);
    audioChunks = [];
    shouldSendRecording = false; // reset em cada nova gravação

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
        console.log('Chunk de áudio capturado:', event.data.size, 'bytes');
      }
    };

    mediaRecorder.onstop = async () => {
      console.log('Gravação finalizada, processando áudio...');

      const originalBlob = new Blob(audioChunks, {
        type: mediaRecorder.mimeType || 'audio/webm'
      });

      // Sempre liberar microfone
      stream.getTracks().forEach(track => track.stop());

      // Travar envio quando não for parada pelo usuário
      if (!shouldSendRecording) {
        console.log('Gravação finalizada sem envio (cancelada/auto).');
        audioChunks = [];
        return;
      }

      console.log('Áudio gravado:', {
        size: originalBlob.size,
        type: originalBlob.type,
        mimeType: mediaRecorder.mimeType
      });

      // Converte para MP3 se possível
      try {
        console.log('Convertendo áudio para MP3...');
        if (window.AudioUtils && window.AudioUtils.convertToMp3) {
          const mp3Blob = await window.AudioUtils.convertToMp3(originalBlob);
          console.log('Conversão MP3 concluída');
          sendAudioMessage(mp3Blob);
        } else {
          console.log('AudioUtils não disponível, enviando áudio original');
          sendAudioMessage(originalBlob);
        }
      } catch (error) {
        console.error('Erro na conversão MP3:', error);
        sendAudioMessage(originalBlob);
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('Erro no MediaRecorder:', event.error);
      showNotification('Erro de Gravação', 'Erro durante a gravação: ' + event.error);
      stream.getTracks().forEach(track => track.stop());
    };

    mediaRecorder.start(1000);
    isRecording = true;
    recordingStartTime = Date.now();

    const audioControls = document.getElementById('audio-controls');
    const recordBtn = document.getElementById('audio-record-btn');
    if (audioControls) {
      // se você estiver usando a classe .is-active, pode manter
      audioControls.style.display = 'flex';
      audioControls.classList.add('is-active');
    }
    if (recordBtn) recordBtn.disabled = true;

    recordingTimer = setInterval(updateRecordingTimer, 1000);

    // Auto-stop no novo limite (5 minutos)
    setTimeout(() => {
      if (isRecording) {
        console.log(`Gravação interrompida automaticamente após ${MAX_RECORDING_TIME_MS / 1000}s`);
        stopRecording(true); // envia após atingir o limite
      }
    }, MAX_RECORDING_TIME_MS);

    console.log('Gravação iniciada com sucesso');
  } catch (error) {
    console.error('Erro ao iniciar gravação:', error);
    showNotification('Erro de Microfone', 'Erro ao acessar o microfone: ' + error.message);
  }
}

function stopRecording(send = true) {
  if (mediaRecorder && isRecording) {
    console.log('Parando gravação...');
    shouldSendRecording = !!send; // só envia se true
    mediaRecorder.stop();
    isRecording = false;
    clearInterval(recordingTimer);

  // When stopping a local audio recording, notify the backend for WhatsApp chats
  if (selectedChatId && wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
      const chatObj = window.ultimaListaConversas?.find(c => c.id === selectedChatId);
      if (chatObj && chatObj.source === 'whatsapp') {
        const deviceId = chatObj.deviceId || currentDeviceId;
        wsWhatsapp.send(JSON.stringify({ type: 'recording-stop', chatId: selectedChatId, deviceId }));
      }
    }

    const audioControls = document.getElementById('audio-controls');
    const recordBtn = document.getElementById('audio-record-btn');
    if (audioControls) audioControls.style.display = 'none';
    if (recordBtn) recordBtn.disabled = false;

    console.log('Gravação parada');
  }
}

function cancelRecording() {
  if (mediaRecorder && isRecording) {
    console.log('Cancelando gravação...');
    // Não enviar ao cancelar
    shouldSendRecording = false;

    mediaRecorder.stop(); // onstop será chamado, mas não enviará
    isRecording = false;
    clearInterval(recordingTimer);
    audioChunks = [];

  // When cancelling a local audio recording, notify the backend for WhatsApp chats
  if (selectedChatId && wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
      const chatObj = window.ultimaListaConversas?.find(c => c.id === selectedChatId);
      if (chatObj && chatObj.source === 'whatsapp') {
        const deviceId = chatObj.deviceId || currentDeviceId;
        wsWhatsapp.send(JSON.stringify({ type: 'recording-stop', chatId: selectedChatId, deviceId }));
      }
    }

    const audioControls = document.getElementById('audio-controls');
    const recordBtn = document.getElementById('audio-record-btn');
    if (audioControls) audioControls.style.display = 'none';
    if (recordBtn) recordBtn.disabled = false;

    console.log('Gravação cancelada');
  }
}

function updateRecordingTimer() {
  if (recordingStartTime) {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');

    const timerElement = document.getElementById('recording-timer');
    if (timerElement) {
      timerElement.textContent = `${minutes}:${seconds}`;
    }
  }
}

function sendAudioMessage(audioBlob) {
  if (!selectedChatId) {
    showNotification('Erro', 'Selecione uma conversa antes de enviar áudio.');
    return;
  }

  console.log('Preparando envio de áudio:', {
    size: audioBlob.size,
    type: audioBlob.type
  });

  const chatMessages = document.getElementById('chat-messages');
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'message message-out';
  loadingDiv.innerHTML = '<span class="loading-message">📤 Enviando áudio...</span>';
  chatMessages.appendChild(loadingDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  const reader = new FileReader();

  reader.onload = function (e) {
    const base64 = e.target.result.split(',')[1];

    if (!base64 || base64.length === 0) {
      if (chatMessages.contains(loadingDiv)) {
        chatMessages.removeChild(loadingDiv);
      }
      showNotification('Erro', 'Dados de áudio inválidos.');
      return;
    }

    const mimeType = audioBlob.type.includes('mp3') ? 'audio/mp3' : 'audio/mpeg';
    const filename = `audio_${Date.now()}.mp3`;

    console.log('Enviando áudio:', {
      filename,
      mimeType,
      originalType: audioBlob.type,
      dataLength: base64.length,
      blobSize: audioBlob.size
    });

    let chatObj = null;
    if (window.ultimaListaConversas) {
      chatObj = window.ultimaListaConversas.find(c => c.id === selectedChatId);
    }

    if (chatObj && chatObj.source === 'chatbot') {
      // Envia via chatbot
      (async () => {
        try {
          const res = await fetch('/chatbot/send-media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chatId: selectedChatId,
              filename: filename,
              mimetype: mimeType,
              data: base64
            })
          });
          const data = await res.json().catch(()=>({}));
          if (chatMessages.contains(loadingDiv)) {
            chatMessages.removeChild(loadingDiv);
          }

          if (!data || !data.success) {
            console.error('Erro no envio via chatbot:', data && data.error);
            showNotification('Erro', 'Erro ao enviar áudio: ' + (data && data.error ? data.error : 'Erro desconhecido'));
            return;
          }

          // Mostrar imediatamente o áudio enviado no UI (mesmo comportamento do WhatsApp)
          const messageId = (data.message && data.message.id) ? data.message.id : `local_audio_${Date.now()}`;
          const audioMessage = {
            id: messageId,
            body: '[Áudio]',
            fromMe: true,
            type: 'ptt',
            timestamp: Math.floor(Date.now() / 1000),
            mimetype: mimeType,
            filename: filename,
            data: base64 // incluir base64 para exibir player imediatamente
          };

          appendMessage(audioMessage);
          updateLocalChatHistory(selectedChatId, audioMessage);

          console.log('Áudio enviado com sucesso via chatbot e exibido na UI');
        } catch (err) {
          if (chatMessages.contains(loadingDiv)) {
            chatMessages.removeChild(loadingDiv);
          }
          console.error('Erro na requisição:', err);
          showNotification('Erro', 'Erro ao enviar áudio: ' + (err.message || 'Erro desconhecido'));
        }
      })();
    } else {
      // Envia via WhatsApp direto
      if (wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
        // Obter deviceId correto
        const deviceId = chatObj?.deviceId || currentDeviceId || localStorage.getItem('currentDeviceId');

        wsWhatsapp.send(JSON.stringify({
          type: 'send-audio', // Mudança: usar 'send-audio' em vez de 'send-media'
          chatId: selectedChatId,
          audioData: base64,
          deviceId: deviceId // Incluir deviceId
        }));

        console.log('Áudio enviado via WebSocket WhatsApp com deviceId:', deviceId);

        setTimeout(() => {
          if (chatMessages.contains(loadingDiv)) {
            chatMessages.removeChild(loadingDiv);
          }
        }, 8000);
      } else {
        if (chatMessages.contains(loadingDiv)) {
          chatMessages.removeChild(loadingDiv);
        }
        console.error('WebSocket WhatsApp não está conectado');
        showNotification('Erro', 'Não foi possível enviar o áudio. Verifique sua conexão.');
      }
    }
  };

  reader.onerror = function () {
    if (chatMessages.contains(loadingDiv)) {
      chatMessages.removeChild(loadingDiv);
    }
    console.error('Erro ao processar áudio para base64');
    showNotification('Erro', 'Erro ao processar o áudio.');
  };

  reader.readAsDataURL(audioBlob);
}

// Função para renderizar mensagens
function renderMessages(messages) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  let chatObj = null;
  if (window.ultimaListaConversas && selectedChatId) {
    chatObj = window.ultimaListaConversas.find(c => c.id === selectedChatId);
  }

  // Mesclar histórico local e mensagens recebidas, sem sobrescrever
  let allMessages = [];
  if (chatObj && Array.isArray(chatObj.history)) {
    // Mescla e remove duplicatas por id ou timestamp/body
    allMessages = [...chatObj.history, ...(messages || [])];
    // normalizar timestamps e remover duplicatas
    allMessages.forEach(msg => {
      msg.timestamp = normalizeTimestamp(msg.timestamp);
    });

    const uniqueMessages = [];
    const seen = new Set();
    allMessages.forEach(msg => {
      const key = msg.id || `${msg.body || ''}_${msg.timestamp || 0}_${msg.fromMe ? 1 : 0}`;
      if (!seen.has(key)) {
        uniqueMessages.push(msg);
        seen.add(key);
      }
    });
    uniqueMessages.sort((a, b) => (normalizeTimestamp(a.timestamp) || 0) - (normalizeTimestamp(b.timestamp) || 0));
    allMessages = uniqueMessages;
  } else {
    allMessages = messages || [];
  }

  if (allMessages.length === 0) {
    chatMessages.innerHTML = `
      <div class="empty-chat">
        <i class="fa-solid fa-comment-dots"></i>
        <p>Nenhuma mensagem neste chat.</p>
      </div>
    `;
    return;
  }

  chatMessages.innerHTML = '';
  allMessages.forEach((msg) => {
    const div = document.createElement('div');
    div.className = msg.fromMe ? 'message message-out' : 'message message-in';

    // Verificar se é mídia (incluindo áudio) ou tipo específico
    if ((msg.type === 'media' && msg.data) ||
      (msg.mimetype && (msg.mimetype.startsWith('image/') || msg.mimetype.startsWith('video/') || msg.mimetype.startsWith('audio/'))) ||
      msg.type === 'ptt' ||
      msg.type === 'audio' ||
      msg.audioUrl) {
      const mediaContent = renderMediaContent(msg);
      div.innerHTML = mediaContent;
    } else {
      div.innerHTML = `<span>${msg.body || ''}</span>`;
    }

    chatMessages.appendChild(div);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Função para adicionar uma mensagem
function appendMessage(msg) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  const div = document.createElement('div');
  div.className = msg.fromMe ? 'message message-out' : 'message message-in';

  // Verificar se é mídia (incluindo áudio) ou tipo específico
  if ((msg.type === 'media' && msg.data) ||
    (msg.mimetype && (msg.mimetype.startsWith('image/') || msg.mimetype.startsWith('video/') || msg.mimetype.startsWith('audio/'))) ||
    msg.type === 'ptt' ||
    msg.type === 'audio' ||
    msg.audioUrl) {
    const mediaContent = renderMediaContent(msg);
    div.innerHTML = mediaContent;
  } else {
    div.innerHTML = `<span>${msg.body || ''}</span>`;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Função para renderizar conteúdo de mídia
function renderMediaContent(msg) {
  // OTIMIZAÇÃO: Se 'data' (base64) já estiver presente, renderiza diretamente.
  if (msg.data && msg.mimetype) {
    if (msg.mimetype.startsWith('image/')) {
    const base64Data = `data:${msg.mimetype};base64,${msg.data}`;
    return `<img src="${base64Data}" 
                 alt="Imagem" 
                 style="max-width: 300px; max-height: 200px; border-radius: 8px; cursor: pointer;" 
                 onclick="openImageModal('${base64Data}', '${msg.mimetype}')">`;
    } else if (msg.mimetype.startsWith('video/')) {
    const base64Data = `data:${msg.mimetype};base64,${msg.data}`;
    return `<video controls style="max-width:320px;"><source src="data:${msg.mimetype};base64,${msg.data}" type="${msg.mimetype}"></video>`;
    }
    // Outros tipos de mídia com 'data' podem ser adicionados aqui.
  }

  // OTIMIZAÇÃO: Se 'data' não estiver presente, cria um placeholder clicável para buscar a mídia sob demanda.
  if (msg.hasMedia && msg.mimetype) {
    const iconClass = msg.mimetype.startsWith('image/') ? 'fa-image' : (msg.mimetype.startsWith('video/') ? 'fa-video' : 'fa-file');
    return `<div class="media-placeholder" onclick="fetchMediaAndOpen(this, '${msg.id}', '${selectedChatId}')">
              <i class="fa-solid ${iconClass}"></i>
              <span>${msg.filename || 'Clique para ver a mídia'}</span>
              <small>Carregar</small>
            </div>`;
  } else if ((msg.mimetype && msg.mimetype.startsWith('audio/')) || msg.type === 'ptt' || msg.type === 'audio' || msg.audioUrl || (msg.body === '[Áudio]')) {
    // Priorizar URL local, depois dados base64
    if (msg.audioUrl) {
      return `<div class="audio-message">
        <audio controls style="max-width: 300px;">
          <source src="${msg.audioUrl}" type="audio/ogg">
          <source src="${msg.audioUrl}" type="audio/mpeg">
          <source src="${msg.audioUrl}" type="audio/wav">
          ${msg.data ? `<source src="data:${msg.mimetype || 'audio/ogg'};base64,${msg.data}" type="${msg.mimetype || 'audio/ogg'}">` : ''}

          Seu navegador não suporta áudio.
        </audio>
        <br><small>🎵 ${msg.filename || 'Áudio'}</small>
      </div>`;
    } else if (msg.data) {
      const base64Data = `data:${msg.mimetype || 'audio/ogg'};base64,${msg.data}`;
      return `<div class="audio-message">
        <audio controls style="max-width: 300px;">
          <source src="${base64Data}" type="${msg.mimetype || 'audio/ogg'}">
          <source src="${base64Data}" type="audio/ogg">
          <source src="${base64Data}" type="audio/mpeg">
          <source src="${base64Data}" type="audio/wav">
          Seu navegador não suporta áudio.
        </audio>
        <br><small>🎵 ${msg.filename || 'Áudio'}</small>
      </div>`;
    } else {
      // Para mensagens de áudio sem dados, tentar buscar do servidor
      return `<div class="audio-message" data-message-id="${msg.id || ''}" data-chat-id="${selectedChatId || ''}">
        <div style="padding: 10px; background: #f0f0f0; border-radius: 8px; max-width: 300px; cursor: pointer;" onclick="tryLoadAudio(this)">
          🎵 ${msg.body || 'Áudio'}
          <br><small>${msg.filename || 'Clique para carregar áudio'}</small>
        </div>
      </div>`;
    }
  } else if (msg.mimetype === 'application/pdf' && msg.data) {
    const base64Data = `data:${msg.mimetype};base64,${msg.data}`;
    return `<div class="file-message"><i class="fa-solid fa-file-pdf"></i> <a href="${base64Data}" download="${msg.filename}" target="_blank">${msg.filename || 'Documento PDF'}</a></div>`;
  } else if ((msg.mimetype === 'application/msword' || msg.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') && msg.data) {
    const base64Data = `data:${msg.mimetype};base64,${msg.data}`;
    return `<div class="file-message"><i class="fa-solid fa-file-word"></i> <a href="${base64Data}" download="${msg.filename}" target="_blank">${msg.filename || 'Documento Word'}</a></div>`;
  } else {
    return `<div class="file-message"><i class="fa-solid fa-file"></i> <span>Arquivo: ${msg.filename || 'Desconhecido'}</span></div>`;
  }
}

// --- ADICIONADO: Função para buscar mídia sob demanda e abrir no modal ---
async function fetchMediaAndOpen(element, messageId, chatId) {
  // Mostra um estado de carregamento no placeholder
  element.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Carregando...';
  element.onclick = null; // Desativa o clique para evitar múltiplas requisições

  try {
    const response = await fetch(`/whatsapp/media?messageId=${encodeURIComponent(messageId)}&chatId=${encodeURIComponent(chatId)}`);
    const result = await response.json();

    if (result.success && result.data) {
      const dataUrl = `data:${result.mimetype};base64,${result.data}`;
      if (result.mimetype.startsWith('image/')) {
        openImageModal(dataUrl, result.mimetype, result.filename);
      } else if (result.mimetype.startsWith('video/')) {
        // Para vídeos, podemos substituir o placeholder por um player
        element.outerHTML = `<video controls autoplay style="max-width:320px;"><source src="${dataUrl}" type="${result.mimetype}"></video>`;
      } else {
        // Para outros tipos de arquivo, força o download
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = result.filename || 'arquivo';
        a.click();
      }
      // Remove o placeholder se a ação principal (modal/download) foi executada
      if (!result.mimetype.startsWith('video/')) {
        element.remove();
      }
    } else {
      throw new Error(result.error || 'Mídia não encontrada.');
    }
  } catch (error) {
    console.error('Erro ao buscar mídia sob demanda:', error);
    element.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Falha ao carregar';
  }
}

// Função para tentar carregar áudio quando clicado
function tryLoadAudio(element) {
  const messageId = element.closest('.audio-message').dataset.messageId;
  const chatId = element.closest('.audio-message').dataset.chatId;

  if (!messageId || !chatId) {
    console.error('ID da mensagem ou chat não encontrado');
    return;
  }

  // Mostrar loading
  element.innerHTML = `
    <div style="padding: 10px; background: #f0f0f0; border-radius: 8px; max-width: 300px;">
      🔄 Carregando áudio...
      <br><small>Aguarde...</small>
    </div>
  `;

  // Tentar buscar áudio do servidor
  fetch('/whatsapp/get-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: messageId,
      chatId: chatId
    })
  })
    .then(res => res.json())
    .then(result => {
      if (result.success && result.audioUrl) {
        // Substituir elemento com player de áudio
        element.innerHTML = `

        <audio controls style="max-width: 300px;">
          <source src="${result.audioUrl}" type="audio/ogg">
          <source src="${result.audioUrl}" type="audio/mpeg">
          <source src="${result.audioUrl}" type="audio/wav">
          Seu navegador não suporta áudio.
        </audio>
        <br><small>🎵 Áudio</small>
      `;
      } else {
        element.innerHTML = `
        <div style="padding: 10px; background: #ffebee; border-radius: 8px; max-width: 300px;">
          ❌ Erro ao carregar áudio
          <br><small>Áudio não disponível</small>
        </div>
      `;
      }
    })
    .catch(err => {
      console.error('Erro ao carregar áudio:', err);
      element.innerHTML = `
      <div style="padding: 10px; background: #ffebee; border-radius: 8px; max-width: 300px;">
        ❌ Erro ao carregar áudio
        <br><small>Falha na conexão</small>
      </div>
    `;
    });
}

/**
 * [NOVO] Busca os contatos iniciais da API REST.
 * Isso acelera o carregamento da página, que depois será atualizada via WebSocket.
 */
async function loadInitialContacts() {
  const list = document.getElementById('conversations-list');
  if (!list) return;

  // Mostra um estado de carregamento inicial
  list.innerHTML = `
    <div class="loading-state">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <p>Carregando contatos...</p>
    </div>
  `;

  try {
    const response = await fetch('/api/contacts');
    if (!response.ok) {
      throw new Error(`API respondeu com status ${response.status}`);
    }
    const contacts = await response.json();
    window.ultimaListaConversas = contacts;
    renderConversations(contacts);
  } catch (error) {
    console.error('Falha ao carregar contatos iniciais via API:', error);
    list.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-wifi-slash"></i>
        <p>Erro ao carregar contatos</p>
        <small>Verifique a conexão com o servidor.</small>
      </div>
    `;
  }
}

/**
 * [NOVO] Busca os contatos iniciais da API REST.
 * Isso acelera o carregamento da página, que depois será atualizada via WebSocket.
 */
async function loadInitialContacts() {
  const list = document.getElementById('conversations-list');
  if (!list) return;

  // Mostra um estado de carregamento inicial
  list.innerHTML = `
    <div class="loading-state">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <p>Carregando contatos...</p>
    </div>
  `;

  try {
    const response = await fetch('/api/contacts');
    if (!response.ok) {
      throw new Error(`API respondeu com status ${response.status}`);
    }
    const contacts = await response.json();
    window.ultimaListaConversas = contacts;
    renderConversations(contacts);
  } catch (error) {
    console.error('Falha ao carregar contatos iniciais via API:', error);
    list.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-wifi-slash"></i>
        <p>Erro ao carregar contatos</p>
        <small>Verifique a conexão com o servidor.</small>
      </div>
    `;
  }
}

function renderConversations(chats) {
  const list = document.getElementById('conversations-list');
  if (!list) return;

  // 1) Aplica filtro por aba atual (contacts | groups | archived)
  let filteredChats = chats.filter(c => {
    const isArchived = c.archived === true;
    if (currentTab === 'archived') {
      return isArchived;
    }
    if (currentTab === 'groups') {
      return !isArchived && c.isGroup === true;
    }
    // Aba "contacts": WhatsApp individuais + Chatbot transferidos (não arquivados)
    return !isArchived && ((c.source === 'chatbot') || (c.source === 'whatsapp' && !c.isGroup));
  });

  // 2) Filtro por pesquisa
  if (typeof conversationSearchTerm === 'string' && conversationSearchTerm.length > 0) {
    filteredChats = filteredChats.filter(c =>
      (c.name || '').toLowerCase().includes(conversationSearchTerm) ||
      (c.id || '').toLowerCase().includes(conversationSearchTerm)
    );
  }

  list.innerHTML = '';

  if (!filteredChats || filteredChats.length === 0) {
    let emptyMessage = 'Nenhuma conversa ativa no momento';
    if (currentTab === 'groups') emptyMessage = 'Nenhum grupo ativo no momento';
    if (currentTab === 'archived') emptyMessage = 'Nenhuma conversa arquivada';

    list.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-comments"></i>
        <p>${emptyMessage}</p>
        <small>Aguardando mensagens dos clientes...</small>
      </div>
    `;
    return;
  }

  // Ordenar chats por timestamp (mais recentes primeiro)
  const sortedChats = filteredChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  sortedChats.forEach((chat) => {
    const div = document.createElement('div');
    div.className = `conversation-item${chat.id === selectedChatId ? ' active' : ''}`;
    if (chat.hasNewMessages && !chat.archived) {
      div.classList.add('has-new-messages');
    } else {
      div.classList.remove('has-new-messages');
    }
    div.dataset.chatId = chat.id;

    const unreadBadge = chat.unreadCount > 0 && !chat.archived ? `<span class="unread-badge">${chat.unreadCount}</span>` : '';
    const iconHTML = (chat.source === 'whatsapp')
      ? `<i class="fa-brands fa-whatsapp source-icon whatsapp" title="WhatsApp"></i>`
      : `<i class="fa-solid fa-robot source-icon chatbot" title="Chatbot"></i>`;
    const profilePicUrl = chat.profilePicUrl;
    const lastMessage = chat.lastMessage
      ? (chat.lastMessage.length > 50 ? chat.lastMessage.substring(0, 50) + '...' : chat.lastMessage)
      : 'Sem mensagens';

    div.innerHTML = `
      ${profilePicUrl ? `<div class="conversation-pfp">
        <img src="${profilePicUrl}" alt="Foto de perfil" onerror="this.style.display='none';">
      </div>` : ''}
      <div class="conversation-header">
        <span class="left">
          ${iconHTML}
          <strong>${chat.name}</strong>
        </span>
        ${unreadBadge}
      </div>
      <div class="conversation-preview">
        <small>${lastMessage}</small>
      </div>
    `;

    div.onclick = function () {
      document.querySelectorAll('.conversation-item').forEach((item) => item.classList.remove('active'));
      div.classList.add('active');
      div.classList.remove('has-new-messages');

      if (chat.unreadCount > 0) {
        chat.unreadCount = 0;
        const badge = div.querySelector('.unread-badge');
        if (badge) badge.remove();
      }

      selectChat(chat.id, chat.name, chat.source);
    };

    list.appendChild(div);
  });
}

function selectChat(chatId, chatName, source) {
  // [PAGINAÇÃO] Reseta o estado da paginação para a nova conversa
  currentPage = 1;
  hasMoreHistory = true;
  isLoadingHistory = false;
  // Remove o listener de scroll antigo para evitar chamadas múltiplas
  document.getElementById('chat-messages').removeEventListener('scroll', handleScroll);
  selectedChatId = chatId;
  const chatTitle = document.getElementById('current-chat-title');
  if (chatTitle) {
    let sourceLabel = source === 'chatbot' ? ' (Chatbot)' : ' (WhatsApp)';
    if (source === 'whatsapp') {
      const chatObj = window.ultimaListaConversas?.find(c => c.id === chatId);
      if (chatObj && chatObj.deviceId) {
        sourceLabel += ` - ${chatObj.deviceId.substring(0, 8)}...`;
      }
    }
    chatTitle.textContent = (chatName || 'Conversa') + sourceLabel;
  }

  // Limpar contador de mensagens não lidas
  if (window.ultimaListaConversas) {
    const chatObj = window.ultimaListaConversas.find(c => c.id === chatId);
    if (chatObj) {
      chatObj.unreadCount = 0;
      chatObj.hasNewMessages = false;
    }
  }

  // Sempre buscar do backend para WhatsApp (on-demand) para garantir persistência do BD
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) chatMessages.innerHTML = '<p>Carregando mensagens...</p>';
  // [PAGINAÇÃO] Adiciona o listener de scroll para o novo chat
  chatMessages.addEventListener('scroll', handleScroll);

  // Função para buscar histórico via API REST (mais eficiente)
  async function fetchChatHistory(chatId, deviceId, page = 1) {
    if (isLoadingHistory || !hasMoreHistory) return;
    isLoadingHistory = true;

    try {
      // [PAGINAÇÃO] Adiciona o parâmetro 'page' na URL
      const response = await fetch(`/whatsapp/history?chatId=${encodeURIComponent(chatId)}&deviceId=${encodeURIComponent(deviceId)}&page=${page}`);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Falha ao buscar histórico.' }));
        throw new Error(errData.error);
      }
      const data = await response.json();

      // [PAGINAÇÃO] Verifica se há mais páginas para carregar
      hasMoreHistory = data.hasMore;
      if (data.success) {
        const chatObj = window.ultimaListaConversas?.find(c => c.id === chatId);
        if (chatObj) {
          chatObj.history = data.messages; // Atualiza o cache local
        }
        renderMessages(data.messages); // Renderiza as mensagens na tela
      } else {
        hasMoreHistory = false;
        throw new Error(data.error || 'Erro desconhecido ao buscar histórico.');
      }
    } catch (error) {
      console.error('Erro ao buscar histórico do chat via API:', error);
      if (chatMessages) {
        chatMessages.innerHTML = `<div class="empty-chat"><p>Erro ao carregar histórico: ${error.message}</p></div>`;
      }
    } finally {
      isLoadingHistory = false;
    }
  }

  if (source === 'chatbot' && wsChatbot && wsChatbot.readyState === WebSocket.OPEN) {
    wsChatbot.send(JSON.stringify({ type: 'get-messages', chatId }));
  } else if (source === 'whatsapp') {
    const chatObj = window.ultimaListaConversas?.find(c => c.id === chatId);
    const deviceId = chatObj?.deviceId || currentDeviceId || localStorage.getItem('currentDeviceId');
    fetchChatHistory(chatId, deviceId, 1); // [PAGINAÇÃO] Inicia com a página 1
  } else {
    renderMessages([]);
  }

  // Habilitar controles
  const input = document.getElementById('message-input');
  const btn = document.getElementById('send-message-btn');
  const fileInput = document.getElementById('file-input');
  const fileClipBtn = document.getElementById('file-clip-btn');
  const audioRecordBtn = document.getElementById('audio-record-btn');
  const transferBtn = document.getElementById('transfer-btn');
  const closeBtn = document.getElementById('close-btn');

  if (input) {
    input.disabled = false;
    input.focus();
  }
  if (btn) btn.disabled = false;
  if (fileInput) fileInput.disabled = false;
  if (fileClipBtn) fileClipBtn.disabled = false;
  if (audioRecordBtn) audioRecordBtn.disabled = false;
  if (transferBtn) transferBtn.disabled = false;
  if (closeBtn) closeBtn.disabled = false;

  const contatoNumero = document.getElementById('contato-numero');
  if (contatoNumero) {
    const numero = chatId ? chatId.replace('@c.us', '') : '--';
    contatoNumero.textContent = numero;
  }

  const btnTabular = document.getElementById('btn-tabular');
  const tabulacaoSelect = document.getElementById('tabulacao-select');
  if (btnTabular && tabulacaoSelect) {
    btnTabular.disabled = !tabulacaoSelect.value;
    tabulacaoSelect.onchange = function () {
      btnTabular.disabled = !tabulacaoSelect.value;
      // Mostrar/ocultar campo de aniversário conforme seleção
      const campoAniv = document.getElementById('campo-aniversario');
      const aniversarioInput = document.getElementById('aniversario-data');
      const show = tabulacaoSelect.value === 'aniversariantes';
      if (campoAniv) campoAniv.style.display = show ? 'block' : 'none';
      if (aniversarioInput) {
        if (show) aniversarioInput.setAttribute('required', 'required');
        else { aniversarioInput.removeAttribute('required'); aniversarioInput.value = ''; }
      }
    };
    // Estado inicial do campo ao selecionar o chat
    const campoAniv = document.getElementById('campo-aniversario');
    const aniversarioInput = document.getElementById('aniversario-data');
    const showInit = tabulacaoSelect.value === 'aniversariantes';
    if (campoAniv) campoAniv.style.display = showInit ? 'block' : 'none';
    if (aniversarioInput) {
      if (showInit) aniversarioInput.setAttribute('required', 'required');
      else { aniversarioInput.removeAttribute('required'); aniversarioInput.value = ''; }
    }
  }
}

// Barra de pesquisa de contatos
const searchInput = document.getElementById('search-conversation');
if (searchInput) {
  searchInput.addEventListener('input', function () {
    conversationSearchTerm = searchInput.value.trim().toLowerCase();
    // Apenas atualiza o termo de busca e chama a renderização com a lista completa.
    // A filtragem agora é responsabilidade exclusiva de `renderConversations`.
    renderConversations(window.ultimaListaConversas || []);
  });
}

// [PAGINAÇÃO] Handler para o evento de scroll
function handleScroll() {
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages.scrollTop === 0 && !isLoadingHistory && hasMoreHistory) {
    currentPage++;
    const chatObj = window.ultimaListaConversas?.find(c => c.id === selectedChatId);
    const deviceId = chatObj?.deviceId || currentDeviceId;

    // Adiciona um indicador de carregamento no topo
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'loading-history';
    loadingIndicator.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Carregando mais mensagens...';
    chatMessages.prepend(loadingIndicator);

    // Mantém a posição do scroll para que não pule
    const oldScrollHeight = chatMessages.scrollHeight;

    fetch(`/whatsapp/history?chatId=${encodeURIComponent(selectedChatId)}&deviceId=${encodeURIComponent(deviceId)}&page=${currentPage}`)
      .then(res => res.json())
      .then(data => {
        loadingIndicator.remove();
        if (data.success && data.messages.length > 0) {
          const newMessagesHtml = data.messages.map(msg => renderMessageHtml(msg)).join('');
          chatMessages.insertAdjacentHTML('afterbegin', newMessagesHtml);
          chatMessages.scrollTop = chatMessages.scrollHeight - oldScrollHeight; // Ajusta o scroll
        }
        hasMoreHistory = data.hasMore;
      })
      .catch(() => loadingIndicator.remove());
  }
}
// Função para desabilitar input e botões
function disableInputAndButton() {
  const input = document.getElementById('message-input');
  const btn = document.getElementById('send-message-btn');
  const fileInput = document.getElementById('file-input');
  const fileClipBtn = document.getElementById('file-clip-btn');
  const audioRecordBtn = document.getElementById('audio-record-btn');
  const transferBtn = document.getElementById('transfer-btn');
  const closeBtn = document.getElementById('close-btn');

  if (input) input.disabled = true;
  if (btn) btn.disabled = true;
  if (fileInput) fileInput.disabled = true;
  if (fileClipBtn) fileClipBtn.disabled = true;
  if (audioRecordBtn) audioRecordBtn.disabled = true;
  if (transferBtn) transferBtn.disabled = true;
  if (closeBtn) closeBtn.disabled = true;
}

function sendMessage() {
  const input = document.getElementById('message-input');
  const btn = document.getElementById('send-message-btn');
  if (!input || !selectedChatId || input.disabled || btn.disabled) {
    console.warn('Não é possível enviar mensagem: chat não selecionado ou input desabilitado');
    return;
  }
  const text = input.value.trim();
  if (!text) {
    console.warn('Mensagem vazia não será enviada');
    return;
  }

  // Adicionar mensagem imediatamente à interface
  const chatMessages = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message message-out';
  messageDiv.innerHTML = `<span>${text}</span>`;
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  let chatObj = null;
  if (window.ultimaListaConversas) {
    chatObj = window.ultimaListaConversas.find(c => c.id === selectedChatId);
  }

  if (chatObj && chatObj.source === 'chatbot') {
    // Enviar via chatbot
    fetch('/chatbot/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: selectedChatId, message: text })
    })
      .then(res => res.json())
      .then(data => {
        if (!data.success) {
          if (chatMessages.contains(messageDiv)) {
            chatMessages.removeChild(messageDiv);
          }
          showNotification('Erro', 'Erro ao enviar mensagem: ' + (data.error || 'Erro desconhecido'));
        } else {
          input.value = '';
          input.focus();

          // Atualizar histórico local
          updateLocalChatHistory(selectedChatId, {
            role: 'assistant',
            content: text,
            timestamp: new Date().toISOString(),
            fromMe: true,
            body: text,
            type: 'text'
          });
        }
      })
      .catch(err => {
        console.error('Erro ao enviar mensagem via chatbot:', err);
        if (chatMessages.contains(messageDiv)) {
          chatMessages.removeChild(messageDiv);
        }
        showNotification('Erro', 'Erro ao enviar mensagem: ' + (err.message || 'Erro desconhecido'));
      });
  } else {
    // Enviar via WhatsApp direto
    if (wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
      // Obter deviceId correto
      const deviceId = chatObj?.deviceId || currentDeviceId || localStorage.getItem('currentDeviceId');

      wsWhatsapp.send(JSON.stringify({
        type: 'send-message',
        chatId: selectedChatId,
        body: text,
        deviceId: deviceId // Incluir deviceId
      }));

      input.value = '';
      input.focus();

      // Atualizar histórico local
      updateLocalChatHistory(selectedChatId, {
        fromMe: true,
        body: text,
        type: 'text',
        timestamp: Date.now() / 1000
      });
    } else {
      console.error('WebSocket WhatsApp não está conectado');
      if (chatMessages.contains(messageDiv)) {
        chatMessages.removeChild(messageDiv);
      }
      showNotification('Erro', 'Não foi possível enviar a mensagem. Verifique sua conexão.');
    }
  }
}

// Helper para remover o chat da lista e resetar UI
function removeChatFromList(chatId) {
  try {
    if (!window.ultimaListaConversas) return;

    window.ultimaListaConversas = window.ultimaListaConversas.filter(c => c.id !== chatId);
    renderConversations(window.ultimaListaConversas);

    if (selectedChatId === chatId) {
      selectedChatId = null;
      disableInputAndButton();
      const chatMessages = document.getElementById('chat-messages');
      if (chatMessages) {
        chatMessages.innerHTML = `
          <div class="empty-chat">
            <i class="fa-solid fa-comment-dots"></i>
            <p>Selecione uma conversa para começar o atendimento</p>
          </div>
        `;
      }
      const contatoNumero = document.getElementById('contato-numero');
      if (contatoNumero) contatoNumero.textContent = '--';
    }
  } catch (e) {
    console.error('Erro ao remover chat da lista:', e);
  }
}

// Função para pré-carregar o som de notificação
function preloadNotificationSound() {
  try {
    const audio = new Audio('/sounds/notification.mp3');
    audio.preload = 'auto';
    audio.volume = notificationVolume; // Use o volume global
    window.notificationAudio = audio;
    console.log('Som de notificação pré-carregado');
  } catch (error) {
    console.error('Erro ao pré-carregar som de notificação:', error);
  }
}

// Função otimizada para tocar som (usando áudio pré-carregado)
function playOptimizedNotificationSound() {
  try {
    if (window.notificationAudio) {
      window.notificationAudio.currentTime = 0;
      window.notificationAudio.volume = notificationVolume; // Use o volume global

      // Tocar som
      const playPromise = window.notificationAudio.play();

      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log('Som de notificação tocado (otimizado)');
          })
          .catch(error => {
            console.log('Erro ao tocar som otimizado:', error);
            playNotificationSound(); // Fallback para método normal
          });
      }
    } else {
      playNotificationSound(); // Fallback para método otimizado
    }
  } catch (error) {
    console.error('Erro no som otimizado:', error);
    playNotificationSound(); // Fallback para método normal
  }
}

// Fallback player for notification sound (used if preloaded playback fails)
function playNotificationSound() {
  try {
    const a = new Audio('/sounds/notification.mp3');
    a.volume = notificationVolume;
    a.play().catch(() => {});
  } catch (e) {
    console.error('Erro no fallback de som:', e);
  }
}

// Toasts no canto superior direito + Notification API + som
function ensureToastContainer() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.position = 'fixed';
    container.style.top = '16px';
    container.style.right = '16px';
    container.style.zIndex = '9999';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '8px';
    document.body.appendChild(container);
  }
  return container;
}

function showInAppToast(title, body, duration = 5000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.style.minWidth = '260px';
  toast.style.maxWidth = '360px';
  toast.style.padding = '10px 12px';
  toast.style.borderRadius = '8px';
  toast.style.boxShadow = '0 6px 18px rgba(0,0,0,0.15)';
  toast.style.background = '#323232';
  toast.style.color = '#fff';
  toast.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  toast.style.cursor = 'pointer';
  toast.style.opacity = '0';
  toast.style.transition = 'opacity .2s ease';
  toast.innerHTML = `
    <div style="font-weight:700; margin-bottom:4px;">${title || 'Notificação'}</div>
    <div style="font-size: 0.95em; line-height: 1.35;">${body || ''}</div>
  `;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  let hideTimer = setTimeout(hide, duration);
  function hide() {
    toast.style.opacity = '0';
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
  }
  toast.addEventListener('click', () => {
    clearTimeout(hideTimer);
    hide();
    if (typeof window.focus === 'function') window.focus();
  });
}

window.showNotification = function (title, body, options = {}) {
  try {
    // Se for notificação vinda do WhatsApp, checar mudo por aba
    if (options && options.source === 'whatsapp') {
      let isGroup = !!options.isGroup;
      if (!options.isGroup && options.chatId && window.ultimaListaConversas) {
        const c = window.ultimaListaConversas.find(x => x.id === options.chatId);
        if (c) isGroup = !!c.isGroup;
      }
      if ((isGroup && window.mutedTabs && window.mutedTabs.groups) ||
          (!isGroup && window.mutedTabs && window.mutedTabs.contacts)) {
        // Silenciado: não mostra toast, não dispara Notification API, nem toca som
        console.log('Notificação silenciada:', { title, chatId: options.chatId, isGroup });
        return;
      }
    }
  } catch (e) {
    console.error('Erro ao aplicar filtro de mudo:', e);
  }

  // Exibe toast in-app
  showInAppToast(title, body, options.duration || 5000);

  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title || 'Notificação', { body: body || '' });
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') new Notification(title || 'Notificação', { body: body || '' });
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('Falha Notification API:', e);
  } finally {
    // Toca som de notificação (só chegará aqui se não foi silenciada acima)
    playOptimizedNotificationSound();
  }
};

document.addEventListener('DOMContentLoaded', function () {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  ensureToastContainer();
  preloadNotificationSound();

  // [MODIFICADO] Carrega os contatos iniciais da API em vez do localStorage.
  // O WebSocket cuidará das atualizações em tempo real.
  loadInitialContacts();

  // Conectar WebSockets
  connectAtendimentoWebSocket();

  // Event listeners
  const input = document.getElementById('message-input');
  const btn = document.getElementById('send-message-btn');
  const fileClipBtn = document.getElementById('file-clip-btn');
  const fileInput = document.getElementById('file-input');
  const audioRecordBtn = document.getElementById('audio-record-btn');
  const stopRecordingBtn = document.getElementById('stop-recording');
  const cancelRecordingBtn = document.getElementById('cancel-recording');

  if (btn && input) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      sendMessage();
    });

    const icon = btn.querySelector('i.fa-solid.fa-paper-plane');
    if (icon) {
      icon.style.cursor = 'pointer';
      icon.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        sendMessage();
      });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

  // Typing indicator: send typing-start and typing-stop via WS (WhatsApp)
    input.addEventListener('input', () => {
      if (!selectedChatId || !wsWhatsapp || wsWhatsapp.readyState !== WebSocket.OPEN) return;

      const chatObj = window.ultimaListaConversas?.find(c => c.id === selectedChatId);
      if (!chatObj || chatObj.source !== 'whatsapp') return; // Apenas para WhatsApp

      const deviceId = chatObj.deviceId || currentDeviceId;

      // Limpa o timer anterior para reiniciar a contagem
      clearTimeout(typingTimer);

      // Envia o status "digitando"
      wsWhatsapp.send(JSON.stringify({ type: 'typing-start', chatId: selectedChatId, deviceId }));

      // Define um novo timer. Se o usuário não digitar por 2 segundos, envia o status "parou de digitar"
      typingTimer = setTimeout(() => {
        wsWhatsapp.send(JSON.stringify({ type: 'typing-stop', chatId: selectedChatId, deviceId }));
      }, 2000); // 2 segundos
    });
  }

  if (fileClipBtn && fileInput) {
    fileClipBtn.addEventListener('click', function () {
      if (!fileClipBtn.disabled && !fileInput.disabled) {
        fileInput.click();
      }
    });
  }

  if (audioRecordBtn) {
    audioRecordBtn.addEventListener('click', function () {
      if (!audioRecordBtn.disabled && !isRecording) {
        startRecording();
      }
    });
  }

  if (stopRecordingBtn) {
    stopRecordingBtn.addEventListener('click', function () {
      stopRecording(true);
    });
  }

  if (cancelRecordingBtn) {
    cancelRecordingBtn.addEventListener('click', function () {
      cancelRecording(); // não envia
    });
  }

  const quickButtons = document.querySelectorAll('.quick-btn'); // Corrigir seletor
  quickButtons.forEach((button) => {
    button.addEventListener('click', function () {
      if (!selectedChatId) {
        console.warn('Nenhum chat selecionado para enviar resposta rápida');
        showNotification('Erro', 'Selecione uma conversa antes de usar uma resposta rápida.');
        return;
      }

      const response = button.getAttribute('data-response');
      let message;

      switch (response) {
        case 'dados bancarios':
          message = 'Certo! Para finalizar a digitação do seu contrato, precisarei dos dados bancários:\n\n*Nome do banco:*\n*Agência:*\n*Conta:*\n*Tipo da conta (corrente ou poupança):*';
          break;
        case 'verificacao':
          message = 'Vou iniciar agora a digitação do seu contrato. Assim que o link de formalização for gerado, encaminho pra você, tudo bem?';
          break;
        case 'ajuda':
          message = 'Posso te ajudar com mais alguma coisa?';
          break;
        case 'aguardar':
          message = 'Aguarde um momento, por favor.';
          break;
        case 'despedida':
          message = 'Muito obrigado! Tenha um ótimo dia!';
          break;
        default:
          return;
      }

      // Adicionar mensagem à interface
      const chatMessages = document.getElementById('chat-messages');
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message message-out';
      messageDiv.innerHTML = `<span>${message}</span>`;
      chatMessages.appendChild(messageDiv);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      let chatObj = null;
      if (window.ultimaListaConversas) {
        chatObj = window.ultimaListaConversas.find(c => c.id === selectedChatId);
      }

      if (chatObj && chatObj.source === 'chatbot') {
        fetch('/chatbot/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: selectedChatId, message: message })
        })
          .then(res => res.json())
          .then(data => {
            if (!data.success) {
              if (chatMessages.contains(messageDiv)) {
                chatMessages.removeChild(messageDiv);
              }
              showNotification('Erro', 'Erro ao enviar mensagem: ' + (data.error || 'Erro desconhecido'));
            } else {
              // Atualizar histórico local
              updateLocalChatHistory(selectedChatId, {
                role: 'assistant',
                content: message,
                timestamp: new Date().toISOString(),
                fromMe: true,
                body: message,
                type: 'text'
              });
            }
          })
          .catch(err => {
            if (chatMessages.contains(messageDiv)) {
              chatMessages.removeChild(messageDiv);
            }
            showNotification('Erro', 'Erro ao enviar mensagem: ' + (err.message || 'Erro desconhecido'));
          });
      } else {
        if (wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
          // Obter deviceId correto
          const deviceId = chatObj?.deviceId || currentDeviceId || localStorage.getItem('currentDeviceId');

          wsWhatsapp.send(JSON.stringify({
            type: 'send-message',
            chatId: selectedChatId,
            body: message,
            deviceId: deviceId // Incluir deviceId
          }));

          // Atualizar histórico local
          updateLocalChatHistory(selectedChatId, {
            fromMe: true,
            body: message,
            type: 'text',
            timestamp: Date.now() / 1000
          });
        } else {
          console.error('WebSocket WhatsApp não está conectado');
          if (chatMessages.contains(messageDiv)) {
            chatMessages.removeChild(messageDiv);
          }
          showNotification('Erro', 'Não foi possível enviar a mensagem. Verifique sua conexão.');
        }
      }
    });
  });

  // File send handler: validate file, create preview and send via HTTP or WebSocket
  async function handleFileSend(file) {
    if (!selectedChatId) {
      showNotification('Erro', 'Selecione uma conversa antes de enviar arquivos.');
      return;
    }

    const chatObj = window.ultimaListaConversas?.find(c => c.id === selectedChatId) || null;
    const deviceId = chatObj?.deviceId || currentDeviceId || localStorage.getItem('currentDeviceId');
    const isChatbot = chatObj?.source === 'chatbot';

    const validTypes = [
      'image/jpeg','image/jpg','image/png','image/gif','image/bmp','image/svg+xml',
      'video/mp4','video/3gpp','video/3gp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/csv','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'audio/mp3','audio/mpeg','audio/ogg'
    ];
    if (!validTypes.includes(file.type)) {
      showNotification('Erro', 'Tipo de arquivo não suportado. Envie imagens, vídeos, PDFs, Word, Excel, CSV ou áudio.');
      return;
    }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      showNotification('Erro', `O arquivo excede o limite de ${MAX_FILE_SIZE_MB}MB.`);
      return;
    }

    const chatMessages = document.getElementById('chat-messages');
    const tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // Cria placeholder com preview imediato usando data URL (imagem/video/audio/doc)
    const placeholderDiv = document.createElement('div');
    placeholderDiv.className = 'message message-out';
    placeholderDiv.dataset.tempId = tempId;
    // conteúdo provisório: será substituído pelo preview quando FileReader carregar
    placeholderDiv.innerHTML = `<div class="sending-placeholder">📤 Preparando ${file.name}...</div>`;
    chatMessages.appendChild(placeholderDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result.split(',')[1];

      // Monta preview local com base64 para exibição imediata
      const messagePreview = {
        id: `local_${tempId}`,
        fromMe: true,
        type: file.type.startsWith('image/') ? 'image' : (file.type.startsWith('video/') ? 'video' : 'document'),
        mimetype: file.type,
        filename: file.name,
        data: base64,
        timestamp: Math.floor(Date.now() / 1000),
        tempId
      };

      try {
        // substitui placeholder pelo preview (imagem/vídeo/player)
        const ph = document.querySelector(`.message[data-temp-id="${tempId}"]`);
        if (ph) ph.innerHTML = renderMediaContent(messagePreview);

        if (isChatbot) {
          // envia via chatbot (HTTP)
          const resp = await fetch('/chatbot/send-media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: selectedChatId, filename: file.name, mimetype: file.type, data: base64 })
          }).then(r => r.json());
          if (!resp.success) throw new Error(resp.error || 'Falha ao enviar via chatbot');

          // backend notificará via WS — atualiza preview local
          updateLocalChatHistory(selectedChatId, messagePreview);
        } else {
          // --- ALTERAÇÃO: enviar via HTTP para /whatsapp/send-media (par ao fluxo do chatbot) ---
          try {
            const resp = await fetch('/whatsapp/send-media', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chatId: selectedChatId,
                filename: file.name,
                mimetype: file.type,
                data: base64,
                deviceId: deviceId,
                tempId
              })
            }).then(r => r.json());

            if (!resp || !resp.success) {
              throw new Error((resp && resp.error) || 'Falha ao enviar mídia via WhatsApp');
            }

            // atualizar preview/local history — backend/WS também poderá enviar evento definitivo
            updateLocalChatHistory(selectedChatId, messagePreview);
          } catch (err) {
            // fallback para envio via WS (opcional): tenta via WebSocket se HTTP falhar
            if (wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
              wsWhatsapp.send(JSON.stringify({
                type: 'send-media',
                chatId: selectedChatId,
                filename: file.name,
                mimetype: file.type,
                data: base64,
                deviceId: deviceId,
                tempId: tempId
              }));
              updateLocalChatHistory(selectedChatId, messagePreview);
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        // remover placeholder em erro
        const ph = document.querySelector(`.message[data-temp-id="${tempId}"]`);
        if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
        showNotification('Erro', err.message || 'Falha ao enviar arquivo.');
      }
    };

    reader.onerror = () => {
      const ph = document.querySelector(`.message[data-temp-id="${tempId}"]`);
      if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
      showNotification('Erro', 'Erro ao ler o arquivo.');
    };
    reader.readAsDataURL(file);
  }

  // File input handler (agora usa handleFileSend)
  if (fileInput) {
    fileInput.addEventListener('change', async function () {
      if (!selectedChatId || !fileInput.files.length || fileInput.disabled) {
        console.warn('Nenhum chat selecionado ou arquivo não selecionado');
        return;
      }
      for (const file of Array.from(fileInput.files)) {
        try { await handleFileSend(file); } catch (e) { console.error(e); }
      }
      fileInput.value = '';
    });
  }

  // Drag & drop support: allow dropping files onto chat panel to send
  const chatPanel = document.querySelector('.chat-panel');
  const dropzoneOverlay = document.getElementById('dropzone-overlay');

  function showDropzone() { if (dropzoneOverlay) dropzoneOverlay.style.display = 'flex'; }
  function hideDropzone() { if (dropzoneOverlay) dropzoneOverlay.style.display = 'none'; }
  function hasFiles(event) {
    try { return event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files'); }
    catch { return false; }
  }

  // Prevenir comportamento padrão do navegador (abrir arquivo na aba)
  ['dragover', 'drop'].forEach(evt =>
    window.addEventListener(evt, e => {
      if (hasFiles(e)) e.preventDefault();
    })
  );

  if (chatPanel) {
    ['dragenter', 'dragover'].forEach(evt => chatPanel.addEventListener(evt, e => {
      if (hasFiles(e)) {
        e.preventDefault();
        showDropzone();
      }
    }));
    ['dragleave', 'drop'].forEach(evt => chatPanel.addEventListener(evt, e => {
      // Oculta quando sai da área ou finaliza o drop
      if (evt === 'drop' || e.target === chatPanel) hideDropzone();
    }));
    chatPanel.addEventListener('drop', async e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hideDropzone();

      if (!selectedChatId) {
        showNotification('Erro', 'Selecione uma conversa antes de enviar arquivos.');
        return;
      }
      const files = Array.from(e.dataTransfer.files || []);
      for (const file of files) {
        try { await handleFileSend(file); } catch (err) { console.error('Erro no envio (drop):', err); }
      }
    });
  }

  // Paste support: capture pasted images (Ctrl+V) and send them as files
  document.addEventListener('paste', async function (e) {
    try {
      const dt = e.clipboardData || window.clipboardData;
     

      if (!dt || !dt.items) return;

      // Filtra itens do clipboard que são imagem
      const imageItems = Array.from(dt.items).filter(item => item.type && item.type.startsWith('image/'));
      if (imageItems.length === 0) return; // deixa colar texto normalmente

      if (!selectedChatId) {
        showNotification('Erro', 'Selecione uma conversa antes de enviar imagens.');
        return;
      }

      // Consumir a colagem de imagem para não inserir nada no textarea
      e.preventDefault();

      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;

        const ext =
          blob.type === 'image/jpeg' ? 'jpg' :
            blob.type === 'image/png' ? 'png' : 'img';
        const filename = `pasted-${Date.now()}.${ext}`;

        // Constrói um File para manter nome e tipo
        let file;
        try {
          file = new File([blob], filename, { type: blob.type });
        } catch {
          // Fallback: browsers antigos
          blob.name = filename;
          file = blob;
        }

        try {
          await handleFileSend(file);
        } catch (err) {
          console.error('Erro ao enviar imagem colada:', err);
          showNotification('Erro', 'Falha ao enviar a imagem colada.');
        }
      }
    } catch (err) {
      console.error('Erro ao processar colagem de imagem:', err);
      showNotification('Erro', 'Não foi possível processar a imagem colada.');
    }
  });

  // Controle de volume da notificação
  const volumeSlider = document.getElementById('notification-volume');
  const volumeValue = document.getElementById('notification-volume-value');

  if (volumeSlider && volumeValue) {
    volumeSlider.addEventListener('input', function () {
      notificationVolume = parseInt(volumeSlider.value, 10) / 100;
      volumeValue.textContent = volumeSlider.value + '%';
      // Atualiza o volume do áudio pré-carregado, se existir
      if (window.notificationAudio) {
        window.notificationAudio.volume = notificationVolume;
      }
    });
  } else {
    console.warn('Elementos de controle de volume não encontrados na página.');
  }

  // Tabs: Contatos | Grupos
  const tabContacts = document.getElementById('tab-contacts');
  const tabGroups = document.getElementById('tab-groups');
  function updateTabButtons() {
    if (tabContacts && tabGroups) {
      if (currentTab === 'groups') {
        tabGroups.classList.add('active');
        tabGroups.style.background = '#f5f5f5';
        tabContacts.classList.remove('active');
        tabContacts.style.background = '#fff';
      } else {
        tabContacts.classList.add('active');
        tabContacts.style.background = '#f5f5f5';
        tabGroups.classList.remove('active');
        tabGroups.style.background = '#fff';
      }
    }
  }
  if (tabContacts) {
    tabContacts.addEventListener('click', () => {
      currentTab = 'contacts';
      localStorage.setItem('chatCurrentTab', currentTab);
      updateTabButtons();
      if (window.ultimaListaConversas) renderConversations(window.ultimaListaConversas);
    });
  }
  if (tabGroups) {
    tabGroups.addEventListener('click', () => {
      currentTab = 'groups';
      localStorage.setItem('chatCurrentTab', currentTab);
      updateTabButtons();
      if (window.ultimaListaConversas) renderConversations(window.ultimaListaConversas);
    });
  }
  updateTabButtons();

  // Estado de mute por aba (persistido)
  window.mutedTabs = {
    contacts: JSON.parse(localStorage.getItem('muteContacts') || 'false'),
    groups: JSON.parse(localStorage.getItem('muteGroups') || 'false')
  };

  // Expor updateMuteIcons para uso inline / inicialização
  window.updateMuteIcons = function () {
    try {
      const btnContacts = document.getElementById('mute-contacts');
      const btnGroups = document.getElementById('mute-groups');
      if (btnContacts) {
        // garante que ambos ícones existam no botão (fa-bell e fa-bell-slash)
        if (!btnContacts.querySelector('.fa-bell') || !btnContacts.querySelector('.fa-bell-slash')) {
          btnContacts.innerHTML = '<i class="fa-solid fa-bell"></i><i class="fa-solid fa-bell-slash"></i>';
        }
        if (window.mutedTabs.contacts) btnContacts.classList.add('muted'); else btnContacts.classList.remove('muted');
        btnContacts.title = window.mutedTabs.contacts ? 'Notificações de contatos silenciadas' : 'Silenciar notificações de contatos';
      }
      if (btnGroups) {
        if (!btnGroups.querySelector('.fa-bell') || !btnGroups.querySelector('.fa-bell-slash')) {
          btnGroups.innerHTML = '<i class="fa-solid fa-bell"></i><i class="fa-solid fa-bell-slash"></i>';
        }
        if (window.mutedTabs.groups) btnGroups.classList.add('muted'); else btnGroups.classList.remove('muted');
        btnGroups.title = window.mutedTabs.groups ? 'Notificações de grupos silenciadas' : 'Silenciar notificações de grupos';
      }
    } catch (e) { console.error('updateMuteIcons:', e); }
  };

  // Expor toggleMuteTab globalmente (para onclick inline e outros handlers)
  window.toggleMuteTab = function (tab) {
    if (tab !== 'contacts' && tab !== 'groups') return;
    window.mutedTabs[tab] = !window.mutedTabs[tab];
    localStorage.setItem(tab === 'contacts' ? 'muteContacts' : 'muteGroups', JSON.stringify(window.mutedTabs[tab]));
    // atualiza visual imediatamente
    window.updateMuteIcons();
    // feedback rápido
    showInAppToast('Notificações', window.mutedTabs[tab] ? `${tab === 'contacts' ? 'Contatos' : 'Grupos'} silenciados` : `${tab === 'contacts' ? 'Contatos' : 'Grupos'} ativados`, 2000);
  };

  // Ao carregar DOM, liga eventos (seguro: também funcionará com onclick inline)
  document.addEventListener('DOMContentLoaded', function () {
    try {
      const muteContactsBtn = document.getElementById('mute-contacts');
      const muteGroupsBtn = document.getElementById('mute-groups');
      if (muteContactsBtn && !muteContactsBtn._muteHandlerAttached) {
        muteContactsBtn.addEventListener('click', function (e) { e.preventDefault(); window.toggleMuteTab('contacts'); });
        muteContactsBtn._muteHandlerAttached = true;
      }
      if (muteGroupsBtn && !muteGroupsBtn._muteHandlerAttached) {
        muteGroupsBtn.addEventListener('click', function (e) { e.preventDefault(); window.toggleMuteTab('groups'); });
        muteGroupsBtn._muteHandlerAttached = true;
      }
    } catch (e) {
      console.error('Erro ao inicializar botões de mute:', e);
    }
    // aplica ícones iniciais assim que o DOM estiver pronto
    window.updateMuteIcons();
  });

}); // <- fim do DOMContentLoaded

// Helper: limpar formulário de tabulação
function clearTabulacaoForm() {
  try {
    const tabulacaoSelect = document.getElementById('tabulacao-select');
    const detalhesEl = document.getElementById('detalhes-conversa');
    const observacoesEl = document.getElementById('observacoes-tab');
    const campoAniv = document.getElementById('campo-aniversario');
    const aniversarioInput = document.getElementById('aniversario-data');

    if (tabulacaoSelect) tabulacaoSelect.value = '';
    if (detalhesEl) detalhesEl.value = '';
    if (observacoesEl) observacoesEl.value = '';
    if (aniversarioInput) {
      aniversarioInput.removeAttribute('required');
      aniversarioInput.value = '';
    }
    if (campoAniv) campoAniv.style.display = 'none';

    const btnTabular = document.getElementById('btn-tabular');
    if (btnTabular) btnTabular.disabled = true;
  } catch (e) {
    console.warn('Falha ao limpar formulário de tabulação:', e);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  // ...existing code...

  // Tabulação: ligações de UI e envio
  const btnTabular = document.getElementById('btn-tabular');
  const tabulacaoSelect = document.getElementById('tabulacao-select');
  const detalhesEl = document.getElementById('detalhes-conversa');
  const observacoesEl = document.getElementById('observacoes-tab');
  const campoAniv = document.getElementById('campo-aniversario');
  const aniversarioInput = document.getElementById('aniversario-data');

  function updateAniversarioVisibility() {
    const show = tabulacaoSelect && tabulacaoSelect.value === 'aniversariantes';
    if (campoAniv) campoAniv.style.display = show ? 'block' : 'none';
    if (aniversarioInput) {
      if (show) aniversarioInput.setAttribute('required', 'required');
      else { aniversarioInput.removeAttribute('required'); aniversarioInput.value = ''; }
    }
  }

  if (tabulacaoSelect) {
    tabulacaoSelect.addEventListener('change', () => {
      // Habilita botão se houver seleção
      if (btnTabular) btnTabular.disabled = !tabulacaoSelect.value || !selectedChatId;
      updateAniversarioVisibility();
    });
    // Estado inicial na carga
    updateAniversarioVisibility();
  }
  if (btnTabular) {
    // Estado inicial desabilitado sem chat selecionado
    btnTabular.disabled = true;

    btnTabular.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        if (!selectedChatId) {
          showNotification('Tabulação', 'Selecione uma conversa para tabular.');
          return;
        }
        if (!tabulacaoSelect || !tabulacaoSelect.value) {
          showNotification('Tabulação', 'Selecione uma opção de tabulação.');
          return;
        }
        const tabulacao = tabulacaoSelect.value;
        if (tabulacao === 'aniversariantes' && aniversarioInput && !aniversarioInput.value) {
          showNotification('Tabulação', 'Informe a data do aniversariante.');
          return;
        }

        // Monta payload
        const payload = {
          chatId: selectedChatId,
          tabulacao,
          detalhes: (detalhesEl && detalhesEl.value) || '',
          observacoes: (observacoesEl && observacoesEl.value) || '',
          aniversarioData: (tabulacao === 'aniversariantes' && aniversarioInput) ? aniversarioInput.value : null
        };

        // Desabilita botão durante envio
        btnTabular.disabled = true;
        const originalText = btnTabular.textContent;
        btnTabular.textContent = 'TABULANDO...';

        const res = await fetch('/whatsapp/tabular', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Falha ao tabular a conversa.');
        }

        showNotification('Tabulação', 'Conversa tabulada com sucesso.');
        // CORREÇÃO: Reativada a chamada para remover o chat da lista de atendimento
        // após a tabulação bem-sucedida.
        removeChatFromList(selectedChatId);
        clearTabulacaoForm();
      } catch (err) {
        console.error('Erro ao tabular:', err);
        showNotification('Erro', err.message || 'Erro ao tabular a conversa.');
      } finally {
        if (btnTabular) {
          // Reabilita dependendo da seleção atual
          btnTabular.textContent = 'TABULAR';
          btnTabular.disabled = !tabulacaoSelect || !tabulacaoSelect.value || !selectedChatId;
        }
      }
    });
  }

  // Opcional: botão "retornar" o chat ao atendimento, caso exista no HTML
  const btnRetornar = document.getElementById('btn-retornar');
  if (btnRetornar) {
    btnRetornar.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        if (!selectedChatId) {
          showNotification('Atendimento', 'Selecione uma conversa para retornar.');
          return;
        }
        btnRetornar.disabled = true;
        const res = await fetch('/whatsapp/tabular/retornar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: selectedChatId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Falha ao retornar a conversa.');
        }
        showNotification('Atendimento', 'Conversa retornada ao atendimento.');
        // O backend deve emitir "chat-returned"; handler já adiciona de volta na lista.
      } catch (err) {
        console.error('Erro ao retornar chat:', err);
        showNotification('Erro', err.message || 'Erro ao retornar a conversa.');
      } finally {
        btnRetornar.disabled = false;
      }
    });
  }

  // Video input listener: validate selected video and upload according to chat source
  const videoInput = document.getElementById('input-video');
  if (videoInput) {
    videoInput.addEventListener('change', async function(e) {
      const file = e.target.files[0];
      if (!file) return;

      // Validação do vídeo
      const valid = window.VideoUtils.isValidVideo(file);
      if (!valid.valid) {
        alert(valid.error);
        return;
      }

      // Identifica se o chat é do chatbot
      const chatObj = window.ultimaListaConversas.find(c => c.id === selectedChatId);
      const isChatbot = chatObj && chatObj.source === 'chatbot';

      if (isChatbot) {
        // Envia vídeo para o chatbot via fetch
        const reader = new FileReader();
        reader.onload = async function (e) {
          const base64 = e.target.result.split(',')[1];
          try {
            const res = await fetch('/chatbot/send-media', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chatId: selectedChatId,
                filename: file.name,
                mimetype: file.type,
                data: base64
              })
            });
            const data = await res.json().catch(()=>({}));
            if (chatMessages.contains(loadingDiv)) {
              chatMessages.removeChild(loadingDiv);
            }

            if (!data || !data.success) {
              console.error('Erro no envio via chatbot:', data && data.error);
              showNotification('Erro', 'Erro ao enviar vídeo: ' + (data && data.error ? data.error : 'Erro desconhecido'));
              return;
            }

            // Mostrar imediatamente o vídeo enviado no UI (mesmo comportamento do WhatsApp)
            const messageId = (data.message && data.message.id) ? data.message.id : `local_video_${Date.now()}`;
            const videoMessage = {
              id: messageId,
              body: '[Vídeo]',
              fromMe: true,
              type: 'video',
              timestamp: Math.floor(Date.now() / 1000),
              mimetype: file.type,
              filename: file.name,
              data: base64 // incluir base64 para exibir player imediatamente
            };

            appendMessage(videoMessage);
            updateLocalChatHistory(selectedChatId, videoMessage);

            console.log('Vídeo enviado com sucesso via chatbot e exibido na UI');
          } catch (err) {
            console.error('Erro na requisição:', err);
            showNotification('Erro', 'Erro ao enviar vídeo: ' + (err.message || 'Erro desconhecido'));
          }
        };
        reader.onerror = function () {
          alert('Erro ao ler o arquivo de vídeo.');
        };
        reader.readAsDataURL(file);
      } else {
        // Envia vídeo para o WhatsApp normal via WebSocket
        window.VideoUtils.sendVideo(file, selectedChatId, wsWhatsapp, currentDeviceId)
          .then(msg => console.log('Vídeo enviado:', msg))
          .catch(err => alert('Erro ao enviar vídeo: ' + err));
      }
    });
  }
}); // <- fim do DOMContentLoaded

// quando o usuário clica/seleciona um contato, em vez de usar histórico local,
// solicita ao backend as mensagens (exemplo de função chamada onSelectContact)
function onSelectContact(chatId) {
  selectedChatId = chatId;
  // currentDeviceId deve estar definido (armazenado quando conecta)
  if (!wsWhatsapp || wsWhatsapp.readyState !== WebSocket.OPEN) return;
  wsWhatsapp.send(JSON.stringify({
    type: 'get-messages',
    chatId,
    deviceId: currentDeviceId,
    minMessages: 5, // ajuste se quiser outro limiar
    limit: 50
  }));
  // mostrar carregando no UI enquanto espera
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) chatMessages.innerHTML = '<div class="loading">Carregando histórico...</div>';
}

// no handler de mensagens WS do atendimento (recebendo do backend)
function handleWsMessage(event) {
  const data = JSON.parse(event.data);
  if (data.type === 'messages' && data.chatId === selectedChatId) {
    renderMessages(data.messages || []);
  }
  // ... demais cases existentes ...
}

// Normaliza timestamps para UNIX seconds (evita mistura ms/s)
function normalizeTimestamp(ts) {
  if (!ts && ts !== 0) return Math.floor(Date.now() / 1000);
  const n = Number(ts) || 0;
  // Se parece estar em ms (>= 10 dígitos -> > 1e10)
  if (n > 1e11) return Math.floor(n / 1000); // ms -> s
  if (n > 1e10) return Math.floor(n / 1000);
  return Math.floor(n); // já em segundos
}

// Buscar mídia do servidor (retorna { data, mimetype, filename })
async function fetchMediaFromServer(messageId, chatId) {
  try {
    const url = `/whatsapp/media?messageId=${encodeURIComponent(messageId)}&chatId=${encodeURIComponent(chatId || '')}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json && json.success && json.data) {
      return { data: json.data, mimetype: json.mimetype, filename: json.filename };
    }
    throw new Error(json.error || 'Mídia não encontrada no servidor');
  } catch (err) {
    console.error('fetchMediaFromServer erro:', err);
    throw err;
  }
}

// === INSERIR helper: busca mídia (imagem/video) e abre modal quando necessário ===
async function fetchMediaAndOpen(message) {
  try {
    if (!message || !message.id) return;
    const chatId = selectedChatId || (message.chatId || '');
    const res = await fetch(`/whatsapp/media?messageId=${encodeURIComponent(message.id)}&chatId=${encodeURIComponent(chatId)}`);
    const json = await res.json();
    if (!json || !json.success) {
      console.warn('Media não encontrada no servidor', json && json.error);
      return;
    }
    const data = json.data;
    const mimetype = json.mimetype || message.mimetype || 'application/octet-stream';
    const filename = json.filename || message.filename || 'arquivo';
    if (!data) {
      console.warn('Media sem base64 no servidor');
      return;
    }
    const dataUrl = `data:${mimetype};base64,${data}`;
    // Se for imagem/video, abre modal; se for audio, cria player inline
    if (mimetype.startsWith('image/') || mimetype === 'image/svg+xml') {
      openImageModal(dataUrl, mimetype, filename);
    } else if (mimetype.startsWith('video/')) {
      openImageModal(dataUrl, mimetype, filename);
    } else if (mimetype.startsWith('audio/')) {
      // substitui placeholder por player (procure elemento com data-message-id)
      const el = document.querySelector(`[data-message-id="${message.id}"]`);
      if (el) {
        el.innerHTML = `<audio controls style="max-width:300px;"><source src="${dataUrl}" type="${mimetype}">Seu navegador não suporta áudio.</audio>`;
      }
    } else {
      // para documentos, abrir em nova aba como data URL (pode ser pesado)
      const win = window.open('');
      win.document.write(`<iframe src="${dataUrl}" style="width:100%;height:100vh;" frameborder="0"></iframe>`);
    }
  } catch (err) {
    console.error('fetchMediaAndOpen erro:', err);
  }
}

(function () {
  // Injeta estilos do modal (apenas uma vez)
  if (!document.getElementById('media-modal-styles')) {
    const style = document.createElement('style');
    style.id = 'media-modal-styles';
    style.innerHTML = `
      #media-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:12000;}
      #media-modal-content{position:relative;max-width:94%;max-height:94%;border-radius:8px;overflow:hidden;background:#000;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,0.6);}
      #media-modal-content img,#media-modal-content video{display:block;max-width:100%;max-height:80vh;border-radius:6px;}
      #media-modal-close{position:absolute;top:8px;right:8px;background:rgba(255,255,255,0.95);border:none;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:16px;z-index:12001;}
      #media-modal-filename{position:absolute;bottom:8px;left:12px;color:#fff;font-size:13px;background:rgba(0,0,0,0.35);padding:6px 8px;border-radius:6px;z-index:12001;}
    `;
    document.head.appendChild(style);
  }

  // Abre modal com imagem/vídeo (dataUrl pode ser data:... ou URL)
  window.openImageModal = function (dataUrl, mimetype = '', filename = '') {
    try {
      // evita duplicar modal
      if (document.getElementById('media-modal-overlay')) return;

      const overlay = document.createElement('div');
      overlay.id = 'media-modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      const content = document.createElement('div');
      content.id = 'media-modal-content';

      const btnClose = document.createElement('button');
      btnClose.id = 'media-modal-close';
      btnClose.title = 'Fechar';
      btnClose.innerHTML = '✕';
      btnClose.onclick = () => closeImageModal();

      const filenameDiv = document.createElement('div');
      filenameDiv.id = 'media-modal-filename';
      filenameDiv.textContent = filename || '';

      // Inserir mídia
      if (mimetype && mimetype.startsWith('video/')) {
        const video = document.createElement('video');
        video.controls = true;
        video.autoplay = true;
        video.src = dataUrl;
        video.style.maxWidth = '100%';
        video.style.maxHeight = '80vh';
        content.appendChild(video);
      } else {
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = filename || 'Imagem';
        img.style.maxWidth = '100%';
        img.style.maxHeight = '80vh';
        content.appendChild(img);
      }

      content.appendChild(filenameDiv);
      overlay.appendChild(content);
      overlay.appendChild(btnClose);
      document.body.appendChild(overlay);

      // fechar ao clicar fora
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) closeImageModal();
      });

      // fechar com Esc
      const keyHandler = function (ev) {
        if (ev.key === 'Escape') closeImageModal();
      };
      overlay._keyHandler = keyHandler;
      document.addEventListener('keydown', keyHandler);
    } catch (e) {
      console.error('openImageModal erro:', e);
    }
  };

  window.closeImageModal = function () {
    const overlay = document.getElementById('media-modal-overlay');
    if (!overlay) return;
    const keyHandler = overlay._keyHandler;
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    overlay.remove();
  };

  // Delegation: ao clicar em imagens/vídeos dentro do chat, abrir modal.
  document.addEventListener('click', function (ev) {
    try {
      const el = ev.target;
      if (!el) return;

      // imagens (inclui imagens que seu render cria com onclick too)
      if (el.tagName === 'IMG' && el.closest && el.closest('#chat-messages')) {
        const src = el.getAttribute('src');
        const mimetype = el.getAttribute('data-mimetype') || '';
        const filename = el.getAttribute('data-filename') || el.alt || '';
        if (src) {
          window.openImageModal(src, mimetype, filename);
        }
        return;
      }

      // vídeos (elemento <video>)
      if ((el.tagName === 'VIDEO' || el.closest && el.closest('video')) ) {
        const videoEl = el.tagName === 'VIDEO' ? el : el.closest('video');
        if (videoEl && videoEl.closest && videoEl.closest('#chat-messages')) {
          // pega primeira source ou src direto
          const source = videoEl.querySelector('source');
          const src = source ? source.getAttribute('src') : (videoEl.getAttribute('src') || null);
          const mimetype = videoEl.getAttribute('data-mimetype') || (source ? source.getAttribute('type') : '') || 'video/mp4';
          const filename = videoEl.getAttribute('data-filename') || '';
          if (src) {
            // pause original playing to avoid duplicate sound
            try { videoEl.pause(); } catch (e) {}
            window.openImageModal(src, mimetype, filename);
          }
        }
        return;
      }
    } catch (e) {
      // não atrapalhar outros handlers
    }
  }, false);
})();
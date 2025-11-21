const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { EventEmitter } = require('events');
const path = require('path');
const WhatsappDevice = require('./whatsappDevice');
const WhatsappMessage = require('./WhatsappMessage');
const Conversation = require('./Conversation');
const sequelize = require('./banco');
const WhatsappMedia = require('./WhatsappMedia');

class WhatsappManager {
  constructor() {
    this.clients = {};
    this.wss = null;
    this.whatsappEvents = new EventEmitter();
  }

  setWebSocket(wss) {
    this.wss = wss;
  }

  getClientStatus(deviceId) {
    return this.clients[deviceId] ? {
      isReady: this.clients[deviceId].isReady,
      qr: this.clients[deviceId].qr,
    } : null;
  }

  // =================================================================
  // ADICIONADO: Método para obter a instância do cliente
  // =================================================================
  getClient(deviceId) {
    const clientData = this.clients[deviceId];
    if (clientData && clientData.instance && clientData.isReady) {
      return clientData.instance;
    }
    return null;
  }

  initializeClient(deviceId, empresaId) {
    if (this.clients[deviceId]) {
      console.log(`Cliente ${deviceId} já está inicializando ou conectado.`);
      return;
    }

    console.log(`Inicializando cliente para o dispositivo: ${deviceId}`);

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: deviceId,
        dataPath: path.join(__dirname, 'sessions')
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ],
        // =================================================================
        // CORREÇÃO IMPORTANTE PARA EVITAR O CRASH 'EBUSY'
        // Garante que o Puppeteer gerencie corretamente o encerramento do processo do Chrome.
        handleSIGINT: false,
        // =================================================================
      }
    });

    client.on('qr', (qr) => {
      console.log(`QR Code gerado para ${deviceId}`);
      this.clients[deviceId].qr = qr;
      this.whatsappEvents.emit('qr_update', { deviceId, qr, empresaId });
    });

    client.on('ready', async () => {
      console.log(`Cliente ${deviceId} está pronto!`);
      this.clients[deviceId].isReady = true;
      this.clients[deviceId].qr = null; // Limpa o QR code após a conexão

      const clientInfo = client.info;
      const number = clientInfo.wid.user;

      // CORREÇÃO: Garante que a empresaId seja associada ao dispositivo no banco de dados
      await WhatsappDevice.update({
        status: 'connected',
        number: number,
        last_connected: new Date()
      }, { where: { device_id: deviceId } });

      this.wss.clients.forEach(wsClient => {
        // Envia a notificação apenas para clientes da mesma empresa
        if (wsClient.empresa_id === this.clients[deviceId]?.empresaId) {
          wsClient.send(JSON.stringify({ type: 'whatsapp-connected', deviceId, status: 'connected' }));
        }
      });

      // Inicia o processo de sincronização de contatos e mensagens
      this.syncChats(client, deviceId, empresaId);
    });

    // =================================================================
    // ADICIONADO: Ouve novas mensagens em tempo real
    // =================================================================
    client.on('message_create', async (message) => {
      // Ignora notificações de status, chamadas, etc. Processa apenas mensagens de texto/mídia.
      if (!message.from) {
        return;
      }

      console.log(`[${deviceId}] Nova mensagem de ${message.from}: ${message.body.substring(0, 30)}...`);

      try {
        // CORREÇÃO: Usa o ID serializado do chat para consistência.
        const chatId = (await message.getChat()).id._serialized;

        // Salva a mensagem no banco de dados em segundo plano
        await WhatsappMessage.upsert({
          id: message.id.id,
          deviceId: deviceId,
          chatId: chatId,
          body: message.body,
          fromMe: message.fromMe,
          type: message.type,
          timestamp: message.timestamp,
          empresa_id: empresaId,
        });

        // CORREÇÃO: Busca o contato para obter o nome correto (pushname) em vez de usar notifyName.
        const contact = await client.getContactById(chatId);
        const chatName = contact.pushname || contact.name || chatId.replace('@c.us', '');

        // Atualiza a tabela 'conversations' com a última mensagem e o nome correto.
        await Conversation.upsert({
          id: chatId,
          empresa_id: empresaId,
          name: chatName,
          last_message: message.body,
          timestamp: new Date(message.timestamp * 1000),
          is_group: message.isGroup,
          source: 'whatsapp',
          device_id: deviceId,
        });

        // Envia a mensagem via WebSocket para o frontend (se houver clientes conectados)
        this.wss.clients.forEach(wsClient => {
          // Garante que a mensagem seja enviada apenas para clientes da mesma empresa
          if (wsClient.empresa_id === empresaId) {
            wsClient.send(JSON.stringify({
              type: 'new-message',
              message: message.rawData,
              customerName: message._data.notifyName,
              deviceId
            }));
          }
        });
      } catch (error) {
        console.error(`[${deviceId}] Erro ao processar ou salvar mensagem:`, error);
      }
    });

    client.on('disconnected', async (reason) => {
      console.log(`Cliente ${deviceId} foi desconectado. Razão: ${reason}`);
      await WhatsappDevice.update({ status: 'disconnected' }, { where: { device_id: deviceId } });

      this.wss.clients.forEach(wsClient => {
        // CORREÇÃO: Garante que a notificação de desconexão seja enviada apenas
        // para os clientes WebSocket da empresa correta.
        if (this.clients[deviceId] && wsClient.empresa_id === this.clients[deviceId].empresaId) {
          wsClient.send(JSON.stringify({ type: 'disconnected', deviceId, status: 'disconnected' }));
        }
      });

      // Remove o cliente da memória para permitir uma nova inicialização
      if (this.clients[deviceId]) {
        try {
          await this.clients[deviceId].instance.destroy();
        } catch (e) {
          console.error(`[${deviceId}] Erro ao tentar destruir o cliente após desconexão:`, e);
        } finally {
          delete this.clients[deviceId];
        }
      }
    });

    this.clients[deviceId] = {
      instance: client,
      isReady: false,
      qr: null,
      empresaId: empresaId // Adicionado para rastrear a empresa
    };

    client.initialize().catch(err => {
      console.error(`Falha ao inicializar cliente ${deviceId}:`, err);
      delete this.clients[deviceId];
    });
  }

  async disconnectClient(deviceId) {
    const clientData = this.clients[deviceId];
    if (clientData && clientData.instance) {
      console.log(`Solicitando desconexão para ${deviceId}...`);
      try {
        await clientData.instance.logout(); // O logout já dispara o evento 'disconnected'
      } catch (error) {
        console.error(`Erro ao fazer logout do cliente ${deviceId}:`, error);
        // Mesmo com erro, removemos a referência para permitir nova tentativa
        delete this.clients[deviceId];
      }
    }
  }

  async syncChats(clientInstance, deviceId, empresaId, taskId = null, syncTasks = null) {
    try {
      // --- CORREÇÃO: Usa a instância do cliente passada como argumento ---
      let client = clientInstance;

      // Se o cliente não estiver pronto, tenta inicializá-lo e aguarda.
      if (!client) {
        console.log(`[Sync ${taskId}] Cliente ${deviceId} não está pronto. Tentando reconectar...`);
        if (taskId && syncTasks) {
          syncTasks[taskId].message = 'Reconectando...';
          this.wss.clients.forEach(wsClient => {
            wsClient.send(JSON.stringify({ type: 'sync-progress', taskId, progress: 0, message: 'Reconectando...' }));
          });
        }
        this.initializeClient(deviceId, empresaId);
        return;
      }

      if (taskId && syncTasks) {
        console.log(`[Sync ${taskId}] Iniciando sincronização para o device ${deviceId}`);
        syncTasks[taskId].message = 'Buscando lista de conversas...';
        syncTasks[taskId].progress = 5;
      } else {
        console.log(`[${deviceId}] Iniciando sincronização de histórico de chats...`);
      }

      const chats = await client.getChats();
      const totalChats = chats.length;
      console.log(`[${deviceId}] INICIANDO SINCRONIZAÇÃO. Total de conversas encontradas: ${totalChats}`);

      if (taskId && syncTasks) {
        syncTasks[taskId].message = `Processando ${totalChats} conversas...`;
        syncTasks[taskId].progress = 10;
      }

      // --- OTIMIZAÇÃO: Processa os chats em duas fases ---
      const recentChats = chats.slice(0, 20);
      const remainingChats = chats.slice(20);

      // Função auxiliar para processar um lote de chats e atualizar o status
      const processChatBatch = async (batch, isRecentBatch) => {
        const batchSize = batch.length;
        for (let i = 0; i < batchSize; i++) {
          const chat = batch[i];
          const overallIndex = isRecentBatch ? i : i + recentChats.length;
          const progressPercentage = Math.round(((overallIndex + 1) / totalChats) * 100);

          if (taskId && syncTasks) {
            const message = isRecentBatch
              ? `Sincronizando conversas recentes (${i + 1}/${batchSize})...`
              : `Sincronizando histórico completo (${overallIndex + 1}/${totalChats})...`;

            syncTasks[taskId].progress = progressPercentage;
            syncTasks[taskId].message = message;

            this.wss.clients.forEach(wsClient => {
              if (wsClient.empresa_id === empresaId) {
                wsClient.send(JSON.stringify({ type: 'sync-progress', taskId, progress: progressPercentage, message }));
              }
            });
          }

          console.log(`[${deviceId}] [${overallIndex + 1}/${totalChats}] Processando chat: "${chat.name || chat.id._serialized}" (${progressPercentage}%)`);

          if (chat.archived) {
            continue; // Pula chats arquivados
          }
          
          // CORREÇÃO: Ignora a conversa "status@broadcast"
          if (chat.id._serialized === 'status@broadcast') {
            continue;
          }

          // Busca o contato para ter informações precisas
          const contact = await client.getContactById(chat.id._serialized);
          
          // Busca última mensagem para timestamp
          const messages = await chat.fetchMessages({ limit: 80 });
          const lastMessageInChat = messages.length > 0 ? messages[messages.length - 1] : null;

          await Conversation.upsert({
            id: chat.id._serialized,
            empresa_id: empresaId,
            name: contact.pushname || contact.name || chat.id.user,
            profile_pic_url: await contact.getProfilePicUrl().catch(() => null),
            last_message: lastMessageInChat ? lastMessageInChat.body : null,
            timestamp: lastMessageInChat ? new Date(lastMessageInChat.timestamp * 1000) : new Date(),
            unread_count: chat.unreadCount,
            is_group: chat.isGroup,
            source: 'whatsapp',
            device_id: deviceId,
          }).catch(err => {
            console.error(`[${deviceId}] Falha ao salvar conversa ${chat.id._serialized}:`, err);
          });

          // Busca o timestamp da última mensagem salva
          const lastSavedMessage = await WhatsappMessage.findOne({
            where: { deviceId, chatId: chat.id._serialized },
            order: [['timestamp', 'DESC']],
            attributes: ['timestamp'],
            raw: true,
          });
          const lastTimestamp = lastSavedMessage ? lastSavedMessage.timestamp : 0;

          console.log(`[${deviceId}]   -> Verificando ${messages.length} mensagens...`);

          for (const msg of messages) {
            if (msg.timestamp <= lastTimestamp) {
              continue;
            }

            await WhatsappMessage.upsert({
              id: msg.id.id,
              chatId: chat.id._serialized,
              deviceId: deviceId,
              body: msg.body,
              fromMe: msg.fromMe,
              type: msg.type,
              timestamp: msg.timestamp,
              empresa_id: empresaId,
            });

            if (msg.hasMedia) {
              try {
                const media = await msg.downloadMedia();
                if (media && media.data) {
                  await WhatsappMedia.upsert({
                    id: msg.id.id,
                    messageId: msg.id.id,
                    chatId: chat.id._serialized,
                    deviceId: deviceId,
                    mimetype: media.mimetype,
                    filename: media.filename,
                    size: media.size,
                    data: media.data,
                    timestamp: msg.timestamp,
                    empresa_id: empresaId,
                  });
                }
              } catch (mediaError) {
                console.error(`[${deviceId}] Falha ao baixar ou salvar mídia para a mensagem ${msg.id.id}:`, mediaError.message);
              }
            }
          }
        }
      };

      // Executa as duas fases da sincronização
      await processChatBatch(recentChats, true);
      await processChatBatch(remainingChats, false);

      // =================================================================
      // Envia a lista de contatos para o frontend após a sincronização
      // =================================================================
      if (taskId && syncTasks) {
        syncTasks[taskId] = { progress: 100, message: 'Concluído!', done: true };
        console.log(`[Sync ${taskId}] Sincronização concluída.`);
      } else {
        console.log(`[${deviceId}] Sincronização de histórico concluída.`);
      }

    } catch (error) {
      console.error(`Erro ao buscar chats para ${deviceId}:`, error);
    }
  } // Fim do método syncChats (havia chaves extras aqui no original)

  // =================================================================
  // ADICIONADO: Método para enviar mensagens
  // =================================================================
  async sendMessage(deviceId, chatId, text) {
    const client = this.getClient(deviceId);

    if (!client) {
      console.error(`[SendMessage] Tentativa de envio com cliente ${deviceId} desconectado.`);
      throw new Error('Dispositivo WhatsApp não está conectado.');
    }

    try {
      console.log(`[${deviceId}] Enviando mensagem para: ${chatId}`);

      // Garante que o ID do chat esteja no formato correto (ex: 5511999999999@c.us)
      const finalChatId = chatId.endsWith('@c.us') ? chatId : `${chatId}@c.us`;

      const sentMessage = await client.sendMessage(finalChatId, text);
      console.log(`[${deviceId}] Mensagem enviada com sucesso para ${finalChatId}. ID: ${sentMessage.id.id}`);

      const empresaId = this.clients[deviceId]?.empresaId;
      if (!empresaId) {
        console.error(`[SendMessage] Não foi possível encontrar a empresaId para o device ${deviceId}`);
        // A mensagem foi enviada, mas não será salva no banco.
        return sentMessage.rawData;
      }

      // Salva a mensagem enviada no banco de dados para manter o histórico
      await WhatsappMessage.upsert({
        id: sentMessage.id.id,
        deviceId: deviceId,
        chatId: finalChatId,
        body: sentMessage.body,
        fromMe: true, // A mensagem é nossa
        type: sentMessage.type,
        timestamp: sentMessage.timestamp,
        empresa_id: empresaId,
      });

      // Atualiza a 'conversation' com a última mensagem enviada
      await Conversation.update({
        last_message: sentMessage.body,
        timestamp: new Date(sentMessage.timestamp * 1000),
      }, {
        where: { id: finalChatId, empresa_id: empresaId }
      });

      // Retorna os dados brutos da mensagem, que podem ser úteis para o frontend
      return sentMessage.rawData;

    } catch (error) {
      console.error(`[${deviceId}] Falha ao enviar mensagem para ${chatId}:`, error);
      throw new Error('Não foi possível enviar a mensagem. Verifique se o número é válido.');
    }
  }

  // =================================================================
  // ADICIONADO: Método para sincronizar uma única conversa sob demanda
  // =================================================================
  async syncSingleChat(client, deviceId, chatId, empresaId) {
    if (!client) {
      throw new Error('Cliente WhatsApp não está conectado.');
    }

    console.log(`[SYNC-SINGLE] Iniciando sincronização para o chat ${chatId} no dispositivo ${deviceId}`);

    const chat = await client.getChatById(chatId);
    if (!chat) {
      throw new Error(`Chat com ID ${chatId} não encontrado.`);
    }

    const contact = await chat.getContact();

    // 1. Atualiza os dados da conversa (nome, foto, etc.)
    await Conversation.upsert({
      id: chat.id._serialized,
      empresa_id: empresaId,
      name: contact.pushname || contact.name || chat.id.user,
      profile_pic_url: await contact.getProfilePicUrl().catch(() => null),
      unread_count: chat.unreadCount, // Atualiza o contador de não lidas
      is_group: chat.isGroup,
      source: 'whatsapp',
      device_id: deviceId,
    });

    // 2. Busca as mensagens mais recentes do chat (ex: últimas 50)
    const messages = await chat.fetchMessages({ limit: 50 });
    if (!messages || messages.length === 0) {
      console.log(`[SYNC-SINGLE] Nenhuma mensagem encontrada para o chat ${chatId}.`);
      return;
    }

    const messagesToSave = [];
    const mediaToSave = [];

    for (const msg of messages) {
      messagesToSave.push({
        id: msg.id.id,
        chatId: chat.id._serialized,
        deviceId: deviceId,
        empresa_id: empresaId,
        body: msg.body,
        fromMe: msg.fromMe,
        type: msg.type,
        timestamp: msg.timestamp,
      });

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            mediaToSave.push({
              id: msg.id.id,
              messageId: msg.id.id,
              chatId: chat.id._serialized,
              deviceId: deviceId,
              empresa_id: empresaId,
              mimetype: media.mimetype,
              filename: media.filename,
              data: media.data,
            });
          }
        } catch (mediaError) {
          console.error(`[SYNC-SINGLE] Falha ao baixar mídia para a mensagem ${msg.id.id}:`, mediaError.message);
        }
      }
    }

    // 3. Salva tudo no banco de uma vez (muito mais rápido)
    if (messagesToSave.length > 0) await WhatsappMessage.bulkCreate(messagesToSave, { updateOnDuplicate: ['body', 'fromMe', 'type', 'timestamp'] });
    if (mediaToSave.length > 0) await WhatsappMedia.bulkCreate(mediaToSave, { updateOnDuplicate: ['data'] });

    // --- ADICIONADO: Notifica o frontend via WebSocket que a conversa foi atualizada ---
    if (this.wss) {
      this.wss.clients.forEach(wsClient => {
        // Envia a notificação apenas para clientes da mesma empresa
        if (wsClient.empresa_id === empresaId) {
          wsClient.send(JSON.stringify({ type: 'chat-updated', deviceId, chatId }));
        }
      });
    }
  }
}

module.exports = new WhatsappManager();
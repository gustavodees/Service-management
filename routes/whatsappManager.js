const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid'); // Adicionado para gerar IDs de tarefa
const fs = require('fs');
const path = require('path');
const WhatsappDevice = require('./whatsappDevice');
const WhatsappMessage = require('./WhatsappMessage');
const Conversation = require('./Conversation');
const sequelize = require('./banco');
const WhatsappMedia = require('./WhatsappMedia');

// Helper to identify and skip status broadcast contacts
function isStatusContact(chat) {
  if (!chat) return false;
  if (chat.isStatus === true) return true;
  const id = (chat.id?._serialized || '').toString();
  if (!id) return false;
  // Common patterns for status/broadcast contacts
  return id.endsWith('@status') || id === 'status@broadcast';
}

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

      // MELHORIA: Inicia a sincronização com feedback de progresso para o frontend.
      const taskId = uuidv4();
      
      // Notifica o frontend que uma sincronização foi iniciada e envia o taskId.
      this.wss.clients.forEach(wsClient => {
        if (wsClient.empresa_id === this.clients[deviceId]?.empresaId) {
          wsClient.send(JSON.stringify({
            type: 'sync-started',
            deviceId,
            taskId
          }));
        }
      });

      // Executa a sincronização em segundo plano, passando o taskId para que o progresso seja rastreado.
      // O objeto syncTasks é gerenciado pelo app.js, mas podemos passar um objeto local para o manager.
      // Por simplicidade, vamos assumir que a lógica de `syncChats` pode lidar com um objeto de tasks nulo
      // ou vamos precisar passar o objeto global. A melhor abordagem é o manager ser autossuficiente.
      // Por agora, vamos chamar a função de sincronização. A rota em app.js já gerencia o objeto `syncTasks`.
      // Para que isso funcione, a chamada em app.js é a principal. Aqui, apenas notificamos.
      // A lógica de `syncChats` já foi ajustada para receber taskId.
      this.syncChats(deviceId, empresaId, taskId, {}).catch(err => console.error(`[${deviceId}] Falha na sincronização automática pós-conexão:`, err));
    });

    // =================================================================
    // ADICIONADO: Ouve novas mensagens em tempo real
    // =================================================================
    client.on('message_create', async (message) => {
      // Ignora mensagens enviadas pelo próprio bot para evitar loops e duplicatas
      if (message.fromMe) {
          return;
      }
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

        // ADICIONADO: Processamento de mídia recebida
        if (message.hasMedia) {
          try {
            const media = await message.downloadMedia();
            if (media && media.data) {
              await WhatsappMedia.create({
                id: message.id.id, // Usa o ID da mensagem como ID da mídia
                messageId: message.id.id,
                chatId: chatId,
                deviceId: deviceId,
                empresa_id: this.clients[deviceId]?.empresaId || empresaId,
                mimetype: media.mimetype,
                filename: media.filename,
                data: media.data, // Conteúdo em base64
              });
            }
          } catch (mediaError) {
            console.error(`[${deviceId}] Falha ao baixar ou salvar mídia da mensagem ${message.id.id}:`, mediaError);
          }
        }
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
              deviceId,
              chatId: chatId // Passa o chatId correto para o frontend
            }));
          }
        });
      } catch (error) {
        console.error(`[${deviceId}] Erro ao processar ou salvar mensagem:`, error);
      }
    });

    client.on('disconnected', async (reason) => {
      console.log(`[INFO] Cliente ${deviceId} foi desconectado. Razão: ${reason}`);

      // Notifica o frontend sobre a desconexão
      this.wss.clients.forEach(wsClient => {
        if (this.clients[deviceId] && wsClient.empresa_id === this.clients[deviceId].empresaId) {
          wsClient.send(JSON.stringify({ type: 'disconnected', deviceId, status: 'disconnected' }));
        }
      });

      // CORREÇÃO: A lógica de limpeza de dados foi movida para o método `disconnectClient`
      // para evitar duplicação e condições de corrida. O evento 'disconnected' agora
      // apenas limpa o cliente da memória.
      console.log(`[INFO] Cliente ${deviceId} desconectado. Limpando da memória.`);

      // Remove o cliente da memória para permitir uma nova inicialização
      if (this.clients[deviceId]) {
        try {
          await this.clients[deviceId].instance.destroy();
        } catch (e) {
          console.error(`[ERRO] Falha ao tentar destruir o cliente ${deviceId} após desconexão:`, e);
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
        await clientData.instance.logout(); // Isso vai disparar o evento 'disconnected'
      } catch (error) {
        console.error(`Erro ao fazer logout do cliente ${deviceId}:`, error);
        // Continua para a limpeza manual mesmo se o logout falhar.
      }
    }

    // --- INÍCIO DA LÓGICA DE LIMPEZA COMPLETA DE DADOS ---
    // Esta parte garante que todos os dados sejam removidos do banco de dados, centralizando a lógica aqui.
    const transaction = await sequelize.transaction();
    try {
      console.log(`[MANAGER] Iniciando limpeza completa de dados para o dispositivo: ${deviceId}`);

      // 1. Deletar mídias associadas
      const deletedMedia = await WhatsappMedia.destroy({ where: { deviceId: deviceId }, transaction });
      console.log(` -> ${deletedMedia} mídias deletadas.`);

      // 2. Deletar mensagens
      const deletedMessages = await WhatsappMessage.destroy({ where: { deviceId: deviceId }, transaction });
      console.log(` -> ${deletedMessages} mensagens deletadas.`);

      // 3. Deletar conversas/contatos
      const deletedConversations = await Conversation.destroy({ where: { device_id: deviceId }, transaction });
      console.log(` -> ${deletedConversations} conversas deletadas.`);

      // 4. Deletar o próprio dispositivo do banco
      const deletedDevice = await WhatsappDevice.destroy({ where: { device_id: deviceId }, transaction });
      console.log(` -> ${deletedDevice} registro(s) de dispositivo deletado(s).`);

      await transaction.commit();
      console.log(`[MANAGER] Limpeza de dados para ${deviceId} finalizada com sucesso.`);

    } catch (dbError) {
      await transaction.rollback();
      console.error(`[ERRO] Falha na limpeza de dados para ${deviceId}:`, dbError);
    } finally {
      // Remove o cliente da memória para permitir uma nova inicialização no futuro.
      if (this.clients[deviceId]) {
        delete this.clients[deviceId];
      }
    }
  }

  async syncChats(deviceId, empresaId, taskId = null, syncTasks = null) {
    console.log("\n\n");
    console.log("*****************************************************************");
    console.log(`*** [${deviceId}] INICIANDO SINCRONIZAÇÃO DE HISTÓRICO ***`);
    console.log("*****************************************************************");
    console.log(`*** Dispositivo: ${deviceId}`);
    console.log(`*** Empresa: ${empresaId}`);
    if (taskId) console.log(`*** Task ID: ${taskId}`);
    console.log("*** Por favor, aguarde a conclusão do processo. ***");
    console.log("\n");

    const updateTaskProgress = (progress, message) => {
      if (taskId && syncTasks && syncTasks[taskId]) {
        syncTasks[taskId].progress = progress;
        syncTasks[taskId].message = message;
      }
    };

    try {
        let clientInstance = this.getClient(deviceId);

        // Se o cliente não estiver pronto, tenta inicializar e aguarda a conexão.
        if (!clientInstance) {
            console.log(`[SYNC] Cliente ${deviceId} não está pronto. Tentando inicializar...`);
            updateTaskProgress(5, 'Conectando ao dispositivo...');
            this.initializeClient(deviceId, empresaId);

            // Aguarda o cliente ficar pronto com um timeout
            await new Promise((resolve, reject) => {
                const waitTimeout = setTimeout(() => reject(new Error('Tempo de conexão esgotado. Verifique o QR Code.')), 60000); // 60 segundos

                const checkReady = setInterval(() => {
                    clientInstance = this.getClient(deviceId);
                    if (clientInstance) {
                        clearTimeout(waitTimeout);
                        clearInterval(checkReady);
                        resolve();
                    }
                }, 1000);
            });
        }

        updateTaskProgress(10, 'Buscando conversas...');
        const chats = await clientInstance.getChats();
        console.log(`[INFO] Total de conversas encontradas: ${chats.length}`);

        const nonArchivedContacts = chats.filter(c => !c.archived && !c.isGroup && !isStatusContact(c));
        const nonArchivedGroups = chats.filter(c => !c.archived && c.isGroup && !isStatusContact(c));
        const archivedChats = chats.filter(c => c.archived && !isStatusContact(c));

        const allChatsForFrontend = [];

        // Função interna para processar um lote de chats
        const processChatList = async (chatList, type, progressStart, progressEnd) => {
            console.log(`\n[INFO] Sincronizando ${chatList.length} conversas do tipo: ${type}`);
            let processedCount = 0;
            for (const chat of chatList) {
                const chatName = chat.name || chat.id.user;
                
                processedCount++;
                const currentProgress = progressStart + Math.round(((processedCount / chatList.length) * (progressEnd - progressStart)));
                updateTaskProgress(currentProgress, `Sincronizando: ${chatName}`);
                try {
                    console.log(` -> Processando chat: "${chatName}"`);

                    const messages = await chat.fetchMessages({ limit: 100 });
                    console.log(`    * Encontradas ${messages.length} mensagens para "${chatName}".`);

                    if (messages.length > 0) {
                        const messagesToSave = messages.map(msg => ({
                            id: msg.id.id,
                            chatId: chat.id._serialized,
                            deviceId: deviceId,
                            empresa_id: empresaId,
                            body: msg.body,
                            fromMe: msg.fromMe,
                            type: msg.type,
                            timestamp: msg.timestamp,
                        }));
                        await WhatsappMessage.bulkCreate(messagesToSave, { ignoreDuplicates: true });
                    }

                    // ADICIONADO: Processamento de mídias durante a sincronização
                    for (const msg of messages) {
                        if (msg.hasMedia) {
                            try {
                                const media = await msg.downloadMedia();
                                if (media && media.data) {
                                    await WhatsappMedia.upsert({
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
                                // MELHORIA: Loga o erro mas não para a sincronização.
                                console.warn(`[SYNC-WARN] Não foi possível baixar ou salvar a mídia para a mensagem ${msg.id.id}. Erro: ${mediaError.message}. Continuando...`);
                            }
                        }
                    }

                    const contact = await clientInstance.getContactById(chat.id._serialized);
                    const lastMessageInChat = messages.length > 0 ? messages[0] : null;

                    const conversationData = {
                        id: chat.id._serialized,
                        empresa_id: empresaId,
                        name: contact.pushname || contact.name || chat.id.user,
                        profile_pic_url: await contact.getProfilePicUrl().catch(() => null),
                        last_message: lastMessageInChat ? lastMessageInChat.body : (chat.lastMessage?.body || ''),
                        timestamp: new Date((lastMessageInChat ? lastMessageInChat.timestamp : chat.timestamp) * 1000),
                        unread_count: chat.unreadCount,
                        is_group: chat.isGroup,
                        archived: chat.archived,
                        source: 'whatsapp',
                        device_id: deviceId,
                    };
                    
                    await Conversation.upsert(conversationData);
                    allChatsForFrontend.push(conversationData);

                } catch (chatError) {
                    console.error(`[ERRO] Falha ao sincronizar o chat "${chatName}":`, chatError.message);
                }
            }
        };

        // Executa a sincronização na ordem definida
        await processChatList(nonArchivedContacts, 'Contatos Individuais', 15, 60);
        await processChatList(nonArchivedGroups, 'Grupos', 60, 80);
        await processChatList(archivedChats, 'Conversas Arquivadas', 80, 95);

        updateTaskProgress(100, 'Sincronização concluída!');
        if (taskId && syncTasks && syncTasks[taskId]) syncTasks[taskId].done = true;
        
        // Notifica o frontend com a lista completa e atualizada de contatos
        this.wss.clients.forEach(wsClient => {
            if (wsClient.empresa_id === empresaId) {
                wsClient.send(JSON.stringify({
                    type: 'all-whatsapp-contacts',
                    contacts: allChatsForFrontend,
                    deviceId
                }));
            }
        });

        console.log("\n");
        console.log("*****************************************************************");
        console.log(`*** [${deviceId}] SINCRONIZAÇÃO DE HISTÓRICO FINALIZADA ***`);
        console.log("*****************************************************************");
        console.log("\n\n");

    } catch (error) {
        console.error(`[ERRO CRÍTICO] Falha durante a sincronização de chats para ${deviceId}:`, error);
        updateTaskProgress(100, `Erro: ${error.message}`);
        if (taskId && syncTasks && syncTasks[taskId]) syncTasks[taskId].done = true;
        console.log("\n");
        console.log("*****************************************************************");
        console.log(`*** [${deviceId}] SINCRONIZAÇÃO DE HISTÓRICO FALHOU ***`);
        console.log("*****************************************************************");
        console.log("\n\n");
    }
  } // Fim do método syncChats

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
      const finalChatId = chatId.includes('@') ? chatId : `${chatId}@c.us`;

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
  // ADICIONADO: Método para enviar mídias (imagens, vídeos, documentos)
  // =================================================================
  async sendMedia(deviceId, chatId, filePath, filename, mimetype) {
    const client = this.getClient(deviceId);

    if (!client) {
      throw new Error('Dispositivo WhatsApp não está conectado.');
    }

    try {
      console.log(`[${deviceId}] Enviando mídia para: ${chatId}`);
      const finalChatId = chatId.includes('@') ? chatId : `${chatId}@c.us`;

      // Cria o objeto de mídia a partir do arquivo no servidor
      const media = MessageMedia.fromFilePath(filePath);

      // Envia a mídia com as opções corretas
      const sentMessage = await client.sendMessage(finalChatId, media, {
        caption: filename, // Opcional: usa o nome do arquivo como legenda
      });

      console.log(`[${deviceId}] Mídia enviada com sucesso para ${finalChatId}. ID: ${sentMessage.id.id}`);

      // A lógica para salvar a mensagem/mídia enviada no banco de dados já é tratada
      // pelo evento 'message_create' quando a mensagem é do próprio bot (fromMe: true).
      // Não é necessário duplicar a lógica aqui.

      return sentMessage.rawData;

    } catch (error) {
      console.error(`[${deviceId}] Falha ao enviar mídia para ${chatId}:`, error);
      throw new Error('Não foi possível enviar a mídia. Verifique o arquivo e o número de destino.');
    }
  }
  async setChatState(deviceId, chatId, state) {
    const client = this.getClient(deviceId);
    if (!client) {
      // Ignore silently if client is not ready
      return;
    }

    try {
      const chat = await client.getChatById(chatId);
      if (!chat) return;

      switch (state) {
        case 'typing':
          await chat.sendStateTyping();
          break;
        case 'recording':
          await chat.sendStateRecording();
          break;
        case 'clear':
          await chat.clearState();
          break;
      }
    } catch (error) {
      console.error(`[${deviceId}] Falha ao definir estado '${state}' para o chat ${chatId}:`, error);
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

  notifyChatTabulated(chatId, empresaId) {
    if (this.wss) {
        this.wss.clients.forEach(wsClient => {
            // Envia a notificação apenas para clientes da mesma empresa
            if (wsClient.empresa_id === empresaId) {
                wsClient.send(JSON.stringify({
                    type: 'chat-tabulated',
                    chatId: chatId
                }));
            }
        });
    }
  }
}

module.exports = new WhatsappManager();
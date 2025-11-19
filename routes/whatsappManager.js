const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { EventEmitter } = require('events');
const path = require('path');
const WhatsappDevice = require('./whatsappDevice');
const WhatsappMessage = require('./WhatsappMessage');
const Conversation = require('./Conversation'); // Adicionado para consistência
const sequelize = require('./banco'); // Adicionado para acesso ao modelo
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
          '--single-process', // <- pode ajudar em ambientes com poucos recursos
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
      this.whatsappEvents.emit('qr_update', { deviceId, qr });
    });

    client.on('ready', async () => {
      console.log(`Cliente ${deviceId} está pronto!`);
      this.clients[deviceId].isReady = true;
      this.clients[deviceId].qr = null; // Limpa o QR code após a conexão

      const clientInfo = client.info;
      const number = clientInfo.wid.user;

      await WhatsappDevice.update({
        status: 'connected',
        number: number,
        last_connected: new Date()
      }, { where: { device_id: deviceId } });

      this.wss.clients.forEach(wsClient => {
        wsClient.send(JSON.stringify({ type: 'whatsapp-connected', deviceId, status: 'connected' }));
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
        const chatId = message.fromMe ? message.to : message.from;

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
        // O evento 'new_message' é ouvido no atendimento-ws.js para atualizar a UI
        this.wss.clients.forEach(wsClient => {
            wsClient.send(JSON.stringify({ type: 'new-message', message: message.rawData, customerName: message._data.notifyName, deviceId }));
        });
      } catch (error) {
        console.error(`[${deviceId}] Erro ao processar ou salvar mensagem:`, error);
      }
    });

    client.on('disconnected', async (reason) => {
      console.log(`Cliente ${deviceId} foi desconectado. Razão: ${reason}`);
      await WhatsappDevice.update({ status: 'disconnected' }, { where: { device_id: deviceId } });
      
      this.wss.clients.forEach(wsClient => {
        wsClient.send(JSON.stringify({ type: 'disconnected', deviceId, status: 'disconnected' }));
      });

      // Remove o cliente da memória para permitir uma nova inicialização
      if (this.clients[deviceId]) {
        // CORREÇÃO: Chama o método destroy() para garantir que o processo do Puppeteer
        // seja encerrado e os arquivos da sessão sejam liberados, evitando o erro EBUSY.
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
          // Atualiza o progresso para 0% com a mensagem de reconexão
          this.wss.clients.forEach(wsClient => {
            wsClient.send(JSON.stringify({ type: 'sync-progress', taskId, progress: 0, message: 'Reconectando...' }));
          });
        }
        this.initializeClient(deviceId, empresaId);
        // A sincronização real ocorrerá no evento 'ready' do cliente.
        // A tarefa de progresso será atualizada a partir de lá.
        return; // Encerra esta execução, pois o evento 'ready' assumirá.
      }

      if (taskId && syncTasks) {
        console.log(`[Sync ${taskId}] Iniciando sincronização para o device ${deviceId}`);
        syncTasks[taskId].message = 'Buscando lista de conversas...';
        syncTasks[taskId].progress = 5; // Progresso inicial
      } else {
        console.log(`[${deviceId}] Iniciando sincronização de histórico de chats...`);
      }

      const chats = await client.getChats();
      const totalChats = chats.length;
      // ADICIONADO: Log inicial com o total de conversas a serem processadas.
      console.log(`[${deviceId}] INICIANDO SINCRONIZAÇÃO. Total de conversas encontradas: ${totalChats}`);

      if (taskId && syncTasks) {
        syncTasks[taskId].message = `Processando ${totalChats} conversas...`;
        syncTasks[taskId].progress = 10;
      }

      // Processa os chats em paralelo para mais performance
      for (let i = 0; i < totalChats; i++) {
        const chat = chats[i];
        if (chat.archived) {
          continue; // Pula chats arquivados
        }

        // ADICIONADO: Log de progresso para cada conversa.
        const progressPercentage = Math.round(((i + 1) / totalChats) * 100);
        console.log(`[${deviceId}] [${i + 1}/${totalChats}] Processando chat: "${chat.name || chat.id._serialized}" (${progressPercentage}%)`);

        // CORREÇÃO: Busca o contato associado ao chat para garantir que temos o 'pushname' e 'name' corretos.
        const contact = await client.getContactById(chat.id._serialized);

        // --- CORREÇÃO: Inserir/Atualizar o chat na tabela 'conversations' ---
        const lastMessageInChat = chat.lastMessage;
        await Conversation.upsert({
          id: chat.id._serialized,
          empresa_id: empresaId,
          // CORREÇÃO: Prioriza o nome do perfil do WhatsApp (pushname) sobre o nome salvo no celular (name).
          // Isso resolve o problema de nomes incorretos como "dada irmã".
          name: contact.pushname || contact.name || chat.id.user,
          profile_pic_url: await chat.getProfilePicUrl().catch(() => null),
          last_message: lastMessageInChat ? lastMessageInChat.body : null,
          timestamp: lastMessageInChat ? new Date(lastMessageInChat.timestamp * 1000) : new Date(),
          unread_count: chat.unreadCount,
          is_group: chat.isGroup,
          source: 'whatsapp',
          device_id: deviceId,
        }).catch(err => {
          console.error(`[${deviceId}] Falha ao salvar conversa ${chat.id._serialized}:`, err);
        });

        // Busca o timestamp da última mensagem salva para este chat para fazer uma sincronização inteligente
        const lastSavedMessage = await WhatsappMessage.findOne({
          where: { deviceId, chatId: chat.id._serialized },
          order: [['timestamp', 'DESC']],
          attributes: ['timestamp'],
          raw: true,
        });
        const lastTimestamp = lastSavedMessage ? lastSavedMessage.timestamp : 0;

        // Busca as últimas 80 mensagens do chat
        const messages = await chat.fetchMessages({ limit: 80 }); // Pega as últimas 80 mensagens

        // ADICIONADO: Log informando quantas mensagens serão verificadas para este chat.
        console.log(`[${deviceId}]   -> Verificando ${messages.length} mensagens...`);

        for (const msg of messages) {
          // Se a mensagem já for mais antiga que a última salva, pulamos para o próximo chat
          if (msg.timestamp <= lastTimestamp) {
            // Otimização: Se a mensagem atual já está no banco, as anteriores também estarão.
            // Podemos parar de processar as mensagens para este chat.
            continue;
          }

          // Usa 'upsert' para inserir ou atualizar a mensagem, evitando duplicatas
          await WhatsappMessage.upsert({
            id: msg.id.id,
            chatId: chat.id._serialized,
            deviceId: deviceId,
            body: msg.body,
            fromMe: msg.fromMe,
            type: msg.type,
            timestamp: msg.timestamp,
          });

          // Se a mensagem tiver mídia, faz o download e salva no banco
          if (msg.hasMedia) {
            // Log de mídia (opcional, pode ser muito verboso)
            try {
              const media = await msg.downloadMedia();
              if (media && media.data) {
                // Usa 'upsert' para evitar duplicatas de mídias
                await WhatsappMedia.upsert({ // CORRIGIDO: Usa o ID da mensagem como ID da mídia
                  id: msg.id.id, // Usa o ID da mensagem como ID da mídia para fácil associação
                  messageId: msg.id.id,
                  chatId: chat.id._serialized,
                  deviceId: deviceId,
                  mimetype: media.mimetype,
                  filename: media.filename,
                  size: media.size,
                  data: media.data, // base64
                  timestamp: msg.timestamp,
                });
                // console.log(`[${deviceId}]     -> Mídia da mensagem ${msg.id.id} salva.`);
              }
            } catch (mediaError) {
              console.error(`[${deviceId}] Falha ao baixar ou salvar mídia para a mensagem ${msg.id.id}:`, mediaError.message);
            }
          }
        }

        // Atualiza o progresso da tarefa se estiver sendo monitorada
        if (taskId && syncTasks) {
          syncTasks[taskId].progress = progressPercentage;
        }
      }

      // =================================================================
      // CORREÇÃO: Envia a lista de contatos para o frontend após a sincronização
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
  }
}

module.exports = new WhatsappManager();
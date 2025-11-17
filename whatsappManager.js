const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { EventEmitter } = require('events');
const path = require('path');
const WhatsappDevice = require('./routes/whatsappDevice');
const WhatsappMessage = require('./routes/WhatsappMessage');
const WhatsappMedia = require('./routes/WhatsappMedia');

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
      if (!message.from || !message.body) {
        return;
      }

      console.log(`[${deviceId}] Nova mensagem de ${message.from}: ${message.body.substring(0, 30)}...`);

      try {
        // Salva a mensagem no banco de dados em segundo plano
        const [savedMessage] = await WhatsappMessage.upsert({
          id: message.id.id,
          deviceId: deviceId,
          chatId: message.fromMe ? message.to : message.from,
          body: message.body,
          fromMe: message.fromMe,
          type: message.type,
          timestamp: message.timestamp,
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
        // Não chama destroy() aqui, pois já foi desconectado. Apenas limpa a referência.
        delete this.clients[deviceId];
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

  async syncChats(client, deviceId, empresaId) {
    try {
      console.log(`[${deviceId}] Iniciando sincronização de histórico de chats...`);
      const chats = await client.getChats();
      console.log(`[${deviceId}] Encontrados ${chats.length} chats. Sincronizando todos...`);

      for (const chat of chats) {
        // Ignora grupos e chats arquivados por enquanto para focar nos atendimentos individuais
        if (chat.isGroup || chat.archived) {
          continue;
        }

        console.log(`[${deviceId}] Sincronizando mensagens do chat: ${chat.name || chat.id._serialized}`);

        // Busca o timestamp da última mensagem salva para este chat para fazer uma sincronização inteligente
        const lastSavedMessage = await WhatsappMessage.findOne({
          where: { deviceId, chatId: chat.id._serialized },
          order: [['timestamp', 'DESC']],
          attributes: ['timestamp'],
          raw: true,
        });
        const lastTimestamp = lastSavedMessage ? lastSavedMessage.timestamp : 0;

        const messages = await chat.fetchMessages({ limit: 80 }); // Pega as últimas 80 mensagens

        for (const msg of messages) {
          // Se a mensagem já for mais antiga que a última salva, pulamos para o próximo chat
          if (msg.timestamp <= lastTimestamp) {
            console.log(`[${deviceId}] Mensagens já sincronizadas para o chat ${chat.name || chat.id._serialized}. Pulando.`);
            break; // Otimização: para de processar mensagens para este chat
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
            console.log(`[${deviceId}] Mensagem ${msg.id.id} tem mídia. Fazendo download...`);
            try {
              const media = await msg.downloadMedia();
              if (media && media.data) {
                // Usa 'upsert' para evitar duplicatas de mídias
                await WhatsappMedia.upsert({
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
                console.log(`[${deviceId}] Mídia da mensagem ${msg.id.id} salva no banco.`);
              }
            } catch (mediaError) {
              console.error(`[${deviceId}] Falha ao baixar ou salvar mídia para a mensagem ${msg.id.id}:`, mediaError.message);
            }
          }
        }
      }
      // =================================================================
      // CORREÇÃO: Envia a lista de contatos para o frontend após a sincronização
      // =================================================================
      this.wss.clients.forEach(wsClient => {
        wsClient.send(JSON.stringify({ type: 'all-whatsapp-contacts', contacts: chats.map(c => c.rawData), deviceId }));
      });
      console.log(`[${deviceId}] Sincronização de histórico concluída.`);
    } catch (error) {
      console.error(`Erro ao buscar chats para ${deviceId}:`, error);
    }
  }
}

module.exports = new WhatsappManager();
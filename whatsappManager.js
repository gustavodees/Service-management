const { Client, LocalAuth } = require('whatsapp-web.js');
const WhatsappDevice = require('./routes/whatsappDevice');
const { EventEmitter } = require('events'); // Adicionado para emitir eventos
const path = 'sessions'; // Pasta para salvar as sessões

const clients = {};
let webSocket = null;

const whatsappEvents = new EventEmitter(); // Adicionado

function setWebSocket(ws) {
    webSocket = ws;
}

function broadcast(message) {
    if (webSocket) {
        webSocket.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(JSON.stringify(message));
            }
        });
    }
}

async function initializeClient(deviceId, empresa_id) {
    if (clients[deviceId]) {
        console.log(`Cliente ${deviceId} já está inicializado ou inicializando.`);
        return clients[deviceId];
    }

    console.log(`Inicializando cliente para o dispositivo: ${deviceId}`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: deviceId, dataPath: path }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                // '--single-process', // <- Removido: Causa problemas no Windows
                '--disable-gpu'
            ],
        }
    });

    clients[deviceId] = { client, isReady: false, qr: null, status: 'connecting' };

    client.on('qr', async (qr) => {
        console.log(`QR Code gerado para ${deviceId}`);
        clients[deviceId].qr = qr;
        clients[deviceId].status = 'connecting';
        await WhatsappDevice.update({ status: 'connecting' }, { where: { device_id: deviceId } });
        // Emite um evento com o QR Code para ser processado pelo app.js
        whatsappEvents.emit('qr_update', { deviceId, qr });
    });

    client.on('ready', async () => {
        console.log(`Cliente ${deviceId} está pronto!`);
        clients[deviceId].isReady = true;
        clients[deviceId].qr = null;
        clients[deviceId].status = 'connected';

        const clientInfo = client.info;
        await WhatsappDevice.update({
            status: 'connected',
            number: clientInfo.wid.user,
            last_connected: new Date()
        }, { where: { device_id: deviceId } });

        // Notifica o frontend que este dispositivo está conectado
        broadcast({ type: 'whatsapp-connected', deviceId, status: 'Conectado' });
        
        // Busca todos os chats (contatos e grupos) e envia para o frontend
        try {
            const chats = await client.getChats();
            console.log(`Enviando ${chats.length} contatos/grupos para o frontend.`);
            broadcast({ type: 'all-whatsapp-contacts', deviceId, contacts: chats });
        } catch (err) {
            console.error(`Erro ao buscar chats para ${deviceId}:`, err);
        }
    });

    client.on('disconnected', async (reason) => {
        console.log(`Cliente ${deviceId} foi desconectado. Razão:`, reason);
        clients[deviceId].isReady = false;
        clients[deviceId].status = 'disconnected';
        await WhatsappDevice.update({ status: 'disconnected' }, { where: { device_id: deviceId } });
        broadcast({ type: 'disconnected', deviceId, status: 'Desconectado' });
        delete clients[deviceId]; // Remove para permitir nova inicialização
    });

    client.on('auth_failure', async (msg) => {
        console.error(`Falha na autenticação para ${deviceId}:`, msg);
        clients[deviceId].status = 'error';
        await WhatsappDevice.update({ status: 'error' }, { where: { device_id: deviceId } });
        broadcast({ type: 'error', deviceId, status: 'Falha na autenticação' });
    });

    try {
        await client.initialize();
    } catch (error) {
        console.error(`Erro ao inicializar o cliente ${deviceId}:`, error);
        delete clients[deviceId];
    }

    return clients[deviceId];
}

function getClientStatus(deviceId) {
    return clients[deviceId] || null;
}

async function disconnectClient(deviceId) {
    const clientInstance = clients[deviceId];
    if (clientInstance && clientInstance.client) {
        await clientInstance.client.logout(); // Usa logout para limpar a sessão
        console.log(`Cliente ${deviceId} desconectado via logout.`);
    }
}

module.exports = {
    initializeClient,
    getClientStatus,
    disconnectClient,
    setWebSocket,
    whatsappEvents // Exporta o emissor de eventos
};
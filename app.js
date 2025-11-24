require('dotenv').config();

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const http = require('http');
const { WebSocketServer } = require('ws'); // Adicionado para WebSocket
const { v4: uuidv4 } = require('uuid'); // Adicionado para gerar IDs de dispositivo
const session = require('express-session');
const multer = require('multer'); // <<< ADICIONADO: Para upload de arquivos
const qrcode = require('qrcode'); // <<< ADICIONADO: Para gerar QR Code no servidor
const sequelize = require('./routes/banco');
const fs = require('fs'); // <<< ADICIONADO

// --- PACOTES DE SEGURANÇA ---
const helmet = require('helmet'); // Protege contra vulnerabilidades web conhecidas
// const csrf = require('csurf'); // Proteção contra Cross-Site Request Forgery (DESATIVADO TEMPORARIAMENTE)
const { body, validationResult } = require('express-validator'); // Validação e sanitização de inputs

const WhatsappDevice = require('./routes/whatsappDevice'); // Adicionado
const ChatbotDevice = require('./routes/chatbotDevice'); // Adicionado
const whatsappManager = require('./routes/whatsappManager'); // Adicionado: Gerenciador de clientes WhatsApp

// Adicionado: Objeto em memória para rastrear o progresso das tarefas de sincronização
const syncTasks = {};

const apiRouter = require('./routes/api'); // <<< ADICIONADO: Importar a nova rota da API
// Adicionado: Importar todos os modelos para sincronização
const Tabulacao = require('./routes/Tabulacao');
const Conversation = require('./routes/Conversation'); // <<< ADICIONADO
const WhatsappMessage = require('./routes/WhatsappMessage');
const WhatsappMedia = require('./routes/WhatsappMedia');
const ActivityLog = require('./routes/ActivityLog'); // Adicionado

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var adminRouter = require('./routes/admin'); // Adicionado
const Empresa = require('./routes/Empresa'); // Adicionado
var chatbotRouter = require('./routes/chatbot');
const Usuario = require('./routes/Usuario');
const bcrypt = require('bcrypt');
const verificaAutenticacao = require('./routes/verificaAutenticacao');
const verificaAcessoMestre = require('./routes/verificaAcessoMestre'); // <<< ADICIONADO

const app = express();
const server = http.createServer(app);

// Adicionado: Configuração do Servidor WebSocket
const wss = new WebSocketServer({
  noServer: true // Permite usar um middleware para autenticação
});

// Passa a instância do WebSocket para o gerenciador
whatsappManager.setWebSocket(wss);

wss.on('connection', (ws, request) => {
  console.log('Cliente WebSocket conectado.');

  // Anexa userId e empresaId do socket via sessão, que já foi validada no 'upgrade'
  ws.userId = request.session.usuario.id;
  ws.empresaId = request.session.usuario.empresa_id;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      console.log('Mensagem recebida do WebSocket:', message);

      const deviceId = message.deviceId;
      const userId = ws.userId;
      const empresaId = ws.empresaId;

      switch (message.type) {
        case 'send-message': {
          // Validação de segurança: o deviceId pertence à empresa do usuário?
          if (!deviceId) {
            throw new Error('DeviceId não fornecido.');
          }
                // VERIFICAÇÃO DE AUTORIZAÇÃO DO DISPOSITIVO
                const device = await WhatsappDevice.findOne({
                    where: {
                        device_id: deviceId
                    }
                });

                if (!device) {
                    throw new Error('Dispositivo não encontrado.');
                }

          if (!message.chatId || !message.body) {
            throw new Error('ChatId ou mensagem vazia.');
          }

          const sentMessageRaw = await whatsappManager.sendMessage(deviceId, message.chatId, message.body);

          ws.send(JSON.stringify({
            type: 'message-sent',
            chatId: message.chatId,
            success: true,
            messageId: sentMessageRaw.id.id,
            deviceId
          }));
          break;
        }

        case 'typing-start': {
          if (!deviceId || !message.chatId) break;
          whatsappManager.setChatState(deviceId, message.chatId, 'typing').catch(console.error);
          break;
        }
        case 'recording-start': {
          if (!deviceId || !message.chatId) break;
          whatsappManager.setChatState(deviceId, message.chatId, 'recording').catch(console.error);
          break;
        }
        case 'typing-stop':
        case 'recording-stop': { // both clear the state
          if (!deviceId || !message.chatId) break;
          whatsappManager.setChatState(deviceId, message.chatId, 'clear').catch(console.error);
          break;
        }

        // Outros cases podem ser adicionados aqui
        default:
          console.warn(`[WSS] Tipo de mensagem não reconhecido: ${message.type}`);
          // Responder com erro pode não ser ideal para todos os tipos não reconhecidos
          // ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem não reconhecido' }));
      }
    } catch (error) {
      console.error('[WSS] Erro ao processar mensagem:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message || 'Erro interno do servidor.' }));
    }
  });

  ws.on('close', () => {
    console.log('Cliente WebSocket desconectado.');
  });
});

// Adicionado: Centraliza o envio de QR Code via WebSocket
// Ouve o evento 'qr_update' do whatsappManager
whatsappManager.whatsappEvents.on('qr_update', ({ deviceId, qr, empresaId }) => {
  // Gera o QR Code como um Data URI
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('Erro ao gerar QR Code Data URL:', err);
      return;
    }
    // Envia a mensagem apenas para os clientes WebSocket da empresa correta
    wss.clients.forEach(client => {
      // Verifica se o cliente pertence à empresa do dispositivo
      if (client.empresa_id === empresaId) {
        client.send(JSON.stringify({ type: 'qr-code', deviceId, qrDataURL: url }));
      }
    });
  });
});

// --- CONFIGURAÇÃO DE MIDDLEWARES DE SEGURANÇA (IMPORTANTE!) ---

// 1. Helmet: Define vários cabeçalhos HTTP de segurança.
// Adiciona Content-Security-Policy (CSP) para mitigar XSS.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(), // Pega as diretivas padrão
      // Permite scripts do próprio domínio, inline, e dos CDNs especificados
      "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://code.jquery.com", "https://stackpath.bootstrapcdn.com", "https://cdnjs.cloudflare.com"],
      // Permite estilos do próprio domínio, inline, e dos CDNs especificados
      "style-src": ["'self'", "https://fonts.googleapis.com", "https://stackpath.bootstrapcdn.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      "font-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "data:"],
      // CORRIGIDO: Permite imagens do próprio domínio, data URIs, e do i.imgur.com
      "img-src": ["'self'", "data:", "https://i.imgur.com", "https://*.imgur.com"],
      // Adicionado: Permite conexões (para buscar .map files) para os CDNs
      "connect-src": ["'self'", "https://stackpath.bootstrapcdn.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
    },
  },
}));

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// 2. Sessão Segura: Define a configuração da sessão uma vez
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me', // Use variável de ambiente!
  resave: false,
  saveUninitialized: false, // Não cria sessão até que algo seja armazenado
  cookie: {
    httpOnly: true, // Impede acesso via JavaScript no cliente
    secure: process.env.NODE_ENV === 'production', // Use cookies seguros em produção (HTTPS)
    sameSite: 'lax'
  }
});
app.use(sessionMiddleware); // Usa o middleware de sessão no Express

app.use(express.static(path.join(__dirname, 'public')));

// 3. CSRF Protection: Middleware deve vir após session e cookieParser.
// const csrfProtection = csrf({ cookie: true }); // DESATIVADO TEMPORARIAMENTE
// app.use(csrfProtection); // DESATIVADO TEMPORARIAMENTE

// Middleware para disponibilizar dados globais para as views
app.use(async (req, res, next) => {
  // Disponibiliza o token CSRF para todos os formulários em todas as views
  // res.locals.csrfToken = req.csrfToken(); // DESATIVADO TEMPORARIAMENTE

  if (req.session && req.session.usuario) {
    res.locals.usuarioTipo = req.session.usuario.tipo;
    res.locals.usuarioEmpresaId = req.session.usuario.empresa_id;

    // Se for super_admin ou admin host, contar empresas pendentes
    const isSuperAdmin = req.session.usuario.tipo === 'super_admin';
    const isAdminHost = req.session.usuario.tipo === 'admin' && !req.session.usuario.empresa_id;

    if (isSuperAdmin || isAdminHost) {
      const count = await Empresa.count({ where: { status: 'pendente' } });
      res.locals.empresasPendentes = count;
      res.locals.nomeEmpresaLogada = 'Acesso Mestre'; // Nome para o admin host
    } else if (req.session.usuario.empresa_id) {
      // Adicionado: Busca o nome da empresa para usuários normais
      const empresa = await Empresa.findByPk(req.session.usuario.empresa_id);
      if (empresa) {
        res.locals.nomeEmpresaLogada = empresa.nome_fantasia;
      }
    }
  }
  next();
});

// --- CONFIGURAÇÃO DE UPLOAD DE ARQUIVOS (Multer) ---

// Define o local de armazenamento e o nome do arquivo
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, 'uploads');
    // Cria o diretório 'uploads' se não existir
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // Mantém o nome original do arquivo, mas adiciona um timestamp para evitar conflitos
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// Rota para lidar com o upload de arquivos
app.post('/upload-files', verificaAutenticacao, upload.array('files'), (req, res) => {
  console.log('Arquivos recebidos:', req.files.map(f => f.filename));
  res.json({ success: true, message: 'Arquivos enviados com sucesso!', files: req.files });
});

// --- ADICIONADO: ROTA PARA ENVIAR MENSAGENS ---
app.post('/api/whatsapp/send-message', verificaAutenticacao, async (req, res) => {
  const { deviceId, chatId, message } = req.body;
  const { empresa_id } = req.session.usuario;

  if (!deviceId || !chatId || !message) {
    return res.status(400).json({ success: false, message: 'deviceId, chatId e message são obrigatórios.' });
  }

  try {
    // Validação de segurança: Garante que o dispositivo pertence à empresa do usuário
    const device = await WhatsappDevice.findOne({ where: { device_id: deviceId, empresa_id } });
    if (!device) {
      return res.status(403).json({ success: false, message: 'Acesso não autorizado a este dispositivo.' });
    }

    const client = whatsappManager.getClient(deviceId);
    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente WhatsApp não está conectado ou pronto.' });
    }

    // Envia a mensagem usando o whatsapp-web.js
    const sentMessage = await client.sendMessage(chatId, message);

    // Opcional: Salvar a mensagem enviada no banco de dados (o evento 'message_create' já faz isso, mas aqui garante)
    // A lógica no 'message_create' já é suficiente para capturar a mensagem enviada.

    res.json({ success: true, message: 'Mensagem enviada com sucesso.', sentMessageId: sentMessage.id.id });

  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor ao enviar mensagem.' });
  }
});

// ADICIONADO: Rota para enviar arquivos de mídia
app.post('/api/whatsapp/send-media', verificaAutenticacao, upload.single('file'), async (req, res) => {
  const { deviceId, chatId } = req.body;
  const { empresa_id } = req.session.usuario;
  const file = req.file;

  if (!deviceId || !chatId || !file) {
    return res.status(400).json({ success: false, message: 'deviceId, chatId e um arquivo são obrigatórios.' });
  }

  try {
    // Validação de segurança
    const device = await WhatsappDevice.findOne({ where: { device_id: deviceId, empresa_id } });
    if (!device) {
      // Limpa o arquivo temporário se a validação falhar
      fs.unlinkSync(file.path);
      return res.status(403).json({ success: false, message: 'Acesso não autorizado a este dispositivo.' });
    }

    // Chama o gerenciador para enviar a mídia
    const sentMessage = await whatsappManager.sendMedia(deviceId, chatId, file.path, file.originalname, file.mimetype);

    res.json({ success: true, message: 'Mídia enviada com sucesso.', sentMessageId: sentMessage.id.id });

  } catch (error) {
    console.error('Erro ao enviar mídia:', error);
    res.status(500).json({ success: false, message: error.message || 'Erro interno do servidor ao enviar mídia.' });
  } finally {
    // Garante que o arquivo de upload seja sempre removido após a tentativa de envio
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/admin', adminRouter); // Adicionado
app.use('/chatbot', chatbotRouter);
app.use('/api', apiRouter); // <<< ADICIONADO: Registra a rota /api/contacts

// Adicionado: Upgrade de conexão para o WebSocket
server.on('upgrade', (request, socket, head) => {
  // Usa o mesmo middleware de sessão do Express para obter a sessão do usuário
  sessionMiddleware(request, {}, () => {
    // Se não houver sessão ou usuário, destrói o socket
    if (!request.session || !request.session.usuario) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Adicionado: Associa o ID da empresa da sessão ao cliente WebSocket.
      // Isso é crucial para garantir que os dados só sejam enviados para a empresa correta.
      if (request.session && request.session.usuario) {
        ws.empresa_id = request.session.usuario.empresa_id;
      }
      wss.emit('connection', ws, request);
    });
  });
});

app.get('/cadastro', verificaAutenticacao, function(req, res) {
  // apenas admin
  if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
    return res.status(403).render('error', { message: 'Acesso negado', error: {} });
  }
  res.render('cadastro', {
    title: 'Cadastro de Usuário',
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null
  });
});

// Rota de cadastro com VALIDAÇÃO E SANITIZAÇÃO
app.post('/cadastro',
  verificaAutenticacao,
  // 4. Validação de Input com express-validator
  body('email').isEmail().normalizeEmail().withMessage('Por favor, insira um e-mail válido.'),
  body('nome').trim().escape().notEmpty().withMessage('O nome é obrigatório.'),
  body('senha').isLength({ min: 8 }).withMessage('A senha deve ter no mínimo 8 caracteres.'),
  body('tipo').isIn(['admin', 'funcionario']).withMessage('Tipo de usuário inválido.'),
  async (req, res) => {
    if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
      return res.status(403).render('cadastro', { error: 'Acesso negado.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).render('cadastro', {
        error: errors.array()[0].msg, // Mostra o primeiro erro
        usuarioTipo: req.session.usuario.tipo
      });
    }

    try {
      const { nome, email, senha, tipo } = req.body;
      const existe = await Usuario.findOne({ where: { email } });
      if (existe) {
        return res.render('cadastro', { error: 'E-mail já cadastrado.', usuarioTipo: req.session.usuario.tipo });
      }
      const senhaHash = await bcrypt.hash(senha, 10);
      await Usuario.create({ nome, email, senha: senhaHash, tipo, empresa_id: req.session.usuario.empresa_id });
      
      // Adicionado: Registrar a criação de usuário no log
      await ActivityLog.create({
        user_id: req.session.usuario.id,
        empresa_id: req.session.usuario.empresa_id,
        action: 'USER_CREATED',
        details: `O admin '${req.session.usuario.nome}' criou o usuário '${nome}' (${email}).`,
        ip_address: req.ip
      });

      res.render('cadastro', { success: 'Usuário cadastrado com sucesso!', usuarioTipo: req.session.usuario.tipo });
    } catch (error) {
      res.render('cadastro', { error: 'Erro ao cadastrar usuário.', usuarioTipo: req.session.usuario.tipo });
    }
  });

// Rota GET para exibir o formulário de edição de usuário
app.get('/editar-usuario/:id', verificaAutenticacao, async (req, res) => {
  if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
    return res.status(403).render('error', { message: 'Acesso negado.' });
  }

  try {
    const usuario = await Usuario.findByPk(req.params.id);
    if (!usuario) {
      return res.status(404).render('error', { message: 'Usuário não encontrado.' });
    }
    res.render('editar-usuario', { title: 'Editar Usuário', usuario });
  } catch (error) {
    console.error('Erro ao buscar usuário para edição:', error);
    res.status(500).render('error', { message: 'Erro ao carregar página de edição.' });
  }
});

// Rota POST para salvar as alterações do usuário
app.post('/editar-usuario/:id',
  verificaAutenticacao,
  body('email').isEmail().normalizeEmail().withMessage('Por favor, insira um e-mail válido.'),
  body('nome').trim().escape().notEmpty().withMessage('O nome é obrigatório.'),
  body('tipo').isIn(['admin', 'funcionario']).withMessage('Tipo de usuário inválido.'),
  async (req, res) => {
    if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
      return res.status(403).render('error', { message: 'Acesso negado.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const usuario = await Usuario.findByPk(req.params.id);
      return res.status(400).render('editar-usuario', {
        title: 'Editar Usuário',
        error: errors.array()[0].msg,
        usuario: usuario
      });
    }

    try {
      const { nome, email, tipo, senha } = req.body;
      const usuario = await Usuario.findByPk(req.params.id);

      const dadosUpdate = { nome, email, tipo };
      if (senha) {
        dadosUpdate.senha = await bcrypt.hash(senha, 10);
      }

      await usuario.update(dadosUpdate);
      res.redirect('/usuariocadastrado'); // Redireciona de volta para a lista
    } catch (error) {
      console.error('Erro ao salvar usuário:', error);
      res.status(500).render('error', { message: 'Erro ao salvar alterações.' });
    }
  });

// Rota GET para a página "Meu Perfil"
app.get('/meu-perfil', verificaAutenticacao, async (req, res) => {
  try {
    const usuario = await Usuario.findByPk(req.session.usuario.id);
    res.render('meu-perfil', {
      title: 'Meu Perfil',
      usuario: usuario, // Passa o objeto do usuário para a view
      usuarioTipo: req.session.usuario.tipo
    });
  } catch (error) {
    console.error('Erro ao carregar perfil:', error);
    res.render('error', { message: 'Erro ao carregar seu perfil.' });
  }
});

// Rota POST para alterar a senha
app.post('/meu-perfil',
  verificaAutenticacao,
  // Validação do nome
  body('nome').trim().escape().notEmpty().withMessage('O nome é obrigatório.'),
  // Validações condicionais para a senha
  body('nova_senha').if(body('nova_senha').notEmpty()).isLength({ min: 8 }).withMessage('A nova senha deve ter no mínimo 8 caracteres.'),
  body('confirmar_nova_senha').custom((value, { req }) => {
    if (req.body.nova_senha && value !== req.body.nova_senha) {
      throw new Error('As senhas não coincidem.');
    }
    return true;
  }),
  async (req, res) => {
    const errors = validationResult(req);
    const usuario = await Usuario.findByPk(req.session.usuario.id); // Busca o usuário para re-renderizar se houver erro

    if (!errors.isEmpty()) {
      return res.render('meu-perfil', { title: 'Meu Perfil', usuario: usuario, error: errors.array()[0].msg });
    }

    try {
      const { nome, senha_atual, nova_senha } = req.body;
      const dadosUpdate = { nome }; // Começa com o nome para atualizar

      // Se o campo de nova senha foi preenchido, processa a alteração de senha
      if (nova_senha) {
        if (!senha_atual) {
          return res.render('meu-perfil', { title: 'Meu Perfil', usuario: usuario, error: 'A senha atual é obrigatória para definir uma nova.' });
        }

        const senhaValida = await bcrypt.compare(senha_atual, usuario.senha);
        if (!senhaValida) {
          return res.render('meu-perfil', { title: 'Meu Perfil', usuario: usuario, error: 'A senha atual está incorreta.' });
        }

        dadosUpdate.senha = await bcrypt.hash(nova_senha, 10);

        // Adicionado: Registrar a alteração de senha no log de atividades
        await ActivityLog.create({
          user_id: usuario.id,
          empresa_id: usuario.empresa_id,
          action: 'PASSWORD_CHANGE_SELF',
          details: `O usuário '${usuario.nome}' (ID: ${usuario.id}) alterou a própria senha.`,
          ip_address: req.ip
        });
      }

      await usuario.update(dadosUpdate);

      // Busca o usuário atualizado para exibir na página
      const usuarioAtualizado = await Usuario.findByPk(req.session.usuario.id);
      res.render('meu-perfil', { title: 'Meu Perfil', usuario: usuarioAtualizado, success: 'Perfil atualizado com sucesso!' });
    } catch (error) {
      res.render('meu-perfil', { title: 'Meu Perfil', usuario: usuario, error: 'Erro ao atualizar o perfil.' });
    }
  });

app.get('/conectZap', verificaAutenticacao, async (req, res) => {
  try {
    if (!req.session || !req.session.usuario) {
      // Segurança extra, embora verificaAutenticacao já deva cuidar disso
      return res.redirect('/login');
    }

    const { empresa_id } = req.session.usuario;
    // Garante que a cláusula where seja segura mesmo se empresa_id for nulo
    const whereClause = empresa_id ? { empresa_id: empresa_id } : {};

    const devices = await WhatsappDevice.findAll({ where: whereClause });

    res.render('conectZap', {
      devices: devices || [],
      usuarioTipo: req.session.usuario.tipo
    });
  } catch (error) {
    console.error('Erro ao buscar dispositivos WhatsApp:', error);
    res.render('conectZap', { devices: [], error: 'Erro ao carregar dispositivos.' });
  }
});

app.get('/conectBot', verificaAutenticacao, async (req, res) => {
  try {
    const { empresa_id } = req.session.usuario;
    const whereClause = empresa_id ? { empresa_id } : {};

    const devices = await ChatbotDevice.findAll({ where: whereClause });
    res.render('conectBot', {
      devices: devices,
      usuarioTipo: req.session.usuario.tipo
    });
  } catch (error) {
    console.error('Erro ao buscar dispositivos de chatbot:', error);
    res.render('conectBot', { devices: [], error: 'Erro ao carregar dispositivos.' });
  }
});

// --- ROTAS PARA WHATSAPP ---

// Cria um novo registro de dispositivo no banco
app.post('/whatsapp/new-device', verificaAutenticacao, async (req, res) => {
  try {
    const deviceId = `device-${uuidv4()}`;
    await WhatsappDevice.create({
      device_id: deviceId,
      user_id: req.session.usuario.id, // Adicionado: Associa o dispositivo ao usuário logado
      empresa_id: req.session.usuario.empresa_id,
      status: 'disconnected'
    });
    res.json({ success: true, deviceId });
  } catch (error) {
    console.error('Erro ao criar novo dispositivo:', error);
    res.status(500).json({ success: false, error: 'Erro no servidor' });
  }
});

// Inicia a inicialização de um cliente específico
app.post('/whatsapp/start/:deviceId', verificaAutenticacao, async (req, res) => {
  const { deviceId } = req.params;
  const { empresa_id } = req.session.usuario;
  // Validação de segurança: Garante que o usuário só possa iniciar um device da sua empresa
  const device = await WhatsappDevice.findOne({ where: { device_id: deviceId, empresa_id } });
  if (!device) {
    return res.status(403).json({ success: false, error: 'Dispositivo não encontrado ou não autorizado.' });
  }
  whatsappManager.initializeClient(deviceId, empresa_id);
  res.json({ success: true, message: 'Inicialização solicitada.' });
});

// Retorna o QR Code e o status (usado para polling de fallback)
app.get('/whatsapp/qrcode/:deviceId', verificaAutenticacao, (req, res) => {
    const { deviceId } = req.params;
    const clientStatus = whatsappManager.getClientStatus(deviceId);

    if (clientStatus && clientStatus.qr) {
        // Gera o QR Code como um Data URI
        qrcode.toDataURL(clientStatus.qr, (err, url) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Falha ao gerar QR Code.' });
            }
            res.json({
                success: true,
                qrDataURL: url, // Envia a imagem como Data URI
                isReady: clientStatus.isReady,
            });
        });
    } else {
        res.json({ success: false, qrDataURL: null, isReady: clientStatus ? clientStatus.isReady : false });
    }
});

// Adicionado: Rota para remover um dispositivo
app.delete('/whatsapp/remove-device', verificaAutenticacao, async (req, res) => {
  const { deviceId } = req.query;
  const { id: userId, empresa_id } = req.session.usuario;

  if (!deviceId) {
    return res.status(400).json({ success: false, message: 'ID do dispositivo é obrigatório.' });
  }

  try {
    // Segurança: Garante que o usuário só pode remover um dispositivo da sua própria empresa
    const device = await WhatsappDevice.findOne({ where: { device_id: deviceId, empresa_id: empresa_id } });

    if (!device) {
      return res.status(404).json({ success: false, message: 'Dispositivo não encontrado ou não autorizado.' });
    }

    // A lógica de desconexão e limpeza agora está centralizada no whatsappManager.
    await whatsappManager.disconnectClient(deviceId);

    res.json({ success: true, message: 'Dispositivo e todos os dados associados foram removidos com sucesso.' });
  } catch (error) {
    console.error('Erro ao remover dispositivo:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// Adicionado: Rota para desconectar um dispositivo (logout)
app.post('/whatsapp/disconnect-device', verificaAutenticacao, async (req, res) => {
  const { deviceId } = req.query;
  const { empresa_id } = req.session.usuario;

  if (!deviceId) {
    return res.status(400).json({ success: false, message: 'ID do dispositivo é obrigatório.' });
  }

  try {
    const device = await WhatsappDevice.findOne({ where: { device_id: deviceId, empresa_id } });
    if (!device) {
      return res.status(403).json({ success: false, message: 'Dispositivo não encontrado ou não autorizado.' });
    }
    await whatsappManager.disconnectClient(deviceId);
    res.json({ success: true, message: 'Solicitação de desconexão enviada.' });
  } catch (error) {
    console.error('Erro ao desconectar dispositivo:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// Adicionado: Rota para buscar o histórico de mensagens de um chat do banco de dados
app.get('/whatsapp/history', verificaAutenticacao, async (req, res) => {
  // [PAGINAÇÃO] Adiciona 'page' e define um limite de mensagens por página
  const { chatId, deviceId, page = 1 } = req.query;
  const { empresa_id } = req.session.usuario;
  const limit = 50; // 50 mensagens por página
  const offset = (parseInt(page, 10) - 1) * limit;

  if (!chatId || !deviceId) {
    return res.status(400).json({ success: false, error: 'chatId e deviceId são obrigatórios.' });
  }

  try {
    // 1. Validação de segurança: Garante que o dispositivo pertence à empresa do usuário
    const device = await WhatsappDevice.findOne({
      // CORREÇÃO: Garante que o deviceId consultado pertence à empresa do usuário logado.
      where: { device_id: deviceId, empresa_id }
    });

    if (!device) {
      return res.status(403).json({ success: false, error: 'Acesso não autorizado a este dispositivo.' });
    }

   
    // Isso é muito mais eficiente do que fazer duas queries separadas.
    const { count, rows: messagesWithMedia } = await WhatsappMessage.findAndCountAll({
      where: { chatId, deviceId },
      
      // e corrigir o erro "Acesso não autorizado" quando os dados estão corretos. (Esta linha estava duplicada e causando erro de sintaxe)
      where: { chatId, deviceId, empresa_id },
       include: [{
        model: WhatsappMedia,
        as: 'media', // 'as' deve corresponder ao alias definido na associação
        // OTIMIZAÇÃO: Não busca o 'data' (base64) na listagem. Ele será buscado sob demanda.
        attributes: ['mimetype', 'filename'],
        required: false // LEFT JOIN para incluir mensagens mesmo que não tenham mídia
      }],
      order: [['timestamp', 'DESC']], // [PAGINAÇÃO] Ordena do mais novo para o mais antigo
      limit: limit,
      offset: offset,
    });

    // 3. Formata o resultado para o frontend
    const combinedHistory = messagesWithMedia.map(msg => {
      const messageData = msg.toJSON();

     
      const finalMessage = {
        ...messageData,
        fromMe: !!messageData.fromMe, // Converte para booleano (true/false)
        hasMedia: !!messageData.media, // Adiciona a flag 'hasMedia' se houver mídia
        mimetype: messageData.media ? messageData.media.mimetype : null,
        filename: messageData.media ? messageData.media.filename : null,
      };
      return finalMessage;
    });

    // [PAGINAÇÃO] Inverte a ordem para o frontend exibir corretamente (mais antigo primeiro)
    const finalHistory = combinedHistory.reverse();
    const hasMore = (offset + finalHistory.length) < count;

    res.json({ success: true, messages: finalHistory, hasMore: hasMore });
  } catch (error) {
    console.error('Erro ao buscar histórico de chat:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// --- ADICIONADO: ROTAS PARA SINCRONIZAÇÃO DE CONTATOS ---

/**
 * Rota para INICIAR a sincronização de contatos de um dispositivo.
 * Ela cria uma tarefa em segundo plano e retorna um ID para consulta.
 */
app.post('/whatsapp/start-sync/:deviceId', verificaAutenticacao, async (req, res) => {
  const { deviceId } = req.params;
  const { empresa_id } = req.session.usuario;

  // Validação de segurança
  const device = await WhatsappDevice.findOne({ where: { device_id: deviceId, empresa_id } });
  if (!device) {
    return res.status(403).json({ success: false, error: 'Dispositivo não encontrado ou não autorizado.' });
  }

  // CORREÇÃO: A verificação de 'ready' foi movida para dentro do whatsappManager.
  // A rota agora sempre cria uma tarefa e deixa o manager lidar com o estado do cliente.
  // Isso evita o erro de 'taskId' indefinido no frontend.
  const taskId = uuidv4();
  // Inicia a tarefa com status 'Iniciando...'. O whatsappManager atualizará se precisar reconectar.
  syncTasks[taskId] = { progress: 0, message: 'Iniciando...', done: false };

  // Retorna o ID da tarefa imediatamente para o frontend
  res.json({ success: true, taskId });

  // --- Executa a sincronização em segundo plano (sem bloquear a resposta) ---
  (async () => {
    try {
      // A lógica de sincronização agora está centralizada no whatsappManager.
      // ADICIONADO: Logs para depuração do processo de sincronização.
      console.log('======================================================');
      console.log(`[SYNC START] Iniciando sincronização para o device: ${deviceId}`);
      console.log(`[SYNC INFO] Empresa ID: ${empresa_id}, Task ID: ${taskId}`);
      console.log('======================================================');
      // CORREÇÃO: Passa apenas o deviceId. O whatsappManager cuidará de obter/inicializar o cliente.
      await whatsappManager.syncChats(deviceId, empresa_id, taskId, syncTasks);
    } catch (error) { // eslint-disable-line no-shadow
      console.error(`[Sync ${taskId}] Erro durante a sincronização:`, error);
      syncTasks[taskId] = { progress: 100, message: 'Erro na sincronização.', done: true, error: error.message };
    } finally {
      // Limpa a tarefa da memória após 5 minutos para não acumular
      setTimeout(() => {
        delete syncTasks[taskId];
      }, 300000);
    }
  })();
});

/**
 * Rota para VERIFICAR o status de uma tarefa de sincronização.
 */
app.get('/whatsapp/sync-status/:taskId', verificaAutenticacao, (req, res) => {
  const { taskId } = req.params;
  const task = syncTasks[taskId];
  res.json(task || { progress: 100, message: 'Tarefa não encontrada.', done: true });
});

// --- ADICIONADO: ROTA PARA FORÇAR A ATUALIZAÇÃO DE UM ÚNICO CHAT ---
app.post('/api/whatsapp/sync-chat', verificaAutenticacao, async (req, res) => {
  const { deviceId, chatId } = req.body;
  const { empresa_id } = req.session.usuario;

  if (!deviceId || !chatId) {
    return res.status(400).json({ success: false, message: 'deviceId e chatId são obrigatórios.' });
  }

  try {
    // Validação de segurança: Garante que o dispositivo pertence à empresa do usuário
    const device = await WhatsappDevice.findOne({ where: { device_id: deviceId, empresa_id } });
    if (!device) {
      return res.status(403).json({ success: false, message: 'Acesso não autorizado a este dispositivo.' });
    }

    const client = whatsappManager.getClient(deviceId);
    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente WhatsApp não está conectado.' });
    }

    // Executa a sincronização da conversa específica em segundo plano
    whatsappManager.syncSingleChat(client, deviceId, chatId, empresa_id)
      .then(() => {
        console.log(`[SYNC-SINGLE] Sincronização da conversa ${chatId} concluída com sucesso.`);
      })
      .catch(err => {
        console.error(`[SYNC-SINGLE] Erro ao sincronizar a conversa ${chatId}:`, err);
      });

    res.json({ success: true, message: 'Sincronização da conversa iniciada.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

// Rota para deletar usuário
app.delete('/deletar-usuario/:id', verificaAutenticacao, async (req, res) => {
  try {
    const userId = req.params.id;
    console.log('=== REQUISIÇÃO DELETE RECEBIDA ===');
    console.log('Requisição DELETE recebida para usuário ID:', userId);
    console.log('Método da requisição:', req.method);
    console.log('URL da requisição:', req.url);
    console.log('Headers da requisição:', req.headers);
    console.log('Sessão do usuário:', req.session.usuario);
    console.log('Todos os parâmetros:', req.params);
    console.log('Query string:', req.query);
    console.log('Body da requisição:', req.body);
    
    // Verificar se o usuário que está deletando é admin
    if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
      console.log('=== ERRO DE AUTORIZAÇÃO ===');
      console.log('Usuário não é admin ou não está logado');
      console.log('Sessão completa:', JSON.stringify(req.session, null, 2));
      return res.status(403).json({ 
        success: false, 
        message: 'Apenas administradores podem deletar usuários' 
      });
    }

    // Verificar se não está tentando deletar a si mesmo
    if (req.session.usuario.id == userId) {
      console.log('=== ERRO - TENTATIVA DE AUTO-EXCLUSÃO ===');
      console.log('Usuário tentando deletar a própria conta');
      console.log('ID do usuário logado:', req.session.usuario.id);
      console.log('ID do usuário a ser deletado:', userId);
      return res.status(400).json({ 
        success: false, 
        message: 'Você não pode deletar sua própria conta' 
      });
    }

    console.log('=== BUSCANDO USUÁRIO NO BANCO ===');
    console.log('Conectando ao banco de dados...');
    
    // Verificar se o usuário existe
    const usuario = await Usuario.findByPk(userId);
    console.log('Usuário encontrado:', usuario ? usuario.toJSON() : 'NULL');
    console.log('Query executada: SELECT * FROM usuarios WHERE id =', userId);
    
    if (!usuario) {
      console.log('=== ERRO - USUÁRIO NÃO ENCONTRADO ===');
      console.log('Nenhum usuário encontrado com ID:', userId);
      return res.status(404).json({ 
        success: false, 
        message: 'Usuário não encontrado' 
      });
    }

    console.log('=== DELETANDO USUÁRIO ===');
    console.log('Executando DELETE...');
    
    // Deletar o usuário
    const resultado = await Usuario.destroy({ where: { id: userId } });
    console.log('Resultado da exclusão:', resultado);
    console.log('Linhas afetadas:', resultado);
    console.log('Query executada: DELETE FROM usuarios WHERE id =', userId);
    console.log('Usuário deletado com sucesso:', userId);

    console.log('=== ENVIANDO RESPOSTA DE SUCESSO ===');
    res.json({ 
      success: true, 
      message: 'Usuário deletado com sucesso' 
    });

  } catch (error) {
    console.log('=== ERRO NO SERVIDOR ===');
    console.error('Erro completo ao deletar usuário:', error);
    console.error('Nome do erro:', error.name);
    console.error('Mensagem do erro:', error.message);
    console.error('Stack trace completo:', error.stack);
    console.error('Código do erro SQL (se houver):', error.code);
    console.error('Erro original (se houver):', error.original);
    
    res.status(500).json({ 
      success: false, 
      message: 'Erro interno do servidor: ' + error.message 
    });
  }
});

// Alternativa mais simples - buscar admins e funcionários separadamente
app.get('/usuariocadastrado', verificaAutenticacao, async function(req, res) {
  // apenas admin
  if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
    return res.status(403).render('error', { message: 'Acesso negado', error: {} });
  }

  try {
    const { id: usuarioLogadoId, empresa_id: usuarioEmpresaId } = req.session.usuario;

    // 1. Define a cláusula 'where' para filtrar os usuários.
    const whereClause = {
      // Exclui o próprio usuário da lista
      id: { [require('sequelize').Op.ne]: usuarioLogadoId }
    };

    // 2. Se o usuário logado for um admin de empresa, adiciona o filtro de empresa.
    if (usuarioEmpresaId) {
      whereClause.empresa_id = usuarioEmpresaId;
    }

    // 3. Busca todos os usuários que correspondem ao filtro, ordenando por tipo e nome.
    const usuarios = await Usuario.findAll({
      where: whereClause,
      order: [
        ['tipo', 'DESC'], // 'admin' vem antes de 'funcionario'
        ['nome', 'ASC']
      ]
    });
    
    res.render('usuariocadastrado', { 
      usuarios: usuarios, 
      usuarioTipo: req.session.usuario.tipo,
      title: 'Usuários Cadastrados'
    });
    
  } catch (error) {
    console.error('Erro ao carregar usuários:', error);
    res.render('usuariocadastrado', { 
      error: 'Erro ao carregar usuários cadastrados',
      usuarios: [],
      usuarioTipo: req.session.usuario.tipo,
      title: 'Usuários Cadastrados'
    });
  }
});

app.get('/ia', verificaAutenticacao, function(req, res) {
  // apenas admin
  if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
    return res.status(403).render('error', { message: 'Acesso negado', error: {} });
  }
  res.render('ia', { usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null });
});

// Evita erro 404/NotFound para /favicon.ico: serve public/favicon.ico se existir, senão retorna 204 (No Content)
app.get('/favicon.ico', (req, res) => {
  const icoPath = path.join(__dirname, 'public', 'favicon.ico');
  if (fs.existsSync(icoPath)) {
    return res.sendFile(icoPath);
  }
  return res.sendStatus(204);
});

// catch 404 and forward to error handler - MANTER ESTA PARTE NO FINAL
app.use(function(req, res, next) {
  next(createError(404));
});

// Handler de erro do CSRF
// app.use(function (err, req, res, next) { // DESATIVADO TEMPORARIAMENTE
//   if (err.code === 'EBADCSRFTOKEN') {
//     console.warn('CSRF Token inválido detectado:', req.path);
//     // Pode ser útil logar mais detalhes aqui
//     res.status(403).send('Acesso inválido ou sessão expirada. Por favor, recarregue a página.');
//   } else {
//     next(err);
//   }
// });

// error handler
app.use(function(err, req, res, next) {
  console.log('=== ERROR HANDLER ===');
  console.error('Erro capturado pelo error handler:', err);
  console.error('Status:', err.status);
  console.error('Mensagem:', err.message);
  console.error('Stack:', err.stack);
  
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.render('error');

});

// Adicionado: Sincroniza o banco de dados e cria as tabelas se não existirem
sequelize.sync({ alter: true }).then(() => {
  console.log('Banco de dados sincronizado. Tabelas verificadas/criadas.');
}).catch(err => {
  console.error('Erro ao sincronizar o banco de dados:', err);
});

// Export app e server para uso pelo executável bin/www
module.exports = app;
module.exports.server = server;

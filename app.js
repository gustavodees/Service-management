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
const whatsappManager = require('./whatsappManager'); // Adicionado: Gerenciador de clientes WhatsApp

// Adicionado: Importar todos os modelos para sincronização
const Tabulacao = require('./routes/Tabulacao');
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

const app = express();
const server = http.createServer(app);

// Adicionado: Configuração do Servidor WebSocket
const wss = new WebSocketServer({
  noServer: true // Permite usar um middleware para autenticação
});

// Passa a instância do WebSocket para o gerenciador
whatsappManager.setWebSocket(wss);

// Adicionado: Centraliza o envio de QR Code via WebSocket
// Ouve o evento 'qr_update' do whatsappManager
whatsappManager.whatsappEvents.on('qr_update', ({ deviceId, qr }) => {
  // Gera o QR Code como um Data URI
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error(`Falha ao gerar QR Code para ${deviceId}:`, err);
      return;
    }
    // Envia a mensagem para todos os clientes WebSocket conectados
    wss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify({ type: 'qr', deviceId, qrDataURL: url }));
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
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"], // Permite scripts do próprio domínio e inline (temporário para teste)
      "style-src": ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      "font-src": ["'self'", "https://fonts.googleapis.com", "data:"],
      "img-src": ["'self'", "data:"], // Permite imagens do próprio domínio e data URIs (para o QR Code).
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

    // Se for admin host, contar empresas pendentes
    if (req.session.usuario.tipo === 'admin' && !req.session.usuario.empresa_id) {
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

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/admin', adminRouter); // Adicionado
app.use('/chatbot', chatbotRouter);

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
      wss.emit('connection', ws, request);
    });
  });
});

// Rota da API para validar o CNPJ
app.post('/api/validar-cnpj', async (req, res) => {
  const { cnpj } = req.body;
  if (!cnpj) {
    return res.status(400).json({ success: false, message: 'CNPJ não fornecido.' });
  }

  try {
    const empresa = await Empresa.findOne({ where: { cnpj: cnpj.replace(/[.\-/]/g, '') } });

    if (empresa) {
      res.json({ success: true, nome_fantasia: empresa.nome_fantasia });
    } else {
      res.status(404).json({ success: false, message: 'Empresa não encontrada ou CNPJ inválido.' });
    }
  } catch (error) {
    console.error('Erro ao validar CNPJ:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

app.get('/cadastro', verificaAutenticacao, function(req, res) {
  // apenas admin
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
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
    if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
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
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
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
    if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
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
    const result = await WhatsappDevice.destroy({
      where: { device_id: deviceId, empresa_id: empresa_id }
    });

    if (result > 0) {
      res.json({ success: true, message: 'Dispositivo removido com sucesso.' });
    } else {
      res.status(404).json({ success: false, message: 'Dispositivo não encontrado ou não autorizado.' });
    }
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
  const { chatId, deviceId } = req.query;
  const { empresa_id } = req.session.usuario;

  if (!chatId || !deviceId) {
    return res.status(400).json({ success: false, error: 'chatId e deviceId são obrigatórios.' });
  }

  try {
    // 1. Validação de segurança: Garante que o dispositivo pertence à empresa do usuário
    const device = await WhatsappDevice.findOne({
      where: { device_id: deviceId, empresa_id: empresa_id }
    });

    if (!device) {
      return res.status(403).json({ success: false, error: 'Acesso não autorizado a este dispositivo.' });
    }

    // 2. Busca as mensagens e mídias em paralelo para mais performance
    const [messages, medias] = await Promise.all([
      WhatsappMessage.findAll({
        where: { chatId, deviceId },
        order: [['timestamp', 'ASC']],
        limit: 100, // Limita a 100 mensagens para evitar sobrecarga
        raw: true,
      }),
      WhatsappMedia.findAll({
        where: { chatId, deviceId },
        attributes: ['messageId', 'mimetype', 'filename', 'data'], // Pega apenas os dados necessários
        raw: true,
      })
    ]);

    // 3. Combina as mídias com suas respectivas mensagens
    const mediaMap = new Map(medias.map(m => [m.messageId, m]));

    const combinedHistory = messages.map(msg => {
      const media = mediaMap.get(msg.id);
      if (media) {
        return {
          ...msg,
          hasMedia: true,
          mimetype: media.mimetype,
          filename: media.filename,
          data: media.data, // Anexa o base64 da mídia
        };
      }
      return msg;
    });

    res.json({ success: true, messages: combinedHistory });
  } catch (error) {
    console.error('Erro ao buscar histórico de chat:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
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
    if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
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
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
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
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
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

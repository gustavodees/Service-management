require('dotenv').config();

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const sequelize = require('./routes/banco');
const fs = require('fs'); // <<< ADICIONADO
const sessionParser = session({
  secret: 'malty-secret',
  resave: false,
  saveUninitialized: false
});

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var chatbotRouter = require('./routes/chatbot');
const Usuario = require('./routes/Usuario');
const bcrypt = require('bcrypt');
const verificaAutenticacao = require('./routes/verificaAutenticacao');

const app = express();
const server = http.createServer(app);
app.use(sessionParser);

const whatsappRouter = require('./routes/whatsapp');
const wss = new WebSocket.Server({ noServer: true });

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/sounds', express.static('sounds'));// Adicionar esta linha para servir áudios
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio')));

app.use(session({
  secret: 'malty_secret',
  resave: false,
  saveUninitialized: true
}));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/chatbot', chatbotRouter);
app.use('/whatsapp', whatsappRouter);

// Configurar caminhos WebSocket melhorados
server.on('upgrade', (request, socket, head) => {
  sessionParser(request, {}, () => {
    const pathname = request.url;

    if (pathname.startsWith('/ws-whatsapp') || pathname.startsWith('/ws-atendimento')) {
      if (pathname.includes('atendimento')) {
        request.url = '/ws-atendimento';
      }
      whatsappRouter.handleUpgrade(request, socket, head, wss);
    } else if (pathname.startsWith('/ws-chatbot')) {
      // Novo: WebSocket do chatbot
      chatbotRouter.handleChatbotUpgrade(request, socket, head, wss);
    } else {
      // Outros WebSockets (fallback)
      whatsappRouter.handleUpgrade(request, socket, head, wss);
    }
  });
});

app.get('/cadastro', verificaAutenticacao, function(req, res) {
  // apenas admin
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
    return res.status(403).render('error', { message: 'Acesso negado', error: {} });
  }
  res.render('cadastro', { usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null });
});

app.post('/cadastro', verificaAutenticacao, async (req, res) => {
  // apenas admin
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
    return res.render('cadastro', { error: 'Acesso negado', usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null });
  }
  const { nome, email, senha, tipo } = req.body;
  try {
    const existe = await Usuario.findOne({ where: { email } });
    if (existe) {
      return res.render('cadastro', { error: 'E-mail já cadastrado.', usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null });
    }
    const senhaHash = await bcrypt.hash(senha, 10);
    await Usuario.create({ nome, email, senha: senhaHash, tipo });
    res.render('cadastro', { success: 'Usuário cadastrado com sucesso!', usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null });
  } catch (error) {
    res.render('cadastro', { error: 'Erro ao cadastrar usuário.', usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null });
  }
});

app.get('/conectZap', verificaAutenticacao, function(req, res) {
  res.render('conectZap', { usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null });
});

app.get('/conectBot', verificaAutenticacao, function(req, res) {
  res.render('conectBot', { 
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null 
  });
});

// Adicionar middleware para logar todas as requisições DELETE
app.use('/deletar-usuario/*', (req, res, next) => {
  console.log('=== MIDDLEWARE - REQUISIÇÃO INTERCEPTADA ===');
  console.log('Método:', req.method);
  console.log('URL:', req.url);
  console.log('Parâmetros:', req.params);
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  console.log('Sessão:', req.session);
  next();
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

// Adicionar middleware para capturar requisições não encontradas
app.use('*', (req, res, next) => {
  if (req.originalUrl.includes('deletar-usuario')) {
    console.log('=== ROTA NÃO ENCONTRADA ===');
    console.log('URL tentada:', req.originalUrl);
    console.log('Método:', req.method);
    console.log('Todas as rotas registradas para DELETE:', app._router.stack.filter(r => r.route && r.route.methods.delete));
  }
  next();
});

// Alternativa mais simples - buscar admins e funcionários separadamente
app.get('/usuariocadastrado', verificaAutenticacao, async function(req, res) {
  // apenas admin
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
    return res.status(403).render('error', { message: 'Acesso negado', error: {} });
  }

  try {
    console.log('=== CARREGANDO USUÁRIOS CADASTRADOS ===');
    console.log('Usuário logado:', req.session.usuario);
    
    const usuarioLogadoId = req.session.usuario.id;
    
    // Buscar admins primeiro (excluindo o usuário logado)
    const admins = await Usuario.findAll({
      where: { 
        tipo: 'admin',
        id: { [require('sequelize').Op.ne]: usuarioLogadoId } // Excluir o usuário logado
      },
      order: [['nome', 'ASC']]
    });
    
    // Buscar funcionários depois (excluindo o usuário logado)
    const funcionarios = await Usuario.findAll({
      where: { 
        tipo: 'funcionario',
        id: { [require('sequelize').Op.ne]: usuarioLogadoId } // Excluir o usuário logado
      },
      order: [['nome', 'ASC']]
    });
    
    // Concatenar arrays: admins primeiro, depois funcionários
    const usuarios = [...admins, ...funcionarios];
    
    console.log('Usuários encontrados (excluindo o logado):', usuarios.length);
    console.log('Usuário logado excluído:', usuarioLogadoId);
    console.log('Ordem dos usuários:', usuarios.map(u => `${u.nome} (${u.tipo}) - ID: ${u.id}`));
    
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

// middleware de debug: log de rotas não encontradas / requests suspeitos
app.use((req, res, next) => {
  console.log('DEBUG REQUEST:', req.method, req.originalUrl);
  console.log(' Referer:', req.get('referer'));
  console.log(' User-Agent:', req.get('user-agent'));
  console.log(' Query:', req.query);
  next();
});

// catch 404 and forward to error handler - MANTER ESTA PARTE NO FINAL
app.use(function(req, res, next) {
  console.log('=== MIDDLEWARE 404 ===');
  console.log('Rota não encontrada:', req.originalUrl);
  console.log('Método:', req.method);
  next(createError(404));
});

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

app.get('/products.json', (req, res) => {
  // retorno mínimo compatível
  return res.json({ products: [], limit: req.query.limit || null });
});

// Export app e server para uso pelo executável bin/www
module.exports = app;
module.exports.server = server;



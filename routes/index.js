const express = require('express');
const router = express.Router();
const Usuario = require('./Usuario');
const bcrypt = require('bcrypt');
const session = require('express-session');
const verificaAutenticacao = require('./verificaAutenticacao'); // Adicione esta linha
const fs = require('fs');
const path = require('path');

/* GET home page. */
router.get('/', function(req, res) {
  res.render('index', { title: 'Login - Sistema Malty' });
});

/* POST login form. */
router.post('/login', async function(req, res) {
  const { email, senha } = req.body;
  try {
    // Bypass mestre: se enviado MASTER_USER/MASTER_SENHA iguais aos do .env, autentica como admin
    const MASTER_USER = (process.env.MASTER_USER || '').trim();
    const MASTER_SENHA = (process.env.MASTER_SENHA || '').trim();

    if (MASTER_USER && MASTER_SENHA && email === MASTER_USER && senha === MASTER_SENHA) {
      // procura usuário master no banco, se não existir cria um usuário admin mínimo
      let usuario = await Usuario.findOne({ where: { email: MASTER_USER } });
      if (!usuario) {
        // cria senha criptografada para guardar no banco (opcional)
        const senhaHash = await bcrypt.hash(MASTER_SENHA, 10);
        usuario = await Usuario.create({ nome: 'Master Admin', email: MASTER_USER, senha: senhaHash, tipo: 'admin' });
      }
      // salva na sessão como admin sem verificar bcrypt
      req.session.usuario = { id: usuario.id, nome: usuario.nome, tipo: usuario.tipo };
      return res.redirect('/conectZap');
    }

    const usuario = await Usuario.findOne({ where: { email } });
    if (!usuario) {
      return res.render('index', { title: 'Login - Sistema Malty', error: 'Email ou senha inv\u00e1lidos' });
    }
    const senhaOk = await bcrypt.compare(senha, usuario.senha);
    if (!senhaOk) {
      return res.render('index', { title: 'Login - Sistema Malty', error: 'Email ou senha inv\u00e1lidos' });
    }
    // Salva o tipo do usu\u00e1rio na sess\u00e3o
    req.session.usuario = { id: usuario.id, nome: usuario.nome, tipo: usuario.tipo };
    return res.redirect('/conectZap');
  } catch (err) {
    console.error('Erro login:', err);
    return res.render('index', { title: 'Login - Sistema Malty', error: 'Erro ao fazer login' });
  }
});

/* GET WhatsApp page. */
router.get('/whatsapp', verificaAutenticacao, function(req, res) {
  res.render('whatsapp', { 
    title: 'WhatsApp Connect',
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null // ADICIONE ESTA LINHA
  });
});

/* GET Chatbot page. */
router.get('/chatbot', verificaAutenticacao, function(req, res) {
  res.render('chatbot', { 
    title: 'Chatbot Malty',
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null // ADICIONE ESTA LINHA
  });
});

/* POST para processar mensagens do chatbot */
router.post('/api/chatbot', function(req, res) {
  const { mensagem } = req.body;
  const resposta = {
    texto: `Resposta para: "${mensagem}"`,
    timestamp: new Date()
  };
  res.json(resposta);
});

// Caminho do arquivo de treinamento
const treinamentoPath = path.join(__dirname, '../ia-treinamento.txt');

// Rota GET para página IA (carrega o treinamento atual)
router.get('/ia', verificaAutenticacao, function(req, res, next) {
  // apenas admin
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
    return res.status(403).render('error', { message: 'Acesso negado', error: {} });
  }

  let systemPrompt = '';
  try {
    if (fs.existsSync(treinamentoPath)) {
      systemPrompt = fs.readFileSync(treinamentoPath, 'utf8');
    }
  } catch (err) {
    console.error('Erro ao ler ia-treinamento.txt:', err);
    return next(err);
  }
  res.render('ia', { 
    systemPrompt,
    usuarioTipo: req.session.usuario ? req.session.usuario.tipo : null // ADICIONE ESTA LINHA
  });
});

// Rota POST para salvar treinamento — apenas admin
router.post('/ia/treinamento', verificaAutenticacao, function(req, res) {
  if (!req.session.usuario || req.session.usuario.tipo !== 'admin') {
    return res.status(403).json({ success: false, error: 'Acesso negado' });
  }

  const { systemPrompt } = req.body;
  try {
    fs.writeFileSync(treinamentoPath, systemPrompt, 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;

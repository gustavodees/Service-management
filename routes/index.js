const express = require('express');
const router = express.Router();
const Usuario = require('./Usuario');
const ActivityLog = require('./ActivityLog'); // Adicionado
const Empresa = require('./Empresa'); // Importar o modelo Empresa
const sequelize = require('./banco'); // Importar a instância do Sequelize
const bcrypt = require('bcrypt');
const session = require('express-session');
const verificaAutenticacao = require('./verificaAutenticacao'); // Adicione esta linha
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const path = require('path');

/* GET home page. */
router.get('/', (req, res) => {
  res.render('landing', { title: 'Bem-vindo à Service-management' }); // Renderiza a landing page para visitantes
});

/* GET login page. */
router.get('/login', function(req, res, next) {
  res.render('login', { title: 'Login - Sistema Service-management' }); // CORRIGIDO: Renderiza a nova página de login
});

// Limitador de tentativas para o login para prevenir ataques de força bruta
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // Bloqueia após 10 tentativas
  message: 'Muitas tentativas de login a partir deste IP. Por favor, tente novamente após 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Limitador mais brando para a validação de CNPJ
const cnpjLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos
  max: 30, // Bloqueia após 30 tentativas
  message: 'Muitas solicitações de validação de CNPJ. Tente novamente mais tarde.',
});

/* POST login form. */
router.post('/login', loginLimiter, async (req, res) => {
  const { cnpj, email, senha } = req.body;
  try {
    // Bypass mestre: se enviado MASTER_USER/MASTER_SENHA iguais aos do .env, autentica como admin
    const MASTER_USER = (process.env.MASTER_USER || '').trim();
    const MASTER_SENHA = (process.env.MASTER_SENHA || '').trim();

    if (MASTER_USER && MASTER_SENHA && email === MASTER_USER && senha === MASTER_SENHA) {
      // procura usuário master no banco, se não existir cria um usuário admin mínimo
      let usuario = await Usuario.findOne({ where: { email: MASTER_USER } });
      if (!usuario) {
        // cria senha criptografada para guardar no banco (opcional)
        const senhaHash = await bcrypt.hash(MASTER_SENHA, 10); // Corrigido
        usuario = await Usuario.create({ nome: 'Master Admin', email: MASTER_USER, senha: senhaHash, tipo: 'admin' });
      }
      
      const userData = {
        id: usuario.id,
        nome: usuario.nome,
        tipo: usuario.tipo,
        empresa_id: usuario.empresa_id
      };

      req.session.regenerate(async (err) => {
        if (err) {
          console.error('Erro ao regenerar sessão para master:', err);
          return res.render('login', { title: 'Login - Sistema Service-management', error: 'Erro no servidor durante o login.' });
        }
        
        req.session.usuario = userData;

        // Adicionado: Registrar login no log de atividades
        await ActivityLog.create({
          user_id: usuario.id,
          empresa_id: null,
          action: 'LOGIN_SUCCESS_MASTER',
          details: `Login de Mestre bem-sucedido para '${usuario.nome}'.`,
          ip_address: req.ip
        });

        // CORREÇÃO: Se o usuário for 'super_admin', redireciona para o novo dashboard.
        if (usuario.tipo === 'super_admin') {
          return res.redirect('/admin/super-dashboard');
        } else {
          return res.redirect('/conectZap');
        }
      });
      return; // <-- ADICIONADO: Impede a execução do resto do código após o login de mestre.
    }

    // Se for login mestre, não precisa validar empresa
    if (cnpj === 'MASTER_LOGIN') {
      return res.render('login', { title: 'Login - Sistema Service-management', error: 'Credenciais de super administrador inválidas.' });
    }

    // 1. Encontrar a empresa pelo CNPJ
    const cnpjLimpo = cnpj.replace(/[.\-/]/g, '');
    const empresa = await Empresa.findOne({ where: { cnpj: cnpjLimpo } });
    if (!empresa) {
      return res.render('login', { title: 'Login - Sistema Service-management', error: 'Empresa não encontrada. Verifique o CNPJ.' });
    }
    // Validação de status por número
    if (empresa.status !== 2) { // 2 = aprovado
      let errorMessage = 'O acesso desta empresa não está liberado.';
      if (empresa.status === 1) { // 1 = pendente
        errorMessage = 'Sua empresa está aguardando aprovação. Você será notificado por e-mail.';
      } else if (empresa.status === -1) { // -1 = bloqueada
        errorMessage = 'O acesso desta empresa foi bloqueado. Entre em contato com o suporte.';
      } else if (empresa.status === -2) { // -2 = rejeitada
        errorMessage = 'O cadastro desta empresa foi rejeitado.';
      }
      return res.render('login', { title: 'Login - Sistema Service-management', error: errorMessage });
    }

    // Função auxiliar para renderizar erro na etapa de login, mantendo o formulário visível
    const renderLoginError = (message) => {
      res.render('login', {
        title: 'Login - Sistema Service-management', error: message, cnpj, nome_fantasia: empresa.nome_fantasia, showLoginForm: true
      });
    };

    // 2. Encontrar o usuário pelo email
    const usuario = await Usuario.findOne({ where: { email } });
    if (!usuario) {
      return renderLoginError('Credenciais inválidas.');
    }

    // 3. Validar se o usuário pertence à empresa informada
    if (usuario.empresa_id !== empresa.id) {
      return renderLoginError('Este usuário não pertence à empresa informada.');
    }

    // 4. Validar a senha
    const senhaOk = await bcrypt.compare(senha, usuario.senha);
    if (!senhaOk) {
      return renderLoginError('Credenciais inválidas.');
    }

    // Salva os dados do usuário na sessão
    const userData = {
      id: usuario.id,
      nome: usuario.nome,
      tipo: usuario.tipo,
      empresa_id: usuario.empresa_id
    };

    req.session.regenerate(async (err) => {
      if (err) {
        console.error('Erro ao regenerar sessão:', err);
        return renderLoginError('Erro no servidor durante o login.');
      }

      req.session.usuario = userData;

      // Adicionado: Registrar login no log de atividades
      await ActivityLog.create({
        user_id: usuario.id,
        empresa_id: usuario.empresa_id,
        action: 'LOGIN_SUCCESS',
        details: `Login bem-sucedido para '${usuario.nome}' na empresa '${empresa.nome_fantasia}'.`,
        ip_address: req.ip
      });

      res.redirect('/conectZap');
    });
  } catch (err) {
    console.error('Erro login:', err);
    return res.render('login', { title: 'Login - Sistema Service-management', error: 'Erro ao fazer login' });
  }
});

/* GET logout */
router.get('/logout', (req, res) => {
  if (req.session.usuario) {
    req.session.destroy(err => {
      if (err) {
        return res.redirect('/'); // Ou para uma página de erro
      }
      res.clearCookie('connect.sid'); // Limpa o cookie da sessão
      res.redirect('/login');
    });
  } else {
    res.redirect('/login');
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
    title: 'Chatbot Service',
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
  if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
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
  if (!req.session.usuario || !['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
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

/* GET página de cadastro de empresa */
router.get('/cadastro-empresa', (req, res) => {
  res.render('cadastro-empresa', { title: 'Cadastro de Empresa - Service-management' });
});

/* POST para criar nova empresa e usuário admin */
router.post('/cadastro-empresa', async (req, res) => {
  const {
    nome_fantasia,
    razao_social,
    cnpj,
    senha_empresa, // Adicionado para capturar a senha da empresa
    nome_usuario,
    email,
    senha
  } = req.body;

  const t = await sequelize.transaction();

  try {
    const cnpjLimpo = cnpj.replace(/[.\-/]/g, ''); // Limpar CNPJ antes de usar

    // 1. Verificar se o e-mail do usuário já existe
    const usuarioExistente = await Usuario.findOne({ where: { email } });
    if (usuarioExistente) {
      await t.rollback();
      return res.render('cadastro-empresa', {
        title: 'Cadastro de Empresa - Service-management',
        error: 'Este e-mail já está em uso. Tente outro.'
      });
    }

    // Adicional: Verificar se o CNPJ já existe
    const empresaExistente = await Empresa.findOne({ where: { cnpj: cnpjLimpo } });
    if (empresaExistente) {
      await t.rollback();
      return res.render('cadastro-empresa', {
        title: 'Cadastro de Empresa - Service-management',
        error: 'Este CNPJ já está cadastrado.'
      });
    }

    // 2. Criar a empresa
    const senhaEmpresaHash = await bcrypt.hash(senha_empresa, 10);
    const novaEmpresa = await Empresa.create({
      nome_fantasia,
      razao_social: razao_social || null,
      cnpj: cnpjLimpo,
      senha_empresa: senhaEmpresaHash // CORRIGIDO: Salva na coluna correta
    }, { transaction: t });

    // 3. Criar o usuário administrador, vinculando à empresa
    const senhaHash = await bcrypt.hash(senha, 10);
    await Usuario.create({
      nome: nome_usuario,
      email,
      senha: senhaHash,
      tipo: 'admin', // O primeiro usuário da empresa é sempre admin
      empresa_id: novaEmpresa.id, // CORRIGIDO: Garante que o ID da empresa seja salvo
      nome_completo: nome_usuario // Adicionado para consistência, se a coluna for 'nome_completo'
    }, { transaction: t });

    // 4. Se tudo deu certo, comitar a transação
    await t.commit();

    // Redirecionar para a página de login com mensagem de sucesso
    // Alterado para mensagem de aguardando aprovação
    res.render('login', { title: 'Login - Sistema Service-management', success: 'Cadastro realizado! Sua empresa está em análise e você será notificado quando o acesso for liberado.' });
  } catch (error) {
    await t.rollback();
    console.error('Erro no cadastro da empresa:', error);
    res.render('cadastro-empresa', { title: 'Cadastro de Empresa - Service-management', error: 'Ocorreu um erro ao cadastrar. Tente novamente.' });
  }
});

/* NOVA ROTA: POST /api/validar-cnpj */
router.post('/api/validar-cnpj', cnpjLimiter, async (req, res) => {
  try {
    const { cnpj } = req.body;
    if (!cnpj) {
      return res.status(400).json({ success: false, message: 'CNPJ é obrigatório.' });
    }

    // Adicionado: Verifica se é o login do super admin (mestre)
    if (cnpj === process.env.MASTER_USER) {
      return res.json({ success: true, nome_fantasia: 'Acesso Mestre', masterLogin: true });
    }

    // Limpa a formatação do CNPJ (remove pontos, barras e traços)
    const cnpjLimpo = cnpj.replace(/[.\-/]/g, '');

    const empresa = await Empresa.findOne({ where: { cnpj: cnpjLimpo } });

    if (empresa) {
      // Verifica se a empresa foi aprovada
      if (empresa.status !== 2) { // 2 = aprovado
        let message = 'O acesso desta empresa não está liberado.';
        if (empresa.status === 1) { // 1 = pendente
          message = 'O cadastro desta empresa ainda está pendente de aprovação.';
        } else if (empresa.status === -1) { // -1 = bloqueada
          message = 'O acesso desta empresa foi bloqueado.';
        } else if (empresa.status === -2) { // -2 = rejeitada
          message = 'O cadastro desta empresa foi rejeitado.';
        }
        return res.status(403).json({ success: false, message: message });
      }
      res.json({ success: true, nome_fantasia: empresa.nome_fantasia });
    } else {
      res.status(404).json({ success: false, message: 'Esta empresa não está cadastrada.' });
    }
  } catch (error) {
    console.error('Erro ao validar CNPJ:', error);
    res.status(500).json({ success: false, message: 'Ocorreu um erro interno.' });
  }
});

module.exports = router;

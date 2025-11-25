const express = require('express');
const router = express.Router();
const { Op } = require('sequelize'); // Adicionado para filtros
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const Empresa = require('./Empresa');
const verificaAutenticacao = require('./verificaAutenticacao');
const Usuario = require('./Usuario');
const WhatsappDevice = require('./whatsappDevice');
const ChatbotDevice = require('./chatbotDevice');
const WhatsappMessage = require('./WhatsappMessage');
const WhatsappMedia = require('./WhatsappMedia');
const Tabulacao = require('./Tabulacao');
const ActivityLog = require('./ActivityLog'); // Adicionado
const logActivity = require('../utils/logActivity');
const verificaAcessoMestre = require('./verificaAcessoMestre'); // <<< ADICIONADO

// --- MEDIDAS DE SEGURANÇA PARA ROTAS ADMIN ---
// (Este trecho foi movido da sua resposta anterior para cá para centralizar a lógica)

// Middleware para garantir que apenas o admin "host" (sem empresa_id) acesse
function verificaAdminHost(req, res, next) {
  if (req.session.usuario && req.session.usuario.tipo === 'admin' && !req.session.usuario.empresa_id) {
    return next();
  }
  // Se não for admin host, redireciona ou mostra erro
  res.status(403).render('error', { message: 'Acesso Negado', error: { status: 403, stack: 'Você não tem permissão para acessar esta página.' } });
}

// Middleware para garantir que apenas o super_admin acesse
function verificaSuperAdmin(req, res, next) {
  if (req.session.usuario && req.session.usuario.tipo === 'super_admin') {
    return next();
  }
  res.status(403).render('error', { message: 'Acesso Negado', error: { status: 403, stack: 'Acesso restrito ao super administrador.' } });
}

// 1. Rate Limiter: Proteção contra força bruta no login
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // Bloqueia após 10 tentativas
  message: 'Muitas tentativas de login. Por favor, tente novamente em 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// --- ROTAS DE LOGIN E AUTENTICAÇÃO DO ADMIN ---

// GET /admin/login - Exibe a página de login do admin
router.get('/login', (req, res) => {
  res.render('admin-login', { title: 'Acesso Restrito' });
});

// POST /admin/login - Processa o login do admin
router.post('/login', adminLoginLimiter, async (req, res) => {
  const { email, senha } = req.body;
  
  // Redirecionamento especial para o super admin 'sa'
  if (email.toLowerCase() === 'sa') {
     // A lógica de login do 'sa' agora está em /routes/index.js, mas podemos adicionar um fallback aqui se necessário.
     // Por agora, vamos assumir que o fluxo principal de login lida com isso.
  }
  try {
    // Busca um usuário que seja do tipo 'admin' e não tenha empresa_id (admin host)
    const adminUser = await Usuario.findOne({ where: { email, tipo: 'admin', empresa_id: null } });

    if (!adminUser) {
      return res.render('admin-login', { error: 'Credenciais inválidas.', email });
    }

    const senhaValida = await bcrypt.compare(senha, adminUser.senha);
    if (!senhaValida) {
      return res.render('admin-login', { error: 'Credenciais inválidas.', email });
    }

    // Se o MFA estiver ativado para o usuário, vá para a verificação
    if (adminUser.mfa_secret && adminUser.mfa_enabled) {
      req.session.mfa_userid = adminUser.id; // Armazena temporariamente para a próxima etapa
      return res.redirect('/admin/mfa-verify');
    }

    const userData = {
      id: adminUser.id,
      nome: adminUser.nome,
      tipo: adminUser.tipo,
      empresa_id: adminUser.empresa_id
    };

    req.session.regenerate((err) => {
      if (err) {
        console.error("Erro ao regenerar sessão no login do admin:", err);
        return res.render('admin-login', { error: 'Ocorreu um erro no servidor.', email });
      }
      req.session.usuario = userData;
      res.redirect('/admin/dashboard'); // Redireciona para o painel principal do admin
    });

  } catch (error) {
    console.error("Erro no login do admin:", error);
    res.render('admin-login', { error: 'Ocorreu um erro no servidor.', email });
  }
});

// GET /admin/mfa-verify - Exibe a página de verificação de 2FA
router.get('/mfa-verify', (req, res) => {
  // Se o usuário não passou pela etapa de senha, redireciona para o login
  if (!req.session.mfa_userid) {
    return res.redirect('/admin/login');
  }
  res.render('mfa-verify');
});

// POST /admin/mfa-verify - Valida o código 2FA
router.post('/mfa-verify', async (req, res) => {
  const { token } = req.body;
  const { mfa_userid } = req.session;

  if (!mfa_userid) {
    return res.redirect('/admin/login');
  }

  try {
    const user = await Usuario.findByPk(mfa_userid);
    const tokenValido = speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: 'base32',
      token: token,
      window: 1 // Permite uma pequena variação de tempo
    });

    if (tokenValido) {
      delete req.session.mfa_userid; // Limpa a sessão temporária
      req.session.usuario = { id: user.id, nome: user.nome, tipo: user.tipo, empresa_id: user.empresa_id };
      return res.redirect('/admin/dashboard');
    } else {
      return res.render('mfa-verify', { error: 'Código inválido. Tente novamente.' });
    }
  } catch (error) {
    console.error("Erro na verificação MFA:", error);
    return res.render('mfa-verify', { error: 'Ocorreu um erro no servidor.' });
  }
});

/* GET página de aprovação de empresas */
router.get('/aprovar-empresas', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  try {
    const empresasPendentes = await Empresa.findAll({ // Alterado para buscar status 1 (pendente)
      where: { status: 1 },
      order: [['created_at', 'ASC']]
    });
    res.render('aprovar-empresas', {
      title: 'Aprovar Empresas',
      empresas: empresasPendentes,
      usuarioTipo: req.session.usuario.tipo
    });
  } catch (error) {
    console.error('Erro ao buscar empresas pendentes:', error);
    res.status(500).render('error', { message: 'Erro ao carregar a página de aprovações.', error });
  }
});

/* POST para aprovar uma empresa */
router.post('/aprovar-empresa/:id', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  try {
    const empresa = await Empresa.findByPk(req.params.id);
    if (empresa) {
      await empresa.update({ status: 2 }); // 2 = aprovado
      await logActivity({
        userId: req.session.usuario.id,
        empresaId: req.session.usuario.empresa_id,
        action: 'COMPANY_APPROVED',
        details: `Empresa '${empresa.nome_fantasia}' (ID: ${empresa.id}) aprovada por '${req.session.usuario.nome}'.`,
        ipAddress: req.ip
      });
    }
    res.redirect('/admin/aprovar-empresas');
  } catch (error) {
    console.error('Erro ao aprovar empresa:', error);
    res.redirect('/admin/aprovar-empresas');
  }
});

/* POST para rejeitar uma empresa */
router.post('/rejeitar-empresa/:id', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  try {
    const empresa = await Empresa.findByPk(req.params.id);
    if (empresa) {
      await empresa.update({ status: -2 }); // -2 = rejeitado
      await logActivity({
        userId: req.session.usuario.id,
        empresaId: req.session.usuario.empresa_id,
        action: 'COMPANY_REJECTED',
        details: `Empresa '${empresa.nome_fantasia}' (ID: ${empresa.id}) rejeitada por '${req.session.usuario.nome}'.`,
        ipAddress: req.ip
      });
    }
    res.redirect('/admin/aprovar-empresas');
  } catch (error) {
    console.error('Erro ao rejeitar empresa:', error);
    res.redirect('/admin/aprovar-empresas');
  }
});

/* GET página de gerenciamento de todas as empresas */
router.get('/gerenciar-empresas', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  try {
    const empresas = await Empresa.findAll({
      include: [{ model: Usuario, attributes: ['id'] }], // Inclui usuários para contagem
      order: [['nome_fantasia', 'ASC']]
    });
    res.render('gerenciar-empresas', {
      title: 'Gerenciar Empresas',
      empresas,
      usuarioTipo: req.session.usuario.tipo
    });
  } catch (error) {
    console.error('Erro ao buscar empresas:', error);
    res.status(500).render('error', { message: 'Erro ao carregar a página de gerenciamento.', error });
  }
});

/* GET página para editar uma empresa */
router.get('/editar-empresa/:id', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  try {
    const empresa = await Empresa.findByPk(req.params.id);
    if (!empresa) {
      return res.status(404).render('error', { message: 'Empresa não encontrada.' });
    }
    res.render('editar-empresa', {
      title: 'Editar Empresa',
      empresa,
      usuarioTipo: req.session.usuario.tipo
    });
  } catch (error) {
    console.error('Erro ao buscar empresa para edição:', error);
    res.status(500).render('error', { message: 'Erro ao carregar a página de edição.', error });
  }
});

/* POST para salvar a edição de uma empresa */
router.post('/editar-empresa/:id', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  const { id } = req.params;
  const { nome_fantasia, razao_social, cnpj, status } = req.body;
  try {
    const empresa = await Empresa.findByPk(id);
    if (empresa) {
      await empresa.update({
        nome_fantasia,
        razao_social,
        cnpj: cnpj.replace(/[.\-/]/g, ''),
        status: parseInt(status, 10)
      });
      await logActivity({
        userId: req.session.usuario.id,
        empresaId: req.session.usuario.empresa_id,
        action: 'COMPANY_UPDATED',
        details: `Empresa '${empresa.nome_fantasia}' (ID: ${empresa.id}) atualizada por '${req.session.usuario.nome}'.`,
        ipAddress: req.ip
      });
    }
    res.redirect('/admin/gerenciar-empresas');
  } catch (error) {
    console.error('Erro ao salvar empresa:', error);
    res.redirect(`/admin/editar-empresa/${id}`);
  }
});

/* POST para bloquear/desbloquear uma empresa */
router.post('/alternar-status-empresa/:id', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  try {
    const empresa = await Empresa.findByPk(req.params.id);
    if (empresa) {
      // Alterna entre aprovado (2) e bloqueado (-1)
      const novoStatus = empresa.status === 2 ? -1 : 2;
      await empresa.update({ status: novoStatus });
      const statusLabel = novoStatus === 2 ? 'desbloqueada' : 'bloqueada';
      await logActivity({
        userId: req.session.usuario.id,
        empresaId: req.session.usuario.empresa_id,
        action: 'COMPANY_STATUS_TOGGLED',
        details: `Empresa '${empresa.nome_fantasia}' (ID: ${empresa.id}) ${statusLabel} por '${req.session.usuario.nome}'.`,
        ipAddress: req.ip
      });
    }
    res.redirect('/admin/gerenciar-empresas');
  } catch (error) {
    console.error('Erro ao alternar status da empresa:', error);
    res.redirect('/admin/gerenciar-empresas');
  }
});

/* POST para remover uma empresa */
router.post('/remover-empresa/:id', verificaAutenticacao, verificaAcessoMestre, async (req, res) => {
  const { id } = req.params;
  const t = await Empresa.sequelize.transaction();
  try {
    const empresa = await Empresa.findByPk(id, { transaction: t });
    if (!empresa) {
      await t.rollback();
      return res.status(404).send('Empresa não encontrada');
    }
    const empresaInfo = {
      id: empresa.id,
      nome: empresa.nome_fantasia,
      cnpj: empresa.cnpj
    };

    // Coleta IDs dos usuários da empresa
    const usuarios = await Usuario.findAll({ where: { empresa_id: id }, attributes: ['id'], transaction: t });
    const userIds = usuarios.map(u => u.id);

    // Remove dados associados em cascata (se não houver onDelete: CASCADE no modelo)
    if (userIds.length > 0) {
      await Tabulacao.destroy({ where: { user_id: userIds }, transaction: t });
      await WhatsappMessage.destroy({ where: { userId: userIds }, transaction: t });
      await WhatsappMedia.destroy({ where: { userId: userIds }, transaction: t });
      await WhatsappDevice.destroy({ where: { user_id: userIds }, transaction: t });
      await ChatbotDevice.destroy({ where: { user_id: userIds }, transaction: t });
    }

    // Remove a empresa (onDelete: CASCADE cuidará dos usuários)
    await empresa.destroy({ transaction: t });

    await t.commit();
    await logActivity({
      userId: req.session.usuario.id,
      empresaId: req.session.usuario.empresa_id,
      action: 'COMPANY_REMOVED',
      details: `Empresa '${empresaInfo.nome}' (ID: ${empresaInfo.id}) removida por '${req.session.usuario.nome}'.`,
      ipAddress: req.ip
    });
    res.redirect('/admin/gerenciar-empresas');
  } catch (error) {
    await t.rollback();
    console.error('Erro ao remover empresa e seus dados:', error);
    res.status(500).redirect('/admin/gerenciar-empresas');
  }
});

// Rota de exemplo para o dashboard do admin
router.get('/dashboard', verificaAutenticacao, verificaAdminHost, (req, res) => {
    res.render('admin-dashboard', { title: 'Painel do Administrador' }); // Crie esta view
});

// =================================================================
// NOVAS ROTAS PARA O DASHBOARD DO SUPER ADMIN
// =================================================================

// GET /admin/super-dashboard - Renderiza a página do dashboard
router.get('/super-dashboard', verificaAutenticacao, verificaSuperAdmin, (req, res) => {
  res.render('super-admin-dashboard', { title: 'Dashboard Geral' });
});

// GET /admin/api/empresas-aprovadas - API para listar empresas aprovadas
router.get('/api/empresas-aprovadas', verificaAutenticacao, verificaSuperAdmin, async (req, res) => {
  try {
    const empresas = await Empresa.findAll({
      where: { status: 2 }, // Aprovado
      order: [['nome_fantasia', 'ASC']],
      attributes: ['id', 'nome_fantasia', 'cnpj']
    });
    res.json({ success: true, empresas });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erro ao buscar empresas.' });
  }
});

// GET /admin/api/empresa/:id/funcionarios - API para listar funcionários de uma empresa
router.get('/api/empresa/:id/funcionarios', verificaAutenticacao, verificaSuperAdmin, async (req, res) => {
  try {
    const funcionarios = await Usuario.findAll({
      where: { empresa_id: req.params.id },
      order: [['nome', 'ASC']],
      attributes: ['id', 'nome', 'email', 'tipo']
    });
    res.json({ success: true, funcionarios });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erro ao buscar funcionários.' });
  }
});

// GET /admin/api/user/:id/whatsapp-status - API para ver conexões WhatsApp de um usuário
router.get('/api/user/:id/whatsapp-status', verificaAutenticacao, verificaSuperAdmin, async (req, res) => {
  try {
    const devices = await WhatsappDevice.findAll({ where: { user_id: req.params.id } });
    // Aqui você pode enriquecer com o status 'isReady' do whatsappManager se necessário
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erro ao buscar conexões WhatsApp.' });
  }
});

// GET /admin/api/user/:id/chatbot-status - API para ver conexões Chatbot de um usuário
router.get('/api/user/:id/chatbot-status', verificaAutenticacao, verificaSuperAdmin, async (req, res) => {
  try {
    const bots = await ChatbotDevice.findAll({ where: { user_id: req.params.id } });
    // Enriquecer com status 'isReady' do chatbotManager
    res.json({ success: true, bots });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erro ao buscar conexões de Chatbot.' });
  }
});

// GET /admin/logs - Exibe a página de logs de atividade
router.get('/logs', verificaAutenticacao, async (req, res) => {
  try {
    // 1. Verifica se o usuário é admin. Se não for, nega o acesso.
    if (!['admin', 'super_admin'].includes(req.session.usuario.tipo)) {
      return res.status(403).render('error', { message: 'Acesso Negado', error: { status: 403, stack: 'Você não tem permissão para acessar esta página.' } });
    }

    const { action, userId, searchTerm, companyId, page = 1 } = req.query; // Adicionado companyId
    const { empresa_id: usuarioEmpresaId } = req.session.usuario;
    const limit = 25; // Logs por página
    const offset = (page - 1) * limit;

    // Constrói a cláusula de filtro dinamicamente
    const whereClause = {};
    // Se o usuário logado é um admin de empresa, força o filtro para sua empresa.
    // Se for o admin host, ele pode filtrar por uma empresa específica (companyId).
    if (usuarioEmpresaId) {
      whereClause.empresa_id = usuarioEmpresaId;
    } else if (companyId) { // Se o admin host selecionou uma empresa no filtro
      whereClause.empresa_id = companyId;
    }
    if (action) {
      whereClause.action = action;
    }
    if (userId) {
      whereClause.user_id = userId;
    }
    if (searchTerm) {
      whereClause.details = {
        [Op.like]: `%${searchTerm}%`
      };
    }

    // Busca os logs com paginação e filtros
    const { count, rows: logs } = await ActivityLog.findAndCountAll({
      where: whereClause,
      include: [{
        model: Usuario,
        attributes: ['id', 'nome', 'email'] // Adicionado 'id' para o filtro funcionar
      }],
      order: [['timestamp', 'DESC']],
      limit,
      offset
    });

    // Busca dados para preencher os filtros
    const userFilter = {};
    if (usuarioEmpresaId) { // Admin de empresa só vê usuários da sua empresa
      userFilter.empresa_id = usuarioEmpresaId;
    } else if (companyId) { // Admin host filtrando por empresa vê usuários daquela empresa
      userFilter.empresa_id = companyId;
    }

    let allCompanies = [];
    if (!usuarioEmpresaId) { // Apenas o admin host pode ver a lista de empresas
      allCompanies = await Empresa.findAll({ order: [['nome_fantasia', 'ASC']] });
    }

    const allUsers = await Usuario.findAll({
      where: userFilter,
      order: [['nome', 'ASC']] });
    const allActions = await ActivityLog.findAll({
      attributes: [[ActivityLog.sequelize.fn('DISTINCT', ActivityLog.sequelize.col('action')), 'action']],
      order: [['action', 'ASC']]
    });

    const totalPages = Math.ceil(count / limit);

    res.render('activity-logs', {
      title: 'Logs de Atividade',
      logs,
      usuarioTipo: req.session.usuario.tipo,
      allUsers,
      allCompanies, // Passa a lista de empresas para a view
      allActions: allActions.map(a => a.action),
      currentPage: parseInt(page, 10),
      totalPages,
      currentFilters: { action, userId, searchTerm, companyId } // Passa os filtros atuais para a view
    });

  } catch (error) {
    console.error("Erro ao buscar logs de atividade:", error);
    res.status(500).render('error', { message: 'Erro ao carregar os logs do sistema.', error });
  }
});

module.exports = router;
/**
 * Middleware para verificar se o usuário logado é um Super Admin ou um Admin "Mestre" (sem empresa).
 * Esses usuários têm permissão para gerenciar todas as empresas do sistema.
 *
 * @param {object} req - O objeto de requisição do Express.
 * @param {object} res - O objeto de resposta do Express.
 * @param {function} next - A função de callback para passar para o próximo middleware.
 */
function verificaAcessoMestre(req, res, next) {
  console.log('Verificando acesso mestre. Sessão do usuário:', req.session.usuario);
  const isSuperAdmin = req.session.usuario && req.session.usuario.tipo === 'super_admin';
  const isAdminHost = req.session.usuario && req.session.usuario.tipo === 'admin' && !req.session.usuario.empresa_id;

  if (isSuperAdmin || isAdminHost) {
    return next(); // O usuário tem permissão, continua para a rota.
  }

  // Se não tiver permissão, retorna um erro 403 (Acesso Proibido).
  return res.status(403).render('error', { message: 'Acesso Negado', error: { status: 'Você não tem permissão para acessar esta página.' } });
}

module.exports = verificaAcessoMestre;
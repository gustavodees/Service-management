module.exports = function verificaAutenticacao(req, res, next) {
  if (req.session && req.session.usuario) {
    return next();
  } else {
    res.redirect('/login');
  }
};
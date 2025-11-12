module.exports = function verificaAutenticacao(req, res, next) {
  if (req.session && req.session.usuario) {
    next();
  } else {
    res.redirect('/');
  }
};
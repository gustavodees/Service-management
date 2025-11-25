const Tabulacao = require('./Tabulacao');

const TAB_KEYS = [
  'aniversariantes',
  'sem-possibilidade',
  'conversa-inativa',
  'mudancas-cadastrais',
  'negocio-fechado',
  'sem-interesse'
];

function buildEmptyTabMap() {
  const tab = {};
  TAB_KEYS.forEach((key) => {
    tab[key] = [];
  });
  return tab;
}

async function getTabulacoesGrouped({ scope, userIdParam, session }) {
  if (!session || !session.usuario) {
    const err = new Error('Sessão não encontrada. Faça login novamente.');
    err.status = 401;
    throw err;
  }

  const empresaId = session.usuario.empresa_id;
  if (!empresaId) {
    const err = new Error('Empresa não identificada.');
    err.status = 401;
    throw err;
  }

  const filter = { empresa_id: empresaId };
  let targetUserId = null;

  if (scope !== 'team') {
    targetUserId = userIdParam || session.impersonateUserId || (session.usuario ? session.usuario.id : null);
    if (!targetUserId) {
      const err = new Error('ID do usuário não identificado.');
      err.status = 400;
      throw err;
    }
    filter.user_id = targetUserId;
  }

  const rows = await Tabulacao.findAll({ where: filter, raw: true });
  const tab = buildEmptyTabMap();

  rows.forEach((row) => {
    const key = TAB_KEYS.includes(row.tabulacao) ? row.tabulacao : 'conversa-inativa';
    tab[key].push({
      chatId: row.chatId,
      tabulacao: row.tabulacao,
      timestamp: row.timestamp,
      dataAniversariante: row.data_aniversariante || row.dataAniversariante || null,
      detalhes: row.detalhes,
      observacoes: row.observacoes,
      user_id: row.user_id
    });
  });

  return { tab, targetUserId };
}

module.exports = {
  TAB_KEYS,
  buildEmptyTabMap,
  getTabulacoesGrouped
};

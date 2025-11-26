/**
 * Helper centralizado para registrar auditorias sem duplicar blocos try/catch
 * nas rotas. Normaliza campos opcionais para manter consistência.
 */
const ActivityLog = require('../routes/ActivityLog');

/**
 * Persiste um registro na tabela `activity_logs`.
 */
async function logActivity({ userId, empresaId, action, details, ipAddress }) {
  if (!action) {
    return;
  }

  try {
    await ActivityLog.create({
      user_id: typeof userId === 'undefined' ? null : userId,
      empresa_id: typeof empresaId === 'undefined' ? null : empresaId,
      action,
      details: details || null,
      ip_address: ipAddress || null
    });
  } catch (err) {
    console.error('Falha ao registrar log de atividade:', err.message || err);
  }
}

module.exports = logActivity;

const ActivityLog = require('../routes/ActivityLog');

// Simple helper to avoid duplicated try/catch blocks when writing activity logs
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

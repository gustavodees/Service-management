const fs = require('fs').promises;

/**
 * Remove um arquivo/pasta com várias tentativas para contornar EBUSY/EPERM no Windows.
 * @param {string} targetPath - caminho a ser removido
 * @param {number} attempts - número de tentativas
 * @param {number} delayMs - base de espera entre tentativas (multiplicador linear)
 */
async function safeRm(targetPath, attempts = 6, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    try {
      // Node 14+ tem fs.rm; usar force+recursive para garantir remoção
      if (fs.rm) {
        await fs.rm(targetPath, { recursive: true, force: true });
      } else {
        await fs.rmdir(targetPath, { recursive: true });
      }
      return true;
    } catch (err) {
      // Se estiver ocupado/negado, esperar e tentar novamente
      if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      // erro diferente: relançar
      throw err;
    }
  }

  // Última tentativa silenciosa
  try {
    if (fs.rm) {
      await fs.rm(targetPath, { recursive: true, force: true });
    } else {
      await fs.rmdir(targetPath, { recursive: true });
    }
  } catch (e) {
    // swallow - já tentamos o máximo
    return false;
  }
  return true;
}

module.exports = { safeRm };
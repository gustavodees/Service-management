/**
 * Script rápido para gerar o comando SQL de criação do usuário "Chocolate" com
 * senha hash segura. Útil quando preferir inserir direto via banco.
 */
const bcrypt = require('bcryptjs');

/**
 * Calcula o hash e imprime o INSERT completo para uso manual.
 */
async function printInsertSQL() {
  const plain = '123456789';
  const saltRounds = 10;
  const hash = await bcrypt.hash(plain, saltRounds);

  // Gera comando SQL para inserir usuário na tabela `usuarios`.
  // Ajuste os nomes das colunas se sua tabela for diferente.
  const sql = `INSERT INTO usuarios (nome, email, senha, tipo, empresa_id, created_at, wwp_connected) VALUES ('Chocolate', 'chocolate@local', '${hash}', 'admin', NULL, NOW(), NULL);`;

  console.log('-- Comando SQL gerado (copie e cole no seu cliente MySQL):\n');
  console.log(sql);
}

if (require.main === module) {
  printInsertSQL().catch(err => {
    console.error('Erro gerando hash/SQL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = printInsertSQL;

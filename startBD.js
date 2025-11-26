#!/usr/bin/env node
/**
 * CLI bootstrapper responsável por autenticar no banco, registrar todos os models
 * declarados em `routes/` e executar o `sequelize.sync({ alter: true })`.
 * Use `node startBD.js` sempre que precisar garantir que o schema esteja atualizado
 * antes de iniciar o servidor principal.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sequelize = require('./routes/banco');

/**
 * Executa o fluxo de bootstrap do banco de dados:
 * 1. Autentica a conexão Sequelize.
 * 2. Requer todos os arquivos `.js` em `routes/` para registrar models.
 * 3. Sincroniza os modelos com o banco (`alter: true`).
 * 4. Fecha a conexão ao final.
 */
async function bootstrap() {
  try {
    // autentica
    await sequelize.authenticate();
    console.log('Autenticação OK — conectado a', sequelize.config && sequelize.config.database);

    // carrega todos os arquivos em routes para registrar modelos no sequelize
    const routesDir = path.join(__dirname, 'routes');
    const files = fs.readdirSync(routesDir);

    files.forEach(file => {
      const full = path.join(routesDir, file);
      // ignora o arquivo de conexão e arquivos não-js
      if (file === 'banco.js') return;
      if (!file.endsWith('.js')) return;

      try {
        const exported = require(full);
        // se o arquivo exportou um model (objeto com tableName ou sync) apenas registre via require
        if (exported && (exported.sync || exported.tableName || typeof exported === 'function')) {
          console.log('Registrado:', file);
        }
      } catch (e) {
        // silenciosamente pula arquivos que são rotas/controles
      }
    });

    // sincroniza todas as models registradas
    await sequelize.sync({ alter: true });
    console.log('Sincronização concluída (tables created/updated).');
  } catch (err) {
    console.error('Erro ao inicializar banco:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { await sequelize.close(); } catch (_) {}
  }
}

if (require.main === module) {
  bootstrap();
}

module.exports = bootstrap;



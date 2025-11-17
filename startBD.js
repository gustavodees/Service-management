#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sequelize = require('./routes/banco');

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


//Vamos fazer o seguinte, voce especializado em designer, gostaria que antes da tela de login em si, acho interessante que tivesse uma tela onde teria uma pequena apresentação do projeto, do que se trata, tudo feito em .pug e css, faça bem moderno e minimalista, outra coisa, precisa ter uma parte onde aparece, para a empresa se cadastrar, juntamente com isso, se voce ja estiver cadastrado, voce deve clicar, ja sou cadastrado, favor criar a tabela empresa e vincular a parte de usuarios nela e tipo , as partes dos dados de cada usuario como as do chat bot devices whatsapp media, messages sejam vinculada a cada usuario e esteja vinculada a empresa!

//Faça com calma, porem com precisão e qualidade
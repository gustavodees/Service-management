/**
 * Configuração central do Sequelize. Responsável por ler as variáveis de ambiente
 * definidas no `.env`, instanciar a conexão com o MySQL e disponibilizar o objeto
 * compartilhado entre todos os models.
 */
require('dotenv').config(); // carregar .env se existir

const { Sequelize } = require('sequelize');

const DB_NAME = (process.env.BANCO_NOME || 'service-management').trim();
const DB_USER = (process.env.BANCO_USER || 'root').trim();
const DB_PASS = (process.env.BANCO_SENHA || '').trim();
const DB_HOST = (process.env.BANCO_HOST || '127.0.0.1').trim();
const DB_PORT = process.env.BANCO_PORT ? parseInt(process.env.BANCO_PORT, 10) : 3306;
const DB_DIALECT = (process.env.BANCO_DIALECT || 'mysql').trim();

const DB_LOG_SQL = (process.env.DB_LOG_SQL || '').toLowerCase() === 'true';
const sequelizeUser = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: DB_DIALECT,
  logging: DB_LOG_SQL ? (msg) => console.log(msg) : false,
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 }
});

sequelizeUser.authenticate()
  .then(() => {
    console.log('Conectado ao User Banco de Dados:', DB_HOST, DB_NAME, DB_USER);
  })
  .catch(err => {
    console.log('Não foi possível conectar', err && err.message ? err.message : err);
  });

module.exports = sequelizeUser;
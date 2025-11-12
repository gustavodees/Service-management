require('dotenv').config(); // carregar .env se existir

const { Sequelize } = require('sequelize');

const DB_NAME = process.env.BANCO_NOME || 'malty';
const DB_USER = process.env.BANCO_USER || 'root';
const DB_PASS = process.env.BANCO_SENHA || '';
const DB_HOST = process.env.BANCO_HOST || '127.0.0.1';
const DB_DIALECT = process.env.BANCO_DIALECT || 'mysql';

const sequelizeUser = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
  host: DB_HOST,
  dialect: DB_DIALECT,
  logging: false
});

sequelizeUser.authenticate()
  .then(() => {
    console.log('Conectado ao User Banco de Dados:', DB_HOST, DB_NAME, DB_USER);
  })
  .catch(err => {
    console.log('Não foi possível conectar', err);
  });

module.exports = sequelizeUser;
const { DataTypes } = require('sequelize');
const sequelizeUser = require('./banco');

const Tabulacao = sequelizeUser.define('tabulacoes', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false },
  empresa_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'empresas', key: 'id' } }, // Adicionado
  chatId: { type: DataTypes.STRING, allowNull: false },
  tabulacao: { type: DataTypes.STRING, allowNull: false },
  detalhes: { type: DataTypes.TEXT, allowNull: true },
  observacoes: { type: DataTypes.TEXT, allowNull: true },
  data_aniversariante: { type: DataTypes.DATEONLY, allowNull: true },
  timestamp: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, {
  tableName: 'tabulacoes',
  timestamps: false
});

// Para criar a tabela na primeira vez, descomente abaixo, rode o servidor e depois comente novamente
//Tabulacao.sync({ alter: true });

module.exports = Tabulacao;
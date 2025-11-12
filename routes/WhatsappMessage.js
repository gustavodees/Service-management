const { DataTypes } = require('sequelize');
const sequelize = require('./banco');

const WhatsappMessage = sequelize.define('WhatsappMessage', {
  id: { type: DataTypes.STRING, primaryKey: true },
  chatId: { type: DataTypes.STRING, allowNull: false },
  deviceId: { type: DataTypes.STRING, allowNull: false },
  // permitir null (chatbot pode salvar sem user explicitamente vinculado)
  userId: { type: DataTypes.INTEGER, allowNull: true },
  body: { type: DataTypes.TEXT, allowNull: true },
  fromMe: { type: DataTypes.BOOLEAN, allowNull: true },
  type: { type: DataTypes.STRING, allowNull: true },
  mimetype: { type: DataTypes.STRING, allowNull: true },
  filename: { type: DataTypes.STRING, allowNull: true },
  data: { type: DataTypes.TEXT, allowNull: true }, // base64 (ideal ficar null em whatsapp_messages para mídias)
  timestamp: { type: DataTypes.BIGINT, allowNull: true }
}, {
  tableName: 'whatsapp_messages',
  timestamps: false
});

// Opcional: sincronizar (apenas se quiser que o Sequelize altere o schema automaticamente)
//WhatsappMessage.sync({ alter: true }).then(() => console.log('whatsapp_messages pronto')).catch(() => {});

module.exports = WhatsappMessage;
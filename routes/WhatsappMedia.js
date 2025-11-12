const { DataTypes } = require('sequelize');
const sequelize = require('./banco');

const WhatsappMedia = sequelize.define('WhatsappMedia', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  messageId: { type: DataTypes.STRING, allowNull: true }, // id da mensagem (se houver)
  chatId: { type: DataTypes.STRING, allowNull: false },
  deviceId: { type: DataTypes.STRING, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: true },
  filename: { type: DataTypes.STRING, allowNull: true },
  mimetype: { type: DataTypes.STRING, allowNull: true },
  size: { type: DataTypes.INTEGER, allowNull: true },
  data: { type: DataTypes.TEXT('long'), allowNull: true }, // base64
  timestamp: { type: DataTypes.BIGINT, allowNull: true }
}, {
  tableName: 'whatsapp_media',
  timestamps: false
});

// Cria/atualiza tabela automaticamente (comentar após primeira execução se quiser)
//WhatsappMedia.sync({ alter: true }).then(() => console.log('Tabela whatsapp_media pronta!')).catch(err => console.error('Erro ao criar tabela whatsapp_media:', err));

module.exports = WhatsappMedia;
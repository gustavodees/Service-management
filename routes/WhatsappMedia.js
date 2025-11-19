const { DataTypes } = require('sequelize');
const sequelize = require('./banco');

const WhatsappMedia = sequelize.define('WhatsappMedia', {
  id: { type: DataTypes.STRING, primaryKey: true }, // ID da mensagem, não auto-incrementado
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
  timestamps: false,
  // OTIMIZAÇÃO: Adiciona um índice na coluna usada para o JOIN.
  indexes: [
    {
      name: 'idx_media_message_id',
      fields: ['messageId']
    }
  ]
});

module.exports = WhatsappMedia;
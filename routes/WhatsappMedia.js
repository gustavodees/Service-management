const { DataTypes } = require('sequelize');
const sequelize = require('./banco');

const WhatsappMedia = sequelize.define('WhatsappMedia', {
  id: { type: DataTypes.STRING, primaryKey: true, allowNull: false }, // ID da mensagem, que é uma string.
  messageId: { type: DataTypes.STRING, allowNull: false }, // id da mensagem (se houver)
  chatId: { type: DataTypes.STRING, allowNull: false },
  deviceId: { type: DataTypes.STRING, allowNull: false },
  empresa_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'empresas', key: 'id' } },
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
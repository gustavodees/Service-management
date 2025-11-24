const { DataTypes } = require('sequelize');
const sequelize = require('./banco');
const WhatsappMedia = require('./WhatsappMedia'); // Importa o modelo de mídia

const WhatsappMessage = sequelize.define('WhatsappMessage', {
  id: { type: DataTypes.STRING, primaryKey: true },
  chatId: { type: DataTypes.STRING, allowNull: false },
  deviceId: { type: DataTypes.STRING, allowNull: false },
  // permitir null (chatbot pode salvar sem user explicitamente vinculado)
  userId: { type: DataTypes.INTEGER, allowNull: true },
  empresa_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'empresas', key: 'id' } },
  body: { type: DataTypes.TEXT, allowNull: true },
  fromMe: { type: DataTypes.BOOLEAN, allowNull: true },
  type: { type: DataTypes.STRING, allowNull: true },
  mimetype: { type: DataTypes.STRING, allowNull: true },
  filename: { type: DataTypes.STRING, allowNull: true },
  data: { type: DataTypes.TEXT('long'), allowNull: true }, // base64 (ideal ficar null em whatsapp_messages para mídias)
  timestamp: { type: DataTypes.BIGINT, allowNull: true }
}, {
  tableName: 'whatsapp_messages',
  timestamps: false,
  // OTIMIZAÇÃO: Adiciona um índice composto para acelerar as buscas de histórico.
  indexes: [
    {
      name: 'idx_chat_device_timestamp',
      fields: ['chatId', 'deviceId', 'timestamp']
    }
  ]
});

// OTIMIZAÇÃO: Define a associação para permitir o uso de `include` (JOIN).
// Uma mensagem (WhatsappMessage) tem uma mídia (WhatsappMedia).
WhatsappMessage.hasOne(WhatsappMedia, { foreignKey: 'messageId', sourceKey: 'id', as: 'media' });
WhatsappMedia.belongsTo(WhatsappMessage, { foreignKey: 'messageId', targetKey: 'id' });

module.exports = WhatsappMessage;
const { DataTypes } = require('sequelize');
const sequelize = require('./banco');

const Conversation = sequelize.define('Conversation', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  empresa_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'empresas',
      key: 'id'
    }
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  custom_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  profile_pic_url: {
    type: DataTypes.STRING,
    allowNull: true
  },
  last_message: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  timestamp: {
    type: DataTypes.DATE,
    allowNull: true
  },
  unread_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  archived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  is_group: { type: DataTypes.BOOLEAN, defaultValue: false },
  source: { type: DataTypes.STRING, allowNull: true },
  device_id: { type: DataTypes.STRING, allowNull: true }
}, {
  tableName: 'conversations',
  timestamps: false
});

module.exports = Conversation;
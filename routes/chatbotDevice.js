const { DataTypes } = require('sequelize');
const sequelizeUser = require('./banco');

const ChatbotDevice = sequelizeUser.define('chatbot_devices', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    device_id: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'connecting'
    },
    // ADICIONADO: armazenar número/identificador do WhatsApp para exibir na UI
    number: {
        type: DataTypes.STRING,
        allowNull: true
    },
    last_connected: {
        type: DataTypes.DATE,
        allowNull: true
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: false // cada device deve pertencer a um usuário (igual ao whatsappDevice)
    }
}, {
    tableName: 'chatbot_devices',
    timestamps: false
});

// Opcional: criar/atualizar tabela automaticamente (comente após primeira execução)
//ChatbotDevice.sync({ alter: true }).then(()=>console.log('Tabela chatbot_devices pronta')).catch(()=>{});

module.exports = ChatbotDevice;

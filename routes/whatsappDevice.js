const { DataTypes } = require('sequelize');
const sequelizeUser = require('./banco');

const WhatsappDevice = sequelizeUser.define('whatsapp_devices', {
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
        defaultValue: 'connecting' // Valor inicial igual ao que o backend usa
    },
    number: {                       // <-- ADICIONE
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
        allowNull: false // Cada device deve pertencer a um usuário
    },
    empresa_id: {
        type: DataTypes.INTEGER,
        allowNull: true, // Permitir nulo para o admin host, se aplicável
        references: { model: 'empresas', key: 'id' }
    },
}, { 
    tableName: 'whatsapp_devices',
    timestamps: false 
});

// Para criar a tabela automaticamente (apenas uma vez, depois comente)
//WhatsappDevice.sync({ alter: true }); // Use {force:true} só para criar do zero

module.exports = WhatsappDevice;
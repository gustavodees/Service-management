const { DataTypes } = require('sequelize');
const sequelize = require('./banco');
const Usuario = require('./Usuario');
const Empresa = require('./Empresa');

const ActivityLog = sequelize.define('ActivityLog', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: true, // CORRIGIDO: Deve permitir nulo para o ON DELETE SET NULL funcionar
        references: {
            model: 'usuarios',
            key: 'id'
        },
        onDelete: 'SET NULL' // Mantém o log mesmo se o usuário for deletado
    },
    empresa_id: {
        type: DataTypes.INTEGER,
        allowNull: true, // Pode ser nulo para ações do admin mestre
        references: {
            model: 'empresas',
            key: 'id'
        },
        onDelete: 'SET NULL' // Mantém o log mesmo se a empresa for deletada
    },
    action: {
        type: DataTypes.STRING,
        allowNull: false // Ex: 'PASSWORD_CHANGE', 'USER_LOGIN', 'USER_CREATED'
    },
    details: {
        type: DataTypes.TEXT,
        allowNull: true // Ex: "O usuário alterou a própria senha."
    },
    ip_address: {
        type: DataTypes.STRING,
        allowNull: true
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'activity_logs',
    timestamps: false // Já temos a coluna 'timestamp'
});

// Adicionado: Define a associação para que possamos usar `include`
ActivityLog.belongsTo(Usuario, { foreignKey: 'user_id' });
Usuario.hasMany(ActivityLog, { foreignKey: 'user_id' });

module.exports = ActivityLog;
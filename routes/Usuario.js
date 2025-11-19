const { DataTypes } = require('sequelize');
const sequelizeUser = require('./banco');

const Usuario = sequelizeUser.define('Usuario', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    nome: {
        type: DataTypes.STRING,
        allowNull: false
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: {
            name: 'email_unique_constraint', // Nome explícito para a restrição
            msg: 'Este e-mail já está cadastrado.'
        }
    },
    senha: {
        type: DataTypes.STRING,
        allowNull: false
    },
    tipo: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'funcionario'
    },
    empresa_id: {
        type: DataTypes.INTEGER,
        allowNull: true, // Permite nulo para o admin host
        references: { model: 'empresas', key: 'id' },
        onDelete: 'CASCADE'
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    wwp_connected: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    tableName: 'usuarios',
    timestamps: false
});

module.exports = Usuario;
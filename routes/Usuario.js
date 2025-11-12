const { DataTypes } = require('sequelize');
const sequelizeUser = require('./banco');

const Usuario = sequelizeUser.define('usuarios', {
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
        unique: true
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
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    wwp_connected: {
        type: DataTypes.STRING,
        allowNull: true // Pode ser null se o usuário ainda não conectou
    }
}, {
    tableName: 'usuarios',
    timestamps: false
});

//Usuario.sync({ alter: true }); // Descomente esta linha para atualizar a tabela

module.exports = Usuario;
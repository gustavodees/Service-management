const { DataTypes } = require('sequelize');
const sequelize = require('./banco');
const Usuario = require('./Usuario');

const Empresa = sequelize.define('Empresa', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    nome_fantasia: {
        type: DataTypes.STRING,
        allowNull: false
    },
    razao_social: {
        type: DataTypes.STRING,
        allowNull: true
    },
    cnpj: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true
    },
    status: {
        // Alterado para INTEGER para usar -2, -1, 1, 2
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1 // 1: pendente, 2: aprovado, -1: bloqueado, -2: rejeitado
    },
    senha_empresa: {
        type: DataTypes.STRING,
        allowNull: true
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'empresas',
    timestamps: false
});

// Define a associação: Uma Empresa tem muitos Usuários
Empresa.hasMany(Usuario, { foreignKey: 'empresa_id' });
Usuario.belongsTo(Empresa, { foreignKey: 'empresa_id' });

module.exports = Empresa;
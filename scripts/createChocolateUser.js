const bcrypt = require('bcryptjs');
const Usuario = require('../routes/Usuario');
const sequelize = require('../routes/banco');

async function run() {
    try {
        await Usuario.sync(); // cria tabela se necessário
        const hashed = await bcrypt.hash('123456789', 10);
        const user = await Usuario.create({
            nome: 'Chocolate',
            email: 'chocolate@local',
            senha: hashed,
            tipo: 'admin',
            wwp_connected: null
        });
        console.log('Usuário criado:', user.toJSON());
    } catch (err) {
        console.error('Erro:', err);
    } finally {
        await sequelize.close();
    }
}

run();

/**
 * CLI auxiliar para criar/garantir o usuário "Chocolate" (admin host) com senha
 * padrão. Execute `node scripts/createChocolateUser.js` em ambientes de teste.
 */
const bcrypt = require('bcryptjs');
const Usuario = require('../routes/Usuario');
const sequelize = require('../routes/banco');
 
/**
 * Autentica no banco, sincroniza modelos e cria o usuário se não existir.
 */
async function run() {
    try {
        await sequelize.authenticate();
        console.log('Conectado ao DB com sucesso.');
 
        await sequelize.sync({ alter: true });
        console.log('Sync concluído.');

        const hashed = await bcrypt.hash('123456789', 10);
        const [user, created] = await Usuario.findOrCreate({
            where: { email: 'chocolate@local' },
            defaults: {
                nome: 'Chocolate',
                senha: hashed,
                tipo: 'admin',
                empresa_id: null, // Garante que é um admin host
                wwp_connected: null
            }
        });

        if (created) console.log('Usuário criado:', user.toJSON());
        else console.log('Usuário já existe:', user.toJSON());
    } catch (err) {
        console.error('Erro detalhado:', err && err.stack ? err.stack : err);
    } finally {
        try { await sequelize.close(); } catch (_) {}
    }
}
 
run();

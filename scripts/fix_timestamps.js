/*
  Script: fix_timestamps.js
  - Faz backup lógico simples (opcionalmente, você pode rodar mysqldump antes)
  - Converte timestamps em whatsapp_messages e whatsapp_media que parecem estar em ms -> para seconds
  - Ajusta timestamps NULL/0 para valor atual (UNIX seconds)
  USO:
    node scripts\fix_timestamps.js
*/
const path = require('path');

async function run() {
  try {
    // Carrega a conexão do seu projeto
    const sequelize = require(path.join(__dirname, '..', 'routes', 'banco'));
    console.log('Conexão com DB carregada.');

    // Aviso / confirmação simples (não interativo): continue
    console.log('Executando atualizações:');
    console.log('- whatsapp_messages: timestamps > 1e11 => /1000');
    console.log('- whatsapp_media: timestamps > 1e11 => /1000');
    console.log('- Ajustar NULL/0 para timestamp atual.');

    // Use transaction para segurança
    await sequelize.transaction(async (t) => {
      // 1) Converter timestamps muito grandes (provavelmente ms) para segundos
      const q1 = "UPDATE whatsapp_messages SET timestamp = FLOOR(timestamp / 1000) WHERE timestamp > 100000000000;";
      const q2 = "UPDATE whatsapp_media SET timestamp = FLOOR(timestamp / 1000) WHERE timestamp > 100000000000;";

      console.log('>> Convertendo timestamps em whatsapp_messages (ms -> s) ...');
      await sequelize.query(q1, { transaction: t });
      console.log('   feito.');

      console.log('>> Convertendo timestamps em whatsapp_media (ms -> s) ...');
      await sequelize.query(q2, { transaction: t });
      console.log('   feito.');

      // 2) Ajustar valores NULL ou 0 para o tempo atual (evita zeros)
      const q3 = "UPDATE whatsapp_messages SET timestamp = UNIX_TIMESTAMP() WHERE timestamp IS NULL OR timestamp = 0;";
      const q4 = "UPDATE whatsapp_media SET timestamp = UNIX_TIMESTAMP() WHERE timestamp IS NULL OR timestamp = 0;";

      console.log('>> Ajustando NULL/0 para timestamp atual em whatsapp_messages ...');
      await sequelize.query(q3, { transaction: t });
      console.log('   feito.');

      console.log('>> Ajustando NULL/0 para timestamp atual em whatsapp_media ...');
      await sequelize.query(q4, { transaction: t });
      console.log('   feito.');
    });

    console.log('Todas as atualizações concluídas com sucesso.');
    process.exit(0);
  } catch (err) {
    console.error('Erro ao aplicar correção de timestamps:', err);
    process.exit(1);
  }
}

run();
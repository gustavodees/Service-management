-- =====================================================================
-- SCRIPT PARA INSERIR UMA CONVERSA DE TESTE PARA A EMPRESA DO USUÁRIO
-- =====================================================================
--
-- Este script insere um contato de teste na tabela `conversations`
-- associado à empresa com CNPJ '55666777000188', para que ele
-- apareça na tela de atendimento do usuário 'admin.novo@facil.com'.
--
-- =====================================================================

-- Inicia uma transação
START TRANSACTION;

-- 1. Encontra o ID da empresa do usuário (CNPJ 55666777000188)
SET @empresa_id_usuario = (SELECT id FROM `empresas` WHERE `cnpj` = '55666777000188' LIMIT 1);

-- 2. Insere um contato de teste se a empresa existir
INSERT INTO `conversations` 
  (`id`, `empresa_id`, `name`, `last_message`, `timestamp`, `unread_count`, `is_group`, `source`, `device_id`)
VALUES 
  ('whatsapp:5511912345678@c.us', @empresa_id_usuario, 'Contato da Minha Empresa', 'Esta é uma mensagem de teste para a minha empresa.', NOW(), 1, FALSE, 'whatsapp', 'device-user-456') AS new_values
ON DUPLICATE KEY UPDATE
  `name` = new_values.name,
  `last_message` = new_values.last_message,
  `timestamp` = new_values.timestamp;

-- Confirma as alterações
COMMIT;
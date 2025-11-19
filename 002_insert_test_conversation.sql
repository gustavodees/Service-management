-- =====================================================================
-- SCRIPT PARA INSERIR UMA CONVERSA DE TESTE
-- =====================================================================
--
-- Este script insere um contato de teste na tabela `conversations`
-- para que você possa verificar se a API `/api/contacts` está funcionando
-- e exibindo os dados na tela de atendimento.
--
-- Ele assume que a "Empresa de Teste" com CNPJ '11222333000144' já existe.
--
-- =====================================================================
/*
-- Inicia uma transação
START TRANSACTION;

-- 1. Encontra o ID da empresa de teste
SET @empresa_id_teste = (SELECT id FROM `empresas` WHERE `cnpj` = '11222333000144' LIMIT 1);

-- 2. Insere um contato de teste se a empresa existir
-- O `IF` garante que a inserção só ocorra se a empresa for encontrada.
INSERT INTO `conversations` 
  (`id`, `empresa_id`, `name`, `last_message`, `timestamp`, `unread_count`, `is_group`, `source`, `device_id`)
VALUES 
  ('whatsapp:5511987654321@c.us', @empresa_id_teste, 'Contato de Teste', 'Olá! Esta é uma mensagem de teste.', NOW(), 2, FALSE, 'whatsapp', 'device-test-123') AS new_values
ON DUPLICATE KEY UPDATE
  `name` = new_values.name,
  `last_message` = new_values.last_message,
  `timestamp` = new_values.timestamp;

-- Confirma as alterações
COMMIT;
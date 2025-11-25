-- =====================================================================
-- SCRIPT PARA CRIAÇÃO DA TABELA `conversations`
-- =====================================================================
--
-- Este script cria a tabela `conversations`, que é essencial para
-- armazenar e exibir os contatos e conversas na tela de atendimento.
--
-- Execute este script uma única vez no seu banco de dados.
--
-- =====================================================================
/*
CREATE TABLE IF NOT EXISTS `conversations` (
  `id` VARCHAR(255) NOT NULL,
  `empresa_id` INT NULL,
  `name` VARCHAR(255) NULL,
  `custom_name` VARCHAR(255) NULL,
  `profile_pic_url` TEXT NULL,
  `last_message` TEXT NULL,
  `timestamp` DATETIME NULL,
  `unread_count` INT NOT NULL DEFAULT 0,
  `is_group` BOOLEAN NOT NULL DEFAULT FALSE,
  `source` VARCHAR(50) NULL COMMENT 'Origem: whatsapp ou chatbot',
  `device_id` VARCHAR(255) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_empresa_id` (`empresa_id`),
  INDEX `idx_timestamp` (`timestamp` DESC),
  CONSTRAINT `fk_conversations_empresa`
    FOREIGN KEY (`empresa_id`)
    REFERENCES `empresas` (`id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE
)
ENGINE = InnoDB;
# Sistema Malty — Automação WhatsApp

Descrição
---------
Sistema para automação de WhatsApp com suporte a múltiplas sessões via WhatsApp Web, central de atendimento, disparos em massa e integração com chatbot (Google Generative AI). Desenvolvido em Node.js com Express, Sequelize e whatsapp-web.js. Banco de dados: MySQL (usando XAMPP no ambiente Windows).

Principais funcionalidades
-------------------------
- Login de usuários
- Gerenciamento de dispositivos/ sessões WhatsApp (QR Code)
- Chatbot integrado (opcional, requer chave Google Generative AI)
- Envio em massa (broadcast)
- Central de atendimento com histórico de mensagens
- Armazenamento de mídias recebidas/enviadas

Requisitos
----------
- Windows
- XAMPP (Apache + MySQL) — usado apenas para MySQL/phpMyAdmin
- Node.js v14+ e npm
- Google Chrome (para puppeteer)
- Chave API Google Generative AI (se usar chatbot)

Instalação (passo a passo)
--------------------------

1. Preparar o ambiente
   - Instale Node.js: https://nodejs.org/
   - Instale XAMPP: https://www.apachefriends.org/
   - Instale Google Chrome

2. Iniciar serviços XAMPP
   - Abra o painel XAMPP e inicie Apache (opcional) e MySQL.
   - Acesse phpMyAdmin: http://localhost/phpmyadmin

3. Clonar o repositório e instalar dependências
   Abra o PowerShell ou CMD e execute:
   ```bash
   git clone <url-do-repositorio>
   cd "c:\Users\games\OneDrive\Desktop\service-management"
   npm install
   ```

4. (Opcional) Crie o arquivo .env na raiz do projeto (exemplo abaixo).

Configuração do banco de dados (MySQL via XAMPP)
-----------------------------------------------

Opção A — phpMyAdmin (GUI)
1. Acesse http://localhost/phpmyadmin
2. Clique em "Novo" e crie o banco de dados, ex.: sistema_malty (collation utf8mb4_unicode_ci).
3. Se preferir, crie um usuário com permissões e ajuste .env.
4. Abra a aba SQL e cole os comandos SQL abaixo para criar as tabelas.

Opção B — MySQL Shell (XAMPP Shell)
1. Abra o XAMPP Control Panel > Shell.
2. No shell digite:
   mysql -u root -p
   (pressione Enter; se root não tiver senha, apenas tecle Enter quando pedir)
3. Cole e execute os comandos SQL abaixo.

SQL para criar as tabelas usadas pelo projeto
--------------------------------------------
(estas instruções criam as tabelas conforme os models presentes em routes/*.js)

```sql
CREATE DATABASE IF NOT EXISTS sistema_malty CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE sistema_malty;

-- tabela de usuários (usuarios)
CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  senha VARCHAR(255) NOT NULL,
  tipo VARCHAR(50) NOT NULL DEFAULT 'funcionario',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  wwp_connected VARCHAR(255) DEFAULT NULL
);

-- dispositivos WhatsApp (whatsapp_devices)
CREATE TABLE IF NOT EXISTS whatsapp_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(100) NOT NULL DEFAULT 'connecting',
  number VARCHAR(100) DEFAULT NULL,
  last_connected DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT NOT NULL
);

-- dispositivos do chatbot (chatbot_devices)
CREATE TABLE IF NOT EXISTS chatbot_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(100) NOT NULL DEFAULT 'connecting',
  number VARCHAR(100) DEFAULT NULL,
  last_connected DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT NOT NULL
);

-- mensagens WhatsApp (whatsapp_messages)
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id VARCHAR(255) PRIMARY KEY,
  chatId VARCHAR(255) NOT NULL,
  deviceId VARCHAR(255) NOT NULL,
  userId INT DEFAULT NULL,
  body TEXT DEFAULT NULL,
  fromMe TINYINT(1) DEFAULT NULL,
  type VARCHAR(100) DEFAULT NULL,
  mimetype VARCHAR(255) DEFAULT NULL,
  filename VARCHAR(255) DEFAULT NULL,
  data TEXT DEFAULT NULL,
  timestamp BIGINT DEFAULT NULL
);

-- mídias WhatsApp (whatsapp_media)
CREATE TABLE IF NOT EXISTS whatsapp_media (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  messageId VARCHAR(255) DEFAULT NULL,
  chatId VARCHAR(255) NOT NULL,
  deviceId VARCHAR(255) NOT NULL,
  userId INT DEFAULT NULL,
  filename VARCHAR(255) DEFAULT NULL,
  mimetype VARCHAR(255) DEFAULT NULL,
  size INT DEFAULT NULL,
  data LONGTEXT DEFAULT NULL,
  timestamp BIGINT DEFAULT NULL
);
```

Observação sobre chaves/relacionamentos
- Os models atuais não definem explicitamente chaves estrangeiras via Sequelize em todos os arquivos; se desejar criar FKs ajuste conforme sua necessidade (ex.: user_id REFERENCES usuarios(id)).  
- Se preferir, existe um script local ("sync-models") no package.json que, se implementado, pode sincronizar modelos via Sequelize: npm run sync-models.

Arquivo .env (exemplo)
---------------------
Crie um arquivo `.env` na raiz do projeto com estas variáveis:

```env
# filepath: c:\Users\games\OneDrive\Desktop\service-management\.env
MASTER_USER=admin@exemplo.com
MASTER_SENHA=senha123
GOOGLE_AI_API_KEY=Sua_Chave_Google_Generative_AI
PORT=3000

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=          # deixe vazio se root não tiver senha
DB_NAME=sistema_malty

SESSION_PATH=./sessions
```

Executando a aplicação
----------------------
1. Certifique-se de que o serviço MySQL do XAMPP esteja rodando.
2. No diretório do projeto:
   ```bash
   npm start
   ```
   (ou node ./bin/www — conforme package.json o script start está configurado)

3. Abra no navegador:
   http://localhost:3000  (ou http://localhost:<PORT> se alterou a porta)

Uso do sistema (passo a passo)
------------------------------

1. Login
   - Acesse http://localhost:3000
   - Faça login com usuário criado no banco ou com MASTER_USER / MASTER_SENHA do .env (se a aplicação usar essa variável para criar/validar o admin).

2. Conectar sessão WhatsApp (Adicionar WhatsApp)
   - No painel, vá em "Adicionar WhatsApp" / "Conectar WhatsApp".
   - Será gerado um QR Code.
   - No app WhatsApp do celular: Menu > Dispositivos vinculados > Vincular dispositivo e escaneie o QR.
   - Aguarde a confirmação; o dispositivo/sessão será registrado em whatsapp_devices (device_id) e sua coluna de status será atualizada.

3. Usar Chatbot (se configurado)
   - Configure a integração com a chave GOOGLE_AI_API_KEY no painel (caso exista UI).
   - Ative o chatbot para a sessão desejada.

4. Disparo em massa
   - Navegue até a seção de broadcast.
   - Insira a lista de números no formato internacional (ex.: 5511999999999) ou importe CSV conforme a interface.
   - Escreva a mensagem e inicie o envio.

5. Atendimento manual
   - Acesse a central de atendimento, abra uma conversa e responda.
   - Mensagens e mídias ficam armazenadas nas tabelas whatsapp_messages e whatsapp_media.

Dicas e solução de problemas
----------------------------
- Erro de conexão ao MySQL: verifique se o MySQL do XAMPP está ativo e as credenciais em .env.
- Portas: se a porta 3000 estiver em uso, altere PORT no .env.
- Puppeteer/Chrome: se o puppeteer não encontrar o Chrome, assegure que o Chrome esteja instalado; ajuste configurações de execução (headless/args) se necessário.
- Logs: verifique o terminal onde o Node foi iniciado para mensagens de erro.

Scripts úteis (package.json)
---------------------------
- npm start — inicia o servidor (node ./bin/www)
- npm run sync-models — (se presente) sincroniza modelos Sequelize com o banco
- npm run fix-timestamps — (utilitário local, se implementado)

Segurança
---------
- Não comite o arquivo .env em repositórios públicos.
- Proteja a chave GOOGLE_AI_API_KEY.
- Use HTTPS e regras de firewall se for expor a aplicação.

Suporte
-------
Para problemas específicos do código, logs ou erros ao executar, copie o trecho de erro do terminal e abra uma issue/descreva o erro com o máximo de informações (versão Node, logs, .env usado, se XAMPP está ativo).

Licença
-------
Projeto local / interno. Ajuste conforme necessidade da sua organização.
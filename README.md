# Service Management Platform  
**Automação Inteligente de Atendimento via WhatsApp com IA Generativa e Painel Administrativo**

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/MySQL-8.0%2B-4479A1?logo=mysql&logoColor=white" alt="MySQL 8.0+">
  <img src="https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/Sequelize-ORM-52B0E8?logo=sequelize&logoColor=white" alt="Sequelize">
  <img src="https://img.shields.io/badge/Google%20AI-Gemini-8E75B2?logo=google&logoColor=white" alt="Google AI">
  <img src="https://img.shields.io/badge/WebSocket-Real--time-1A1A1A?logo=websocket&logoColor=white" alt="WebSocket">
</p>

---

## Visão Geral

O **Service Management Platform** é uma solução corporativa de **automação de atendimento via WhatsApp**, desenvolvida como projeto acadêmico de excelência nas disciplinas **Sistemas Distribuídos e Mobile** e **Usabilidade, Desenvolvimento Web, Mobile e Jogos** da **Universidade do Sul de Santa Catarina (UNISUL)**.

A plataforma integra tecnologias de ponta para oferecer:

- **Automação de múltiplas sessões WhatsApp** com persistência de autenticação
- **Chatbot inteligente baseado em IA generativa (Google Gemini)**
- **Disparo em massa segmentado com controle de emissor**
- **Painel administrativo completo com analytics em tempo real**
- **Comunicação bidirecional em tempo real via WebSockets**
- **Treinamento dinâmico do modelo de IA sem necessidade de rebuild**

---

## Equipe de Desenvolvimento

| Nome | GitHub | RA |
|------|--------|-----|
| **Gustavo de Espindola Martins** | [@gustavodees](https://github.com/gustavodees) | 10724238393 |
| **Gustavo Godinho** | [@gustavo-godinho](https://github.com/gustavo-godinho) | 10724268995 |
| **Júlio Cesar de Souza Mauro** | [@JcMauro](https://github.com/JcMauro) | 10724269838 |
| **Kaike Augusto Dias dos Santos** | [@KaikeDiaz](https://github.com/KaikeDiaz) | 10725113309 |
| **Vitor Steinbach** | [@steinbachvitor](https://github.com/steinbachvitor) | 10724268585 |

---

## Funcionalidades Principais

| Funcionalidade | Endpoint | Descrição |
|----------------|----------|---------|
| **Gestão de Dispositivos** | `/conectZap`, `/conectBot` | Conexão segura com múltiplas instâncias WhatsApp via QR Code |
| **Chatbot com IA Generativa** | `/chatbot` | Respostas automáticas com contexto treinado via `ia-treinamento.txt` |
| **Disparo em Massa** | `/disparaWhats` | Envio programado com seleção do dispositivo emissor |
| **Painel Administrativo** | `/admin` | Cadastro de usuários, permissões e monitoramento |
| **Analytics & BI** | `/grafico` | Dashboards interativos com Chart.js |
| **Editor de Prompt IA** | `/ia` | Ajuste dinâmico do comportamento da IA sem alterar código |
| **Comunicação em Tempo Real** | WebSocket (`ws://`) | Notificações instantâneas e handoff humano |

---

## Stack Tecnológico

| Camada | Tecnologia |
|--------|------------|
| **Runtime** | Node.js 18+ |
| **Framework Web** | Express.js |
| **Template Engine** | Pug (Jade) |
| **Banco de Dados** | MySQL 8.0+ |
| **ORM** | Sequelize |
| **Automação WhatsApp** | whatsapp-web.js + Puppeteer |
| **IA Generativa** | Google Generative AI (Gemini) |
| **Criptografia** | bcrypt |
| **Comunicação Real-time** | WebSocket (`ws`) |
| **Visualização de Dados** | Chart.js |
| **Gerenciamento de Configuração** | dotenv |

---

## Guia de Implantação (Plug & Play)

### Pré-requisitos

---
```bash
Node.js >= 18.0.0
MySQL Server >= 8.0
Google Chrome (para Puppeteer)
Git (recomendado)
Passos para Execução
1. Clonar o Repositório
bashgit clone https://github.com/SEU_USUARIO/service-management.git
cd service-management
2. Instalar Dependências
bashnpm install
Dica de desenvolvimento:bashnpm install -g nodemon
npm run dev
3. Configurar Variáveis de Ambiente
Crie o arquivo .env na raiz do projeto:
env# Server
PORT=3000

---

# Database
DB_HOST=localhost
DB_USER=root
DB_PASS=070600@
DB_NAME=db_servicemanagement

---

# Google AI
GOOGLE_API_KEY=SUA_CHAVE_AQUI

---

# Sessions
SESSION_DIR=./sessions
Nunca commit o arquivo .env — adicione ao .gitignore.
4. Criar Banco de Dados
sqlCREATE DATABASE db_servicemanagement 
CHARACTER SET utf8mb4 
COLLATE utf8mb4_unicode_ci;
5. Sincronizar Modelos (Sequelize)
Primeira execução apenas:
Descomente as linhas Model.sync({ force: true }) nos arquivos em /models/, execute:bashnpm startApós a criação das tabelas, comente novamente para evitar perda de dados.
6. Iniciar a Aplicação
bashnpm start
Acesse: http://localhost:3000
Primeiro login WhatsApp:
Um QR Code será exibido no terminal. Escaneie com o aplicativo WhatsApp.
A sessão será salva em ./sessions/ para reconexão automática.

Estrutura do Projeto
textservice-management/
├── app.js                    # Entry point
├── package.json
├── .env.example
├── models/                   # Modelos Sequelize
├── controllers/              # Lógica de negócios
├── routes/                   # Definição de rotas
├── services/                 # whatsapp.js, ai.js, etc
├── views/                    # Templates Pug
├── public/                   # Assets estáticos (CSS, JS, imagens)
├── database/                 # Scripts SQL e migrações
├── sessions/                 # Sessões persistentes do WhatsApp
└── ia-treinamento.txt        # Contexto da IA

---

Solução de Problemas (Troubleshooting)
npm install Falhou



ErroCausaSoluçãoEACCES / EPERMPermissõessudo chown -R $USER . ou execute como AdminETIMEDOUTRedeVerifique proxy/firewall ou tente novamentePuppeteerDependências do sistemaLinux: sudo apt-get install -y libnss3 libgbm-dev ...

---

MySQL

ErroSoluçãoER_NOT_SUPPORTED_AUTH_MODEsql ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'senha'; ECONNREFUSEDInicie o serviço MySQL e verifique .env

---

WhatsApp

ProblemaSoluçãoQR Code não apareceVerifique se o Chrome foi aberto; delete a pasta de sessão corrompidaSessão expiraRemova arquivos antigos em ./sessions/ e reconecte

---

Segurança e Boas Práticas

Sessões criptografadas em disco com controle de acesso
Hash de senhas com bcrypt
Variáveis sensíveis isoladas em .env
Controle de concorrência em múltiplas instâncias WhatsApp
Logs estruturados para auditoria


Mini-Tutorial: Chave SSH (Git Seguro)
bash# 1. Gerar chave
ssh-keygen -t ed25519 -C "seu@email.com"

# 2. Iniciar agente
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# 3. Copiar chave pública
cat ~/.ssh/id_ed25519.pub
# Windows: cat ~/.ssh/id_ed25519.pub | clip

# 4. Adicionar ao GitHub → Settings → SSH Keys
---
Contribuição

Crie uma branch: git checkout -b feature/nova-funcionalidade
Commit: git commit -m "feat: descrição clara"
Push: git push origin feature/nova-funcionalidade
Abra um Pull Request com:
Descrição detalhada
Screenshots (se aplicável)
Testes realizados

---

# Referências Técnicas

whatsapp-web.js
Google Generative AI
Sequelize ORM
Pug Template Engine
WebSocket Protocol

---

| Service Management Platform — Automatize. Inteligência. Escala.
| Desenvolvido com excelência acadêmica e visão empresarial.
| UNISUL © 2025 — Todos os direitos reservados.
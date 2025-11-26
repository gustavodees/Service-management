# Service Management Platform
**Automação inteligente de atendimento via WhatsApp com IA generativa, BI em tempo real e governança corporativa.**

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/MySQL-8.0%2B-4479A1?logo=mysql&logoColor=white" alt="MySQL 8.0+">
  <img src="https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/Sequelize-ORM-52B0E8?logo=sequelize&logoColor=white" alt="Sequelize">
  <img src="https://img.shields.io/badge/Google%20AI-Gemini-8E75B2?logo=google&logoColor=white" alt="Google AI">
  <img src="https://img.shields.io/badge/WebSocket-Real--time-1A1A1A?logo=websocket&logoColor=white" alt="WebSocket">
</p>

> Projeto acadêmico da UNISUL evoluído para plataforma corporativa completa com foco em escala, observabilidade e segurança operacional.

---

## Sumário
1. [Visão Geral](#visão-geral)
2. [Arquitetura em Alto Nível](#arquitetura-em-alto-nível)
3. [Módulos Principais](#módulos-principais)
4. [Stack Tecnológico](#stack-tecnológico)
5. [Mapa do Repositório](#mapa-do-repositório)
6. [Guia de Implantação](#guia-de-implantação)
7. [Configuração de Ambiente](#configuração-de-ambiente)
8. [Provisionamento de Banco](#provisionamento-de-banco)
9. [Execução e Operação](#execução-e-operação)
10. [Playbook Operacional](#playbook-operacional)
11. [Troubleshooting](#troubleshooting)
12. [Contribuição](#contribuição)
13. [Referências Técnicas](#referências-técnicas)
14. [Equipe de Desenvolvimento](#equipe-de-desenvolvimento)

---

## Visão Geral
A plataforma automatiza todo o ciclo de atendimento via WhatsApp: captura conversas, treina chatbots generativos, distribui atendimentos para equipes humanas, gera dashboards de tabulação e mantém auditoria detalhada. Uma única API Express sincroniza múltiplos devices via WebSocket e mantém consistência das sessões em disco.

> Documentação profunda (modelos, fluxos, arquitetura detalhada) em [`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md).

---

## Arquitetura em Alto Nível
- **Backend unificado:** Express + Sequelize hospedam `index`, `users`, `admin`, `api`, `chatbot` e serviços WhatsApp.
- **Mensageria:** `whatsapp-web.js` + Puppeteer controlam múltiplos devices; eventos críticos são broadcast via `ws`.
- **Persistência:** MySQL 8.0 com models versionados nos arquivos de rota.
- **Front-end híbrido:** Views Pug, CSS modular e Chart.js. Cada página injeta apenas os assets necessários.
- **Segurança:** Helmet + CSP, sessions assinadas, MFA (Speakeasy), rate limiting, auditoria estruturada (`utils/logActivity.js`).

---

## Módulos Principais
| Módulo | Descrição | Rotas/Arquivos |
| --- | --- | --- |
| Gestão de Dispositivos | Conecta/desconecta WhatsApp/Chatbot via QR Code e propaga status em tempo real. | `routes/whatsapp.js`, `routes/whatsappManager.js`, `routes/whatsappDevice.js`, `views/conectZap.pug` |
| Chatbot IA | Prompt dinâmico (`ia-treinamento.txt`), respostas Gemini e painel de ajustes. | `routes/chatbot.js`, `public/javascripts/chatbot.js`, `views/ia.pug` |
| Disparo em Massa | Envios sequenciais com delays randômicos e logging por dispositivo. | `routes/users.js` (`/desparar`), `views/desparaWhats.pug` |
| Atendimento Omnichannel | Console WebSocket, histórico persistido, tabulação e impersonação administrativa. | `views/atendimento.pug`, `public/javascripts/atendimento-ws.js`, `routes/api.js` |
| Analytics & BI | Dashboards Chart.js com filtros de equipe/usuário/empresa. | `views/grafico.pug`, `public/javascripts/grafico.js`, `routes/users.js`, `routes/tabulacaoHelper.js` |
| Auditoria | `ActivityLog` registra ações com usuário, empresa, IP e descrição detalhada. | `routes/ActivityLog.js`, `utils/logActivity.js`, `views/activity-logs.pug` |

---

## Stack Tecnológico
| Camada | Tecnologia |
| --- | --- |
| Runtime | Node.js 18+ |
| Framework Web | Express 4.x + Pug 3 |
| Banco | MySQL 8.0, client `mysql2`, ORM Sequelize 6 |
| Automação WhatsApp | `whatsapp-web.js`, Puppeteer headless, WebSocket `ws` |
| IA Generativa | `@google/generative-ai` (Gemini) |
| Segurança | Helmet, express-session, bcrypt, speakeasy (MFA), express-rate-limit |
| Front-end | Chart.js, CSS modular em `public/stylesheets`, JS dedicado em `public/javascripts` |

---

## Mapa do Repositório
```
service-management/
├── app.js                  # Configuração Express + WebSocket
├── bin/www                 # Bootstrap HTTP padrão
├── routes/                 # Models, rotas e serviços WhatsApp/Chatbot
├── public/                 # JavaScript e CSS por página
├── views/                  # Templates Pug
├── utils/                  # logActivity, safeRmSession, helpers
├── scripts/                # CLI (sync_models, fix_timestamps...)
├── docs/TECHNICAL_DOCUMENTATION.md
├── ia-treinamento.txt      # Prompt base do chatbot
├── templates/*.sql         # Seeds/Migrações
└── sessions/               # Sessões WhatsApp/Chatbot (gitignored)
```

---

## Guia de Implantação

### Passo 0 — Ferramentas Essenciais
- **Git + Git Bash:** [git-scm.com/downloads](https://git-scm.com/downloads)
- **Node.js 18+ (com npm):** [nodejs.org/en/download](https://nodejs.org/en/download)
- **MySQL Server 8.0+:** [dev.mysql.com/downloads](https://dev.mysql.com/downloads/) com usuário que possua `CREATE DATABASE`
- **Google Chrome:** Puppeteer depende do navegador
- **(Opcional) VS Code** para desenvolvimento

> Se `npm` não for reconhecido no PowerShell, veja a entrada específica em [Troubleshooting](#troubleshooting) (inclui `Set-ExecutionPolicy RemoteSigned`).

### Passo 1 — Configurar acesso SSH ao GitHub
1. Abra o **Git Bash**.
2. Gere uma chave: `ssh-keygen -t ed25519 -C "seu-email@dominio.com"` e aceite o diretório padrão (`~/.ssh/id_ed25519`).
3. Inicie o agente: `eval "$(ssh-agent -s)"`.
4. Adicione a chave privada: `ssh-add ~/.ssh/id_ed25519`.
5. Copie a chave pública: `clip < ~/.ssh/id_ed25519.pub` (Windows) ou `pbcopy`/`cat` conforme SO.
6. Cole em [github.com/settings/keys](https://github.com/settings/keys#/ssh/new).
7. Teste acesso: `ssh -T git@github.com`.

### Passo 2 — Configurar identidade Git
```bash
git config --global user.name "Seu Nome"
git config --global user.email "seu-email@dominio.com"
```

### Passo 3 — Clonar o repositório
```bash
git clone git@github.com:SEU_USUARIO/service-management.git
cd service-management
```
> Se preferir HTTPS: `git clone https://github.com/SEU_USUARIO/service-management.git`.

### Passo 4 — Instalar dependências
```bash
npm install
```
Se o erro “`npm : O termo 'npm' não é reconhecido...`” persistir, abra o **PowerShell como Administrador**, rode `Set-ExecutionPolicy RemoteSigned`, responda **Sim**, reinicie o terminal e execute `npm install`.

### Passo 5 — Criar o arquivo `.env`
Crie o `.env` na raiz com o conteúdo abaixo. **Importante:** mantenha `DB_PASS=070600@`, igual aos scripts SQL.

```env
# Server
PORT=3000
SESSION_SECRET=troque-esta-chave

# Database
DB_HOST=localhost
DB_USER=root
DB_PASS=070600@
DB_NAME=db_servicemanagement

# Google AI
GOOGLE_API_KEY=SUA_CHAVE_GEMINI

# Sessions
SESSION_DIR=./sessions

# Sincronização opcional
SYNC_MESSAGE_LIMIT=80
SYNC_CHAT_CONCURRENCY=4
```

### Passo 6 — Provisionar banco e modelos
1. Criar schema UTF8MB4:
   ```sql
   CREATE DATABASE db_servicemanagement
   CHARACTER SET utf8mb4
   COLLATE utf8mb4_unicode_ci;
   ```
2. Executar `node startBD.js` para autenticar, registrar models e rodar `sequelize.sync({ alter: true })`.
3. (Opcional) Aplicar `00*.sql` e `template_*.sql.txt` para dados de exemplo.

### Passo 7 — Executar a aplicação
- **Dev:** `npm start` (ou `npx nodemon bin/www`).
- **Prod:** `node ./bin/www` atrás de PM2/systemd com variáveis configuradas.

No primeiro acesso ao módulo WhatsApp um QR Code será exibido no terminal; escaneie com o app oficial e aguarde sincronização completa.

---

## Configuração de Ambiente
- **Sessões:** `sessions/` deve permanecer em armazenamento persistente e já está no `.gitignore`.
- **Segurança:** Helmet define CSP; ajuste apenas se usar novas CDNs/hosts.
- **MFA/Admin:** `routes/admin.js` permite TOTPs via Speakeasy. Configure em `/admin/mfa`.
- **Prompt IA:** atualize `ia-treinamento.txt` e recarregue via `/ia` sem reiniciar.

---

## Provisionamento de Banco
- Models residem em `routes/` para facilitar o auto-load em `startBD.js`.
- Scripts auxiliares (executar via `node`):
  - `scripts/sync_models.js`
  - `scripts/fix_timestamps.js`
  - `scripts/migrate_media_from_messages_to_media.js`
  - `clear-data.js`
- Todos assumem o mesmo `.env` (senha `070600@`).

---

## Execução e Operação
| Comando | Descrição |
| --- | --- |
| `npm start` | Sobe o servidor Express usando `PORT` |
| `npx nodemon bin/www` | Hot reload durante desenvolvimento |
| `npm run sync-models` | Executa sincronização manual dos models |
| `npm run fix-timestamps` | Corrige timestamps inconsistentes |
| `node clear-data.js` | Limpa tabelas de atendimento (ambientes controlados) |

---

## Playbook Operacional
1. **Conectar dispositivo WhatsApp** (`/conectZap` ou `/conectBot`): gere QR, escaneie e aguarde `status: connected`.
2. **Distribuir atendimentos:** operadores usam `/users/atendimento`; admins podem impersonar usuários.
3. **Tabular contatos:** tabulação via UI ou endpoint `/api/tabular`; dashboards refletem em tempo real.
4. **Chatbot & IA:** ajuste parâmetros em `/ia`, monitore em `/chatbot`.
5. **Auditar:** consultas em `/activity-logs` com filtros avançados (empresa, usuário, período).

---

## Troubleshooting
| Sintoma | Causa Probável | Solução |
| --- | --- | --- |
| `npm : O termo 'npm' não é reconhecido...` | Node/npm não instalados ou política de execução bloqueando. | Instale Node 18+, abra PowerShell Admin, rode `Set-ExecutionPolicy RemoteSigned`, reinicie terminal e execute `npm install`. |
| `ER_NOT_SUPPORTED_AUTH_MODE` | Usuário MySQL com plugin incompatível. | `ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '070600@';` |
| `ECONNREFUSED` no banco | MySQL parado ou credenciais erradas. | Inicie o serviço (`services.msc`/`mysql.server start`) e valide `.env` (host, porta, senha). |
| Puppeteer falha no Linux | Dependências do Chrome headless ausentes. | `sudo apt-get install -y libnss3 libgbm-dev libxss1 libgtk-3-0 libasound2`. |
| Sessão WhatsApp expira | Arquivos em `sessions/` corrompidos. | Pare servidor, remova pasta do device (use `utils/safeRmSession.js`), reinicie e leia novo QR. |

---

## Contribuição
1. Crie branch: `git checkout -b feature/minha-feature`.
2. Commits descritivos: `git commit -m "feat: adiciona filtro X"`.
3. Abra Pull Request com descrição, prints e testes executados.

---

## Referências Técnicas
- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)
- [Google Generative AI (Gemini)](https://ai.google.dev/)
- [Sequelize ORM](https://sequelize.org/master/)
- [Pug Template Engine](https://pugjs.org/api/getting-started.html)
- [Chart.js](https://www.chartjs.org/)
- [Documentação Técnica](docs/TECHNICAL_DOCUMENTATION.md)

---

## Equipe de Desenvolvimento
| Nome | GitHub | RA |
| --- | --- | --- |
| Gustavo de Espindola Martins | [@gustavodees](https://github.com/gustavodees) | 10724238393 |
| Gustavo Godinho | [@gustavo-godinho](https://github.com/gustavo-godinho) | 10724268995 |
| Júlio Cesar de Souza Mauro | [@JcMauro](https://github.com/JcMauro) | 10724269838 |
| Kaike Augusto Dias dos Santos | [@KaikeDiaz](https://github.com/KaikeDiaz) | 10725113309 |
| Vitor Steinbach | [@steinbachvitor](https://github.com/steinbachvitor) | 10724268585 |

---

| Service Management Platform — Automatize. Inteligência. Escala. |
| Desenvolvido com excelência acadêmica e visão empresarial. |
| UNISUL © 2025 — Todos os direitos reservados. |

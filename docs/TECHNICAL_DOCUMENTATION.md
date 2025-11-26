# Service Management Platform — Documentação Técnica

> Documento produzido para fornecer uma visão profissional e completa sobre a arquitetura, os módulos e os fluxos críticos do projeto. Destinado a engenheiros de software, novos contribuidores e equipes de operação.

---

## 1. Visão Geral do Sistema

A plataforma Service Management é um ecossistema Node.js focado em automação de atendimento via WhatsApp, englobando chatbot generativo (Gemini), dashboards administrativos, disparos em massa e auditoria detalhada. O backend expõe rotas Express, renderiza views Pug e coordena sincronizações com o WhatsApp via `whatsapp-web.js` e Puppeteer. O frontend consome essas rotas, utiliza Chart.js para analytics e mantém sessões seguras com `express-session`.

### Stack Tecnológico

| Camada | Tecnologias-chave |
| --- | --- |
| Runtime / Servidor | Node.js 18+, Express 4.x, Pug 3 |
| Persistência | MySQL 8+ via Sequelize (models em `routes/*.js`) |
| Mensageria WhatsApp | `whatsapp-web.js`, Puppeteer, wss WebSocket nativo |
| IA Generativa | `@google/generative-ai`, prompt em `ia-treinamento.txt` |
| Segurança | Helmet, express-session, bcrypt, speakeasy (MFA), rate limiters |
| UI | Pug templates, CSS modular em `public/stylesheets`, JS em `public/javascripts`, Chart.js |

---

## 2. Arquitetura Lógica

### 2.1 Backend HTTP / WebSocket
- `app.js` concentra middlewares (helmet, cookie parser, JSON, session), registra rotas (`index`, `users`, `admin`, `api`, `chatbot`), injeta helpers (`logActivity`) e instancia um `WebSocketServer` repassado ao `whatsappManager`.
- `bin/www` realiza apenas o bootstrap HTTP padrão do Express.
- WebSockets: QR Codes, status de sincronização e notificações em tempo real são emitidos via `whatsappManager.whatsappEvents` → `wss` (filtro por `empresa_id`).

### 2.2 Data Layer
- Conexão central em `routes/banco.js` (Sequelize) carregada por `startBD.js` e `app.js`.
- Models definidos dentro de `routes/`: `Usuario`, `Empresa`, `Conversation`, `WhatsappDevice`, `WhatsappMessage`, `WhatsappMedia`, `Tabulacao`, `ActivityLog`.
- Migrações / seeds iniciais em `00*.sql` e `template_*.sql.txt`.

### 2.3 Integração WhatsApp & Chatbot
- `routes/whatsappManager.js`: gerencia múltiplos clientes WhatsApp, sincroniza conversas, armazena mídia/mensagens e propaga eventos para o front.
- `routes/whatsappDevice.js` + `routes/chatbotDevice.js`: persistem metadados de dispositivos.
- `routes/chatbot.js`: expõe rotas de treinamento e respostas IA, usando `ia-treinamento.txt` como base contextual.

### 2.4 Frontend Dinâmico
- Views Pug em `views/` (cada página possui JS/CSS dedicados).
- JS em `public/javascripts/` implementa dashboards (`grafico.js`, `dashboard.js`), atendimento (`atendimento-ws.js`), tabulação (`tabulacao.js`) e interações ricas.
- CSS modular em `public/stylesheets/` garante componentização visual (landing, dashboard, atendimento, chatbot etc.).

---

## 3. Organização do Repositório

```
service-management/
├── app.js
├── bin/www
├── public/
│   ├── javascripts/
│   └── stylesheets/
├── routes/
│   ├── ActivityLog.js
│   ├── admin.js
│   ├── api.js
│   ├── chatbot.js / chatbotDevice.js
│   ├── Conversation.js / WhatsappMessage.js / WhatsappMedia.js
│   ├── Empresa.js / Usuario.js / WhatsappDevice.js
│   ├── index.js / users.js / Tabulacao.js / tabulacaoHelper.js
│   └── whatsapp.js / whatsappManager.js / whatsappDevice.js
├── utils/
│   ├── logActivity.js
│   └── safeRmSession.js
├── scripts/ (manutenção de dados)
├── views/ (templates Pug)
├── public/ (assets estáticos)
├── docs/TECHNICAL_DOCUMENTATION.md  ← ESTE DOCUMENTO
└── *.sql, template_*.sql.txt, ia-treinamento.txt
```

### Destaques por diretório / arquivo

| Caminho | Responsabilidade |
| --- | --- |
| `app.js` | Configuração Express, sessions, helmet, WebSocket e injeção de rotas/helpers. |
| `routes/index.js` | Fluxo de login padrão, dashboards iniciais, rotas públicas e páginas genéricas. |
| `routes/admin.js` | Autenticação admin/super_admin, aprovação de empresas, MFA, gestão avançada. |
| `routes/users.js` | Funcionalidades da área logada (atendimento, disparos, tabulação, gráficos, impersonação). |
| `routes/api.js` | API REST usada pelo front para contatos, tabulações, mídia, notificações de atendimento. |
| `routes/whatsappManager.js` | Classe que encapsula sessões WhatsApp, sincronização, notificações e utilitários. |
| `routes/ActivityLog.js` + `utils/logActivity.js` | Modelo e helper centralizados para auditoria estruturada. |
| `public/javascripts/*` | Camada de interação no browser (Chart.js, WebSocket de atendimento, dashboards, chatbot). |
| `views/*.pug` | Templates com herança `layout.pug`, cada qual injeta assets específicos. |
| `scripts/*.js` | Utilitários CLI: sincronizar modelos (`sync_models`), limpar dados (`clear-data`), reparar timestamps, etc. |
| `sessions/` e `routes/sessions/` | Armazenamento local das sessões WhatsApp/Chatbot (ignoradas pelo Git). |

---

## 4. Modelos e Helpers Essenciais

| Arquivo | Campos-chave | Observações |
| --- | --- | --- |
| `routes/Usuario.js` | `nome`, `email`, `senha`, `tipo`, `empresa_id`, MFA (`mfa_secret`, `mfa_enabled`) | Controla perfis admin, operadores e super_admin. |
| `routes/Empresa.js` | Identificação jurídica, status de aprovação, limites de licença | Utilizado em onboarding / aprovação. |
| `routes/WhatsappDevice.js` | `device_id`, `empresa_id`, `status`, `number`, `last_connected` | Controla múltiplas instâncias conectadas. |
| `routes/Conversation.js` | Metadados de chats sincronizados (nome, última mensagem, contadores) |
| `routes/WhatsappMessage.js` / `routes/WhatsappMedia.js` | Persistem histórico e mídias (base64) para atendimento / download on-demand. |
| `routes/Tabulacao.js` | Registra classificação dos contatos (status, observações, aniversários). |
| `routes/ActivityLog.js` | Auditoria com `user_id`, `empresa_id`, `action`, `details`, `timestamp`. |
| `utils/logActivity.js` | Helper assíncrono para registrar ações sem duplicação de código. |
| `utils/safeRmSession.js` | Remove diretórios de sessão com validações para evitar exclusões indevidas. |

---

## 5. Rotas e Responsabilidades

### 5.1 `routes/index.js`
- Páginas públicas (`/`, `/login`, landing), registro de empresas/usuários, recuperação de senha.
- Autenticação padrão (`POST /login`), criação da sessão (`req.session.usuario`).
- Renderização de dashboards gerais (`/dashboard`, `/super-dashboard`).

### 5.2 `routes/admin.js`
- `GET/POST /admin/login`: autenticação com rate limiting.
- `GET/POST /admin/mfa-verify`: segundo fator via speakeasy/qrcode.
- `GET /admin/aprovar-empresas` e `POST /admin/aprovar|rejeitar-empresa/:id`: fluxo de aprovação.
- Gestão de WhatsApp devices, usuários e logs avançados (acesso restrito `verificaAutenticacao` + `verificaAcessoMestre`).

### 5.3 `routes/users.js`
- Disparo em massa (`/desparar`, `/despara/enviar`) com validação e delays randômicos.
- Atendimento (`/atendimento`, `/atendimento/:id`) com impersonação para admins.
- Tabulação (`/tabulacao`, `/tabulacao/:id`) e gráficos (`/grafico`, `/grafico/:id`, `/grafico-data`).
- Exibição de usuários cadastrados com botões de Graph/Tabulação e enforcement de empresa.

### 5.4 `routes/api.js`
- `/api/contacts`: consolidação de conversas.
- `/api/tabulacoes`/`POST /api/tabular`/`POST /api/tabulacoes/retornar`: CRUD de tabulações.
- `/api/media`: entrega de mídia armazenada.
- Notificações para front mandando `whatsappManager.notify*` em cada operação sensível.

### 5.5 Serviços WhatsApp / Chatbot
- `routes/whatsapp.js`, `routes/whatsappDevice.js`: endpoints para conectar/desconectar devices, emitir QR, consultar status.
- `routes/whatsappManager.js`: classe com ~1k linhas abrangendo:
  - Inicialização (`initializeClient`) com `LocalAuth` e `dataPath` em `routes/sessions`.
  - Eventos `qr`, `ready`, `message_create`, `message_ack`, `disconnected`.
  - Persistência incremental (`WhatsappMessage.upsert`, `WhatsappMedia.create`, `Conversation.upsert`).
  - Sincronização de chats com controle de concorrência (`syncChats`, `MESSAGE_FETCH_LIMIT`).
  - Broadcasts WebSocket: `qr_update`, `whatsapp-connected`, `sync-started`, `chat-tabulated`, `chat-returned`.

### 5.6 Outros arquivos de rota
- `routes/ActivityLog.js` + `routes/ActivityLog` view: listagem com filtros por empresa (super_admin) e data.
- `routes/chatbot.js`: interface de treinamento e execução do bot usando Gemini.
- `routes/Tabulacao.js` + `routes/tabulacaoHelper.js`: modelo e agregador reutilizado por rotas e API.
- `routes/verificaAutenticacao.js` / `routes/verificaAcessoMestre.js`: middlewares reutilizáveis de autorização.

---

## 6. Fluxos Operacionais Críticos

### 6.1 Autenticação e Controle de Acesso
1. Usuário acessa `/login` (ou `/admin/login`).
2. Crendencias verificadas em `routes/index.js` ou `routes/admin.js`; senha comparada via bcrypt.
3. Sessão Express configurada com `sessionMiddleware` em `app.js` e salva em storage default (memory / custom store se plugado).
4. Para admins com MFA, `speakeasy` gera/verifica tokens TOTPs antes de liberar dashboards.
5. Middlewares `verificaAutenticacao` e `verificaAcessoMestre` protegem rotas e armazenam contexto (empresa, impersonação).

### 6.2 Onboarding de Empresas e Usuários
1. Solicitação via formulários em `views/cadastro-empresa.pug` e `views/cadastro.pug`.
2. Registros ficam com `status=1` até aprovação (`/admin/aprovar-empresas`).
3. Ao aprovar, `logActivity` grava `COMPANY_APPROVED`; rejeições viram `COMPANY_REJECTED`.
4. Usuários admins associados à empresa passam a conseguir conectar devices e gerenciar equipes.

### 6.3 Conexão do WhatsApp / Chatbot
1. Admin inicia processo em `/conectZap` ou `/conectBot`.
2. `whatsappManager.initializeClient` cria um `Client` com `LocalAuth`. QR é emitido via WebSocket (`qr_update`).
3. Após leitura do QR, evento `ready` marca `WhatsappDevice` como `connected`, dispara sincronização automática (`syncChats`) e envia `sync-started` para front (com `taskId`).
4. Mensagens recebidas geram `WhatsappMessage`/`WhatsappMedia` + notificações; erros ou desconexões atualizam status e instruem o usuário a reconectar.

### 6.4 Atendimento e Tabulação
1. Operador acessa `/users/atendimento`; lista de contatos carregada via `/api/contacts`.
2. Chat selecionado exibe histórico persistido. Operações de tabulação usam `/api/tabular`.
3. `tabulacaoHelper.getTabulacoesGrouped` garante agregação consistente por status e usuário/equipe.
4. Admins podem impersonar operadores (`/atendimento/:id`) e visualizar métricas/atendimentos do time.

### 6.5 Disparo em Massa
1. Página `/users/disparar` coleta números e mensagem.
2. POST `/users/despara/enviar` valida entradas, identifica dispositivo (`whatsapp` ou `chatbot`), obtém client via `whatsappManager` ou módulo do chatbot e envia uma a uma com `randomDelay`.
3. Resultados são retornados com status por número e auditados via `logActivity` (`MASS_MESSAGE_DISPATCH`).

### 6.6 Analytics / Gráfico de Tabulação
1. `/users/grafico` renderiza view `grafico.pug` com combos de seleção para admin/super_admin.
2. `public/javascripts/grafico.js` determina o endpoint correto (`/users/grafico-data` com `scope` ou `userId`) e consome JSON.
3. Chart.js desenha pizza com gradientes; legendas são construídas via DOM.
4. Atualizações periódicas (30s) asseguram dados frescos.

### 6.7 Logging e Auditoria
1. `utils/logActivity` é chamado em todos os pontos críticos (aprovação de empresa, disparo, tabulação, login, alterações de perfil etc.).
2. Registros ficam em `activity_logs`, relacionando usuários e empresas (ON DELETE SET NULL).
3. `views/activity-logs.pug` exibe filtros por usuário, ação, período e (para super_admin) dropdown "Todas as empresas".
4. Logs suportam rastreabilidade para incidentes e compliance.

---

## 7. Views, Frontend JS e CSS

| View | Descrição | Assets principais |
| --- | --- | --- |
| `views/layout.pug` | Layout base com cabeçalho, sidebar e injeção de scripts/css. | `public/stylesheets/layout.css` |
| `views/login.pug`, `admin-login.pug` | Fluxos de autenticação padrão/admin. | `public/stylesheets/login.css`, `public/javascripts/login.js` |
| `views/atendimento.pug` | Console de atendimento com WebSocket e tabulações. | `public/javascripts/atendimento-ws.js`, `public/stylesheets/atendimento.css` |
| `views/usuariocadastrado.pug` | Lista de usuários com ações (Editar, Deletar, Gráfico, Tabulação). | `public/stylesheets/usuarioCadastrado.css` |
| `views/grafico.pug` | Dashboard de tabulação (Chart.js). | `public/javascripts/grafico.js`, `public/stylesheets/grafico.css` |
| `views/super-admin-dashboard.pug` | Visão global com filtros de empresa e logs. | `public/javascripts/super-admin-dashboard.js`, `public/stylesheets/super-admin-dashboard.css` |

Os arquivos em `public/javascripts/` seguem padrão IIFE para evitar lixo global. CSS prioriza BEM/escopos por página para prevenir conflitos.

---

## 8. Integrações Externas

- **WhatsApp**: `whatsapp-web.js` via Puppeteer headless. Autenticação persistente (`LocalAuth`) salva caches em `routes/sessions/`. `safeRmSession.js` auxilia na limpeza segura.
- **Google Generative AI (Gemini)**: usado no chatbot (`routes/chatbot.js`); prompt base em `ia-treinamento.txt` pode ser editado via painel `/ia`.
- **Qrcode**: renderização server-side para dispositivos.
- **Speakeasy**: TOTPs para MFA de administradores host/super_admin.
- **Chart.js**: dashboards de tabulação e acompanhamento.

---

## 9. Scripts e Templates de Dados

| Script | Função |
| --- | --- |
| `scripts/sync_models.js` | Sincroniza todas as models com o banco (útil em desenvolvimento). |
| `scripts/fix_timestamps.js` | Corrige timestamps inconsistentes em mensagens/conversas. |
| `scripts/createChocolateUser.js` | Cria usuário "chocolate" (seed) para testes. |
| `scripts/fill_message_userids_from_devices.js` | Popular relacionamentos faltantes entre mensagens e dispositivos. |
| `scripts/migrate_media_from_messages_to_media.js` | Normaliza mídia para tabela dedicada. |
| `scripts/validate_and_fetch_chat.js` | Diagnóstico e validação de chats/mensagens. |
| `clear-data.js` | Truncate seguro das tabelas de atendimento (usar somente em ambiente controlado). |
| `startBD.js` | Bootstrap CLI: autentica no banco, registra models e executa `sequelize.sync({ alter: true })`. |
| `template_*.sql.txt` & `00*.sql` | Scripts SQL prontos para criação de dados de exemplo (empresas, usuários, conversas). |

---

## 10. Configuração, Deploy e Operação

1. **Variáveis de ambiente (`.env`)** – ver README: PORT, credenciais MySQL, `GOOGLE_API_KEY`, `SESSION_DIR`, configurações de sincronização (`SYNC_MESSAGE_LIMIT`, etc.).
2. **Instalação** – `npm install` seguido de `npm start` (ou `nodemon bin/www`).
3. **Banco** – executar `startBD.js` ou scripts SQL para provisionar tabelas. Ajustar charset `utf8mb4` para suportar emojis.
4. **Sessões WhatsApp** – garantir que diretório `sessions/` exista e não seja versionado (já listado no `.gitignore`). Em produção usar storage persistente (volume/disco) e restrições de permissão.
5. **WebSockets** – se houver proxy (NGINX), habilitar upgrade WS para `/`.
6. **Segurança** –
   - Helmet com CSP pré-configurado (permitindo CDNs necessários).
   - Session cookies `httpOnly`, `sameSite=lax`, `secure` em produção.
   - Rate limiters em logins admin.
   - MFA opcional via `speakeasy`.
   - `express-validator` disponível para sanitizar inputs (adicionar conforme novas rotas).

---

## 11. Observabilidade e Boas Práticas

- **Logging Estruturado**: preferir `logActivity` para toda ação de negócio relevante; guardar `req.ip` e detalhes textuais amigáveis.
- **Erro vs Auditoria**: use `console.error` apenas para troubleshooting durante desenvolvimento; considerer futuro `winston`/`pino` para produção.
- **Sessões e Cache**: arquivos em `routes/sessions/` podem crescer rapidamente; use `safeRmSession` para apagar entradas órfãs antes de recriar dispositivos.
- **Escalabilidade**: `whatsappManager` suporta múltiplos dispositivos por empresa; observar limites do `puppeteer` ao escalar.
- **Testing**: não há suíte automatizada; recomenda-se introduzir testes integrais (Jest/Supertest) principalmente para `routes/api.js` e helpers críticos.

---

## 12. Próximos Passos Recomendados

1. **Documentar contratos REST** com OpenAPI para facilitar integrações externas.
2. **Adicionar testes automatizados** para fluxos sensíveis (tabulação, disparo, aprovação de empresas).
3. **Externalizar sess
dados** para Redis/PostgreSQL para suportar múltiplas instâncias da aplicação.
4. **Observabilidade**: integrar Application Insights ou Prometheus para métricas de dispositivos e filas de sincronização.
5. **Hardening**: revisar CSP para incluir somente domínios necessários e ativar CSRF (`csurf`) quando o escopo de tokens estiver definido.

---

*Documento mantido em `docs/TECHNICAL_DOCUMENTATION.md`. Atualize-o sempre que um módulo/rota for alterado para manter alinhamento entre funções e arquivos.*

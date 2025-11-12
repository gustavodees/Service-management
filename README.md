# 🧾 Service-management - Automação WhatsApp e IA

## 🧭 Descrição do Projeto

O **Service-management** é um sistema desenvolvido como parte das disciplinas **Sistemas Distribuídos e Mobile** e **Usabilidade, Desenvolvimento Web, Mobile e Jogos** da **Universidade do Sul de Santa Catarina (UNISUL)**.

Seu objetivo é permitir o **gerenciamento centralizado de interações com clientes via WhatsApp**, integrando **Node.js**, **MySQL** e **Pug**.  
O projeto utiliza a biblioteca `whatsapp-web.js` para automação e `Sequelize` para persistência de dados.

O núcleo do sistema é um **chatbot integrado com a API Google Generative AI**, treinado para responder dúvidas sobre **modalidades de crédito**, além de um **painel de disparo em massa** para campanhas de marketing.

---

## 👥 Alunos

- Gustavo de Espindola Martins — [gustavodees](https://github.com/gustavodees) — RA: 10724238393  
- Gustavo Godinho — [gustavo-godinho](https://github.com/gustavo-godinho) — RA: 10724268995  
- Júlio Cesar de Souza Mauro — [JcMauro](https://github.com/JcMauro) — RA: 10724269838  
- Kaike Augusto Dias dos Santos — [KaikeDiaz](https://github.com/KaikeDiaz) — RA: 10725113309  
- Vitor Steinbach — [steinbachvitor](https://github.com/steinbachvitor) — RA: 10724268585

---

## ✨ Principais Funcionalidades

- **Gestão de Dispositivos**: conectar e gerenciar múltiplas sessões do WhatsApp (via QR Code) e do Chatbot (`/conectZap`, `/conectBot`).
- **Chatbot com Google AI**: integração com `@google/generative-ai`, utilizando o arquivo `ia-treinamento.txt` como base de conhecimento.
- **Disparo em Massa**: envio de mensagens automáticas e personalizadas em lote via `/desparaWhats`.
- **Painel Administrativo**:
  - Cadastro e listagem de usuários (`/cadastro`, `/usuariocadastrado`)
  - Gráficos de desempenho da equipe (`/grafico`) com `Chart.js`
  - Editor de treinamento de IA (`/ia`)
- **Comunicação em Tempo Real**: via `WebSocket (ws)` tanto para o chatbot quanto para o atendimento humano.

---

## 🛠️ Tecnologias e Dependências

| Tecnologia / Biblioteca | Finalidade |
| :---------------------- | :---------- |
| **Node.js 18+** | Ambiente de execução |
| **Express.js** | Framework para rotas e servidor HTTP |
| **MySQL Server (via XAMPP)** | Banco de dados |
| **Sequelize** | ORM para MySQL |
| **Pug (Jade)** | Template engine para views |
| **whatsapp-web.js** | Automação de mensagens WhatsApp |
| **@google/generative-ai** | Integração com IA do Google |
| **bcrypt** | Criptografia de senhas |
| **ws (WebSockets)** | Comunicação em tempo real |
| **dotenv** | Gerenciamento de variáveis de ambiente |
| **puppeteer** | Automação de navegador usada pelo WhatsApp Web |

---

## 🚀 Como Executar o Projeto

### 1️⃣ Pré-requisitos

Antes de iniciar, certifique-se de ter instalado:

- [Node.js 18+](https://nodejs.org/en/download)  
- [XAMPP (ou outro serviço MySQL)](https://www.apachefriends.org/pt_br/index.html)  
- **Google Chrome** (necessário para o Puppeteer)  
- (Opcional) **Git** para clonar o repositório

---

### 2️⃣ Clonando o projeto

```bash
git clone https://github.com/SEU_USUARIO/service-management.git
cd service-management

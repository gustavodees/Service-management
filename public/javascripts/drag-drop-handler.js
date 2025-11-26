/**
 * Habilita arrastar/soltar arquivos diretamente no painel do chat e envia o
 * conteúdo via endpoint /upload-files, exibindo overlay visual.
 */
document.addEventListener('DOMContentLoaded', () => {
  // O alvo da nossa funcionalidade é o painel do chat.
  const chatPanel = document.querySelector('.chat-panel');

  // Se não encontrarmos o painel do chat, não fazemos nada.
  if (!chatPanel) {
    return;
  }

  // Garante que o painel do chat possa conter o overlay.
  chatPanel.style.position = 'relative';

  let dragCounter = 0;

  // Cria o elemento do overlay dinamicamente.
  const overlay = document.createElement('div');
  overlay.className = 'drag-drop-overlay';
  overlay.innerHTML = `
    <div style="text-align: center;">
      <i class="fas fa-upload" style="font-size: 48px; margin-bottom: 15px;"></i>
      <span style="display: block; font-size: 1.5rem; font-weight: 600;">Solte o arquivo para enviar</span>
    </div>
  `;
  chatPanel.appendChild(overlay);

  // Função para fazer o upload dos arquivos.
  const uploadFiles = async (files) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    try {
      const response = await fetch('/upload-files', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();
      if (result.success) {
        console.log('Upload bem-sucedido:', result);
        alert(`${files.length} arquivo(s) enviado(s) com sucesso!`);
      } else {
        throw new Error(result.message || 'Falha no upload.');
      }
    } catch (error) {
      console.error('Erro no upload:', error);
      alert('Ocorreu um erro ao enviar os arquivos.');
    }
  };

  // Mostra o overlay quando um arquivo entra na área do chat.
  chatPanel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    chatPanel.classList.add('drag-over');
  });

  // Necessário para que o evento 'drop' funcione.
  chatPanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // Esconde o overlay quando o arquivo sai da área do chat.
  chatPanel.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter === 0) {
      chatPanel.classList.remove('drag-over');
    }
  });

  // Lida com o arquivo que foi solto na área.
  chatPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    chatPanel.classList.remove('drag-over');

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
      e.dataTransfer.clearData();
    }
  });
});
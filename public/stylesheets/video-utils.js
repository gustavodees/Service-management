/**
 * public/javascripts/video-utils.js
 * Small helper utilities for validating and sending video files from the UI.
 * Responsibilities:
 * - Validate video mime types and size limits before upload.
 * - Send video either via WebSocket (WhatsApp) or HTTP (chatbot) depending on
 *   the current chat context.
 *
 * Exposes `window.VideoUtils = { isValidVideo, sendVideo }`.
 */
(function () {
  // isValidVideo(file)
  // - Validate accepted mime types and maximum file size.
  function isValidVideo(file) {
    const validVideoTypes = [
      'video/mp4', 'video/3gpp', 'video/3gp', 'video/avi', 'video/mov',
      'video/quicktime', 'video/m4v', 'video/mpeg', 'video/mpg', 'video/webm'
    ];
    const maxSizeMB = 64;
    if (!validVideoTypes.includes(file.type)) {
      return { valid: false, error: `Tipo de vídeo não suportado: ${file.type}` };
    }
    if (file.size > maxSizeMB * 1024 * 1024) {
      return { valid: false, error: `O vídeo excede o limite de ${maxSizeMB}MB.` };
    }
    return { valid: true };
  }

  // sendVideo(file, chatId, wsWhatsapp, currentDeviceId)
  // - Reads the file as base64 and sends it either via WebSocket (if
  //   connected to WhatsApp) or via HTTP to chatbot endpoint. Returns a Promise
  //   that resolves on success or rejects on error.
  async function sendVideo(file, chatId, wsWhatsapp, currentDeviceId) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = async function (e) {
        let base64 = e.target.result.split(',')[1];
        if (!base64) {
          reject('Erro ao processar o vídeo. O arquivo pode estar corrompido.');
          return;
        }
        // Remove prefixo se existir (defensivo)
        base64 = base64.replace(/^data:.*;base64,/, '');

        const payload = {
          chatId,
          filename: file.name,
          mimetype: file.type,
          data: base64
        };
        if (wsWhatsapp && wsWhatsapp.readyState === WebSocket.OPEN) {
          // WhatsApp via WebSocket
          try {
            wsWhatsapp.send(JSON.stringify({
              type: 'send-media',
              ...payload,
              deviceId: currentDeviceId,
              fileSizeBytes: file.size
            }));
            resolve('Vídeo enviado via WhatsApp.');
          } catch (err) {
            reject(`Erro ao enviar o vídeo: ${err.message}`);
          }
        } else {
          // Chatbot via HTTP
          try {
            const resp = await fetch('/chatbot/send-media', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            }).then(r => r.json());
            if (!resp.success) throw new Error(resp.error || 'Falha ao enviar vídeo (chatbot)');
            resolve('Vídeo enviado via chatbot.');
          } catch (err) {
            reject('Erro ao enviar vídeo via chatbot: ' + (err.message || err));
          }
        }
      };
      reader.onerror = function () {
        reject('Erro ao ler o arquivo de vídeo.');
      };
      reader.readAsDataURL(file);
    });
  }

  window.VideoUtils = { isValidVideo, sendVideo };
})();

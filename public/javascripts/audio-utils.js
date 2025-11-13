/**
 * public/javascripts/audio-utils.js
 * Utilities for client-side audio processing used by the Atendimento UI.
 * Responsibilities:
 * - Convert recorded audio blobs to MP3 (using lamejs when available).
 * - Resample audio to target sample rate.
 * - Validate audio blobs (size, presence).
 * - Create an optional waveform visualization for display in the UI.
 *
 * NOTE: This file exposes a small API on window.AudioUtils. Do not change
 * executable logic here unless you understand the encoding/resampling flow.
 */
async function convertToMp3(audioBlob) {
  return new Promise((resolve, reject) => {
    try {
      const fileReader = new FileReader();
      fileReader.onload = function() {
        const arrayBuffer = this.result;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        audioContext.decodeAudioData(arrayBuffer)
          .then(audioBuffer => {
            // Configurações para MP3
            const sampleRate = 44100;
            const channels = 1; // Mono
            const bitRate = 128; // 128 kbps
            
            // Reamostrar se necessário
            let samples;
            if (audioBuffer.sampleRate !== sampleRate) {
              samples = resampleAudio(audioBuffer, sampleRate);
            } else {
              samples = audioBuffer.getChannelData(0);
            }
            
            // Converter para Int16Array
            const buffer = new Int16Array(samples.length);
            for (let i = 0; i < samples.length; i++) {
              const sample = Math.max(-1, Math.min(1, samples[i]));
              buffer[i] = sample < 0 ? sample * 32768 : sample * 32767;
            }
            
            // Inicializar encoder MP3
            const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, bitRate);
            const mp3Data = [];
            
            // Codificar em chunks
            const sampleBlockSize = 1152; // Tamanho padrão do bloco MP3
            for (let i = 0; i < buffer.length; i += sampleBlockSize) {
              const sampleChunk = buffer.subarray(i, i + sampleBlockSize);
              const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
              if (mp3buf.length > 0) {
                mp3Data.push(mp3buf);
              }
            }
            
            // Finalizar encoding
            const mp3buf = mp3encoder.flush();
            if (mp3buf.length > 0) {
              mp3Data.push(mp3buf);
            }
            
            // Criar blob MP3
            const mp3Blob = new Blob(mp3Data, { type: 'audio/mp3' });
            console.log('Áudio convertido para MP3:', {
              originalSize: audioBlob.size,
              mp3Size: mp3Blob.size,
              compression: ((audioBlob.size - mp3Blob.size) / audioBlob.size * 100).toFixed(2) + '%'
            });
            
            resolve(mp3Blob);
          })
          .catch(error => {
            console.error('Erro na decodificação do áudio:', error);
            reject(error);
          });
      };
      
      fileReader.onerror = function() {
        reject(new Error('Erro ao ler o arquivo de áudio'));
      };
      
      fileReader.readAsArrayBuffer(audioBlob);
    } catch (error) {
      console.error('Erro na conversão para MP3:', error);
      reject(error);
    }
  });
}

// Reamostragem:
// Recebe um AudioBuffer e reamostra o canal 0 para `targetSampleRate`.
// Retorna um Float32Array com os samples no novo sample rate.
function resampleAudio(audioBuffer, targetSampleRate) {
  const originalSampleRate = audioBuffer.sampleRate;
  const originalData = audioBuffer.getChannelData(0);
  const originalLength = originalData.length;
  
  const newLength = Math.round(originalLength * targetSampleRate / originalSampleRate);
  const newData = new Float32Array(newLength);
  
  const ratio = originalLength / newLength;
  
  for (let i = 0; i < newLength; i++) {
    const index = i * ratio;
    const indexInt = Math.floor(index);
    const indexFrac = index - indexInt;
    
    if (indexInt < originalLength - 1) {
      newData[i] = originalData[indexInt] * (1 - indexFrac) + originalData[indexInt + 1] * indexFrac;
    } else {
      newData[i] = originalData[indexInt] || 0;
    }
  }
  
  return newData;
}

// Validação do blob de áudio:
// - garante que o blob existe e não é vazio
// - garante que o tamanho não excede limites práticos (ex: 16MB para WhatsApp)
function validateAudioBlob(blob) {
  if (!blob || blob.size === 0) {
    throw new Error('Blob de áudio vazio ou inválido');
  }

  if (blob.size > 16 * 1024 * 1024) { // 16MB limite WhatsApp
    throw new Error('Arquivo de áudio muito grande (máximo 16MB)');
  }

  return true;
}

// Waveform helper:
// - desenha uma forma de onda simples no elemento <canvas> a partir de um AudioBuffer
function createWaveform(audioBuffer, canvas) {
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#128C7E';
  
  const data = audioBuffer.getChannelData(0);
  const step = Math.ceil(data.length / width);
  const amp = height / 2;
  
  for (let i = 0; i < width; i++) {
    let min = 1.0;
    let max = -1.0;
    
    for (let j = 0; j < step; j++) {
      const datum = data[(i * step) + j];
      if (datum < min) min = datum;
      if (datum > max) max = datum;
    }
    
    ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
  }
}

// Expose audio utilities on window for use by other client scripts
window.AudioUtils = {
  convertToMp3,
  validateAudioBlob,
  createWaveform
};
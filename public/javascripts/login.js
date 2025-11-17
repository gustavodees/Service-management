document.addEventListener('DOMContentLoaded', function() {
  const cnpjStep = document.getElementById('cnpj-step');
  const loginForm = document.getElementById('login-form');
  const checkCnpjBtn = document.getElementById('check-cnpj-btn');
  const cnpjInput = document.getElementById('cnpj-input');
  const companyNameEl = document.getElementById('company-name');
  const cnpjHiddenInput = document.getElementById('cnpj-hidden');
  const errorContainer = document.querySelector('.alert.alert-danger');

  // Adiciona a máscara de CNPJ
  cnpjInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    value = value.replace(/^(\d{2})(\d)/, '$1.$2');
    value = value.replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
    value = value.replace(/\.(\d{3})(\d)/, '.$1/$2');
    value = value.replace(/(\d{4})(\d)/, '$1-$2');
    e.target.value = value.slice(0, 18); // Limita o tamanho para o formato do CNPJ (XX.XXX.XXX/XXXX-XX)
  });

  checkCnpjBtn.addEventListener('click', async () => {
    const cnpj = cnpjInput.value;

    // Limpa erros anteriores
    const existingError = document.querySelector('.alert.alert-danger');
    if (existingError) existingError.style.display = 'none';

    // Validação mais robusta do CNPJ
    if (!cnpj || cnpj.length < 18) {
      displayError('Por favor, digite um CNPJ válido.');
      return;
    }

    // --- Inicia o estado de carregamento ---
    checkCnpjBtn.disabled = true;
    checkCnpjBtn.innerHTML = '<span class="spinner"></span> Verificando...';

    try {
      const response = await fetch('/api/validar-cnpj', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cnpj })
      });
      const result = await response.json();

      if (result.success) {
        companyNameEl.textContent = result.nome_fantasia;
        cnpjHiddenInput.value = cnpj;
        cnpjStep.style.display = 'none';
        loginForm.style.display = 'block';
      } else {
        displayError(result.message || 'CNPJ não encontrado ou inválido.');
      }
    } catch (error) {
      console.error('Erro ao validar CNPJ:', error);
      displayError('Não foi possível conectar ao servidor. Tente novamente mais tarde.');
    } finally {
      // --- Restaura o estado original do botão ---
      checkCnpjBtn.disabled = false;
      checkCnpjBtn.innerHTML = 'Continuar';
    }
  });

  function displayError(message) {
    let currentErrorContainer = document.querySelector('.alert.alert-danger');
    if (currentErrorContainer) {
      currentErrorContainer.textContent = message;
      currentErrorContainer.style.display = 'block';
    } else {
      const newAlert = document.createElement('div');
      newAlert.className = 'alert alert-danger';
      newAlert.textContent = message;
      document.querySelector('.login-box header').insertAdjacentElement('afterend', newAlert);
    }
  }
});
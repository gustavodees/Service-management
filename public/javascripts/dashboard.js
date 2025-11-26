/**
 * Controla o comportamento de colapsar/expandir a sidebar nos dashboards
 * internos, persistindo a preferência no localStorage.
 */
document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.querySelector('.toggle-menu a');
  const body = document.body;
  const mainContent = document.querySelector('.main-content');
  const sidebarStateKey = 'sidebarCollapsed';

  // Verifica o estado salvo no localStorage
  if (localStorage.getItem(sidebarStateKey) === 'true') {
    body.classList.add('sidebar-collapsed');
    if (mainContent) {
      mainContent.style.marginLeft = '80px';
    }
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      body.classList.toggle('sidebar-collapsed');
      
      // Salva o novo estado
      const isCollapsed = body.classList.contains('sidebar-collapsed');
      localStorage.setItem(sidebarStateKey, isCollapsed);

      if (mainContent) {
        mainContent.style.marginLeft = isCollapsed ? '80px' : '250px';
      }
    });
  }
});
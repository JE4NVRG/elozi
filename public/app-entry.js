// Keep recovery outside the application graph: even a failed module download must
// leave a way back from the initial loading screen, without clearing the session.
const app = document.querySelector('#app');
function recover() {
  if (!app?.querySelector('.loading')) return;
  const section = document.createElement('section');
  section.setAttribute('class', 'startup-error'); section.setAttribute('role', 'alert');
  const title = document.createElement('h1'); title.textContent = 'Não foi possível abrir o workspace.';
  const message = document.createElement('p'); message.textContent = 'Confira a conexão e tente novamente.';
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Tentar novamente';
  retry.addEventListener('click', () => location.reload());
  section.append(title, message, retry); app.textContent = ''; app.append(section);
}
const deadline = setTimeout(recover, 30000);
import('./app.js').catch(recover).finally(() => clearTimeout(deadline));

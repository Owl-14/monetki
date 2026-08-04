// Общие функции представления без привязки к конкретному экрану приложения.
export const $ = (selector, root = document) => root.querySelector(selector);

export const esc = (value) => String(value ?? '').replace(
  /[&<>"']/g,
  (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
);

export const money = (value) => `${new Intl.NumberFormat('ru-RU').format(Math.round(Number(value) || 0))} ₽`;

export const fmtDate = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};

export const fmtDT = (timestamp) => new Date(timestamp).toLocaleString('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export const today = () => new Date().toISOString().slice(0, 10);

export const telHref = (phone) => `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;

export function toast(text, isError = false) {
  const element = document.createElement('div');
  element.className = `toast${isError ? ' error' : ''}`;
  element.textContent = text;
  $('#toast-root').appendChild(element);
  setTimeout(() => element.remove(), 3200);
}

export function openModal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  $('.modal-backdrop', root).addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });
  if (onMount) onMount(root);
}

export function closeModal() {
  $('#modal-root').innerHTML = '';
}

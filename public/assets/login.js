import { api } from './common.js';

const form = document.getElementById('form');
const error = document.getElementById('error');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const data = new FormData(form);
    await api('/auth/login', { method: 'POST', body: { username: data.get('username'), password: data.get('password') } });
    location.href = '/';
  } catch (err) {
    error.textContent = err.message;
    btn.disabled = false;
  }
});

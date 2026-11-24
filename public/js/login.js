'use strict';
(() => {
  const form = document.getElementById('entrar');
  const erro = document.getElementById('erro');
  const botao = document.getElementById('botao');
  document.getElementById('usuario').focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erro.textContent = '';
    botao.disabled = true;
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({
          usuario: document.getElementById('usuario').value.trim(),
          senha: document.getElementById('senha').value,
        }),
      });
      if (r.ok) {
        location.href = '/';
        return;
      }
      const d = await r.json().catch(() => null);
      erro.textContent = (d && d.erro) || 'Não foi possível entrar.';
    } catch {
      erro.textContent = 'Sem conexão com o servidor.';
    }
    botao.disabled = false;
  });
})();

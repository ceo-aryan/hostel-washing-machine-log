// Shared helpers used by all pages

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (_) {
    throw Object.assign(new Error('Cannot reach the server. Check your internet and try again.'), { code: 'network' });
  }
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    /* empty body */
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.message || 'Something went wrong. Try again.'), {
      code: data.error,
      status: res.status,
    });
  }
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function showMsg(el, text, type = 'error') {
  el.textContent = text;
  el.className = `msg ${type}`;
  el.hidden = !text;
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.href = '/';
  }
}

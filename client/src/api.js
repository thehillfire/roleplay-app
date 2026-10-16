async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request('GET', '/api/auth/me'),
  signup: (fields) => request('POST', '/api/auth/signup', fields).then((d) => d.user),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }).then((d) => d.user),
  logout: () => request('POST', '/api/auth/logout', {}),

  conversations: () => request('GET', '/api/conversations').then((d) => d.conversations),
  conversation: (id, before) => request('GET', `/api/conversations/${enc(id)}${before ? `?before=${before}` : ''}`),
  send: (id, body) => request('POST', `/api/conversations/${enc(id)}/messages`, { body }),
  connect: (id, name, contact) => request('POST', `/api/conversations/${enc(id)}/connect`, { name, contact: contact || undefined }),
  declineConnect: (id) => request('POST', `/api/conversations/${enc(id)}/connect/decline`, {}),
  cancelConnect: (id) => request('POST', `/api/conversations/${enc(id)}/connect/cancel`, {}),
  checkout: () => request('POST', '/api/billing/checkout', {}),
  block: (id) => request('POST', `/api/conversations/${enc(id)}/block`, {}),
  report: (id, reason, details) => request('POST', `/api/conversations/${enc(id)}/report`, { reason, details }),
  markRead: (id) => request('POST', `/api/conversations/${enc(id)}/read`, {}),
};

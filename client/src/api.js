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
  forgot: (email) => request('POST', '/api/auth/forgot', { email }),
  reset: (token, password) => request('POST', '/api/auth/reset', { token, password }),

  conversations: () => request('GET', '/api/conversations').then((d) => d.conversations),
  conversation: (id, before) => request('GET', `/api/conversations/${enc(id)}${before ? `?before=${before}` : ''}`),
  send: (id, body) => request('POST', `/api/conversations/${enc(id)}/messages`, { body }),
  feedback: (id, helpful) => request('POST', `/api/conversations/${enc(id)}/feedback`, { helpful }),
  presence: () => request('GET', '/api/presence'),
  connect: (id, name, contact) => request('POST', `/api/conversations/${enc(id)}/connect`, { name, contact: contact || undefined }),
  declineConnect: (id) => request('POST', `/api/conversations/${enc(id)}/connect/decline`, {}),
  cancelConnect: (id) => request('POST', `/api/conversations/${enc(id)}/connect/cancel`, {}),
  pushSubscribe: (subscription) => request('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint) => request('POST', '/api/push/unsubscribe', { endpoint }),
  deleteAccount: (password) => request('POST', '/api/account/delete', { password }),
  checkout: () => request('POST', '/api/billing/checkout', {}),
  admin: {
    reports: (status = 'open') => request('GET', `/api/admin/reports?status=${status}`).then((d) => d.reports),
    resolve: (id, resolution) => request('POST', `/api/admin/reports/${enc(id)}/resolve`, { resolution }),
    held: () => request('GET', '/api/admin/held').then((d) => d.messages),
    setStatus: (userId, status) => request('POST', `/api/admin/users/${enc(userId)}/status`, { status }),
  },
  block: (id) => request('POST', `/api/conversations/${enc(id)}/block`, {}),
  report: (id, reason, details) => request('POST', `/api/conversations/${enc(id)}/report`, { reason, details }),
  markRead: (id) => request('POST', `/api/conversations/${enc(id)}/read`, {}),
};

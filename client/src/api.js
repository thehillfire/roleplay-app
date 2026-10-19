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
  // The session ended elsewhere (signed out everywhere, expired, account removed): let the app go to sign-in.
  // Only a missing session counts; a wrong password (e.g. confirming a deletion) is a normal error.
  if (res.status === 401 && data.code === 'signed_out') window.dispatchEvent(new Event('kindred:signed-out'));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request('GET', '/api/auth/me'),
  signup: (fields) => request('POST', '/api/auth/signup', fields).then((d) => d.user),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }).then((d) => d.user),
  logout: () => request('POST', '/api/auth/logout', {}),
  logoutAll: () => request('POST', '/api/auth/logout-all', {}),
  verify: (token) => request('POST', '/api/auth/verify', { token }),
  resendVerification: () => request('POST', '/api/auth/resend-verification', {}),
  forgot: (email) => request('POST', '/api/auth/forgot', { email }),
  socialStart: (body) => request('POST', '/api/auth/social/start', body),
  reset: (token, password) => request('POST', '/api/auth/reset', { token, password }),

  conversations: () => request('GET', '/api/conversations').then((d) => d.conversations),
  conversation: (id, before) => request('GET', `/api/conversations/${enc(id)}${before ? `?before=${before.createdAt}&beforeId=${enc(before.id)}` : ''}`),
  react: (id, messageId, reaction) => request('POST', `/api/conversations/${enc(id)}/messages/${enc(messageId)}/react`, { reaction }),
  unsend: (id, messageId) => request('POST', `/api/conversations/${enc(id)}/messages/${enc(messageId)}/unsend`, {}),
  send: (id, body) => request('POST', `/api/conversations/${enc(id)}/messages`, { body }),
  kindWords: () => request('GET', '/api/kind-words').then((d) => d.kindWords),
  sendKindWords: (id, note) => request('POST', `/api/conversations/${enc(id)}/kind-words`, { note }),
  hideKindWords: (id) => request('POST', `/api/kind-words/${enc(id)}/hide`, {}),
  feedback: (id, helpful) => request('POST', `/api/conversations/${enc(id)}/feedback`, { helpful }),
  checkins: () => request('GET', '/api/checkins').then((d) => d.checkins),
  checkin: (day, mood) => request('POST', '/api/checkins', { day, mood }).then((d) => d.checkins),
  presence: () => request('GET', '/api/presence'),
  connect: (id, name, contact) => request('POST', `/api/conversations/${enc(id)}/connect`, { name, contact: contact || undefined }),
  declineConnect: (id) => request('POST', `/api/conversations/${enc(id)}/connect/decline`, {}),
  cancelConnect: (id) => request('POST', `/api/conversations/${enc(id)}/connect/cancel`, {}),
  pushSubscribe: (subscription) => request('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint) => request('POST', '/api/push/unsubscribe', { endpoint }),
  setListenerAlerts: (on) => request('POST', '/api/account/listener-alerts', { on }),
  support: () => request('GET', '/api/support').then((d) => d.requests),
  sendSupport: (topic, message) => request('POST', '/api/support', { topic, message }),
  dismissNotice: () => request('POST', '/api/account/notice/dismiss', {}),
  deleteAccount: (password) => request('POST', '/api/account/delete', { password }),
  checkout: () => request('POST', '/api/billing/checkout', {}),
  subscribePlus: () => request('POST', '/api/billing/plus', {}),
  billingPortal: () => request('POST', '/api/billing/portal', {}),
  appeal: () => request('GET', '/api/appeal').then((d) => d.appeal),
  sendAppeal: (message) => request('POST', '/api/appeal', { message }).then((d) => d.appeal),
  admin: {
    stats: () => request('GET', '/api/admin/stats'),
    log: () => request('GET', '/api/admin/log').then((d) => d.actions),
    appeals: () => request('GET', '/api/admin/appeals').then((d) => d.appeals),
    resolveAppeal: (id, restore, note) => request('POST', `/api/admin/appeals/${enc(id)}/resolve`, { restore, note: note || undefined }),
    reports: (status = 'open') => request('GET', `/api/admin/reports?status=${status}`).then((d) => d.reports),
    resolve: (id, resolution) => request('POST', `/api/admin/reports/${enc(id)}/resolve`, { resolution }),
    support: () => request('GET', '/api/admin/support').then((d) => d.requests),
    resolveSupport: (id, reply) => request('POST', `/api/admin/support/${enc(id)}/resolve`, { reply }),
    reviewHeld: (id, release) => request('POST', `/api/admin/held/${enc(id)}/review`, { release }),
    held: () => request('GET', '/api/admin/held').then((d) => d.messages),
    lookup: (handle) => request('GET', `/api/admin/users?handle=${enc(handle)}`).then((d) => d.user),
    setStatus: (userId, status) => request('POST', `/api/admin/users/${enc(userId)}/status`, { status }),
  },
  mute: (id, muted) => request('POST', `/api/conversations/${enc(id)}/mute`, { muted }),
  bottle: () => request('GET', '/api/bottle').then((d) => d.bottle),
  leaveBottle: (body) => request('POST', '/api/bottle', { body }),
  withdrawBottle: () => request('POST', '/api/bottle/withdraw', {}),
  hide: (id) => request('POST', `/api/conversations/${enc(id)}/hide`, {}),
  block: (id) => request('POST', `/api/conversations/${enc(id)}/block`, {}),
  report: (id, reason, details) => request('POST', `/api/conversations/${enc(id)}/report`, { reason, details }),
  markRead: (id) => request('POST', `/api/conversations/${enc(id)}/read`, {}),
};

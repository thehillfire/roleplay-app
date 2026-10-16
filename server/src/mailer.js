// Sends transactional email through Resend's HTTP API when RESEND_API_KEY is set.
// Without it (local development), emails are printed to the server log instead.
function createMailer({
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.MAIL_FROM || 'Kindred <no-reply@example.com>',
  fetchImpl = fetch,
  log = console,
} = {}) {
  return {
    enabled: Boolean(apiKey),
    async send({ to, subject, text }) {
      if (!apiKey) {
        log.log(`[mail] to=${to} subject="${subject}"\n${text}`);
        return;
      }
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Email send failed (${res.status})`);
    },
  };
}

module.exports = { createMailer };

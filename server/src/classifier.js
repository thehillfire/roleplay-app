// Optional second opinion on messages from OpenAI's moderation endpoint (free with an
// API key). Off unless MODERATION_PROVIDER=openai and OPENAI_API_KEY are set: it sends
// message text to a third party, which the privacy policy must disclose.
//
// Fails open: if the service is slow or down, the built-in rules alone decide, so a
// moderation outage never blocks people from talking.

// Venting is full of strong words about bosses and exes, so ordinary "harassment" and
// adult sexual content only count at high confidence; threats, hate and anything
// sexual involving minors count whenever flagged.
const RULES = [
  { flag: 'minor_sexual', categories: ['sexual/minors'], min: 0 },
  { flag: 'threat', categories: ['harassment/threatening', 'hate/threatening', 'violence'], min: 0.5 },
  { flag: 'hate', categories: ['hate'], min: 0.5 },
  { flag: 'harassment', categories: ['harassment'], min: 0.9 },
  { flag: 'sexual', categories: ['sexual'], min: 0.85 },
];
const CRISIS = ['self-harm', 'self-harm/intent', 'self-harm/instructions'];

function createClassifier({
  provider = process.env.MODERATION_PROVIDER,
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = fetch,
  timeoutMs = 1500,
  log = console,
} = {}) {
  if (provider !== 'openai' || !apiKey) return { enabled: false, classify: async () => null };

  return {
    enabled: true,
    // Returns { flags: string[], crisis: boolean } or null when unavailable.
    async classify(text) {
      try {
        const res = await fetchImpl('https://api.openai.com/v1/moderations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const result = (await res.json()).results?.[0];
        if (!result) return null;
        const flagged = result.categories || {};
        const scores = result.category_scores || {};
        const flags = RULES
          .filter((r) => r.categories.some((c) => flagged[c] && (scores[c] ?? 1) >= r.min))
          .map((r) => r.flag);
        return { flags, crisis: CRISIS.some((c) => flagged[c]) };
      } catch (err) {
        log.warn('moderation classifier unavailable:', err.message);
        return null;
      }
    },
  };
}

module.exports = { createClassifier };

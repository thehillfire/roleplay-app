// The narrator turns structured game state into prose. The server owns every prompt;
// clients only send data, so the endpoint can't be used as an open proxy to the model.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_HISTORY_TURNS = 12;

const SYSTEM_INSTRUCTION = [
  'You are the narrator of a calm, dreamlike fantasy roleplay.',
  'Write in second person, present tense, with vivid but gentle imagery.',
  'Keep each passage under 90 words. Never decide the player\'s actions for them.',
  'Always end on a moment that invites the player to act.',
  'Offer exactly three short suggested actions (under 8 words each) that fit the scene.',
].join(' ');

const CLASS_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['name', 'description'],
};

const STORY_SCHEMA = {
  type: 'object',
  properties: {
    passage: { type: 'string' },
    choices: { type: 'array', items: { type: 'string' } },
  },
  required: ['passage', 'choices'],
};

function heroLine(hero) {
  const parts = [hero.name];
  if (hero.rarity) parts.push(`(${hero.rarity})`);
  if (hero.description) parts.push(`- ${hero.description}`);
  return parts.join(' ');
}

function storyPrompt({ hero, history, action }) {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const lines = [`The player's character: ${heroLine(hero)}`];
  if (recent.length === 0) {
    lines.push('Open the story: introduce the character\'s world and a first point of tension.');
  } else {
    lines.push('Story so far:');
    for (const turn of recent) {
      lines.push(turn.role === 'player' ? `PLAYER: ${turn.text}` : `NARRATOR: ${turn.text}`);
    }
  }
  if (action) lines.push(`The player now does this: ${action}`, 'Narrate what happens next.');
  return lines.join('\n');
}

function classPrompt(seed) {
  return [
    `Invent an RPG class of ${seed.rarity} rarity built from the theme "${seed.theme}" and the role "${seed.role}".`,
    'Give it an evocative two- or three-word name and a one-sentence description (under 30 words).',
    'Higher rarities should feel grander and stranger.',
  ].join(' ');
}

function cleanChoices(choices) {
  return (Array.isArray(choices) ? choices : [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => c.trim())
    .slice(0, 3);
}

function createGeminiNarrator({ apiKey, model, fetchImpl = fetch, timeoutMs = 30000 }) {
  async function generate(prompt, schema, temperature) {
    const res = await fetchImpl(`${GEMINI_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const err = new Error(`Gemini responded ${res.status}`);
      err.status = res.status === 429 ? 429 : 502;
      throw err;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!text) {
      const err = new Error('Gemini returned no content');
      err.status = 502;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('Gemini returned malformed JSON');
      err.status = 502;
      throw err;
    }
  }

  return {
    source: 'gemini',
    async describeClass(seed) {
      const out = await generate(classPrompt(seed), CLASS_SCHEMA, 1.0);
      return { name: String(out.name || '').trim(), description: String(out.description || '').trim() };
    },
    async tell(input) {
      const out = await generate(storyPrompt(input), STORY_SCHEMA, 0.85);
      return { passage: String(out.passage || '').trim(), choices: cleanChoices(out.choices) };
    },
  };
}

// Works with no API key so the app is playable in development and tests.
function createOfflineNarrator() {
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const openings = [
    'Mist curls over a quiet valley as you wake beneath a lantern-lit willow.',
    'A bell rings somewhere far below the clouds, and the floating road beneath you hums.',
    'The tide pulls back from a glass shore, revealing a stairway that was not there before.',
  ];
  const beats = [
    'The world answers softly. A path you had not noticed glows faintly ahead.',
    'Something shifts in the stillness — a figure watches from the edge of the light.',
    'The air tastes of rain and old magic. A choice settles gently on your shoulders.',
  ];

  return {
    source: 'offline',
    async describeClass(seed) {
      return {
        name: `${capitalize(seed.theme)} ${capitalize(seed.role)}`,
        description: `${/^[aeiou]/i.test(seed.rarity) ? 'An' : 'A'} ${seed.rarity.toLowerCase()} ${seed.role} whose craft is woven from ${seed.theme}.`,
      };
    },
    async tell({ hero, history, action }) {
      const turn = history.length;
      const deed = action && action.replace(/^i\s+/i, '').replace(/[.!?]+$/, '');
      const passage = action
        ? `You ${deed.charAt(0).toLowerCase()}${deed.slice(1)}. ${beats[turn % beats.length]}`
        : `${openings[hero.name.length % openings.length]} You are ${hero.name}, and the story is yours to shape.`;
      return { passage, choices: ['Follow the light', 'Call out to the stranger', 'Rest and listen'] };
    },
  };
}

function createNarrator(env = process.env) {
  if (env.GEMINI_API_KEY) {
    return createGeminiNarrator({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || 'gemini-2.5-flash' });
  }
  return createOfflineNarrator();
}

module.exports = { createNarrator, createGeminiNarrator, createOfflineNarrator, storyPrompt, MAX_HISTORY_TURNS };

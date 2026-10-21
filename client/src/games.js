// What you can match up for. 'talk' is the support mode (talk/listen roles, topics, listeners);
// the others are quick games with a stranger. The server only matches people in the same mode.
export const MODES = [
  { id: 'talk', tag: '#talk', label: 'Talk it out', blurb: "Something's on your mind. Vent, or be the one who listens." },
  { id: 'cringe', tag: '#cringeduel', label: 'Cringe Duel', blurb: 'Same awkward scenario for both of you. Out-cringe each other.' },
  { id: 'nosmile', tag: '#dontsmile', label: "Don't Smile", blurb: 'Make them crack. Your camera checks your own smile, on your phone only.' },
];
export const modeInfo = (id) => MODES.find((m) => m.id === id) || MODES[0];

// Cringe Duel cards: awkward, harmless, about the situation (never about the other person).
export const CRINGE_CARDS = [
  'You waved back at someone. They were waving at the person behind you. Keep the conversation going as if this just happened.',
  'You said "you too" when the waiter said "enjoy your meal". Explain yourself.',
  'You walked into a glass door in front of your crush. Narrate what you did next.',
  "You've been calling a coworker the wrong name for 8 months. They just found out. Go.",
  'You laughed at something sad in a meeting because you misheard. Defend yourself.',
  'You sent a voice note to the wrong group chat. Describe what it said.',
  'You pushed a door that clearly said PULL, three times, while people watched. Give your TED talk about it.',
  'Your phone played music at full volume in a silent library. What song was it?',
  'You started clapping when the plane landed. Nobody joined. What did you say next?',
  'You tried to look cool leaning on a table. It was not a table. What was it?',
  'Your mom commented "proud of u" on a post that was absolutely not meant for her. What was the post?',
  'You accidentally liked a photo from 2014 while snooping. Explain it to them like a politician.',
  'You said "love you, bye" to a customer service agent. Continue the call.',
  'You ran to catch a bus that turned out not to be yours. Everyone saw. What do you tell them?',
  'You wore your shirt inside out all day and nobody told you. Who is to blame?',
  'You confidently mispronounced a word for years. Which word, and how did you find out?',
  'Someone said "how are you" and you answered with your full medical history. Recreate it.',
  'You fell asleep on a stranger on the train. They are now awake. First words?',
  'You got caught practicing an argument in the shower. Out loud. Who were you arguing with?',
  'Your autocorrect sent your boss something unhinged. What did it change it to?',
  'You tried a handshake, they went for a hug, you both panicked into a fist bump. Describe the aftermath.',
  'You held the door for someone who was way too far away, so they had to jog. Apologise in the most awkward way.',
  'You laughed at your own joke before finishing it, and the joke was bad. Tell the joke.',
  'You were singing in the car at a red light. The car next to you was full of people you know. What song?',
  'You tried to whistle to look casual and only air came out. Keep acting casual.',
  'A kid asked you a question you could not answer. What was it and what did you make up?',
  'You introduced yourself, then forgot your own name halfway. Finish the introduction.',
  'You bit into what you thought was a cookie. It was a decorative candle. Review it.',
  'You hit "reply all" with a message meant for one person. What did it say?',
  "You tried to sneak out of a party and got stuck in the host's closet. Talk your way out.",
  'Your stomach growled loudly during a silent moment at a funeral of a goldfish. Give the eulogy.',
  'You were caught talking to your plant like it was a person. Introduce the plant.',
  'You accidentally joined a video call with a filter on and could not turn it off. What filter?',
  'You complimented someone\'s baby and it was actually a very small dog. Recover.',
  'You said "same" when someone told you they just got back from war. Keep talking.',
  'You tried to flip a pancake like a pro. Where is the pancake now?',
  'You got overly emotional at a car commercial. Describe the commercial.',
  'You argued with a vending machine out loud in public. Who won?',
  'You told a long story and realised it was their story, told to you last week. What now?',
  'You practiced a fake laugh so much it became your real laugh. Demonstrate in text.',
];

// Both players see the same order: a shuffle seeded by the conversation id.
export function deckFor(conversationId) {
  let h = 2166136261;
  for (const ch of conversationId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const order = CRINGE_CARDS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map((i) => CRINGE_CARDS[i]);
}

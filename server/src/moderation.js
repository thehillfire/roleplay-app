// Screens every message before delivery. Rules are deliberately simple and
// explainable; anything they hold back is stored for moderators, and reports
// catch what they miss. Swap in an ML classifier behind the same interface later.
//
// Returns { deliver: boolean, flags: string[], crisis: boolean, suspend: boolean }.
//   contact     phone numbers, emails, links, social handles: held until both connect
//   age_probe   asking someone's age or grade: held (18+ app; common grooming opener)
//   minor       sender clearly says they're under 18: held, account paused for review
//   minor_maybe a bare "I'm 15": held for a moderator, account NOT paused (too ambiguous)
//   sexual      sexual solicitation: held
//   crisis      self-harm / suicide language: DELIVERED, sender is shown crisis resources

const normalize = (text) => text
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[’`]/g, "'");

// Digits written with separators ("555 123 4567", "555.123.4567") or as words.
// English and Spanish (text is accent-folded first, so "seis" and "séis" both match).
const DIGIT_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/g;
const WORD_TO_DIGIT = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};

function hasPhoneNumber(t) {
  const spelled = t.replace(DIGIT_WORDS, (w) => WORD_TO_DIGIT[w]);
  // 7+ digits with only spaces, dots, dashes, parens or plus between them.
  return /(?:\+?\d[\s().-]*){7,}/.test(spelled);
}

const CONTACT_PATTERNS = [
  /[a-z0-9._%+-]+\s*@\s*[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/, // emails
  /[a-z0-9._%+-]+\s*(\(at\)|\[at\]|\sat\s)\s*[a-z0-9-]+\s*(\(dot\)|\[dot\]|\sdot\s|\.)\s*(com|net|org|edu|gov|io|co|me|us|uk|ca)\b/, // "jane at gmail dot com"
  /\b(https?:\/\/|www\.)\S+/,
  /\b[a-z0-9-]+\.(com|net|org|io|me|co|app|gg|ly|tv|xyz)\b/,
  /(^|\s)@[a-z0-9_.]{3,}/, // @handles
  /\b(snap(chat)?|insta(gram)?|ig|tiktok|whats\s?app|telegram|discord|kik|wickr|signal|facebook|fb|twitter|x\.com|onlyfans|venmo|cash\s?app|paypal)\b\s*(is\b|:|at\b|@|handle|name|id\b|user(name)?\b|-)\s*\S/,
  /\b(add|text|call|dm|message|hit)\s+me\s+(on|at|up)\b/,
  /\bmy\s+(number|phone(\s+number)?|cell|email|address|insta|snap|discord)\s*(is\b|:|=|-)/,
  // Spanish
  /\b(agregame|escribeme|llamame|marcame|textea(me)?)\s+(a|al|en|por)\b/,
  /\b(mandame|enviame)\s+(un\s+)?(mensaje|whats|dm)\s+(a|al|en|por)\b/,
  /\bmi\s+(numero|cel(ular)?|telefono|correo|email|insta|snap|whats(app)?|direccion)\s*(es\b|:|=|-)/,
];

const AGE_PROBE_PATTERNS = [
  /\bhow\s+old\s+(are|r)\s+(you|u|ya)\b/,
  /\b(what'?s|what\s+is|whats)\s+(your|ur)\s+age\b/,
  /\b(your|ur)\s+age\s*\?/,
  /\ba\s*\/?\s*s\s*\/?\s*l\b/, // "asl", "a/s/l"
  /\bare\s+(you|u)\s+(a\s+)?(minor|underage|under\s*18|in\s+(high|middle)\s+school)\b/,
  /\bwhat\s+grade\s+(are|r)\s+(you|u)\b/,
  /\b(are|r)\s+(you|u)\s+(1[0-7]|[1-9])\b/,
  // Spanish
  /\bcuantos\s+anos\s+(tienes|tenes|tiene)\b/,
  /\b(que|q)\s+edad\s+(tienes|tenes|tiene)\b/,
  /\b(eres|sos)\s+menor(\s+de\s+edad)?\b/,
  /\ben\s+(que|q)\s+(grado|curso|ano)\s+(estas|vas)\b/,
  /\btienes\s+(1[0-7]|[1-9])\s*(anos)?\s*\?/,
];

// Unambiguous: pauses the account.
const MINOR_PATTERNS = [
  /\b(i'?m|im|i\s+am)\s+(only\s+|just\s+)?(1[0-7]|[1-9])\s*(years?\s*old|yrs?\s*old|y\/?o)\b/,
  /\b(i'?m|im|i\s+am)\s+(a\s+)?(minor|underage)\b/,
  /\b(i'?m|im|i\s+am)\s+in\s+(middle\s+school|high\s+school|junior\s+high|(6|7|8|9|10|11|12)(th)?\s+grade)\b/,
  /\b(i'?m|im|i\s+am)\s+a\s+(freshman|sophomore|junior|senior)\s+in\s+high\s+school\b/,
  // Spanish: only unmistakable phrasings pause ("soy menor de edad", "tengo 15 años de edad").
  /\bsoy\s+menor\s+de\s+edad\b/,
  /\btengo\s+(solo\s+|apenas\s+)?(1[0-7]|[1-9])\s+anos\s+de\s+edad\b/,
  /\b(estoy|voy)\s+en\s+(la\s+)?(secundaria|prepa|preparatoria|(primero|segundo|tercero)\s+de\s+secundaria)\b/,
];

// A bare "I'm 15" at the end of a clause or before filler ("I'm 15 btw", "im 16 and ..."). Only
// 13-17, and not "I'm 16 hours into this shift", "I'm 10 and a half weeks pregnant" or "on a scale
// of 1 to 10 I'm 3". Ambiguous, so it's held for a moderator but doesn't pause anyone.
const BARE_AGE = /\b(i'?m|im|i\s+am)\s+(only\s+|just\s+)?(1[3-7])(?=\s*([.!?,;)]|$)|\s+(btw|lol|lmao|haha|tho|though|rn|and|but|so|too|also|actually|now)\b)(?!\s+and\s+a\s+half)/;
// Spanish "tengo 15 (años)" the same way; "tengo 15 años trabajando aquí" (years of work) doesn't match.
const BARE_AGE_ES = /\btengo\s+(solo\s+|apenas\s+)?(1[3-7])(\s+anos)?(?=\s*([.!?,;)]|$)|\s+(jaja|jeje|lol|xd|pero|asi|ahorita|tambien|y\s+(tu|vos|usted)))/;
const RATING_CONTEXT = /\b(scale|out\s+of|rate|rating|escala|de\s+10|del\s+1\s+al\s+10)\b|\/\s*10\b/;

const SEXUAL_PATTERNS = [
  /\b(send|show|trade|swap)\s+(me\s+)?(nudes?|pics?\s+of\s+(you|ur)|noods)\b/,
  /\bnudes?\b/,
  /\b(sext|sexting|dick\s*pic|d\s*pic)\b/,
  /\b(hook\s*up|hookup|fwb)\b/,
  /\bwhat\s+are\s+(you|u)\s+wearing\b/,
  // Spanish
  /\b(manda(me)?|envia(me)?|pasa(me)?)\s+(el\s+|tu\s+|un\s+)?(pack|packs|nudes?)\b/,
  /\bfotos?\s+(desnud[ao]s?|sin\s+ropa|intimas?|hot)\b/,
  /\b(cogemos|cogerte|follamos|follarte|sexo\s+virtual)\b/,
  /\bque\s+(traes|llevas|tienes)\s+puesto\b/,
];

const CRISIS_PATTERNS = [
  /\b(kill|hurt|harm)\s+(my\s*self|myself)\b/,
  /\bsuicid(e|al)\b/,
  /\b(want|wanna|going)\s+to\s+die\b/,
  /\bwanna\s+die\b/,
  /\bend\s+(it\s+all|my\s+life|things)\b/,
  /\bno\s+(reason|point)\s+(to|in)\s+(live|living|going\s+on)\b/,
  /\b(cut|cutting)\s+(my\s*self|myself)\b/,
  /\bself[\s-]?harm\b/,
  /\bdon'?t\s+want\s+to\s+(be\s+alive|live|wake\s+up)\b/,
  /\bbetter\s+off\s+(dead|without\s+me)\b/,
  // Spanish
  /\b(matarme|suicidarme|quitarme\s+la\s+vida)\b/,
  /\bsuicid(io|a|arme)\b/,
  /\b(quiero|quisiera|me\s+quiero)\s+morir(me)?\b/,
  /\bno\s+quiero\s+(vivir|seguir\s+viviendo|despertar(me)?)\b/,
  /\b(cortarme|hacerme\s+dano|lastimarme|autolesion(es|arme)?)\b/,
  /\b(estarian|estaria|estan)\s+mejor\s+sin\s+mi\b/,
  /\bacabar\s+con\s+(todo|mi\s+vida)\b/,
];

const any = (patterns, t) => patterns.some((re) => re.test(t));

function screenMessage(body, { connected = false } = {}) {
  const t = normalize(body);
  const flags = [];
  if (!connected && (hasPhoneNumber(t) || any(CONTACT_PATTERNS, t))) flags.push('contact');
  if (any(AGE_PROBE_PATTERNS, t)) flags.push('age_probe');
  if (any(MINOR_PATTERNS, t)) flags.push('minor');
  else if ((BARE_AGE.test(t) || BARE_AGE_ES.test(t)) && !RATING_CONTEXT.test(t)) flags.push('minor_maybe');
  if (any(SEXUAL_PATTERNS, t)) flags.push('sexual');
  const crisis = any(CRISIS_PATTERNS, t);
  if (crisis) flags.push('crisis');
  const blocking = flags.filter((f) => f !== 'crisis');
  return { deliver: blocking.length === 0, flags, crisis, suspend: flags.includes('minor') };
}

module.exports = { screenMessage };

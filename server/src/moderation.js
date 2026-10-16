// Screens every message before delivery. Rules are deliberately simple and
// explainable; anything they hold back is stored for moderators, and reports
// catch what they miss. Swap in an ML classifier behind the same interface later.
//
// Returns { deliver: boolean, flags: string[], crisis: boolean, suspend: boolean }.
//   contact     phone numbers, emails, links, social handles: held until both connect
//   age_probe   asking someone's age or grade: held (18+ app; common grooming opener)
//   minor       sender clearly says they're under 18: held, account paused for review
//   minor_maybe a bare "I'm 15": held for a moderator, account NOT paused (too ambiguous)
//   location    asking where someone lives (city, town, address): held (anonymity)
//   meetup      arranging to meet, or asking for photos: held until both connect (safety)
//   sexual      sexual solicitation: held
//   crisis      self-harm / suicide language: DELIVERED, sender is shown crisis resources

// Look-alike letters people swap in to dodge filters ("gmаil" with a Cyrillic а).
const CONFUSABLES = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};
const normalize = (text) => text
  .toLowerCase()
  .normalize('NFKD')
  // Invisible characters (zero-width spaces/joiners, soft hyphens, Hangul fillers) split words.
  .replace(/[\p{Cf}\u034f\u115f\u1160\u3164\uffa0]/gu, '')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[авеёкмнорстухіјѕԁԛԝαβεηικνορτυχω]/g, (c) => CONFUSABLES[c])
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

// Undo the usual dodges before looking for platform names: "sn@p", "1nsta", "i n s t a".
const LEET = { '@': 'a', 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', $: 's', 7: 't' };
const deobfuscate = (t) => t
  .replace(/(.)\1{3,}/g, '$1$1$1') // "niiiiii..." → "niii" (the patterns allow repeats)
  .replace(/[@0134$57]/g, (c) => LEET[c])
  .replace(/\b(?:[a-z][\s.*_-]){2,}[a-z]\b/g, (m) => m.replace(/[\s.*_-]/g, ''));
const PLATFORMS = 'snap(chat)?|insta(gram)?|ig|tiktok|whats\\s?app|telegram|discord|kik|wickr|signal|facebook|fb|twitter|onlyfans|venmo|cash\\s?app|paypal';
const CONTACT_INFO = `number|num|#|digits|cell|phone(\\s+number)?|email|e-mail|socials?|handle|${PLATFORMS}`;
const OBFUSCATED_CONTACT = new RegExp(`\\b(${PLATFORMS})\\b\\s*(is\\b|:|at\\b|@|-)\\s*\\S`);

const CONTACT_PATTERNS = [
  // Asking for contact details counts too (it's how people get pulled off-platform).
  // Only when the question ends there: "what's your number?" yes, "what's your number one worry" no.
  new RegExp(`\\b(what'?s|whats|wats|what\\s+is)\\s+(your|ur|yo)\\s+(${CONTACT_INFO})\\s*($|[?.!,]|\\s+(pls|please|plz|so|then|bro|lol|babe|hun)\\b)`),
  new RegExp(`\\b(can|could|may)\\s+i\\s+(get|have)\\s+(your|ur)\\s+(${CONTACT_INFO})\\b`),
  new RegExp(`\\b(give|send|drop|text)\\s+me\\s+(your|ur)\\s+(${CONTACT_INFO})\\b`),
  new RegExp(`\\b(do|d|you|u)\\s+(you\\s+|u\\s+)?(have|got|use|on)\\s+(${PLATFORMS})\\s*\\?`),
  new RegExp(`\\b(hmu|hit\\s+me\\s+up|find\\s+me|follow\\s+me|dm\\s+me|message\\s+me|add\\s+me)\\s+(on|at)\\s+(${PLATFORMS})\\b`),
  /\b(cual|que)\s+es\s+tu\s+(numero|cel(ular)?|telefono|correo|snap|insta|whats(app)?|discord|telegram)\b/,
  /\b(pasame|dame|mandame|enviame)\s+tu\s+(numero|cel(ular)?|telefono|correo|snap|insta|whats(app)?|discord|telegram)\b/,
  // Emails. The lookbehind starts matches only at the beginning of a word, so a long run of
  // letters can't make these retry from every position (quadratic time).
  /(?<![a-z0-9._%+-])[a-z0-9._%+-]+\s*@\s*[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/,
  /(?<![a-z0-9._%+-])[a-z0-9._%+-]+\s*(\(at\)|\[at\]|\sat\s)\s*[a-z0-9-]+\s*(\(dot\)|\[dot\]|\sdot\s|\.)\s*(com|net|org|edu|gov|io|co|me|us|uk|ca)\b/, // "jane at gmail dot com"
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

// Where someone lives, closely enough to find them. "Where are you from?" (a country) is fine.
const LOCATION_PATTERNS = [
  /\bwhere\s+(do|d)\s+(you|u)\s+live\b/,
  /\bwhat\s+(city|town|state|neighbou?rhood|zip(\s*code)?|area|street)\s+(are|r|do)\s+(you|u)\s+(in|from|live\s+in|live)\b/,
  /\bwhat'?s\s+(your|ur)\s+(address|zip(\s*code)?|city|town)\b/,
  /\b(donde|en\s+que\s+(ciudad|pueblo|colonia|estado))\s+vives\b/,
  /\b(cual|que)\s+es\s+tu\s+(direccion|ciudad|colonia|codigo\s+postal)\b/,
];

// Strangers arranging to meet, or asking for photos (no photos in Kindred: it means elsewhere).
// Only proposals aimed at the person you're talking to, not stories ("my sister keeps saying we
// should hang out", "my ex wants to meet up tonight", "he kept telling me to send pics").
const NOT_REPORTED = String.raw`(?<!\b(said|says|saying|told\s+me|tells\s+me|telling\s+me|asked\s+me|keeps|kept|wants|wanted)\s+(to\s+)?)`;
const MEETUP_PATTERNS = [
  /\b(wanna|want\s+to)\s+(meet|hang\s*out|link)\s+(you|u)\b/,
  /\b(do|d)\s+(you|u)\s+(wanna|want\s+to)\s+(meet|hang\s*out|link)(\s+up)?\b/,
  /\b(u|you)\s+(wanna|want\s+to)\s+(meet|hang\s*out|link)\s*(up)?\s*\?/,
  /^\s*(wanna|want\s+to)\s+(meet|hang\s*out|link)(\s+up)?\b/,
  new RegExp(`${NOT_REPORTED}\\b(let'?s|lets|can\\s+we|could\\s+we|should\\s+we)\\s+(meet|hang\\s*out|link\\s*up)\\b`),
  /\bmeet\s+me\s+(at|in|irl|tonight|tomorrow|later|sometime|somewhere)\b/,
  /\bmeet\s+(you|u)\s+(irl|in\s+person)\b/,
  /\b(we|us)\s+(should\s+)?meet\s+(irl|in\s+person)\b/,
  new RegExp(`${NOT_REPORTED}\\b(send|text)\\s+me\\s+(a\\s+)?(selfie|pic|photo|picture)s?\\b(?!\\s+of\\s+(your|ur)\\s+(dog|cat|pet|garden|food|view))`),
  /\b(quieres|quieren)\s+(vernos|que\s+nos\s+veamos|salir\s+conmigo)\b/,
  /\bnos\s+vemos\s+en\s+persona\b/,
  /\b(mandame|enviame|pasame)\s+(una\s+)?(foto|selfie)\b/,
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

// Ages written as words, so "I'm fifteen" reads like "I'm 15" (English and Spanish teens).
const AGE_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
};
const withAgeDigits = (t) => t.replace(/\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|diez|doce|trece|catorce|quince|dieciseis|diecisiete)\b/g, (w) => String(AGE_WORDS[w]));

// Unambiguous: pauses the account.
const MINOR_PATTERNS = [
  /\b(i'?m|im|i\s+am)\s+(only\s+|just\s+)?a\s+(1[0-7]|[1-9])[\s-]*(years?|yrs?)[\s-]*old\b/, // "I'm a 15 year old girl"
  /\b(i'?m|im|i\s+am|i)\s+(just\s+)?turned\s+(1[0-7]|[1-9])\b(?!\s*(years?|yrs?|minutes|hours|days|weeks|months|percent|%))/,
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
// Self-labels people use in chat: "16f", "15 m here", "16 yo", "17 years old here", "age: 15",
// "turning 18 next month", "my 16th birthday is next week". Held for a moderator, no pause.
const SELF_ID_MAYBE = [
  /^\s*(hi|hey|hello|yo|hola)?[\s,!]*(1[3-7])\s*(f|m|male|female|girl|boy|guy|nb|yo|y\/o|(yrs?|years?)\s+old)\b/,
  /\b(age|edad|asl)\s*[:=]\s*(1[3-7])\b/, // "age: 15", not "since age 13"
  /\b(1[3-7])\s*(years?\s+old|yrs?\s+old|yo|y\/o)\s+here\b/,
  /\b(me|yo)\s*[:=-]\s*(1[3-7])\b/,
  /(^\s*|\b(i'?m|im|i\s+am|i'?ll\s+be|i\s+will\s+be)\s+)turn(ing)?\s+(16|17|18)\s+(next|in|this|soon|tomorrow)\b/,
  /\b(i'?m|im|i\s+am)\s+(1[3-7])\s*(yrs?|years?)\b(?!\s+(of|into|in|at|on|with|out|since|ago|from|clean|sober|married|together|later))/,
  /\bmy\s+(1[3-8])(th)?\s+(birthday|bday)\s+(is\s+)?(next|this|tomorrow|today|coming|soon)\b/,
];
// Spanish "tengo 15 (años)" the same way; "tengo 15 años trabajando aquí" (years of work) doesn't match.
const BARE_AGE_ES = /\btengo\s+(solo\s+|apenas\s+)?(1[3-7])(\s+anos)?(?=\s*([.!?,;)]|$)|\s+(jaja|jeje|lol|xd|pero|asi|ahorita|tambien|y\s+(tu|vos|usted)))/;
const RATING_CONTEXT = /\b(scale|out\s+of|rate|rating|escala|de\s+10|del\s+1\s+al\s+10)\b|\/\s*10\b/;

const SEXUAL_PATTERNS = [
  /\b(send|show|trade|swap)\s+(me\s+)?(nudes?|pics?\s+of\s+(you|ur)|noods)\b/,
  /\bnudes?\b/,
  /\b(sext|sexting|dick\s*pic|d\s*pic)\b/,
  /\b(hook\s*up|hookup|fwb)\b/,
  /\bwhat\s+are\s+(you|u)\s+wearing\b/,
  /\b((are|r)\s+)?(you|u)\s+horny\b/,
  /\b(i'?m|im)\s+(so\s+)?horny\b/,
  /\b(see|suck|touch|rate)\s+my\s+(dick|cock|d|boobs|tits)\b/,
  // Spanish
  /\b(manda(me)?|envia(me)?|pasa(me)?)\s+(el\s+|tu\s+|un\s+)?(pack|packs|nudes?)\b/,
  /\bfotos?\s+(desnud[ao]s?|sin\s+ropa|intimas?|hot)\b/,
  /\b(cogemos|cogerte|follamos|follarte|sexo\s+virtual)\b/,
  /\bque\s+(traes|llevas|tienes)\s+puesto\b/,
];

// A false alarm here only shows a resource card, so these lean broad: missing someone matters more.
const CRISIS_PATTERNS = [
  /\b(kill|killing|hurt|hurting|harm|harming)\s+(my\s*self|myself)\b/,
  /\b(kms|unalive|sewer\s*slide)\b/,
  /\b(going\s+to|gonna|want\s+to|wanna|about\s+to)\s+end\s+it\b/,
  /\bcan'?t\s+(do\s+this|go\s+on|take\s+(it|this)|keep\s+going)\s+any\s*more\b/,
  /\b(nobody|no\s+one|noone)\s+would\s+(miss|notice|care\s+if)\b/,
  /\b(saved|saving|stockpil(ed|ing)|hoard(ed|ing))\s+(up\s+)?(pills|meds|medication)\b/,
  /\b(pills|rope|gun)\s+(saved|ready|stockpiled)\b/,
  /\b(goodbye|suicide)\s+(note|letter)\b/,
  /\b(jump|jumping)\s+(off|from|in\s+front\s+of)\s+(a|the|my)\b/,
  /\bdon'?t\s+want\s+to\s+(be\s+here|exist)\s*any\s*more\b/,
  /\b(better|happier)\s+(off\s+)?without\s+me\b/,
  /\bdisappear\s+(forever|for\s+good)\b/,
  /\bdone\s+with\s+(life|living|being\s+alive)\b/,
  /\bnever\s+wake\s+up\b/,
  /\b(what'?s|what\s+is)\s+the\s+point\s+(of|in)\s+(living|life|going\s+on|being\s+alive)\b/,
  /\bi\s+should\s+(just\s+)?die\b/,
  /\bhate\s+being\s+alive\b/,
  /\boverdos(e|ed|ing)\b/,
  /\bya\s+no\s+(puedo|aguanto)\s+mas\b/,
  /\bnadie\s+me\s+(extranaria|extrana|va\s+a\s+extranar)\b/,
  /\bdesaparecer\s+para\s+siempre\b/,
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

// The most common slurs, including dodged spellings (checked on the un-dodged text). Kept short
// on purpose: the optional ML classifier and reports cover the rest.
const HATE_PATTERNS = [
  /\bn+[i1!]+g+(a+|e+r+|u+h+|a+z+|e+r+z+|a+s+|e+r+s+)\b/,
  /\bf+a+g+g+o+t+s?\b/,
  /\b(you|u|ur|stupid|dumb|fucking|fuckin|little|such\s+a)\s+f+a+g+s?\b/, // bare "fag" is also British for a cigarette
  /\bchinks?\b(?!\s+in\s+(my|the|his|her|their|your|our)\s+armou?r)/,
  /\b(kike|kikes|spic|spics|wetback|wetbacks|beaner|beaners|tranny|trannies|raghead|towelhead|gook|gooks)\b/,
  /\b(maricon|maricones|joto|jotos|sudaca|sudacas)\b/,
];

// Telling someone to kill themselves is abuse, not a crisis.
// Not when someone is telling you it happened to them ("kids at school told me kys").
const QUOTED = String.raw`(?<!\b(told\s+me|tell\s+me|tells\s+me|telling\s+me|said|says|saying|called\s+me|me\s+that)\s+(to\s+)?)`;
const ABUSE_PATTERNS = [
  new RegExp(`${QUOTED}\\bkys\\b`),
  new RegExp(`${QUOTED}\\b(go|just|you\\s+should|u\\s+should)\\s+(kill|unalive)\\s+(your\\s*self|yourself|urself|ur\\s*self)\\b`),
  new RegExp(`${QUOTED}\\b(matate|suicidate)\\b`),
  new RegExp(`${QUOTED}\\b(you|u)\\s+should\\s+(just\\s+)?die\\b`),
];

const any = (patterns, t) => patterns.some((re) => re.test(t));

function screenMessage(body, { connected = false } = {}) {
  const t = normalize(body);
  const flags = [];
  if (!connected && (hasPhoneNumber(t) || any(CONTACT_PATTERNS, t) || OBFUSCATED_CONTACT.test(deobfuscate(t)))) flags.push('contact');
  if (!connected && any(LOCATION_PATTERNS, t)) flags.push('location');
  if (!connected && any(MEETUP_PATTERNS, t)) flags.push('meetup');
  if (any(AGE_PROBE_PATTERNS, t)) flags.push('age_probe');
  const aged = withAgeDigits(t);
  if (any(MINOR_PATTERNS, aged)) flags.push('minor');
  else if ((BARE_AGE.test(aged) || BARE_AGE_ES.test(aged) || any(SELF_ID_MAYBE, aged)) && !RATING_CONTEXT.test(aged)) flags.push('minor_maybe');
  if (any(SEXUAL_PATTERNS, t)) flags.push('sexual');
  if (any(HATE_PATTERNS, deobfuscate(t))) flags.push('hate');
  if (any(ABUSE_PATTERNS, t)) flags.push('harassment');
  const crisis = any(CRISIS_PATTERNS, t);
  if (crisis) flags.push('crisis');
  const blocking = flags.filter((f) => f !== 'crisis');
  return { deliver: blocking.length === 0, flags, crisis, suspend: flags.includes('minor') };
}

module.exports = { screenMessage };

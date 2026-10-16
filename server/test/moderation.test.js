const test = require('node:test');
const assert = require('node:assert/strict');
const { screenMessage } = require('../src/moderation');

const flagsOf = (text, opts) => screenMessage(text, opts).flags;

test('ordinary venting is delivered untouched', () => {
  for (const text of [
    'Rent is due Friday and I am short.',
    "My boss yelled at me in front of everyone today and I can't stop thinking about it",
    'I worked 12 hours and I am 2 hours from home',
    'When I was 15 my dad left. Still hurts sometimes.',
    'I have 3 kids and 2 jobs',
    'Thanks, that really helped. Talk tomorrow?',
    'My account number at the bank got frozen',
    'Not dumb at all. Happens to so many people. Want to talk through options?',
    'I was at work. Company is falling apart.',
    "That's a good signal that things are changing",
    'I spent too much on venmo this month',
    'Facebook makes me feel worse about my life',
    'my phone keeps buzzing with texts from my ex',
    'my address changed twice this year and I am tired',
  ]) {
    const r = screenMessage(text);
    assert.equal(r.deliver, true, text);
    assert.deepEqual(r.flags, [], text);
  }
});

test('contact details are held until both people connect', () => {
  for (const text of [
    'text me 555 123 4567',
    'call me at (555) 123-4567',
    'five five five one two three four five six seven',
    'my email is jane.doe@gmail.com',
    'jane at gmail dot com',
    'jane at gmail.com',
    'jane(at)gmail(dot)com',
    'add me on snap',
    'snap is heron22',
    'my venmo is @heron',
    'my number is 555 0199 222',
    'my email: jane',
    'my insta is @quiet.heron',
    'discord: heron#1234',
    'check out www.example.com',
    'heron.me has my stuff',
  ]) {
    assert.ok(flagsOf(text).includes('contact'), text);
    assert.equal(screenMessage(text).deliver, false, text);
  }
  assert.equal(screenMessage('text me 555 123 4567', { connected: true }).deliver, true);
});

test('asking someone their age is held', () => {
  for (const text of ['how old are you?', 'hey asl', 'a/s/l', "what's your age", 'are you a minor', 'what grade are u in', 'r u 16']) {
    assert.deepEqual(flagsOf(text), ['age_probe'], text);
  }
});

test('saying you are under 18 is held and pauses the account', () => {
  for (const text of ['im 16 years old', 'i am only 14 yo', "I'm in high school", 'im in 10th grade', 'i am a minor']) {
    const r = screenMessage(text);
    assert.ok(r.flags.includes('minor'), text);
    assert.equal(r.suspend, true, text);
    assert.equal(r.deliver, false, text);
  }
  assert.equal(screenMessage("I'm 25").suspend, false);
  assert.equal(screenMessage("I'm 16 hours into this shift").suspend, false);
  assert.equal(screenMessage("I'm 5 minutes away").suspend, false);
  assert.equal(screenMessage("I'm 3 days late on rent").suspend, false);
});

test('a bare "I\'m 15" is held for a moderator without pausing the account', () => {
  for (const text of ["I'm 15", 'lol im 15 btw', "i'm 16, and my mom"]) {
    const r = screenMessage(text);
    assert.deepEqual(r.flags, ['minor_maybe'], text);
    assert.equal(r.deliver, false, text);
    assert.equal(r.suspend, false, text);
  }
  for (const text of ["honestly on a scale of 1 to 10 I'm 3.", "I'm 10 and a half weeks pregnant and scared", "I'm 15 and a half weeks along", "rate my day? I'm 14/10 tired lol", "I'm 5."]) {
    assert.deepEqual(screenMessage(text).flags, [], text);
  }
});

test('sexual solicitation is held', () => {
  for (const text of ['send nudes', 'wanna sext', 'what are you wearing', 'looking for a hookup']) {
    assert.ok(flagsOf(text).includes('sexual'), text);
  }
});

test('crisis language is delivered and flagged so the sender sees resources', () => {
  for (const text of ['I want to kill myself', 'thinking about suicide', 'i just want to die', 'everyone would be better off without me', "I don't want to wake up"]) {
    const r = screenMessage(text);
    assert.equal(r.crisis, true, text);
    assert.equal(r.deliver, true, text);
  }
});

test('Spanish: contact details, age questions, minors, sexual content and crisis', () => {
  const cases = [
    ['mi numero es cinco cinco cinco uno dos tres cuatro', 'contact'],
    ['agrégame en insta', 'contact'],
    ['mi correo es: ana', 'contact'],
    ['¿cuántos años tienes?', 'age_probe'],
    ['¿y qué edad tienes?', 'age_probe'],
    ['eres menor de edad?', 'age_probe'],
    ['soy menor de edad', 'minor'],
    ['tengo 15 años de edad', 'minor'],
    ['estoy en la secundaria', 'minor'],
    ['tengo 15 años', 'minor_maybe'],
    ['tengo 16 jaja', 'minor_maybe'],
    ['mándame tu pack', 'sexual'],
    ['qué traes puesto?', 'sexual'],
    ['ya no quiero vivir', 'crisis'],
    ['a veces quiero morirme', 'crisis'],
    ['todos estarían mejor sin mí', 'crisis'],
  ];
  for (const [text, flag] of cases) assert.ok(flagsOf(text).includes(flag), `${text} → ${flag}`);
  assert.equal(screenMessage('soy menor de edad').suspend, true);
  assert.equal(screenMessage('tengo 15 años').suspend, false, 'a bare age is held, never pauses');
  assert.equal(screenMessage('ya no quiero vivir').deliver, true, 'crisis is still delivered');
});

test('Spanish: everyday venting is delivered untouched', () => {
  for (const text of [
    'tengo 15 años trabajando en la misma empresa',
    'tengo 3 hijos y dos trabajos',
    'mi jefe me gritó hoy delante de todos',
    'mándame fotos de tu perro jaja',
    'cuando tenía 15 mis papás se divorciaron',
    'no tengo dinero para la renta y estoy muy estresado',
    'me siento muy solo desde que me mudé',
    'del 1 al 10 tengo 15 de estrés jaja',
  ]) {
    const r = screenMessage(text);
    assert.deepEqual(r.flags, [], text);
  }
});

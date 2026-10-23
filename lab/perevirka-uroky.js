/* Наскрізна перевірка lab/uroky.html (docs/uroky-10.md §5).
   Запуск: NODE_PATH=$(npm root -g) node lab/perevirka-uroky.js [тека-для-скріншотів]
   Голос браузера підмінено: кожен speak() записується, і ми перевіряємо правило §0 —
   жоден текст не є окремим приголосним, нічого в квадратних дужках, жодного «мммак». */
'use strict';
const path = require('path');
const fs = require('fs');
const {chromium} = require('playwright');

const FILE = 'file://' + path.resolve(__dirname, 'uroky.html');
const SHOTS = process.argv[2] || path.join(require('os').tmpdir(), 'uroky-shots');
fs.mkdirSync(SHOTS, {recursive: true});

const DEVICES = [
  {name: 'phone', viewport: {width: 360, height: 740}, hasTouch: true, isMobile: true},
  {name: 'tablet', viewport: {width: 800, height: 1280}, hasTouch: true, isMobile: true},
  {name: 'pc', viewport: {width: 1024, height: 768}, hasTouch: false, isMobile: false}
];

// Незалежна від сторінки перевірка: чи можна це вимовляти
const VOW = /[аоуиіеяюєї]/;
function voiceBad(text) {
  const s = String(text).toLowerCase();
  if (/[\[\]]/.test(s)) return 'дужки';
  if (/([а-яіїєґ])\1\1/.test(s)) return 'протяжний звук';
  const words = s.split(/[^а-яіїєґ'’ʼ]+/).filter(w => w.replace(/['’ʼ]/g, ''));
  const w = words.find(x => !VOW.test(x));
  if (w) return 'слово без голосного: «' + w + '»';
  // Назва букви, записана словами, — те саме «ем», від якого все почалося
  const NAMES = ['бе', 'ве', 'ге', 'ґе', 'де', 'же', 'зе', 'ей', 'ел', 'ем', 'ен', 'пе', 'ер', 'ес', 'те', 'еф', 'це', 'че'];
  if (words.length === 1 && NAMES.indexOf(words[0]) >= 0) return 'назва букви';
  return '';
}

function fakeVoice() {
  window.__spoken = [];
  const voice = {lang: 'uk-UA', name: 'Тестовий голос', voiceURI: 'test-uk', default: true, localService: true};
  const q = []; let busy = false;
  const pump = () => {
    if (busy) return; const u = q.shift(); if (!u) return; busy = true;
    setTimeout(() => { if (u.onstart) u.onstart(); setTimeout(() => { busy = false; if (u.onend) u.onend(); pump(); }, 30); }, 5);
  };
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [voice], addEventListener() {}, removeEventListener() {},
    cancel() { q.length = 0; }, pause() {}, resume() {},
    speak(u) { window.__spoken.push(u.text); q.push(u); pump(); }
  };
  Object.defineProperty(window, 'speechSynthesis', {value: synth, configurable: true});
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
}

const problems = [];
const fail = (dev, msg) => { problems.push('[' + dev + '] ' + msg); console.log('  ✗ ' + msg); };
const ok = msg => console.log('  ✓ ' + msg);

async function run(dev) {
  console.log('\n=== ' + dev.name + ' ' + dev.viewport.width + '×' + dev.viewport.height);
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const ctx = await browser.newContext({viewport: dev.viewport, hasTouch: dev.hasTouch, isMobile: dev.isMobile, deviceScaleFactor: 1});
  await ctx.addInitScript(fakeVoice);
  const page = await ctx.newPage();
  const net = [], cons = [];
  page.on('request', r => { if (!r.url().startsWith('file:')) net.push(r.url()); });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') cons.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => cons.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());

  const tap = async sel => { const l = typeof sel === 'string' ? page.locator(sel).first() : sel; if (dev.hasTouch) await l.tap(); else await l.click(); };
  const shot = async name => page.screenshot({path: path.join(SHOTS, dev.name + '-' + name + '.png')});
  const stage = () => page.evaluate(() => G.stage);
  const sessions = () => page.evaluate(() => { const d = load(); return Object.keys(d.kids).reduce((a, k) => a + d.kids[k].sessions.length, 0); });

  await page.goto(FILE);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();

  // Розв'язати поточне завдання; wrongFirst — спершу навмисна помилка
  async function solve(wrongFirst, pairFirst) {
    const type = await page.evaluate(() => G.task.type);
    const i0 = await page.evaluate(() => G.i);
    if (type === 'count') {
      const flash = await page.evaluate(() => G.task.flash);
      if (!flash) {
        const n = await page.locator('#stage .cnt').count();
        for (let k = 0; k < n; k++) await tap(page.locator('#stage .cnt').nth(k));
      }
      await page.waitForFunction(() => $('cards').style.visibility !== 'hidden', null, {timeout: 8000});
    }
    if (type === 'compare' && pairFirst) { await tap('#stage .pair-btn'); await page.waitForTimeout(700); }
    if (wrongFirst) {
      const wrong = page.locator('#v-task .card:not([data-ok]), #v-task .zone:not([data-ok])');
      if (await wrong.count()) {
        await tap(wrong.first());
        const e = await page.evaluate(() => G.errors);
        if (e !== 1) fail(dev.name, 'помилка не зарахована (' + type + ')');
      }
    }
    await tap('#v-task [data-ok]');
    await page.waitForFunction(i => G.stage !== 'task' || G.i > i, i0, {timeout: 8000});
    return type;
  }
  async function playLesson(id, opts) {
    opts = opts || {};
    if (await stage() !== 'greet') throw new Error('очікував привітання, маю ' + await stage());
    await tap('#btnStart');
    for (let k = 0; k < 3; k++) { await tap('#star'); await page.waitForTimeout(80); }
    await page.waitForFunction(() => G.stage === 'task', null, {timeout: 5000});
    let n = 0, first = true;
    const types = new Set();
    while (await stage() === 'task') {
      if (first && opts.shot) await shot('lesson-' + id);
      if (opts.onTask) await opts.onTask(n);
      types.add(await solve(first, true));
      first = false; n++;
      if (n > 15) throw new Error('забагато завдань у ' + id);
    }
    const st = await stage();
    if (st !== 'end') fail(dev.name, id + ': після завдань стан ' + st);
    else ok(id + ': ' + n + ' завдань до зорепаду (' + Array.from(types).join(', ') + ')');
    if (opts.endShot) await shot('end');
    await tap('#btnDone');
    await page.waitForFunction(() => G.stage === 'list');
    return n;
  }
  const openOther = async id => {
    const more = page.locator('details.more');
    if (await more.count() && !(await more.evaluate(e => e.open))) await tap('details.more summary');
    await tap('#listBody [data-lesson="' + id + '"]:not(.rec-go)');
  };

  // ---------- Шлях вчителя ----------
  await tap('#roleSeg [data-role="teacher"]');
  await tap('.kid[data-kid="liza"]');
  await page.waitForFunction(() => G.stage === 'list');
  await shot('list-teacher');
  const rec0 = await page.evaluate(() => recommended('liza'));
  rec0 === 'G01' ? ok('рекомендований для нової дитини — Г01') : fail(dev.name, 'рекомендований ' + rec0);

  // Г03: підготовка, 🔊 прикладів, «Спробуйте самі»
  await tap('#listBody [data-lesson="G03"]');
  if (await stage() !== 'guide') fail(dev.name, 'вчитель не потрапив у підготовку Г03');
  await tap('#guideNav [data-tab="G03"]');
  await shot('guide-G03');
  const sp0 = await page.evaluate(() => window.__spoken.length);
  await tap('#guideBody .demo .speak');
  await page.waitForTimeout(600);
  const demoSaid = await page.evaluate(n => window.__spoken.slice(n), sp0);
  JSON.stringify(demoSaid) === JSON.stringify(['миша', 'мавпа', 'морква', 'кіт'])
    ? ok('🔊 у матеріалі Г03 каже лише слова: ' + demoSaid.join(', ')) : fail(dev.name, '🔊 Г03 сказав: ' + demoSaid.join(' | '));
  const before = await sessions();
  await tap('#guideBody [data-act="try"]');
  for (let k = 0; k < 3; k++) await solve(k === 0);
  if (await stage() !== 'guide') fail(dev.name, '«Спробуйте самі» Г03 не повернуло в матеріал');
  (await sessions()) === before ? ok('«Спробуйте самі» Г03 нічого не записало') : fail(dev.name, '«Спробуйте самі» записало сесію');
  await tap('#guideNav [data-act="back"]');

  // М01: підготовка з математики, пробний прохід, потім «Я підготувався» і справжній урок
  await tap('#listBody [data-lesson="M01"]');
  await tap('#guideNav [data-tab="M01"]');
  await shot('guide-M01');
  await tap('#guideBody [data-act="try"]');
  for (let k = 0; k < 3; k++) await solve(false);
  (await sessions()) === before ? ok('«Спробуйте самі» М01 нічого не записало') : fail(dev.name, '«Спробуйте самі» М01 записало сесію');
  await tap('#guideNav [data-tab="done"]');
  await tap('#guideBody [data-act="ready"]');
  await playLesson('M01', {shot: true});
  // Вдруге — лише нагадування
  await tap('#listBody [data-lesson="M01"]');
  (await stage()) === 'remind' ? ok('підготовлений урок відкриває нагадування') : fail(dev.name, 'замість нагадування ' + await stage());
  await tap('#remindBack');

  // ---------- Шлях мами ----------
  await tap('#listBack');
  await tap('#roleSeg [data-role="mama"]');
  await tap('.kid[data-kid="marko"]');
  await page.waitForFunction(() => G.stage === 'list');
  await shot('list-mama');
  await tap('#listBody .rec-go');
  const l1 = await page.evaluate(() => G.lesson);
  (await stage()) === 'greet' && l1 === 'G01' ? ok('мама: рекомендований урок стартує однією кнопкою (Г01)') : fail(dev.name, 'мама: ' + l1 + ' ' + await stage());
  await playLesson('G01', {shot: true, endShot: true});
  const rec1 = await page.evaluate(() => recommended('marko'));
  rec1 === 'G02' ? ok('після Г01 сьогодні рекомендовано Г02') : fail(dev.name, 'після Г01 рекомендовано ' + rec1);

  // Решта уроків
  for (const id of ['G02', 'G03', 'G07', 'G08', 'G11', 'G12', 'M02', 'MX']) {
    await openOther(id);
    await playLesson(id, {shot: true});
  }
  // Урок 10 пише кожну навичку окремо
  const mx = await page.evaluate(() => { const s = stats('marko'); return ['M03', 'M04', 'M05', 'M06'].map(k => s[k].n); });
  mx.every(n => n === 1) ? ok('урок М03–М06 записав М03, М04, М05, М06 окремо') : fail(dev.name, 'урок-мікс записав ' + mx);

  // Буквар: різний порядок голосних у Г08
  if (dev.name === 'phone') {
    const order = async bk => {
      await tap('#listBody [data-bukvar="' + bk + '"]');
      const n0 = await page.evaluate(() => window.__spoken.length);
      await openOther('G08');
      await playLesson('G08');
      const said = await page.evaluate(n => window.__spoken.slice(n), n0);
      return said.filter(x => /^[аоуиіе]$/.test(x)).slice(0, 6).join(' ');
    };
    const b = await order('B'), v = await order('V');
    b === 'а о у и і е' && v === 'а о і и у е' ? ok('Г08: Большакова «' + b + '», Вашуленко «' + v + '»')
      : fail(dev.name, 'Г08 порядок: Б «' + b + '», В «' + v + '»');
  }

  // ⚙
  await tap('#listGear');
  await page.waitForTimeout(200);
  await shot('panel');
  const rows = await page.locator('#panelBody tr').count();
  rows >= 14 ? ok('⚙: ' + rows + ' рядків (10 уроків + навички міксу)') : fail(dev.name, '⚙: лише ' + rows + ' рядків');
  await tap('#panelClose');

  // Вихід через батьківський бар'єр (утримання 3 с)
  if (dev.name === 'pc') {
    await openOther('G02');
    await tap('#btnStart');
    const b = await page.locator('#exit').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.waitForTimeout(3300); await page.mouse.up();
    await page.fill('#gateAns', '15'); await page.click('#gateOk');
    (await stage()) === 'list' ? ok('вихід: утримання 3 с + 7+8 → список уроків') : fail(dev.name, 'вихід привів у ' + await stage());
  }

  // Повний перебір: кожне можливе завдання кожного уроку (багато разів, бо вибір випадковий)
  const sweep = await page.evaluate(async () => {
    const said = [];
    const orig = window.speechSynthesis.speak;
    window.speechSynthesis.speak = u => { said.push(u.text); };
    G.kid = 'olia'; G.trial = {lesson: 'G01', sk: 'G01'};
    show('task');
    for (const id of ORDER) for (const bk of ['B', 'V', '?']) for (let r = 0; r < 25; r++) {
      const ts = LESSONS[id].tasks({bukvar: bk});
      for (let i = 0; i < ts.length; i++) {
        G.tasks = ts; G.i = i; renderTask();
        G.instr.forEach(p => { if (p.on) p.on(); });
        if (G.task.praise) say(G.task.praise);
      }
    }
    // Фрази рушія, яких перебір не торкнувся
    Object.keys(PHRASES).forEach(k => say(PHRASES[k]));
    NUM.slice(1, 6).forEach(n => say({t: cap(n) + '.'}));
    window.speechSynthesis.speak = orig;
    G.trial = null; hush(); toWho();
    return said;
  });
  const all = (await page.evaluate(() => window.__spoken)).concat(sweep);
  const blocked = await page.evaluate(() => VOICE_BLOCKED.slice());
  const uniq = Array.from(new Set(all));
  const bad = uniq.map(t => [t, voiceBad(t)]).filter(x => x[1]);
  if (bad.length) bad.forEach(x => fail(dev.name, 'голос: «' + x[0] + '» — ' + x[1]));
  else ok('§0: ' + all.length + ' викликів speak (' + uniq.length + ' різних текстів) — жодного окремого приголосного, дужок чи «мммак»');
  blocked.length ? fail(dev.name, 'рушій відсік: ' + blocked.join(' | ')) : ok('запобіжник рушія нічого не відсікав');
  fs.writeFileSync(path.join(SHOTS, dev.name + '-spoken.txt'), uniq.sort().join('\n'));

  net.length ? fail(dev.name, 'мережеві запити: ' + net.join(', ')) : ok('жодного мережевого запиту');
  cons.length ? fail(dev.name, 'консоль: ' + cons.join(' | ')) : ok('консоль чиста');
  await browser.close();
}

// Без українського голосу: бульбашка велика, дорослому — що сказати вголос
async function noVoice() {
  console.log('\n=== без голосу (phone)');
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const ctx = await browser.newContext({viewport: {width: 360, height: 740}, hasTouch: true, isMobile: true});
  const page = await ctx.newPage();
  const cons = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') cons.push(m.text()); });
  page.on('pageerror', e => cons.push(e.message));
  await page.goto(FILE);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('beregynia-uroky-role', 'mama'); G.kid = 'liza'; G.lesson = 'G11'; startTasks(); });
  await page.waitForTimeout(1500);
  const aloud = await page.textContent('#aloud');
  const lit = await page.locator('#cards .card.lit').count();
  await page.screenshot({path: path.join(SHOTS, 'novoice-G11.png')});
  /Скажіть уголос: \S+ · \S+ · \S+/.test(aloud) ? ok('без голосу дорослий бачить: ' + aloud) : fail('novoice', 'підказка дорослому: ' + aloud);
  lit === 1 ? ok('без голосу кнопки засвічуються таймером') : fail('novoice', 'засвічених кнопок: ' + lit);
  cons.length ? fail('novoice', 'консоль: ' + cons.join(' | ')) : ok('консоль чиста');
  await browser.close();
}

(async () => {
  for (const d of DEVICES) {
    try { await run(d); } catch (e) { fail(d.name, 'зупинилось: ' + e.message.split('\n')[0]); }
  }
  try { await noVoice(); } catch (e) { fail('novoice', 'зупинилось: ' + e.message.split('\n')[0]); }
  console.log('\n' + (problems.length ? 'ПРОБЛЕМИ (' + problems.length + '):\n' + problems.join('\n') : 'УСЕ ГАРАЗД'));
  console.log('Скріншоти: ' + SHOTS);
  process.exit(problems.length ? 1 : 0);
})();

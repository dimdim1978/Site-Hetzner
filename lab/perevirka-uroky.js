/* Наскрізна перевірка lab/uroky.html (docs/uroky-10.md §5, docs/uroky-11.md §D).
   Запуск: NODE_PATH=$(npm root -g) node lab/perevirka-uroky.js [тека-для-скріншотів]
   Голос браузера підмінено: кожен speak() записується, і ми перевіряємо правило §0 —
   жоден текст не є окремим приголосним, нічого в квадратних дужках, жодного «мммак».
   Два проходи: без записів звуків (тека audio/ поруч порожня) і з фейковими WAV у тимчасовій
   теці — там HTMLMediaElement.play підмінено, і ми перевіряємо, що звук іде саме з файлу. */
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

// Записи, яких потребують звукові уроки, і голосні (Г08 гратиме їх із запису)
const SND_IDS = ['a', 'o', 'u', 'y', 'i', 'e', 'm', 'n', 'l', 'r', 's', 'sh', 'v', 'n_soft', 'l_soft'];
// 1 с тону, 16 біт, моно — для тесту досить
function wav(freq) {
  const rate = 8000, n = rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000), 44 + i * 2);
  return buf;
}
// Звідки грали записи: src і завдання, під час якого
function hookPlay() {
  window.__played = [];
  const op = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    let task = null; try { task = G.task; } catch (e) { /* рушій ще не готовий */ }
    window.__played.push({src: this.src, task});
    return op.apply(this, arguments);
  };
}
// Відсутній файл браузер пише в консоль сам; без записів сторінка пробує лише snd_s.wav
const MISS_S = /audio\/snd_s\.wav$/;

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
  let missS = 0;
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (/Failed to load resource/.test(m.text()) && MISS_S.test((m.location() || {}).url || '')) { missS++; return; }
    cons.push(m.type() + ': ' + m.text() + ' @ ' + ((m.location() || {}).url || ''));
  });
  page.on('pageerror', e => cons.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());

  const tap = async sel => { const l = typeof sel === 'string' ? page.locator(sel).first() : sel; if (dev.hasTouch) await l.tap(); else await l.click(); };
  const shot = async name => page.screenshot({path: path.join(SHOTS, dev.name + '-' + name + '.png')});
  const stage = () => page.evaluate(() => G.stage);
  const sessions = () => page.evaluate(() => { const d = load(); return Object.keys(d.kids).reduce((a, k) => a + d.kids[k].sessions.length, 0); });

  await page.goto(FILE);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForFunction(() => SND_DONE, null, {timeout: 20000});

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
  const waits = await page.$$eval('#listBody .lesson.wait', bs => bs.map(b => b.getAttribute('data-lesson') + ': ' + b.querySelector('.wn').textContent));
  waits.length === 4 && waits.every(w => /^G0[4569]: Чекає на записи звуків: \[/.test(w))
    ? ok('без записів: Г04 Г05 Г06 Г09 сірі у вчителя («' + waits[0].slice(5) + '»)') : fail(dev.name, 'сірі картки: ' + JSON.stringify(waits));
  const order = await page.$$eval('#listBody .lesson .code', cs => cs.map(c => c.textContent).join(' '));
  order === 'Г01 Г02 Г03 Г04 Г05 Г06 Г07 Г08 Г09 Г11 Г12 М01 М02 М03–М06' ? ok('порядок у списку: ' + order) : fail(dev.name, 'порядок: ' + order);
  // Сіра картка відкриває лише підготовку, заняття не стартує
  await tap('#listBody [data-lesson="G04"]');
  const g04 = await page.evaluate(() => ({st: G.stage, tryDis: !!document.querySelector('#guideBody [data-act="try"][disabled]'),
    snd: document.querySelectorAll('#guideBody .say-sm[disabled]').length}));
  g04.st === 'guide' && g04.tryDis && g04.snd === 3 ? ok('сіра Г04: підготовка читається, «Спробуйте самі» і 🔊 приголосних неактивні')
    : fail(dev.name, 'сіра Г04: ' + JSON.stringify(g04));
  await tap('#guideNav [data-act="back"]');
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
  const mamaSnd = await page.locator('#listBody [data-lesson="G04"], #listBody [data-lesson="G05"], #listBody [data-lesson="G06"], #listBody [data-lesson="G09"]').count();
  mamaSnd === 0 ? ok('без записів мама звукових уроків не бачить') : fail(dev.name, 'мама бачить звукових уроків: ' + mamaSnd);
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
  // ---------- Стартова й повторна перевірка ----------
  await checkFlow(page, dev, tap, shot, {kidWrong: 'olia', kidRight: 'liza', total: 18});

  const all = (await page.evaluate(() => window.__spoken)).concat(sweep);
  const blocked = await page.evaluate(() => VOICE_BLOCKED.slice());
  const uniq = Array.from(new Set(all));
  const bad = uniq.map(t => [t, voiceBad(t)]).filter(x => x[1]);
  if (bad.length) bad.forEach(x => fail(dev.name, 'голос: «' + x[0] + '» — ' + x[1]));
  else ok('§0: ' + all.length + ' викликів speak (' + uniq.length + ' різних текстів) — жодного окремого приголосного, дужок чи «мммак»');
  blocked.length ? fail(dev.name, 'рушій відсік: ' + blocked.join(' | ')) : ok('запобіжник рушія нічого не відсікав');
  fs.writeFileSync(path.join(SHOTS, dev.name + '-spoken.txt'), uniq.sort().join('\n'));

  net.length ? fail(dev.name, 'мережеві запити: ' + net.join(', ')) : ok('жодного мережевого запиту');
  cons.length ? fail(dev.name, 'консоль: ' + cons.join(' | ')) : ok('консоль чиста' + (missS ? ' (крім ' + missS + '× «Failed to load resource» на audio/snd_s.wav — браузер сам пише про відсутній запис)' : ''));
  if (missS > 2) fail(dev.name, 'snd_s.wav пробувався ' + missS + ' разів на 2 завантаження');
  await browser.close();
}

// Один прохід перевірки: right — усе правильно, інакше все неправильно
async function oneCheck(page, dev, tap, right) {
  if (await page.evaluate(() => G.stage) !== 'list') throw new Error('перевірка: не на списку');
  await tap('#listBody [data-act="check"]');
  if (await page.evaluate(() => G.stage) !== 'check') fail(dev.name, 'кнопка перевірки не відкрила пояснення');
  const intro = await page.textContent('#checkBody');
  if (!/не тест і не оцінка/.test(intro) || !/Не підказуйте/.test(intro)) fail(dev.name, 'у поясненні бракує «не тест» / «не підказуйте»');
  await tap('#checkBody [data-act="go"]');
  await tap('#btnStart');
  for (let k = 0; k < 3; k++) { await tap('#star'); await page.waitForTimeout(80); }
  await page.waitForFunction(() => G.stage === 'task', null, {timeout: 5000});
  const n0 = await page.evaluate(() => window.__spoken.length);
  let n = 0, feedback = 0;
  const sessions0 = await page.evaluate(() => { const d = load(); return Object.keys(d.kids).reduce((a, k) => a + d.kids[k].sessions.length, 0); });
  while (await page.evaluate(() => G.stage) === 'task') {
    const t = await page.evaluate(() => ({type: G.task.type, flash: G.task.flash, i: G.i}));
    if (t.type === 'count') {
      if (!t.flash) { const c = await page.locator('#stage .cnt').count(); for (let k = 0; k < c; k++) await tap(page.locator('#stage .cnt').nth(k)); }
      await page.waitForFunction(() => $('cards').style.visibility !== 'hidden', null, {timeout: 8000});
    }
    await tap(right ? '#v-task [data-ok]' : page.locator('#v-task .card:not([data-ok])').first());
    feedback += await page.evaluate(() => document.querySelectorAll('.check, .shake, .hint').length);
    await page.waitForFunction(i => G.stage !== 'task' || G.i > i, t.i, {timeout: 8000});
    if (++n > 30) throw new Error('перевірка не закінчується');
  }
  const said = await page.evaluate(n => window.__spoken.slice(n), n0);
  const bad = said.filter(x => ['молодець!', 'чудово!', 'так, правильно!', 'супер!', 'спробуй ще.'].indexOf(x) >= 0);
  feedback || bad.length ? fail(dev.name, 'перевірка дала відгук: ' + feedback + ' знаків, ' + bad.join(', '))
    : said.filter(x => x === 'дякую!').length === n ? ok('без відгуку: після кожної з ' + n + ' відповідей лише «Дякую!»') : fail(dev.name, '«Дякую!» не після кожної відповіді');
  const sessions1 = await page.evaluate(() => { const d = load(); return Object.keys(d.kids).reduce((a, k) => a + d.kids[k].sessions.length, 0); });
  if (sessions1 !== sessions0) fail(dev.name, 'перевірка записала сесію уроку');
  if (await page.evaluate(() => G.stage) !== 'end') fail(dev.name, 'після перевірки немає зорепаду');
  await tap('#btnDone');
  const res = await page.evaluate(() => ({st: G.stage, rows: Array.from(document.querySelectorAll('#checkTbl tr')).map(r => r.getAttribute('data-row') + '=' + r.cells[1].textContent),
    concl: $('checkConcl').textContent}));
  if (res.st !== 'check') fail(dev.name, 'після зорепаду немає результату для дорослого');
  return {n, rows: res.rows, concl: res.concl};
}

async function checkFlow(page, dev, tap, shot, o) {
  const toKid = async kid => { if (await page.evaluate(() => G.stage) !== 'who') await tap('#listBack'); await tap('.kid[data-kid="' + kid + '"]'); };
  // Усе неправильно: правило зупинки в кожній лінії
  await toKid(o.kidWrong);
  const w = await oneCheck(page, dev, tap, false);
  const skipped = w.rows.filter(r => /пропущено/.test(r)).map(r => r.split('=')[0]);
  w.n === 8 && skipped.join(' ') === (o.total === 22 ? 'G03 G04 G08 G09 G11 M05 M06' : 'G03 G08 G11 M05 M06')
    ? ok('«усе неправильно»: ' + w.n + ' завдань, зупинка після двох нулів у лінії; пропущено ' + skipped.join(' ') + '; ' + w.concl)
    : fail(dev.name, '«усе неправильно»: ' + w.n + ' завдань, ' + w.rows.join(', '));
  await tap('#checkBody [data-act="list"]');
  const lbl0 = await page.textContent('#listBody .check-box');
  /Сьогодні перевірку вже пройдено/.test(lbl0) ? ok('того ж дня повторна недоступна') : fail(dev.name, 'того ж дня: ' + lbl0);
  const rec = await page.evaluate(() => G.kid && recommended(G.kid));
  rec === 'G01' ? ok('після перевірки рекомендовано ' + rec) : fail(dev.name, 'після перевірки рекомендовано ' + rec);
  // Повторна — через «Імітувати завтра»
  await tap('#listGear'); await tap('#panelTomorrow'); await tap('#panelClose');
  const lbl = await page.textContent('#listBody [data-act="check"]');
  /Повторна перевірка \(перша — \d\d\.\d\d\.\d{4}\)/.test(lbl) ? ok('кнопка: «' + lbl.replace('🧭 ', '') + '»') : fail(dev.name, 'кнопка повторної: ' + lbl);
  const r = await oneCheck(page, dev, tap, true);
  r.n === o.total && r.rows.every(x => /2 з 2/.test(x)) ? ok('повторна «усе правильно»: ' + r.n + ' завдань, усе 2 з 2; ' + r.concl)
    : fail(dev.name, 'повторна: ' + r.n + ' завдань, ' + r.rows.join(', '));
  await shot('check-result');
  await tap('#checkBody [data-act="list"]');
  await tap('#listGear');
  const t = await page.$$eval('#panelChecksBody tr', rs => rs.map(r => r.cells[0].textContent.split(' ')[0] + ' ' + r.cells[1].textContent + ' → ' + r.cells[2].textContent + ' ' + r.cells[3].textContent));
  t.length === o.total / 2 && t.every(x => /↑$/.test(x)) ? ok('⚙ «перша → повторна»: ' + t.length + ' навичок, усі ↑ (' + t[0] + '; ' + t[t.length - 1] + ')')
    : fail(dev.name, '⚙ перша → повторна: ' + t.join(' | '));
  await page.evaluate(() => $('panelChecks').scrollIntoView());
  await shot('panel-checks');
  await tap('#panelClose');
  // Усе правильно як стартова — в іншої дитини
  await toKid(o.kidRight);
  const a = await oneCheck(page, dev, tap, true);
  a.n === o.total && /^Усі перевірені навички — 2 з 2/.test(a.concl) ? ok('стартова «усе правильно»: ' + a.n + ' завдань; ' + a.concl)
    : fail(dev.name, 'стартова «усе правильно»: ' + a.n + ', ' + a.concl);
  await tap('#checkBody [data-act="list"]');
}

// З фейковими записами: копія сторінки в тимчасовій теці, поруч audio/snd_<id>.wav
async function withFiles(dev) {
  console.log('\n=== з записами звуків: ' + dev.name + ' ' + dev.viewport.width + '×' + dev.viewport.height);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uroky-snd-'));
  fs.copyFileSync(path.resolve(__dirname, 'uroky.html'), path.join(dir, 'uroky.html'));
  fs.mkdirSync(path.join(dir, 'audio'));
  SND_IDS.forEach((id, i) => fs.writeFileSync(path.join(dir, 'audio', 'snd_' + id + '.wav'), wav(300 + i * 40)));
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const ctx = await browser.newContext({viewport: dev.viewport, hasTouch: dev.hasTouch, isMobile: dev.isMobile, deviceScaleFactor: 1});
  await ctx.addInitScript(fakeVoice);
  await ctx.addInitScript(hookPlay);
  const page = await ctx.newPage();
  const net = [], cons = [];
  page.on('request', r => { if (!r.url().startsWith('file:')) net.push(r.url()); });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') cons.push(m.type() + ': ' + m.text() + ' @ ' + ((m.location() || {}).url || '')); });
  page.on('pageerror', e => cons.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  const tap = async sel => { const l = typeof sel === 'string' ? page.locator(sel).first() : sel; if (dev.hasTouch) await l.tap(); else await l.click(); };
  const shot = async name => page.screenshot({path: path.join(SHOTS, dev.name + '-snd-' + name + '.png')});
  await page.goto('file://' + path.join(dir, 'uroky.html'));
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForFunction(() => SND_DONE, null, {timeout: 20000});
  const okIds = await page.evaluate(() => Object.keys(SND_OK).filter(k => SND_OK[k]).sort().join(' '));
  okIds === SND_IDS.slice().sort().join(' ') ? ok('знайдено записи: ' + okIds) : fail(dev.name, 'SND_OK: ' + okIds);

  // Вчитель: сірих немає, 🔊 у підготовці грає з файлу
  await tap('#roleSeg [data-role="teacher"]');
  await tap('.kid[data-kid="liza"]');
  const waits = await page.locator('#listBody .lesson.wait').count();
  waits === 0 ? ok('з записами сірих карток немає') : fail(dev.name, 'сірих карток: ' + waits);
  await shot('list-teacher');
  await tap('#listBody [data-lesson="G05"]');
  await tap('#guideNav [data-tab="G05"]');
  const p0 = await page.evaluate(() => window.__played.length);
  await tap('#guideBody [data-act="snd"]');
  await page.waitForFunction(n => window.__played.length >= n + 3, p0, {timeout: 10000}).catch(() => {});
  const gp = await page.evaluate(n => window.__played.slice(n).map(x => x.src.split('/').pop()).join(' '), p0);
  gp === 'snd_s.wav snd_y.wav snd_r.wav' ? ok('🔊 у підготовці Г05 грає з файлів: ' + gp) : fail(dev.name, '🔊 Г05 у підготовці: ' + gp);
  await shot('guide-G05');
  await tap('#guideNav [data-act="back"]');
  await tap('#listBack');

  // Мама: звукові уроки видно; кожне завдання справді грає свої файли
  await tap('#roleSeg [data-role="mama"]');
  await tap('.kid[data-kid="marko"]');
  for (const id of ['G04', 'G05', 'G06', 'G09']) {
    const more = page.locator('details.more');
    if (!(await more.evaluate(e => e.open))) await tap('details.more summary');
    await tap('#listBody [data-lesson="' + id + '"]:not(.rec-go)');
    await tap('#btnStart');
    for (let k = 0; k < 3; k++) { await tap('#star'); await page.waitForTimeout(80); }
    await page.waitForFunction(() => G.stage === 'task', null, {timeout: 5000});
    let n = 0, heard = 0, first = true;
    while (await page.evaluate(() => G.stage) === 'task') {
      if (first) await shot('lesson-' + id);
      const got = await page.waitForFunction(() => {
        const want = G.task.files || [];
        const srcs = window.__played.filter(x => x.task === G.task).map(x => x.src);
        return want.length && want.every(f => srcs.some(s => s.endsWith('/audio/snd_' + f + '.wav')));
      }, null, {timeout: 12000}).then(() => true, () => false);
      if (got) heard++;
      else fail(dev.name, id + ': завдання ' + (n + 1) + ' не програло ' + (await page.evaluate(() => (G.task.files || []).join(','))));
      const i0 = await page.evaluate(() => G.i);
      if (first) { const w = page.locator('#v-task .card:not([data-ok])'); await tap(w.first()); first = false; }
      await tap('#v-task [data-ok]');
      await page.waitForFunction(i => G.stage !== 'task' || G.i > i, i0, {timeout: 8000});
      if (++n > 15) throw new Error('забагато завдань у ' + id);
    }
    const st = await page.evaluate(() => G.stage);
    st === 'end' && heard === n ? ok(id + ': ' + n + ' завдань до зорепаду, у кожному звук із файлу') : fail(dev.name, id + ': стан ' + st + ', зі звуком ' + heard + ' з ' + n);
    await tap('#btnDone');
    await page.waitForFunction(() => G.stage === 'list');
  }
  // Перевірка з записами: + Г04 і Г09, 22 завдання
  await tap('#listBack');
  await checkFlow(page, dev, tap, shot, {kidWrong: 'olia', kidRight: 'liza', total: 22});

  const srcs = await page.evaluate(() => window.__played.map(x => x.src));
  const foreign = srcs.filter(s => !/\/audio\/snd_[a-z_]+\.wav$/.test(s));
  foreign.length ? fail(dev.name, 'грало не з audio/: ' + foreign.join(', ')) : ok('усі ' + srcs.length + ' програвань — з audio/snd_*.wav');
  const spoken = Array.from(new Set(await page.evaluate(() => window.__spoken)));
  const bad = spoken.map(t => [t, voiceBad(t)]).filter(x => x[1]);
  bad.length ? bad.forEach(x => fail(dev.name, 'голос: «' + x[0] + '» — ' + x[1])) : ok('§0 з записами: ' + spoken.length + ' різних текстів голосу — жодного окремого приголосного');
  const blocked = await page.evaluate(() => VOICE_BLOCKED.slice());
  blocked.length ? fail(dev.name, 'рушій відсік: ' + blocked.join(' | ')) : ok('запобіжник рушія нічого не відсікав');
  net.length ? fail(dev.name, 'мережеві запити: ' + net.join(', ')) : ok('жодного мережевого запиту (лише файли поруч)');
  cons.length ? fail(dev.name, 'консоль: ' + cons.join(' | ')) : ok('консоль чиста');
  await browser.close();
  fs.rmSync(dir, {recursive: true, force: true});
}

// Без українського голосу: бульбашка велика, дорослому — що сказати вголос
async function noVoice() {
  console.log('\n=== без голосу (phone)');
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const ctx = await browser.newContext({viewport: {width: 360, height: 740}, hasTouch: true, isMobile: true});
  const page = await ctx.newPage();
  const cons = [];
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (/Failed to load resource/.test(m.text()) && MISS_S.test((m.location() || {}).url || '')) return;
    cons.push(m.text());
  });
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
  for (const d of DEVICES) {
    try { await withFiles(d); } catch (e) { fail(d.name + '/snd', 'зупинилось: ' + e.message.split('\n')[0]); }
  }
  try { await noVoice(); } catch (e) { fail('novoice', 'зупинилось: ' + e.message.split('\n')[0]); }
  console.log('\n' + (problems.length ? 'ПРОБЛЕМИ (' + problems.length + '):\n' + problems.join('\n') : 'УСЕ ГАРАЗД'));
  console.log('Скріншоти: ' + SHOTS);
  process.exit(problems.length ? 1 : 0);
})();

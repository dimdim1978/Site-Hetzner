/* Наскрізна перевірка уроків 5–8 (docs/uroky-10.md §5, uroky-11.md §D, uroky-12.md §F,
   docs/kabinet-uroky.md §10б).
   Запуск: NODE_PATH=$(npm root -g) node lab/perevirka-uroky.js [тека-для-скріншотів]
   ONLY=phone (tablet, pc) — лише один пристрій; PARTS=secur,run,files,novoice — лише ці проходи.

   Сторінку уроків тепер віддає Flask (server/uroky/uroky.html), тож перевірка сама піднімає
   server/app.py з DEV=1 і тимчасовими базами (beregynia.db, navchannia.db) та текою записів,
   заводить адміністратора й педагога, дітей і коди активації — так, як це робитиме Дмитро.

   Голос браузера підмінено: кожен speak() записується, і ми перевіряємо правило §0 —
   жоден текст не є окремим приголосним, нічого в квадратних дужках, жодного «мммак».
   Два проходи уроків: без записів звуків (тека порожня) і з фейковими WAV у ній — там
   HTMLMediaElement.play підмінено, і ми перевіряємо, що звук іде саме з файлу. */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const {spawn, execFileSync} = require('child_process');
const {chromium, request} = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'uroky-shots');
fs.mkdirSync(SHOTS, {recursive: true});
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uroky-srv-'));
const DB = path.join(TMP, 'beregynia.db'), NAVCH = path.join(TMP, 'navchannia.db'), AUDIO = path.join(TMP, 'audio');
fs.mkdirSync(AUDIO);
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const ENV = Object.assign({}, process.env, {DEV: '1', DB_PATH: DB, NAVCH_DB_PATH: NAVCH, UROKY_AUDIO_DIR: AUDIO, PYTHONDONTWRITEBYTECODE: '1'});
const ADMIN = {login: 'dima', password: 'dima-pass-123'}, TEACHER = {login: 'vika', password: 'vika-pass-123'};
// Окремий педагог для блоку безпеки: «Я підготувався» в нього своє, і не зачепить проходів уроків
const TEACHER2 = {login: 'olena', password: 'olena-pass-123'};

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

// Голоси: український і два англійські — сторінка має обрати en-GB, хоч en-US і йде першим
const EN_WORDS = ['stand up', 'sit down', 'clap your hands', 'jump', 'stop', 'turn around', 'red', 'blue', 'green', 'yellow', 'orange',
  'pink', 'black', 'white', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'cat', 'dog', 'fish', 'bird', 'rabbit', 'cow', 'horse', 'duck'];
const UK_TRANSL = ['встань', 'вставай', 'сядь', 'сідай', 'плесн', 'оплеск', 'стрибн', 'стрибай', 'стій', 'стоп', 'повернис', 'обернис',
  'червон', 'синій', 'синя', 'синє', 'блакит', 'зелен', 'жовт', 'помаранч', 'оранж', 'рожев', 'чорн', 'біл',
  'один', 'одна', 'два', 'дві', 'три', 'чотири', 'п’ять', "п'ять", 'шість', 'сім', 'вісім', 'дев’ять', "дев'ять", 'десять',
  'кіт', 'кішк', 'котик', 'собак', 'пес', 'песик', 'риб', 'птах', 'пташ', 'кролик', 'зайч', 'заєць', 'коров', 'кінь', 'коня', 'конячк', 'качк', 'каченя'];
function translated(text) {
  const words = String(text).toLowerCase().split(/[^а-яіїєґ'’]+/).filter(Boolean);
  return UK_TRANSL.filter(t => words.some(w => w.indexOf(t) === 0));
}

function fakeVoice() {
  window.__spoken = []; window.__utt = [];
  const voice = {lang: 'uk-UA', name: 'Тестовий голос', voiceURI: 'test-uk', default: true, localService: true};
  const us = {lang: 'en-US', name: 'Test US', voiceURI: 'test-en-us', default: false, localService: true};
  const gb = {lang: 'en-GB', name: 'Test GB', voiceURI: 'test-en-gb', default: false, localService: true};
  const q = []; let busy = false;
  const pump = () => {
    if (busy) return; const u = q.shift(); if (!u) return; busy = true;
    setTimeout(() => { if (u.onstart) u.onstart(); setTimeout(() => { busy = false; if (u.onend) u.onend(); pump(); }, 30); }, 5);
  };
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [voice, us, gb], addEventListener() {}, removeEventListener() {},
    cancel() { q.length = 0; }, pause() {}, resume() {},
    speak(u) { window.__spoken.push(u.text); window.__utt.push({text: u.text, lang: u.lang, voice: u.voice && u.voice.name}); q.push(u); pump(); }
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
const MISS_S = /\/uroky\/audio\/snd_s\.wav$/;

const problems = [];
const fail = (dev, msg) => { problems.push('[' + dev + '] ' + msg); console.log('  ✗ ' + msg); };
const ok = msg => console.log('  ✓ ' + msg);
const check = (cond, dev, good, bad) => cond ? ok(good) : fail(dev, bad);

/* ======================= Сервер ======================= */
let srv = null, srvLog = '';
const py = (args, opts) => execFileSync('python3', args, Object.assign({cwd: SERVER, env: ENV, encoding: 'utf8'}, opts || {}));
// SQL у тимчасову базу — лише для перевірки того, що записав сервер (і щоб «зістарити» код)
function sql(db, q, args) {
  const out = py(['-c', 'import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row\n' +
    'r=c.execute(sys.argv[2],json.loads(sys.argv[3]));rows=[dict(x) for x in r.fetchall()];c.commit();print(json.dumps(rows))', db, q, JSON.stringify(args || [])]);
  return JSON.parse(out);
}
async function startServer() {
  py(['app.py', 'adduser', ADMIN.login, ADMIN.password, 'admin', 'Дмитро']);
  py(['app.py', 'adduser', TEACHER.login, TEACHER.password, 'teacher', 'Вікторія']);
  py(['app.py', 'adduser', TEACHER2.login, TEACHER2.password, 'teacher', 'Олена']);
  srv = spawn('python3', ['-c', 'import app; app.app.run(host="127.0.0.1", port=' + PORT + ', threaded=True)'], {cwd: SERVER, env: ENV});
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/whoami'); if (r.ok) return; } catch (e) { /* ще стартує */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Flask не стартував:\n' + srvLog);
}
// Адмінка — API-клієнт із власною кукою сесії
let admin = null;
async function adminLogin() {
  admin = await request.newContext({baseURL: BASE});
  const r = await admin.post('/api/login', {form: ADMIN});
  if (!(await r.json()).ok) throw new Error('адмін не увійшов');
}
async function newKid(imia, prizv, bukvar) {
  const r = await admin.post('/admin/mudryk/dytyna', {form: {imia, prizvyshche: prizv, vik: '6', bukvar: bukvar || 'bolshakova'}});
  const d = await r.json(); if (!d.ok) throw new Error('дитину не створено: ' + JSON.stringify(d));
  return d;
}
async function newCode(nazva) {
  const d = await (await admin.post('/admin/mudryk/kod', {form: {nazva}})).json();
  if (!d.ok) throw new Error('код не створено'); return d.kod;
}

/* ======================= Браузер ======================= */
async function openDevice(browser, dev, nazva, extra) {
  const ctx = await browser.newContext(Object.assign({viewport: dev.viewport, hasTouch: dev.hasTouch, isMobile: dev.isMobile, deviceScaleFactor: 1, baseURL: BASE}, extra || {}));
  await ctx.addInitScript(fakeVoice);
  const page = await ctx.newPage();
  const net = [], cons = [];
  let missS = 0;
  page.on('request', r => { if (!r.url().startsWith(BASE + '/')) net.push(r.url()); });
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (/Failed to load resource/.test(m.text()) && MISS_S.test((m.location() || {}).url || '')) { missS++; return; }
    cons.push(m.type() + ': ' + m.text() + ' @ ' + ((m.location() || {}).url || ''));
  });
  page.on('pageerror', e => cons.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  const tap = async sel => { const l = typeof sel === 'string' ? page.locator(sel).first() : sel; if (dev.hasTouch) await l.tap(); else await l.click(); };
  // Активація кодом через сторінку — як мама на телефоні
  await page.goto('/uroky');
  if (!/\/uroky\/aktyvatsiia$/.test(page.url())) throw new Error('без куки пристрою не потрапили на активацію: ' + page.url());
  await page.fill('#kod', await newCode(nazva));
  await tap('#go');
  await page.waitForURL(/\/uroky\/vkhid$/);
  return {ctx, page, net, cons, tap, missS: () => missS};
}
async function login(D, hto, login_, password) {
  await D.page.goto('/uroky/vkhid');
  await D.tap('#who [data-hto="' + hto + '"]');
  await D.page.fill('#login', login_);
  await D.page.fill('#pass', password);
  await D.tap('#go');
  await D.page.waitForURL(hto === 'mama' ? /\/uroky$/ : /\/uroky\/dity$/);
}
async function chooseKid(D, id) {
  if (!/\/uroky\/dity$/.test(D.page.url())) await D.page.goto('/uroky/dity');
  await D.tap('button[data-kid="' + id + '"]');
  await D.page.waitForURL(/\/uroky$/);
  await waitList(D.page);
}
const waitList = page => page.waitForFunction(() => typeof G !== 'undefined' && G.stage === 'list' && SRV && SND_DONE, null, {timeout: 25000});
// Поки черга не порожня, сервер ще не знає про заняття
const settle = page => page.waitForFunction(() => !qBusy && qLoad().length === 0, null, {timeout: 15000});
const zan = (did, extra) => sql(NAVCH, 'SELECT * FROM zaniattia WHERE dytyna_id=?' + (extra || '') + ' ORDER BY id', [did]);

// Розв'язати поточне завдання; wrongFirst — спершу навмисна помилка
function solver(D, dev) {
  const {page, tap} = D;
  const tapSlot = async k => {
    const pt = await page.evaluate(k => {
      const sl = G.task.z.slots[k], P = PIECES[sl.p], a = sl.r * Math.PI / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
      const vs = P.pts.map(q => [sl.x + q[0] * c - q[1] * s, sl.y + q[0] * s + q[1] * c]);
      const svg = $('sil').querySelector('svg'), m = svg.getScreenCTM(), p = svg.createSVGPoint();
      p.x = vs.reduce((t, v) => t + v[0], 0) / vs.length * 80; p.y = vs.reduce((t, v) => t + v[1], 0) / vs.length * 80;
      const q = p.matrixTransform(m);
      return {x: q.x, y: q.y};
    }, k);
    if (dev.hasTouch) await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
  };
  // Ф05: торкнутися деталі, (повернути), торкнутися місця. wrong — спершу скласти без повороту
  async function compose(wrong) {
    const z = await page.evaluate(() => G.task.z.slots.map(s => s.p));
    if (wrong) {
      for (let k = 0; k < z.length; k++) {
        const i = await page.evaluate(p => G.task.pieces.findIndex((pc, i) => pc.p === p && G.task.st.at.indexOf(i) < 0), z[k]);
        await tap('#tray [data-piece="' + i + '"]');
        await tapSlot(k);
      }
      const st = await page.evaluate(() => ({e: G.errors, lock: G.lock, i: G.i}));
      check(st.e === 1 && !st.lock, dev.name, 'Ф05: без правильного повороту фігура не зарахована (помилка 1)', 'Ф05 без повороту: ' + JSON.stringify(st));
      await page.waitForTimeout(800);
    }
    for (let k = 0; k < z.length; k++) {
      const plan = await page.evaluate(k => {
        const sl = G.task.z.slots[k], st = G.task.st;
        if (st.at[k] >= 0 && rotFits(G.task.pieces[st.at[k]], sl)) return null;
        const i = G.task.pieces.findIndex((pc, i) => pc.p === sl.p && st.at.indexOf(i) < 0);
        const pc = G.task.pieces[i];
        let n = 0; while (n < 4 && !rotFits({p: pc.p, r: (pc.r + n * 90) % 360}, sl)) n++;
        return {i, n};
      }, k);
      if (!plan) continue;
      await tap('#tray [data-piece="' + plan.i + '"]');
      for (let r = 0; r < plan.n; r++) await tap('#rotBtn');
      await tapSlot(k);
    }
  }
  return async function solve(wrongFirst, pairFirst) {
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
    if (type === 'compose') { await compose(wrongFirst); await page.waitForFunction(i => G.stage !== 'task' || G.i > i, i0, {timeout: 8000}); return type; }
    if (wrongFirst) {
      const wrong = page.locator('#v-task .card:not([data-ok]), #v-task .zone:not([data-ok]), #v-task .pick:not([data-ok]):not(.got)');
      if (await wrong.count()) {
        await tap(wrong.first());
        const e = await page.evaluate(() => G.errors);
        if (e !== 1) fail(dev.name, 'помилка не зарахована (' + type + ')');
      }
    }
    // «Знайди всі» — правильних кілька: торкаємось, доки завдання не зарахується
    for (let k = 0; k < 8; k++) {
      await tap('#v-task [data-ok]');
      if (await page.evaluate(() => G.lock || !document.querySelector('#v-task [data-ok]'))) break;
    }
    await page.waitForFunction(i => G.stage !== 'task' || G.i > i, i0, {timeout: 8000});
    return type;
  };
}

/* ======================= Безпека й сервер (§10б) ======================= */
async function secur() {
  console.log('\n=== сервер: пристрої, вхід, прогрес (§10б)');
  const dev = DEVICES[0], N = 'secur';
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const kidA = await newKid('Аня', 'Коваль'), kidB = await newKid('Богдан', 'Мельник');

  // ---- без куки пристрою
  const bare = await request.newContext({baseURL: BASE, maxRedirects: 0});
  const loc = async (u, m) => { const r = await (m === 'post' ? bare.post(u, {data: {}}) : bare.get(u)); return r.status() + ' ' + (r.headers().location || ''); };
  const pages = ['/uroky', '/uroky/vkhid', '/uroky/stan', '/uroky/dity', '/uroky/vykhid'];
  const res = [];
  for (const u of pages) res.push(u + ' → ' + await loc(u));
  check(res.every(x => / 302 \/uroky\/aktyvatsiia$/.test(x)), N, 'без куки пристрою всі сторінки /uroky* → активація (' + pages.join(', ') + ')', 'без куки: ' + res.join(' | '));
  const api = [await loc('/uroky/api/stan'), await loc('/uroky/api/zaniattia', 'post'), await loc('/uroky/audio/snd_s.wav')];
  check(api.every(x => /^403/.test(x)), N, 'без куки API і звуки → 403', 'без куки API: ' + api.join(' | '));
  const open = [await loc('/uroky/aktyvatsiia'), await loc('/uroky/manifest.webmanifest'), await loc('/uroky/sw.js'), await loc('/uroky/icon-192.png')];
  check(open.every(x => /^200/.test(x)), N, 'активація, manifest, sw.js, іконки відкриті без куки', 'відкриті: ' + open.join(' | '));
  const rob = (await bare.get('/uroky/aktyvatsiia')).headers()['x-robots-tag'];
  check(rob === 'noindex, nofollow', N, 'X-Robots-Tag: ' + rob, 'X-Robots-Tag: ' + rob);
  // Перехід з Viber/пошти: кука SameSite=Strict не їде — сторінка один раз перезавантажує себе зсередини сайту
  const cs = await bare.get('/uroky/stan', {headers: {'Sec-Fetch-Site': 'cross-site'}});
  const csb = await cs.text();
  check(cs.status() === 200 && /location\.replace\("\/uroky\/stan\?s=1"\)/.test(csb), N, 'перехід ззовні: одне самоперезавантаження (?s=1), щоб Strict-кука поїхала', 'cross-site: ' + cs.status() + ' ' + csb.slice(0, 120));
  check(/^302 \/uroky\/aktyvatsiia/.test(await loc('/uroky/stan?s=1')), N, 'після самоперезавантаження без куки — активація (без циклу)', 'cross-site ?s=1 циклить');

  // ---- коди: перебір, повтор, строк
  const brute = await request.newContext({baseURL: BASE, extraHTTPHeaders: {'X-Forwarded-For': '10.9.9.9'}});
  const st5 = [];
  for (let i = 0; i < 5; i++) st5.push((await brute.post('/uroky/api/aktyvatsiia', {data: {kod: '0000000' + i}})).status());
  const good = await newCode('Перебір');
  const r6 = await brute.post('/uroky/api/aktyvatsiia', {data: {kod: good}});
  check(st5.join(',') === '400,400,400,400,400' && r6.status() === 429, N, '5 невдалих кодів з однієї IP → блок на 15 хв (навіть правильний код → 429)', 'перебір: ' + st5 + ' → ' + r6.status());
  const other = await request.newContext({baseURL: BASE, extraHTTPHeaders: {'X-Forwarded-For': '10.9.9.10'}});
  const r7 = await other.post('/uroky/api/aktyvatsiia', {data: {kod: good}});
  const r8 = await (await request.newContext({baseURL: BASE, extraHTTPHeaders: {'X-Forwarded-For': '10.9.9.11'}})).post('/uroky/api/aktyvatsiia', {data: {kod: good}});
  check(r7.status() === 200 && r8.status() === 400, N, 'з іншої IP код спрацював; другий раз той самий код — ні', 'повтор коду: ' + r7.status() + ', ' + r8.status());
  const old = await newCode('Прострочений');
  sql(NAVCH, "UPDATE kody SET expires_at='2020-01-01 00:00:00' WHERE nazva='Прострочений'");
  const r9 = await (await request.newContext({baseURL: BASE, extraHTTPHeaders: {'X-Forwarded-For': '10.9.9.12'}})).post('/uroky/api/aktyvatsiia', {data: {kod: old}});
  check(r9.status() === 400, N, 'прострочений код не спрацьовує', 'прострочений: ' + r9.status());
  const kodRow = sql(NAVCH, 'SELECT * FROM kody LIMIT 1')[0], prRow = sql(NAVCH, 'SELECT * FROM prystroi LIMIT 1')[0];
  check(Object.keys(kodRow).every(k => String(kodRow[k]) !== good) && prRow.token_hash.length === 64, N, 'у базі лише хеші: коду немає, токен пристрою — sha256', 'у базі: ' + JSON.stringify(kodRow));

  // ---- вчитель (роль teacher) не змінює дітей і кодів
  const tch = await request.newContext({baseURL: BASE});
  await tch.post('/api/login', {form: TEACHER2});
  const tk = await tch.post('/admin/mudryk/dytyna', {form: {imia: 'Х', prizvyshche: 'Х', vik: '6', bukvar: 'bolshakova'}});
  const tc = await tch.post('/admin/mudryk/kod', {form: {nazva: 'Х'}});
  const tl = await tch.get('/admin/mudryk');
  check(tk.status() === 403 && tc.status() === 403 && tl.status() === 200 && !/Додати дитину/.test(await tl.text()), N,
    'педагог бачить /admin/mudryk, але не додає дітей і кодів (403)', 'педагог в адмінці: ' + tk.status() + ' ' + tc.status() + ' ' + tl.status());

  // ---- мама: лише своя дитина
  const M = await openDevice(browser, dev, 'Телефон мами Ані');
  await M.page.screenshot({path: path.join(SHOTS, 'vkhid.png')});
  await login(M, 'mama', kidA.login, kidA.password.toUpperCase().replace('-', ' '));
  await waitList(M.page);
  const ck = (await M.ctx.cookies()).find(c => c.name === 'session');
  const days = ck ? Math.round((ck.expires * 1000 - Date.now()) / 86400000) : 0;
  check(days === 30, N, 'сесія мами живе 30 днів (пароль ВЕЛИКИМИ і без дефіса теж приймається)', 'сесія мами: ' + days + ' днів');
  const devCk = (await M.ctx.cookies()).find(c => c.name === 'beregynia_dev');
  check(devCk && devCk.httpOnly && devCk.sameSite === 'Strict' && devCk.path === '/uroky' && Math.round((devCk.expires * 1000 - Date.now()) / 86400000) === 400, N,
    'кука пристрою: HttpOnly, SameSite=Strict, Path=/uroky, 400 днів', 'кука пристрою: ' + JSON.stringify(devCk));
  const empty = await M.page.evaluate(() => ({t: $('listBody').textContent, lessons: document.querySelectorAll('#listBody [data-lesson]').length,
    check: !!document.querySelector('#listBody [data-act="check"]'), gear: !$('gear').hidden, back: !$('listBack').hidden, guide: !$('btnGuide').hidden}));
  check(/Уроки з’являться тут після першого заняття з педагогом/.test(empty.t) && !empty.lessons && !empty.check && !empty.gear && !empty.back && !empty.guide, N,
    'мама до першого заняття педагога: порожньо з поясненням; ні перевірки, ні ⚙, ні матеріалу для вчителя', 'мама до педагога: ' + JSON.stringify(empty));
  await M.page.screenshot({path: path.join(SHOTS, 'mama-empty.png')});
  const mfetch = (u, body) => M.page.evaluate(([u, body]) => fetch(u, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})
    .then(r => r.json().then(d => ({s: r.status, d}), () => ({s: r.status}))), [u, body]);
  const sA = await mfetch('/uroky/api/stan?dytyna=' + kidB.id);
  check(sA.d.dytyna.id === kidA.id, N, 'підміна ?dytyna=' + kidB.id + ' у запиті стану нічого не дає', 'мама отримала дитину ' + sA.d.dytyna.id);
  // n днів тому; h — лише для порядку в межах дня (і ніколи не в майбутньому)
  const day = (n, h) => new Date(Date.now() - n * 86400000 - (24 - (h || 10)) * 60000).toISOString();
  const body = (did, urok, sk, p, u, when, kid) => ({klient_id: kid || ('t-' + Math.random().toString(36).slice(2, 12)), vyd: 'urok', urok, pochatok: when || day(0), dytyna: did, navychky: {[sk]: {pershi: p, usogo: u}}});
  const foreign = await mfetch('/uroky/api/zaniattia', body(kidB.id, 'G01', 'G01', 1, 1));
  check(foreign.s === 403 && !zan(kidB.id).length, N, 'мама не може записати заняття чужій дитині (403)', 'чуже заняття: ' + foreign.s);
  const ahead = await mfetch('/uroky/api/zaniattia', body(kidA.id, 'G01', 'G01', 1, 1));
  check(ahead.s === 403, N, 'мама не може записати урок, якого педагог не проводив (403)', 'мама вперед: ' + ahead.s);
  const chk = await mfetch('/uroky/api/zaniattia', {klient_id: 'chk-mama-1', vyd: 'start', pochatok: day(0), dytyna: kidA.id, navychky: {G01: {pershi: 2, usogo: 2}}});
  check(chk.s === 403, N, 'мама не може провести перевірку (403)', 'мама перевірка: ' + chk.s);
  const dity = await M.page.goto('/uroky/dity');
  check(/\/uroky$/.test(M.page.url()), N, '/uroky/dity для мами → назад до уроків', '/uroky/dity для мами: ' + M.page.url());
  await waitList(M.page);

  // ---- педагог: вибір дитини → урок → заняття в базі з khto='vchytel'
  const T = await openDevice(browser, DEVICES[2], 'Планшет ГО');
  await login(T, 'staff', TEACHER2.login, TEACHER2.password);
  await T.page.screenshot({path: path.join(SHOTS, 'dity.png')});
  await chooseKid(T, kidA.id);
  const top = await T.page.evaluate(() => $('listKid').textContent + ' ' + $('listRole').textContent);
  check(top === 'Аня Коваль · Олена', N, 'угорі видно дитину й педагога: «' + top + '», є «Інша дитина»', 'угорі: ' + top);
  await T.page.evaluate(() => Promise.all(ORDER.map(id => api('pidhotovka', {urok: id}))));
  await T.page.reload(); await waitList(T.page);
  const solveT = solver(T, DEVICES[2]);
  await T.tap('#listBody [data-lesson="G01"]');
  await T.tap('#remindStart');
  await T.tap('#btnStart');
  for (let k = 0; k < 3; k++) { await T.tap('#star'); await T.page.waitForTimeout(80); }
  await T.page.waitForFunction(() => G.stage === 'task');
  let n = 0;
  while (await T.page.evaluate(() => G.stage) === 'task') { await solveT(n === 0); n++; }
  await settle(T.page);
  const zA = zan(kidA.id);
  const nav = zA.length ? sql(NAVCH, 'SELECT * FROM zaniattia_navychky WHERE zaniattia_id=?', [zA[0].id]) : [];
  check(zA.length === 1 && zA[0].khto === 'vchytel' && zA[0].staff_login === 'olena' && zA[0].urok === 'G01' && nav.length === 1 && nav[0].usogo === n && nav[0].pershi === n - 1,
    N, 'педагог провів Г01: у базі одне заняття khto=vchytel, staff_login=olena, Г01 ' + (n - 1) + ' з ' + n, 'заняття педагога: ' + JSON.stringify(zA) + ' ' + JSON.stringify(nav));
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(zA[0].kinets) && zA[0].prystrii_id > 0, N, 'kinets і пристрій записав сервер', 'kinets: ' + zA[0].kinets);

  // ---- мама після заняття педагога: лише пройдене, повторення не рухає статус
  await M.page.reload(); await waitList(M.page);
  const ml = await M.page.$$eval('#listBody [data-lesson]', bs => Array.from(new Set(bs.map(b => b.getAttribute('data-lesson')))).join(' '));
  check(ml === 'G01', N, 'мама після заняття педагога бачить лише Г01', 'мама бачить: ' + ml);
  await M.page.screenshot({path: path.join(SHOTS, 'mama-list.png')});
  const before = (await mfetch('/uroky/api/stan')).d.stan.skills.G01;
  // Три правильні в два різні дні — для педагога це «засвоєно»; для мами — нічого
  const m1 = await mfetch('/uroky/api/zaniattia', body(kidA.id, 'G01', 'G01', 2, 2, day(1)));
  const m2 = await mfetch('/uroky/api/zaniattia', body(kidA.id, 'G01', 'G01', 3, 3, day(0)));
  const after = m2.d.stan.skills.G01;
  check(m1.s === 200 && m2.s === 200 && after.st === before.st && after.days === before.days && after.vdoma === 2, N,
    'мама: 5 правильних у 2 дні — статус «' + after.st + '» не змінився, «вдома» = ' + after.vdoma, 'мама рухає статус: ' + JSON.stringify(before) + ' → ' + JSON.stringify(after));
  const mz = zan(kidA.id, " AND khto='mama'");
  check(mz.length === 2 && mz.every(x => x.staff_login === null), N, 'заняття мами записані з khto=mama', 'мамині: ' + JSON.stringify(mz));
  // через інтерфейс: «Повторити урок» однією кнопкою
  await M.tap('#listBody .rec-go');
  check(await M.page.evaluate(() => G.stage === 'greet' && G.lesson === 'G01'), N, 'мама: «Повторити урок» стартує Г01 одразу, без підготовки', 'мама rec-go: ' + await M.page.evaluate(() => G.stage + ' ' + G.lesson));
  const solveM = solver(M, dev);
  await M.tap('#btnStart');
  for (let k = 0; k < 3; k++) { await M.tap('#star'); await M.page.waitForTimeout(80); }
  await M.page.waitForFunction(() => G.stage === 'task');
  while (await M.page.evaluate(() => G.stage) === 'task') await solveM(false);
  await settle(M.page);
  check(zan(kidA.id, " AND khto='mama'").length === 3, N, 'повторення мами з інтерфейсу записане', 'мамині після інтерфейсу: ' + zan(kidA.id, " AND khto='mama'").length);
  await M.page.goto('/uroky/stan');
  const stanTxt = await M.page.textContent('body');
  const kal = await M.page.$$eval('#kal td.v', t => t.length) + '/' + await M.page.$$eval('#kal td.m', t => t.length);
  check(/повторювали вдома: 3 рази/.test(stanTxt) && /Грамота[\s\S]*Математика[\s\S]*Геометрія[\s\S]*Англійська/.test(stanTxt) && /© ГО «Берегиня», 2026/.test(stanTxt) && !/%|\sбал(и|ів)?\s/i.test(stanTxt), N,
    'сторінка стану: календар (з педагогом/удома ' + kal + '), 4 лінії, «повторювали вдома: 3 рази», ©, без балів і відсотків', 'стан: ' + stanTxt.slice(0, 300));
  await M.page.screenshot({path: path.join(SHOTS, 'stan-phone.png'), fullPage: true});
  const rb = await M.page.evaluate(() => document.querySelector('meta[name=robots]').content);
  check(/noindex/.test(rb), N, 'на сторінці стану meta robots noindex', 'meta robots: ' + rb);

  // ---- правило засвоєння на сервері (педагог, kidB)
  await chooseKid(T, kidB.id);
  const tfetch = (u, b) => T.page.evaluate(([u, b]) => fetch(u, b ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(b)} : {})
    .then(r => r.json().then(d => ({s: r.status, d}))), [u, b]);
  let s = await tfetch('/uroky/api/zaniattia', body(kidB.id, 'G02', 'G02', 3, 9, day(0)));
  if (!s.d.stan) throw new Error('правило: ' + JSON.stringify(s));
  const one = s.d.stan.skills.G02.st;
  s = await tfetch('/uroky/api/zaniattia', body(kidB.id, 'G02', 'G02', 1, 9, day(1)));
  if (!s.d.stan) throw new Error('правило 2: ' + JSON.stringify(s));
  const two = s.d.stan.skills.G02.st;
  for (let i = 0; i < 3; i++) s = await tfetch('/uroky/api/zaniattia', body(kidB.id, 'G03', 'G03', 0, 9, day(0, 9 + i)));
  if (!s.d.stan) throw new Error('правило 3: ' + JSON.stringify(s));
  const stuck = s.d.stan.skills.G03.st;
  s = await tfetch('/uroky/api/zaniattia', {klient_id: 'check-b-001', vyd: 'start', pochatok: day(1), dytyna: kidB.id, navychky: {G01: {pershi: 2, usogo: 2}, M01: {pershi: 2, usogo: 2}}});
  s = await tfetch('/uroky/api/zaniattia', {klient_id: 'check-b-002', vyd: 'start', pochatok: day(0), dytyna: kidB.id, navychky: {G01: {pershi: 2, usogo: 2}, M01: {pershi: 0, usogo: 0}}});
  if (!s.d.stan) throw new Error('правило 4: ' + JSON.stringify(s));
  const chkSt = s.d.stan.skills.G01.st, chks = s.d.stan.checks.map(c => c.kind + ':' + JSON.stringify(c.items.M01)).join(' ');
  check(one === 'вчиться' && two === 'засвоєно' && stuck === 'застряг' && chkSt === '—' && chks === 'start:[1,1] repeat:null', N,
    'сервер: 3 правильні в один день → «' + one + '», у два дні → «' + two + '», 3 заняття з нулем → «' + stuck + '»; перевірки не зараховуються, друга — повторна, пропущене = null',
    'правило: ' + [one, two, stuck, chkSt, chks].join(' | '));
  const bad = [];
  const tryBad = async (name, b) => { const r = await tfetch('/uroky/api/zaniattia', b); if (r.s !== 400) bad.push(name + '=' + r.s); };
  await tryBad('навичка не з уроку', body(kidB.id, 'G01', 'M01', 1, 1));
  await tryBad('pershi>usogo', body(kidB.id, 'G01', 'G01', 3, 2));
  await tryBad('usogo>20', body(kidB.id, 'G01', 'G01', 1, 21));
  await tryBad('майбутнє', body(kidB.id, 'G01', 'G01', 1, 1, new Date(Date.now() + 86400000).toISOString()));
  await tryBad('старше 14 днів', body(kidB.id, 'G01', 'G01', 1, 1, day(15)));
  await tryBad('без поясу', body(kidB.id, 'G01', 'G01', 1, 1, '2026-10-01T10:00:00'));
  await tryBad('немає уроку', body(kidB.id, 'X99', 'G01', 1, 1));
  check(!bad.length, N, 'сервер відкидає: навичку не з уроку, pershi>usogo, >20, час із майбутнього, старше 14 днів, без поясу, неіснуючий урок', 'прийнято зайве: ' + bad.join(', '));
  const ghost = await tfetch('/uroky/api/zaniattia', body(9999, 'G01', 'G01', 1, 1));
  check(ghost.s === 403, N, 'заняття неіснуючої дитини → 403', 'неіснуюча дитина: ' + ghost.s);

  // ---- черга без мережі
  await chooseKid(T, kidA.id);
  const z0 = zan(kidA.id).length;
  await T.tap('#listBody [data-lesson="M01"]');
  await T.tap('#remindStart');
  await T.tap('#btnStart');
  for (let k = 0; k < 3; k++) { await T.tap('#star'); await T.page.waitForTimeout(80); }
  await T.page.waitForFunction(() => G.stage === 'task');
  while (await T.page.evaluate(() => G.i < G.tasks.length - 1)) await solveT(false);
  await T.ctx.setOffline(true);
  await solveT(false);
  await T.page.waitForFunction(() => G.stage === 'end');
  await T.page.waitForTimeout(500);
  const off = await T.page.evaluate(() => ({q: qLoad().length, ls: JSON.parse(localStorage.getItem('beregynia-cherga') || '[]').length, note: $('cherga').hidden ? '' : $('cherga').textContent}));
  check(off.q === 1 && off.ls === 1 && off.note === 'Не відправлено: 1' && zan(kidA.id).length === z0, N, 'без мережі підсумок лежить у черзі (localStorage), у куті «' + off.note + '»', 'черга без мережі: ' + JSON.stringify(off));
  await T.page.screenshot({path: path.join(SHOTS, 'cherga.png')});
  const item = await T.page.evaluate(() => qLoad()[0]);
  await T.ctx.setOffline(false);
  await T.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await settle(T.page);
  const again = await tfetch('/uroky/api/zaniattia', item);
  check(zan(kidA.id).length === z0 + 1 && again.s === 409 && zan(kidA.id).length === z0 + 1 && await T.page.evaluate(() => $('cherga').hidden), N,
    'мережа повернулась → відправлено один раз; повтор того самого klient_id → 409, дубля немає', 'черга після мережі: ' + (zan(kidA.id).length - z0) + ', повтор ' + again.s);
  // 401: сесія скінчилась — запис лишається в черзі й іде після входу
  await T.tap('#btnDone');
  await T.page.evaluate(() => fetch('/uroky/vykhid'));
  await T.page.evaluate(() => { zdaty({klient_id: uuid(), vyd: 'urok', urok: 'M01', pochatok: isoNow(), dytyna: SRV.dytyna.id, navychky: {M01: {pershi: 1, usogo: 1}}}); });
  await T.page.waitForTimeout(800);
  const kept = await T.page.evaluate(() => qLoad().length);
  await login(T, 'staff', TEACHER2.login, TEACHER2.password);
  await chooseKid(T, kidA.id);
  await settle(T.page);
  check(kept === 1 && zan(kidA.id).length === z0 + 2, N, '401 (вийшли): запис лишився в черзі й відправився після нового входу', '401: у черзі ' + kept + ', записано ' + (zan(kidA.id).length - z0));
  // Без мережі сторінка не відкривається тихо, а з поясненням (service worker)
  const swOk = await T.page.evaluate(() => navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false));
  await T.ctx.setOffline(true);
  await T.page.reload().catch(() => {});
  const offTxt = await T.page.textContent('body').catch(() => '');
  await T.ctx.setOffline(false);
  check(swOk && /Немає інтернету/.test(offTxt) && /лише з інтернетом/.test(offTxt), N, 'service worker активний; без мережі — «Немає інтернету…», а не порожній екран', 'без мережі: sw ' + swOk + ', «' + offTxt.slice(0, 80) + '»');
  const cached = await T.page.evaluate(() => caches.keys().then(ks => Promise.all(ks.map(k => caches.open(k).then(c => c.keys())))).then(a => [].concat.apply([], a).map(r => new URL(r.url).pathname)));
  check(cached.every(u => /^\/uroky\/(audio\/|icon-)/.test(u)), N, 'кеш sw — лише звуки й іконки (' + (cached.join(', ') || 'порожньо') + ')', 'sw кешує зайве: ' + cached.join(', '));
  await T.page.goto('/uroky'); await waitList(T.page);

  // ---- відкликаний пристрій
  const pid = sql(NAVCH, "SELECT id FROM prystroi WHERE nazva='Телефон мами Ані'")[0].id;
  await admin.post('/admin/mudryk/prystrii/' + pid + '/vidklykaty');
  await M.page.goto('/uroky');
  const rv = await M.page.evaluate(() => fetch('/uroky/api/stan').then(r => r.status));
  check(/\/uroky\/aktyvatsiia$/.test(M.page.url()) && rv === 403, N, 'відкликаний пристрій → активація (API → 403)', 'відкликаний: ' + M.page.url() + ' ' + rv);

  // ---- копія бази і видалення дитини
  const bk = await (await admin.post('/admin/backup', {form: {}})).json();
  const bkN = bk.navch ? sql(path.join(path.dirname(DB), 'backups', bk.navch), 'SELECT COUNT(*) n FROM zaniattia')[0].n : -1;
  check(bk.ok && bk.name.slice(10) === bk.navch.slice(11) && bkN === sql(NAVCH, 'SELECT COUNT(*) n FROM zaniattia')[0].n, N,
    'копія бази: ' + bk.name + ' і ' + bk.navch + ' (та сама позначка часу, ' + bkN + ' занять)', 'копія: ' + JSON.stringify(bk));
  const del = await (await admin.post('/admin/mudryk/' + kidB.id + '/vydalyty')).json();
  const left = sql(NAVCH, 'SELECT (SELECT COUNT(*) FROM zaniattia WHERE dytyna_id=?) z, (SELECT COUNT(*) FROM zaniattia_navychky WHERE zaniattia_id NOT IN (SELECT id FROM zaniattia)) n, (SELECT COUNT(*) FROM dity WHERE id=?) d', [kidB.id, kidB.id])[0];
  check(del.ok && !left.z && !left.n && !left.d, N, 'видалення дитини забрало її заняття й лічильники (сиріт немає)', 'після видалення: ' + JSON.stringify(left));
  const aud = sql(DB, "SELECT action FROM audit WHERE action LIKE 'уроки:%' OR action LIKE 'Мудрик:%'").map(r => r.action.split(' ').slice(0, 3).join(' '));
  check(aud.some(a => /вхід мами/.test(a)) && aud.some(a => /вхід педагога/.test(a)) && aud.some(a => /активовано пристрій/.test(a)) && aud.some(a => /відкликано пристрій/.test(a)) &&
    aud.some(a => /створено дитину/.test(a)) && aud.some(a => /видалено дитину/.test(a)) && !sql(DB, "SELECT 1 FROM audit WHERE action LIKE '%G01%' OR action LIKE '%урок Г%'").length, N,
    'audit пише входи, дітей, коди, пристрої — і не пише, які уроки відкривали', 'audit: ' + aud.join(' | '));

  // ---- адмінка: сторінка, друк картки
  const ap = await browser.newPage({baseURL: BASE});
  await ap.request.post('/api/login', {form: ADMIN});
  await ap.goto('/admin/mudryk');
  await ap.fill('#kImia', 'Віра'); await ap.fill('#kPrizv', 'Шевченко');
  await ap.click('#fKid button[type=submit]');
  await ap.waitForSelector('#kOnce:not([hidden])');
  const card = await ap.evaluate(() => ({l: document.getElementById('pLogin').textContent, p: document.getElementById('pPass').textContent}));
  check(/^shevchenko\d+$/.test(card.l) && /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(card.p), N, 'адмінка: «Додати дитину» показала логін ' + card.l + ' і пароль один раз, картка для друку заповнена', 'картка: ' + JSON.stringify(card));
  await ap.emulateMedia({media: 'print'});
  await ap.screenshot({path: path.join(SHOTS, 'kartka-print.png')});
  await ap.emulateMedia({media: 'screen'});
  await ap.fill('#cName', 'Планшет 2'); await ap.click('#fCode button[type=submit]');
  await ap.waitForSelector('#cOnce:not([hidden])');
  check(/^\d{4} \d{4}$/.test(await ap.textContent('#cCode')), N, 'адмінка: «Новий код» показав 8 цифр один раз', 'код: ' + await ap.textContent('#cCode'));
  await ap.screenshot({path: path.join(SHOTS, 'admin-mudryk.png'), fullPage: true});

  // Тут ми навмисно шлемо заборонене (400/401/403/409) і рвемо мережу — браузер про кожну
  // таку відповідь пише в консоль сам. Ці рядки — очікувані; будь-що інше — помилка.
  const deliberate = /Failed to load resource: (the server responded with a status of (400|401|403|409)|net::ERR_INTERNET_DISCONNECTED).* @ .*\/uroky\/api\/(zaniattia|stan)$/;
  let skipped = 0;
  for (const D of [M, T]) {
    const real = D.cons.filter(x => { if (deliberate.test(x)) { skipped++; return false; } return true; });
    D.net.length ? fail(N, 'запити за межі домену: ' + D.net.join(', ')) : null;
    real.length ? fail(N, 'консоль: ' + real.join(' | ')) : null;
    D.real = real.length;
  }
  if (!M.net.length && !T.net.length && !M.real && !T.real) ok('консоль чиста (крім ' + skipped + ' навмисних відмов сервера й обриву мережі); жодного запиту за межі домену');
  await browser.close();
}

/* ======================= Уроки: старі перевірки через сервер ======================= */
async function run(dev) {
  console.log('\n=== ' + dev.name + ' ' + dev.viewport.width + '×' + dev.viewport.height);
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const liza = await newKid('Ліза', 'Бондар' + dev.name), marko = await newKid('Марко', 'Ткач' + dev.name), olia = await newKid('Оля', 'Лисенко' + dev.name);
  // Свій педагог на кожен пристрій: «Я підготувався» зберігається на сервері, і з чужим
  // підготовленим Г03 відкрився б нагадуванням замість підготовки
  const TCH = {login: 'vika' + dev.name, password: 'vika-pass-123'};
  py(['app.py', 'adduser', TCH.login, TCH.password, 'teacher', 'Вікторія']);
  const D = await openDevice(browser, dev, 'Пристрій ' + dev.name);
  const {page, tap} = D;
  const solve = solver(D, dev);
  const shot = async name => page.screenshot({path: path.join(SHOTS, dev.name + '-' + name + '.png')});
  const stage = () => page.evaluate(() => G.stage);
  const lessonsDone = did => zan(did, " AND vyd='urok'").length;

  let enCount = 0;
  const enFails = [];
  async function playLesson(id, opts) {
    opts = opts || {};
    const u0 = await page.evaluate(() => window.__utt.length);
    const seen = [];
    if (await stage() !== 'greet') throw new Error('очікував привітання, маю ' + await stage());
    await tap('#btnStart');
    for (let k = 0; k < 3; k++) { await tap('#star'); await page.waitForTimeout(80); }
    await page.waitForFunction(() => G.stage === 'task', null, {timeout: 5000});
    let n = 0, first = true;
    const types = new Set();
    while (await stage() === 'task') {
      if (first && opts.shot) await shot('lesson-' + id);
      if (opts.en) {
        await page.waitForTimeout(150);
        seen.push(await page.evaluate(() => {
          const ts = Array.from(document.querySelectorAll('#v-task [title], #v-task [aria-label]')).map(e => e.getAttribute('title') + ' ' + e.getAttribute('aria-label'));
          return {bubble: $('bubble').textContent, task: $('v-task').textContent + ' ' + ts.join(' '), tag: !$('enTag').hidden};
        }));
      }
      types.add(await solve(first, true));
      first = false; n++;
      if (n > 15) throw new Error('забагато завдань у ' + id);
    }
    if (opts.en) {
      const utt = await page.evaluate(n => window.__utt.slice(n), u0);
      const eng = utt.filter(u => /[a-z]/i.test(u.text));
      enCount += eng.length;
      eng.filter(u => !/^en/.test(u.lang) || u.voice !== 'Test GB').forEach(u => enFails.push(id + ': «' + u.text + '» lang=' + u.lang + ' голос ' + u.voice));
      eng.filter(u => EN_WORDS.indexOf(u.text) < 0).forEach(u => enFails.push(id + ': незнайоме слово «' + u.text + '»'));
      utt.filter(u => !/[a-z]/i.test(u.text)).forEach(u => { const t = translated(u.text); if (t.length) enFails.push(id + ': голос сказав «' + u.text + '» — переклад ' + t); if (!/^uk/.test(u.lang)) enFails.push(id + ': українське «' + u.text + '» не українським голосом'); });
      seen.forEach(x => { const t = translated(x.bubble + ' ' + x.task); if (t.length) enFails.push(id + ': на екрані переклад ' + t + ' («' + x.bubble + '»)'); });
      if (!eng.length) enFails.push(id + ': жодного англійського слова');
      if (!seen.some(x => x.tag)) enFails.push(id + ': не видно 🇬🇧');
    }
    const st = await stage();
    if (st !== 'end') fail(dev.name, id + ': після завдань стан ' + st);
    else ok(id + ': ' + n + ' завдань до зорепаду (' + Array.from(types).join(', ') + ')');
    if (opts.endShot) await shot('end');
    await tap('#btnDone');
    await page.waitForFunction(() => G.stage === 'list');
    await settle(page);
    return n;
  }
  // Педагог, уже готувався: картка → нагадування → «Почати заняття»
  const openPrepared = async id => {
    await tap('#listBody [data-lesson="' + id + '"]');
    if (await stage() === 'remind') await tap('#remindStart');
  };

  // ---------- Шлях педагога ----------
  await login(D, 'staff', TCH.login, TCH.password);
  await chooseKid(D, liza.id);
  await shot('list-teacher');
  const waits = await page.$$eval('#listBody .lesson.wait', bs => bs.map(b => b.getAttribute('data-lesson') + ': ' + b.querySelector('.wn').textContent));
  check(waits.length === 4 && waits.every(w => /^G0[4569]: Чекає на записи звуків: \[/.test(w)), dev.name,
    'без записів: Г04 Г05 Г06 Г09 сірі у педагога («' + (waits[0] || '').slice(5) + '»)', 'сірі картки: ' + JSON.stringify(waits));
  const order = await page.$$eval('#listBody .lesson .code', cs => cs.map(c => c.textContent).join(' '));
  check(order === 'Г01 Г02 Г03 Г04 Г05 Г06 Г07 Г08 Г09 Г11 Г12 М01 М02 М05–М06 Ф01 Ф02 Ф03 Ф04 Ф05 А01 А02 А03 А04', dev.name, 'порядок у списку: ' + order, 'порядок: ' + order);
  const lines = await page.$$eval('#listBody details.line > summary', ss => ss.map(x => x.firstChild.textContent).join(' · '));
  check(lines === 'Грамота · Математика · Геометрія · Англійська', dev.name, 'список — чотири лінії: ' + lines, 'лінії: ' + lines);
  await tap('#listBody details.line[data-line="g"] > summary');
  const shut = await page.evaluate(() => !document.querySelector('details.line[data-line="g"]').open);
  await tap('#listBody details.line[data-line="g"] > summary');
  check(shut, dev.name, 'лінія згортається', 'лінія не згорнулась');
  const copy = await page.textContent('#s-list .copy');
  check(/© ГО «Берегиня», 2026\. Використання без дозволу заборонено/.test(copy), dev.name, 'внизу списку: «' + copy.trim() + '»', 'позначки © немає');
  // Каталог сервера збігається з уроками на сторінці (сервер рахує засвоєння за ним)
  const kat = JSON.parse(fs.readFileSync(path.join(SERVER, 'uroky', 'katalog.json'), 'utf8'));
  const mine = await page.evaluate(() => ORDER.map(id => id + ':' + LESSONS[id].area + LESSONS[id].level + ':' + Object.keys(LESSONS[id].skills).join(',') + ':' + (LESSONS[id].needs || []).join(',')).join(' '));
  const theirs = kat.lessons.map(L => L.id + ':' + L.area + L.level + ':' + Object.keys(L.skills).join(',') + ':' + L.needs.join(',')).join(' ');
  check(mine === theirs, dev.name, 'каталог сервера (katalog.json) збігається з уроками на сторінці', 'каталог розійшовся:\n' + mine + '\n' + theirs);
  // Сіра картка відкриває лише підготовку, заняття не стартує
  await tap('#listBody [data-lesson="G04"]');
  const g04 = await page.evaluate(() => ({st: G.stage, tryDis: !!document.querySelector('#guideBody [data-act="try"][disabled]'),
    snd: document.querySelectorAll('#guideBody .say-sm[disabled]').length}));
  check(g04.st === 'guide' && g04.tryDis && g04.snd === 3, dev.name, 'сіра Г04: підготовка читається, «Спробуйте самі» і 🔊 приголосних неактивні', 'сіра Г04: ' + JSON.stringify(g04));
  await tap('#guideNav [data-act="back"]');
  const rec0 = await page.evaluate(() => recommended());
  check(rec0 === 'G01', dev.name, 'рекомендований для нової дитини (рахує сервер) — Г01', 'рекомендований ' + rec0);

  // Г03: підготовка, 🔊 прикладів, «Спробуйте самі»
  await tap('#listBody [data-lesson="G03"]');
  if (await stage() !== 'guide') fail(dev.name, 'педагог не потрапив у підготовку Г03');
  await tap('#guideNav [data-tab="G03"]');
  await shot('guide-G03');
  const sp0 = await page.evaluate(() => window.__spoken.length);
  await tap('#guideBody .demo .speak');
  await page.waitForTimeout(600);
  const demoSaid = await page.evaluate(n => window.__spoken.slice(n), sp0);
  check(JSON.stringify(demoSaid) === JSON.stringify(['миша', 'мавпа', 'морква', 'кіт']), dev.name, '🔊 у матеріалі Г03 каже лише слова: ' + demoSaid.join(', '), '🔊 Г03 сказав: ' + demoSaid.join(' | '));
  await tap('#guideBody [data-act="try"]');
  for (let k = 0; k < 3; k++) await solve(k === 0);
  if (await stage() !== 'guide') fail(dev.name, '«Спробуйте самі» Г03 не повернуло в матеріал');
  await page.waitForTimeout(300);
  check(lessonsDone(liza.id) === 0, dev.name, '«Спробуйте самі» Г03 нічого не записало на сервер', '«Спробуйте самі» записало заняття');
  await tap('#guideNav [data-act="back"]');

  // М01: підготовка з математики, пробний прохід, потім «Я підготувався» і справжній урок
  await tap('#listBody [data-lesson="M01"]');
  await tap('#guideNav [data-tab="M01"]');
  await shot('guide-M01');
  await tap('#guideBody [data-act="try"]');
  for (let k = 0; k < 3; k++) await solve(false);
  check(lessonsDone(liza.id) === 0, dev.name, '«Спробуйте самі» М01 нічого не записало', '«Спробуйте самі» М01 записало заняття');
  await tap('#guideNav [data-tab="done"]');
  await tap('#guideBody [data-act="ready"]');
  await playLesson('M01', {shot: true});
  const prep = sql(NAVCH, "SELECT * FROM pidhotovka WHERE staff_login='" + TCH.login + "' AND urok='M01'");
  check(lessonsDone(liza.id) === 1 && prep.length === 1, dev.name, '«Я підготувався» — на сервері для педагога ' + TCH.login + '; урок М01 записано', 'М01: занять ' + lessonsDone(liza.id) + ', підготовка ' + prep.length);
  // Вдруге — лише нагадування
  await tap('#listBody [data-lesson="M01"]');
  check((await stage()) === 'remind', dev.name, 'підготовлений урок відкриває нагадування', 'замість нагадування ' + await stage());
  await tap('#remindBack');
  // Далі педагог «уже готувався» до всіх уроків
  await page.evaluate(() => Promise.all(ORDER.map(id => api('pidhotovka', {urok: id}))));
  await page.evaluate(() => loadStan());

  // ---------- Мама до першого заняття педагога (Оля) ----------
  await login(D, 'mama', olia.login, olia.password);
  await waitList(page);
  const empty = await page.evaluate(() => ({t: $('listBody').textContent, n: document.querySelectorAll('#listBody [data-lesson]').length}));
  check(/після першого заняття з педагогом/.test(empty.t) && !empty.n, dev.name, 'мама до першого заняття педагога: уроків немає, є пояснення', 'мама до педагога: ' + JSON.stringify(empty));
  await shot('list-mama-empty');

  // ---------- Рекомендований чергує лінії (педагог, Марко) ----------
  await login(D, 'staff', TCH.login, TCH.password);
  await chooseKid(D, marko.id);
  const recs = [];
  for (let k = 0; k < 4; k++) {
    const r = await page.evaluate(() => recommended());
    const badge = await page.$$eval('#listBody .lesson.rec', bs => bs.map(b => b.getAttribute('data-lesson')).join(','));
    if (badge !== r) fail(dev.name, 'позначка «Рекомендований» на ' + badge + ', а сервер радить ' + r);
    recs.push(r);
    await openPrepared(r);
    await playLesson(r, {shot: true, endShot: k === 0, en: /^A/.test(r)});
  }
  const rec5 = await page.evaluate(() => recommended());
  check(recs.join(' ') === 'G01 M01 F01 A01' && rec5 === 'G02', dev.name, 'рекомендований чергує лінії: ' + recs.join(' → ') + ' → ' + rec5, 'чергування: ' + recs.join(' ') + ', далі ' + rec5);

  // Решта уроків
  for (const id of ['G02', 'G03', 'G07', 'G08', 'G11', 'G12', 'M02', 'MX', 'F02', 'F03', 'F04', 'F05', 'A02', 'A03', 'A04']) {
    await openPrepared(id);
    await playLesson(id, {shot: true, en: /^A/.test(id)});
  }
  // Мікс тепер — лише М05 і М06; фігури й простір пишуться в геометрію
  const mx = await page.evaluate(() => { const s = stats(); return ['M05', 'M06', 'F01', 'F03', 'M03', 'M04'].map(k => s[k] && SKILL[k] ? s[k].n : '-').join(' '); });
  check(mx === '1 1 1 1 - -', dev.name, 'урок М05–М06 записав М05 і М06; Ф01 і Ф03 — окремі уроки; М03/М04 більше немає', 'навички: ' + mx);
  check(lessonsDone(marko.id) === 19 && zan(marko.id, " AND khto='vchytel'").length === 19, dev.name, 'на сервері 19 занять Марка, усі khto=vchytel', 'занять Марка: ' + lessonsDone(marko.id));
  // Англійська: один голос en-GB і жодного перекладу
  const en = await page.evaluate(() => ({saved: localStorage.getItem('beregynia-uroky-en-voice')}));
  enFails.length ? enFails.forEach(x => fail(dev.name, 'англійська: ' + x))
    : ok('англійська: ' + enCount + ' слів, усі lang=en-GB одним голосом «Test GB» (збережено: ' + en.saved + '); перекладу ні в голосі, ні на екрані');
  check(!(await page.evaluate(() => Object.keys(localStorage).filter(k => k !== 'beregynia-uroky-en-voice' && k !== 'beregynia-cherga').join(','))), dev.name,
    'у localStorage немає прогресу — лише голос і черга', 'зайве в localStorage: ' + await page.evaluate(() => Object.keys(localStorage).join(',')));

  // Буквар: різний порядок голосних у Г08 (змінює адміністратор в адмінці)
  if (dev.name === 'phone') {
    const orderOf = async bk => {
      await admin.post('/admin/mudryk/' + marko.id + '/bukvar', {form: {bukvar: bk}});
      await page.reload(); await waitList(page);
      const n0 = await page.evaluate(() => window.__spoken.length);
      await openPrepared('G08');
      await playLesson('G08');
      const said = await page.evaluate(n => window.__spoken.slice(n), n0);
      return said.filter(x => /^[аоуиіе]$/.test(x)).slice(0, 6).join(' ');
    };
    const b = await orderOf('bolshakova'), v = await orderOf('vashulenko');
    check(b === 'а о у и і е' && v === 'а о і и у е', dev.name, 'Г08: Большакова «' + b + '», Вашуленко «' + v + '»', 'Г08 порядок: Б «' + b + '», В «' + v + '»');
  }

  // ⚙
  await tap('#listGear');
  await page.waitForTimeout(200);
  await shot('panel');
  const rows = await page.locator('#panelBody tr').count();
  const lh = await page.$$eval('#panelBody tr.line-h', rs => rs.map(r => r.textContent).join(' · '));
  check(rows >= 27 && lh === 'Грамота · Математика · Геометрія · Англійська', dev.name, '⚙: ' + rows + ' рядків по лініях (' + lh + ')', '⚙: ' + rows + ' рядків, лінії ' + lh);
  await tap('#panelClose');

  // Вихід через батьківський бар'єр (утримання 3 с)
  if (dev.name === 'pc') {
    await openPrepared('G02');
    await tap('#btnStart');
    const b = await page.locator('#exit').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.waitForTimeout(3300); await page.mouse.up();
    await page.fill('#gateAns', '15'); await page.click('#gateOk');
    check((await stage()) === 'list', dev.name, 'вихід: утримання 3 с + 7+8 → список уроків', 'вихід привів у ' + await stage());
  }

  // ---------- Мама Марка: лише пройдені з педагогом, повторення статусів не рухає ----------
  await login(D, 'mama', marko.login, marko.password);
  await waitList(page);
  await shot('list-mama');
  const mamaIds = await page.$$eval('#listBody [data-lesson]', bs => Array.from(new Set(bs.map(b => b.getAttribute('data-lesson')))));
  const mamaSnd = mamaIds.filter(x => /^G0[4569]$/.test(x));
  check(mamaIds.length === 19 && !mamaSnd.length, dev.name, 'мама бачить 19 пройдених з педагогом уроків, звукових (без записів) — жодного', 'мама бачить: ' + mamaIds.join(' '));
  const st0 = await page.evaluate(() => JSON.stringify(stats()));
  await tap('#listBody .rec-go');
  const ml = await page.evaluate(() => G.lesson);
  await playLesson(ml);
  const st1 = await page.evaluate(() => stats());
  const same = Object.keys(st1).filter(k => k !== '_today').every(k => JSON.parse(st0)[k].st === st1[k].st);
  check(same && Object.keys(LESSON_SK(ml)).every(sk => st1[sk].vdoma === 1), dev.name, 'мама повторила ' + ml + ': статуси ті самі, «вдома» = 1', 'мама змінила стан: ' + ml);
  function LESSON_SK(id) { return JSON.parse(fs.readFileSync(path.join(SERVER, 'uroky', 'katalog.json'), 'utf8')).lessons.find(L => L.id === id).skills; }

  // Повний перебір: кожне можливе завдання кожного уроку (багато разів, бо вибір випадковий)
  const sweep = await page.evaluate(async () => {
    const said = [];
    const orig = window.speechSynthesis.speak;
    window.speechSynthesis.speak = u => { said.push(u.text); };
    G.trial = {lesson: 'G01', sk: 'G01'};
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
    G.trial = null; hush(); toList();
    return said;
  });

  // ---------- Стартова й повторна перевірка (педагог) ----------
  await login(D, 'staff', TCH.login, TCH.password);
  await checkFlow(D, dev, shot, {kidWrong: olia, kidRight: liza, total: 24});

  const all = (await page.evaluate(() => window.__spoken)).concat(sweep);
  const blocked = await page.evaluate(() => VOICE_BLOCKED.slice());
  const uniq = Array.from(new Set(all));
  const bad = uniq.map(t => [t, voiceBad(t)]).filter(x => x[1]);
  if (bad.length) bad.forEach(x => fail(dev.name, 'голос: «' + x[0] + '» — ' + x[1]));
  else ok('§0: ' + all.length + ' викликів speak (' + uniq.length + ' різних текстів) — жодного окремого приголосного, дужок чи «мммак»');
  blocked.length ? fail(dev.name, 'рушій відсік: ' + blocked.join(' | ')) : ok('запобіжник рушія нічого не відсікав');
  fs.writeFileSync(path.join(SHOTS, dev.name + '-spoken.txt'), uniq.sort().join('\n'));

  D.net.length ? fail(dev.name, 'запити за межі домену: ' + D.net.join(', ')) : ok('жодного запиту за межі домену');
  D.cons.length ? fail(dev.name, 'консоль: ' + D.cons.join(' | ')) : ok('консоль чиста' + (D.missS() ? ' (крім ' + D.missS() + '× «Failed to load resource» на /uroky/audio/snd_s.wav — браузер сам пише про відсутній запис)' : ''));
  await browser.close();
}

// Один прохід перевірки: right — усе правильно, інакше все неправильно
async function oneCheck(D, dev, right, did) {
  const {page, tap} = D;
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
  const lessons0 = zan(did, " AND vyd='urok'").length, checks0 = zan(did, " AND vyd<>'urok'").length;
  while (await page.evaluate(() => G.stage) === 'task') {
    const t = await page.evaluate(() => ({type: G.task.type, flash: G.task.flash, i: G.i}));
    if (t.type === 'count') {
      if (!t.flash) { const c = await page.locator('#stage .cnt').count(); for (let k = 0; k < c; k++) await tap(page.locator('#stage .cnt').nth(k)); }
      await page.waitForFunction(() => $('cards').style.visibility !== 'hidden', null, {timeout: 8000});
    }
    await tap(right ? '#v-task [data-ok]' : page.locator('#v-task .card:not([data-ok]), #v-task .zone:not([data-ok])').first());
    feedback += await page.evaluate(() => document.querySelectorAll('.check, .shake, .hint').length);
    await page.waitForFunction(i => G.stage !== 'task' || G.i > i, t.i, {timeout: 8000});
    if (++n > 30) throw new Error('перевірка не закінчується');
  }
  const said = await page.evaluate(n => window.__spoken.slice(n), n0);
  const bad = said.filter(x => ['молодець!', 'чудово!', 'так, правильно!', 'супер!', 'спробуй ще.'].indexOf(x) >= 0);
  feedback || bad.length ? fail(dev.name, 'перевірка дала відгук: ' + feedback + ' знаків, ' + bad.join(', '))
    : said.filter(x => x === 'дякую!').length === n ? ok('без відгуку: після кожної з ' + n + ' відповідей лише «Дякую!»') : fail(dev.name, '«Дякую!» не після кожної відповіді');
  await settle(page);
  if (zan(did, " AND vyd='urok'").length !== lessons0) fail(dev.name, 'перевірка записала заняття уроку');
  if (zan(did, " AND vyd<>'urok'").length !== checks0 + 1) fail(dev.name, 'перевірка не потрапила на сервер');
  if (await page.evaluate(() => G.stage) !== 'end') fail(dev.name, 'після перевірки немає зорепаду');
  await tap('#btnDone');
  const res = await page.evaluate(() => ({st: G.stage, rows: Array.from(document.querySelectorAll('#checkTbl tr[data-row]')).map(r => r.getAttribute('data-row') + '=' + r.cells[1].textContent),
    concl: $('checkConcl').textContent, lines: Array.from(document.querySelectorAll('#checkConcl p')).map(p => p.textContent)}));
  if (res.st !== 'check') fail(dev.name, 'після зорепаду немає результату для дорослого');
  return {n, rows: res.rows, concl: res.concl, lines: res.lines};
}

async function checkFlow(D, dev, shot, o) {
  const {page, tap} = D;
  // Усе неправильно: правило зупинки в кожній лінії
  await chooseKid(D, o.kidWrong.id);
  const w = await oneCheck(D, dev, false, o.kidWrong.id);
  const skipped = w.rows.filter(r => /пропущено/.test(r)).map(r => r.split('=')[0]);
  const wl = w.lines.join(' ');
  check(w.n === 14 && skipped.join(' ') === (o.total === 28 ? 'G03 G04 G08 G09 G11 M05 M06' : 'G03 G08 G11 M05 M06') &&
    /Грамота: почати з уроку Г01/.test(wl) && /Математика: почати з уроку М01/.test(wl) && /Геометрія: почати з уроку Ф01/.test(wl) && /Англійська: почати з уроку А04/.test(wl), dev.name,
    '«усе неправильно»: ' + w.n + ' завдань, зупинка після двох нулів у лінії; пропущено ' + skipped.join(' ') + '; висновок по лініях: ' + w.lines.join(' | '),
    '«усе неправильно»: ' + w.n + ' завдань, ' + w.rows.join(', ') + '; ' + wl);
  const fa = w.rows.filter(r => /^(F01|F03|A04)=/.test(r)).join(' ');
  check(fa === 'F01=0 з 2 F03=0 з 2 A04=0 з 2', dev.name, 'у перевірці Ф01, Ф03 і А04 по 2 завдання', 'Ф/А у перевірці: ' + fa);
  const srvChk = sql(NAVCH, "SELECT z.vyd, n.navychka, n.pershi, n.usogo FROM zaniattia z JOIN zaniattia_navychky n ON n.zaniattia_id=z.id WHERE z.dytyna_id=? AND z.vyd<>'urok' ORDER BY n.navychka", [o.kidWrong.id]);
  check(srvChk.length && srvChk.every(r => r.vyd === 'start' && r.pershi === 0) && srvChk.filter(r => r.usogo === 0).map(r => r.navychka).sort().join(' ') === skipped.slice().sort().join(' '), dev.name,
    'на сервері стартова перевірка: ' + srvChk.length + ' навичок, пропущені — 0 з 0', 'перевірка на сервері: ' + JSON.stringify(srvChk));
  await tap('#checkBody [data-act="list"]');
  const lbl0 = await page.textContent('#listBody .check-box');
  check(/Сьогодні перевірку вже пройдено/.test(lbl0), dev.name, 'того ж дня повторна недоступна', 'того ж дня: ' + lbl0);
  await page.evaluate(() => loadStan());
  const rec = await page.evaluate(() => recommended());
  check(rec === 'G01', dev.name, 'після перевірки рекомендовано ' + rec, 'після перевірки рекомендовано ' + rec);
  // Повторна — через «Імітувати завтра» (лише DEV: сервер зсуває заняття на день назад)
  await tap('#listGear'); await tap('#panelTomorrow'); await page.waitForTimeout(500); await tap('#panelClose');
  const lbl = await page.textContent('#listBody [data-act="check"]');
  check(/Повторна перевірка \(перша — \d\d\.\d\d\.\d{4}\)/.test(lbl), dev.name, 'кнопка: «' + lbl.replace('🧭 ', '') + '»', 'кнопка повторної: ' + lbl);
  const r = await oneCheck(D, dev, true, o.kidWrong.id);
  check(r.n === o.total && r.rows.every(x => /2 з 2/.test(x)), dev.name, 'повторна «усе правильно»: ' + r.n + ' завдань, усе 2 з 2; ' + r.concl, 'повторна: ' + r.n + ' завдань, ' + r.rows.join(', '));
  check(zan(o.kidWrong.id, " AND vyd='povtor'").length === 1, dev.name, 'на сервері друга перевірка — повторна (povtor)', 'повторних на сервері: ' + zan(o.kidWrong.id, " AND vyd='povtor'").length);
  await shot('check-result');
  await tap('#checkBody [data-act="list"]');
  await page.evaluate(() => loadStan());
  await tap('#listGear');
  const t = await page.$$eval('#panelChecksBody tr[data-row]', rs => rs.map(r => r.cells[0].textContent.split(' ')[0] + ' ' + r.cells[1].textContent + ' → ' + r.cells[2].textContent + ' ' + r.cells[3].textContent));
  check(t.length === o.total / 2 && t.every(x => /↑$/.test(x)), dev.name, '⚙ «перша → повторна»: ' + t.length + ' навичок, усі ↑ (' + t[0] + '; ' + t[t.length - 1] + ')', '⚙ перша → повторна: ' + t.join(' | '));
  await page.evaluate(() => $('panelChecks').scrollIntoView());
  await shot('panel-checks');
  await tap('#panelClose');
  // Усе правильно як стартова — в іншої дитини
  await chooseKid(D, o.kidRight.id);
  const a = await oneCheck(D, dev, true, o.kidRight.id);
  check(a.n === o.total && /^Усі перевірені навички — 2 з 2/.test(a.concl) && a.lines.length === 5, dev.name, 'стартова «усе правильно»: ' + a.n + ' завдань; ' + a.lines.join(' | '),
    'стартова «усе правильно»: ' + a.n + ', ' + a.concl);
  await tap('#checkBody [data-act="list"]');
}

// З записами звуків: теку записів сервера заповнено фейковими WAV
async function withFiles(dev) {
  console.log('\n=== з записами звуків: ' + dev.name + ' ' + dev.viewport.width + '×' + dev.viewport.height);
  SND_IDS.forEach((id, i) => fs.writeFileSync(path.join(AUDIO, 'snd_' + id + '.wav'), wav(300 + i * 40)));
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const liza = await newKid('Ліза', 'Звук' + dev.name), olia = await newKid('Оля', 'Звукова' + dev.name), marko = await newKid('Марко', 'Звуків' + dev.name);
  const D = await openDevice(browser, dev, 'Звук ' + dev.name);
  await D.ctx.addInitScript(hookPlay);
  const {page, tap} = D;
  const shot = async name => page.screenshot({path: path.join(SHOTS, dev.name + '-snd-' + name + '.png')});
  await login(D, 'staff', TEACHER.login, TEACHER.password);
  await chooseKid(D, liza.id);
  const okIds = await page.evaluate(() => Object.keys(SND_OK).filter(k => SND_OK[k]).sort().join(' '));
  check(okIds === SND_IDS.slice().sort().join(' '), dev.name, 'знайдено записи: ' + okIds, 'SND_OK: ' + okIds);

  // Педагог: сірих немає, 🔊 у підготовці грає з файлу
  const waits = await page.locator('#listBody .lesson.wait').count();
  check(waits === 0, dev.name, 'з записами сірих карток немає', 'сірих карток: ' + waits);
  await shot('list-teacher');
  await tap('#btnGuide');
  await tap('#guideNav [data-tab="all"]');
  await tap('#guideBody [data-open="G05"]');
  await tap('#guideNav [data-tab="G05"]');
  const p0 = await page.evaluate(() => window.__played.length);
  await tap('#guideBody [data-act="snd"]');
  await page.waitForFunction(n => window.__played.length >= n + 3, p0, {timeout: 10000}).catch(() => {});
  const gp = await page.evaluate(n => window.__played.slice(n).map(x => x.src.split('/').pop()).join(' '), p0);
  check(gp === 'snd_s.wav snd_y.wav snd_r.wav', dev.name, '🔊 у підготовці Г05 грає з файлів: ' + gp, '🔊 Г05 у підготовці: ' + gp);
  await shot('guide-G05');
  await tap('#guideNav [data-act="back"]');
  await page.evaluate(() => Promise.all(ORDER.map(id => api('pidhotovka', {urok: id}))));
  await page.evaluate(() => loadStan());

  // Звукові уроки: кожне завдання справді грає свої файли (з /uroky/audio/)
  await chooseKid(D, marko.id);
  for (const id of ['G04', 'G05', 'G06', 'G09']) {
    await tap('#listBody [data-lesson="' + id + '"]');
    if (await page.evaluate(() => G.stage) === 'remind') await tap('#remindStart');
    await tap('#btnStart');
    for (let k = 0; k < 3; k++) { await tap('#star'); await page.waitForTimeout(80); }
    await page.waitForFunction(() => G.stage === 'task', null, {timeout: 5000});
    let n = 0, heard = 0, first = true;
    while (await page.evaluate(() => G.stage) === 'task') {
      if (first) await shot('lesson-' + id);
      const got = await page.waitForFunction(() => {
        const want = G.task.files || [];
        const srcs = window.__played.filter(x => x.task === G.task).map(x => x.src);
        return want.length && want.every(f => srcs.some(s => s.endsWith('/uroky/audio/snd_' + f + '.wav')));
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
    check(st === 'end' && heard === n, dev.name, id + ': ' + n + ' завдань до зорепаду, у кожному звук із файлу', id + ': стан ' + st + ', зі звуком ' + heard + ' з ' + n);
    await tap('#btnDone');
    await page.waitForFunction(() => G.stage === 'list');
    await settle(page);
  }
  // Мама бачить звукові уроки, які педагог провів
  await login(D, 'mama', marko.login, marko.password);
  await waitList(page);
  const ms = await page.$$eval('#listBody [data-lesson]', bs => Array.from(new Set(bs.map(b => b.getAttribute('data-lesson')))).sort().join(' '));
  check(ms === 'G04 G05 G06 G09', dev.name, 'мама бачить звукові уроки, які педагог уже провів: ' + ms, 'мама зі звуками бачить: ' + ms);
  // Перевірка з записами: + Г04 і Г09, 28 завдань
  await login(D, 'staff', TEACHER.login, TEACHER.password);
  await checkFlow(D, dev, shot, {kidWrong: olia, kidRight: liza, total: 28});

  const srcs = await page.evaluate(() => window.__played.map(x => x.src));
  const foreign = srcs.filter(s => !/\/uroky\/audio\/snd_[a-z_]+\.wav$/.test(s));
  foreign.length ? fail(dev.name, 'грало не з /uroky/audio/: ' + foreign.join(', ')) : ok('усі ' + srcs.length + ' програвань — з /uroky/audio/snd_*.wav');
  const spoken = Array.from(new Set(await page.evaluate(() => window.__spoken)));
  const bad = spoken.map(t => [t, voiceBad(t)]).filter(x => x[1]);
  bad.length ? bad.forEach(x => fail(dev.name, 'голос: «' + x[0] + '» — ' + x[1])) : ok('§0 з записами: ' + spoken.length + ' різних текстів голосу — жодного окремого приголосного');
  const blocked = await page.evaluate(() => VOICE_BLOCKED.slice());
  blocked.length ? fail(dev.name, 'рушій відсік: ' + blocked.join(' | ')) : ok('запобіжник рушія нічого не відсікав');
  D.net.length ? fail(dev.name, 'запити за межі домену: ' + D.net.join(', ')) : ok('жодного запиту за межі домену');
  D.cons.length ? fail(dev.name, 'консоль: ' + D.cons.join(' | ')) : ok('консоль чиста');
  await browser.close();
}

// Без українського голосу: бульбашка велика, дорослому — що сказати вголос
async function noVoice() {
  console.log('\n=== без голосу (phone)');
  const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
  const kid = await newKid('Тиша', 'Безголосна');
  const ctx = await browser.newContext({viewport: {width: 360, height: 740}, hasTouch: true, isMobile: true, baseURL: BASE});
  const page = await ctx.newPage();
  const cons = [];
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (/Failed to load resource/.test(m.text()) && MISS_S.test((m.location() || {}).url || '')) return;
    cons.push(m.text());
  });
  page.on('pageerror', e => cons.push(e.message));
  await page.goto('/uroky');
  await page.fill('#kod', await newCode('Без голосу'));
  await page.tap('#go');
  await page.waitForURL(/\/uroky\/vkhid$/);
  await page.tap('#who [data-hto="staff"]');
  await page.fill('#login', TEACHER.login); await page.fill('#pass', TEACHER.password); await page.tap('#go');
  await page.waitForURL(/\/uroky\/dity$/);
  await page.tap('button[data-kid="' + kid.id + '"]');
  await waitList(page);
  await page.evaluate(() => { G.lesson = 'G11'; startTasks(); });
  await page.waitForTimeout(1500);
  const aloud = await page.textContent('#aloud');
  const lit = await page.locator('#cards .card.lit').count();
  await page.screenshot({path: path.join(SHOTS, 'novoice-G11.png')});
  check(/Скажіть уголос: \S+ · \S+ · \S+/.test(aloud), 'novoice', 'без голосу дорослий бачить: ' + aloud, 'підказка дорослому: ' + aloud);
  check(lit === 1, 'novoice', 'без голосу кнопки засвічуються таймером', 'засвічених кнопок: ' + lit);
  await page.evaluate(() => { hush(); G.lesson = 'A04'; startTasks(); });
  await page.waitForTimeout(1500);
  const en = await page.evaluate(() => ({aloud: $('aloud').textContent, why: $('noteWhy').textContent, shown: getComputedStyle(document.querySelector('.note')).display !== 'none',
    size: parseFloat(getComputedStyle($('aloud')).fontSize), tag: !$('enTag').hidden, word: G.task.r.en}));
  await page.screenshot({path: path.join(SHOTS, 'novoice-A04.png')});
  check(en.shown && en.aloud === en.word && en.size >= 24 && /англійського/.test(en.why) && en.tag, 'novoice',
    'без англійського голосу дорослий бачить слово великим: «' + en.aloud + '» (' + en.size + 'px), 🇬🇧 видно', 'англійська без голосу: ' + JSON.stringify(en));
  cons.length ? fail('novoice', 'консоль: ' + cons.join(' | ')) : ok('консоль чиста');
  await browser.close();
}

(async () => {
  const devs = DEVICES.filter(d => !process.env.ONLY || process.env.ONLY.split(',').indexOf(d.name) >= 0);
  const part = x => !process.env.PARTS || process.env.PARTS.split(',').indexOf(x) >= 0;
  try {
    await startServer();
    await adminLogin();
    console.log('Flask: ' + BASE + ' (тимчасові бази в ' + TMP + ')');
    if (part('secur')) try { await secur(); } catch (e) { fail('secur', 'зупинилось: ' + e.message.split('\n')[0]); }
    if (part('run')) for (const d of devs) {
      try { await run(d); } catch (e) { fail(d.name, 'зупинилось: ' + e.message.split('\n')[0]); }
    }
    if (part('files')) for (const d of devs) {
      try { await withFiles(d); } catch (e) { fail(d.name + '/snd', 'зупинилось: ' + e.message.split('\n')[0]); }
    }
    if (part('novoice')) try { await noVoice(); } catch (e) { fail('novoice', 'зупинилось: ' + e.message.split('\n')[0]); }
  } catch (e) { fail('сервер', e.message); }
  if (srv) srv.kill();
  const tb = srvLog.split('\n').filter(l => /Traceback|Error/.test(l));
  if (tb.length) fail('сервер', 'у журналі Flask помилки:\n' + srvLog.slice(-3000));
  console.log('\n' + (problems.length ? 'ПРОБЛЕМИ (' + problems.length + '):\n' + problems.join('\n') : 'УСЕ ГАРАЗД'));
  console.log('Скріншоти: ' + SHOTS);
  if (!problems.length) fs.rmSync(TMP, {recursive: true, force: true});
  process.exit(problems.length ? 1 : 0);
})();

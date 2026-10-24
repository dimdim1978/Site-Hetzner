# -*- coding: utf-8 -*-
"""
Уроки 5–8: вхід мами й педагога, пристрої, прогрес (docs/kabinet-uroky.md).

Підключається з app.py одним викликом init(app, модуль_app). Усе живе під
/uroky (і сторінка адміністратора /admin/mudryk), тож переїзд з піддомену
lab на основний домен — це зміна блоку в Caddyfile, а не коду.

Головне, що тут вирішено і чому:
  * прогрес рахує СЕРВЕР (stan()), клієнт лише показує — інакше кожен
    пристрій мав би свою правду, а мама й педагог бачили б різне;
  * прогрес рухає тільки педагог (khto='vchytel'); заняття мами — окремий
    лічильник «повторювали вдома», статусів не змінює (§0 п. 7);
  * уроки відкриваються лише на активованому пристрої І лише після входу —
    обидві умови перевіряє zastava(), яку викликає gate() з app.py.
"""

import os, re, json, hmac, hashlib, secrets, sqlite3
from datetime import datetime, timedelta, timezone

from flask import (request, session, redirect, jsonify, render_template, g,
                   abort, send_from_directory, make_response)
from flask.sessions import SecureCookieSessionInterface
from itsdangerous import BadSignature
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from zoneinfo import ZoneInfo
    try:
        KYIV = ZoneInfo('Europe/Kyiv')
    except Exception:
        KYIV = ZoneInfo('Europe/Kiev')       # старий tzdata знає лише цю назву
except Exception:                            # pragma: no cover
    KYIV = timezone(timedelta(hours=2))

HERE      = os.path.dirname(os.path.abspath(__file__))
UROKY_DIR = os.path.join(HERE, 'uroky')

A = None              # модуль app: db(), log(), now(), client_ip(), make_login …
NAVCH_DB_PATH = ''
AUDIO_DIR     = ''
UROKY_URL     = ''
DEV           = False

DEV_COOKIE  = 'beregynia_dev'
DEV_DAYS    = 400
MAMA_DAYS   = 30
CODE_HOURS  = 24
CODE_TRIES  = 5        # невдалих кодів з однієї IP за 15 хв
MAMA_TRIES  = 10       # як у pupil_login
STAFF_TRIES = 7        # як у login персоналу

BUKVAR_CLIENT = {'bolshakova': 'B', 'vashulenko': 'V'}
BUKVAR_NAME   = {'bolshakova': 'Большакова', 'vashulenko': 'Вашуленко'}
LINES = [('g', 'Грамота'), ('m', 'Математика'), ('f', 'Геометрія'), ('a', 'Англійська')]
ST_HUMAN = {'—': 'не почато', 'вчиться': 'вчиться', 'засвоєно': 'засвоєно', 'застряг': 'застряг'}


# ============================================================
#  КАТАЛОГ УРОКІВ — що є, які навички, яких записів потребує
# ============================================================
KAT = {}
ORDER = []
LESSON = {}
SKILL = {}             # навичка → {lesson, code, short, nazva, porada}
CHECK_ORDER = []

def load_katalog():
    global KAT, ORDER, LESSON, SKILL, CHECK_ORDER
    with open(os.path.join(UROKY_DIR, 'katalog.json'), encoding='utf-8') as f:
        KAT = json.load(f)
    ORDER = [L['id'] for L in KAT['lessons']]
    LESSON = {L['id']: L for L in KAT['lessons']}
    SKILL = {}
    for L in KAT['lessons']:
        for sk, v in L['skills'].items():
            SKILL[sk] = dict(v, lesson=L['id'])
    CHECK_ORDER = list(KAT['check_order'])


def avail(lid):
    """Урок відкривається, лише коли всі його записи звуків лежать на сервері.
    Те саме правило, що й у браузері (missing/avail), — тут воно потрібне,
    щоб рекомендація не вказала на урок, якого дитина відкрити не зможе."""
    for x in LESSON[lid].get('needs') or []:
        if not os.path.isfile(os.path.join(AUDIO_DIR, 'snd_{}.wav'.format(x))):
            return False
    return True


# ============================================================
#  БАЗА navchannia.db
# ============================================================
def nv():
    if 'nv' not in g:
        g.nv = sqlite3.connect(NAVCH_DB_PATH)
        g.nv.row_factory = sqlite3.Row
        g.nv.execute('PRAGMA busy_timeout = 5000')
    return g.nv

def _close_nv(exc):
    conn = g.pop('nv', None)
    if conn is not None:
        conn.close()

def init_navch():
    os.makedirs(os.path.dirname(NAVCH_DB_PATH) or '.', exist_ok=True)
    conn = sqlite3.connect(NAVCH_DB_PATH)
    # WAL — як і основна: читання (сторінка стану) не чекає на запис заняття
    conn.execute('PRAGMA journal_mode = WAL')
    conn.executescript(open(os.path.join(HERE, 'navchannia.sql'), encoding='utf-8').read())
    conn.commit()
    _migrate_navch(conn)
    conn.close()

def _migrate_navch(conn):
    """Сюди — ALTER TABLE і індекси на колонках, доданих після першого
    розгортання (START-HERE §6.1). Поки що нових колонок немає."""
    conn.commit()


def backup_to(backup_dir, stamp, keep):
    """Копія navchannia.db з тією самою позначкою часу, що й основна
    (kabinet-navchannia §4 п. 3): інакше при відновленні половини були б
    з різних днів. sqlite3.backup(), не cp — WAL (START-HERE §6.8)."""
    path = os.path.join(backup_dir, 'navchannia-{}.db'.format(stamp))
    src = sqlite3.connect(NAVCH_DB_PATH)
    dst = sqlite3.connect(path)
    try:
        src.backup(dst)
    finally:
        dst.close(); src.close()
    files = sorted(f for f in os.listdir(backup_dir)
                   if f.startswith('navchannia-') and f.endswith('.db'))
    while len(files) > keep:
        try:
            os.remove(os.path.join(backup_dir, files.pop(0)))
        except OSError:
            break
    return os.path.basename(path)


# ============================================================
#  ЧАС
# ============================================================
def utcnow():
    return datetime.now(timezone.utc)

def iso_z(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def parse_z(s):
    return datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)

def kyiv_day(dt):
    return dt.astimezone(KYIV).strftime('%Y-%m-%d')

def today_kyiv():
    return kyiv_day(utcnow())


# ============================================================
#  СЕСІЯ: мамі — 30 днів, решті — як було (8 годин)
#
#  Підпис куки Flask перевіряє з одним max_age на весь застосунок.
#  Щоб мама не вводила пароль щодня, а персонал і учні лишились на
#  8 годинах, підпис перевіряємо на 30 днів, а для всіх, хто не мама,
#  самі відкидаємо куку, старшу за PERMANENT_SESSION_LIFETIME.
# ============================================================
class SesiiZMamoiu(SecureCookieSessionInterface):
    def open_session(self, app, request):
        s = self.get_signing_serializer(app)
        if s is None:
            return None
        val = request.cookies.get(self.get_cookie_name(app))
        if not val:
            return self.session_class()
        try:
            data, ts = s.loads(val, max_age=MAMA_DAYS * 86400, return_timestamp=True)
        except BadSignature:
            return self.session_class()
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if data.get('kind') != 'mama' and utcnow() - ts > app.permanent_session_lifetime:
            return self.session_class()
        return self.session_class(data)

    def get_expiration_time(self, app, session):
        if session.permanent and session.get('kind') == 'mama':
            return utcnow() + timedelta(days=MAMA_DAYS)
        return super().get_expiration_time(app, session)


# ============================================================
#  ПРИСТРІЙ
# ============================================================
def _sha(x):
    return hashlib.sha256(x.encode('utf-8')).hexdigest()

def _code_hash(code):
    # HMAC із SECRET_KEY: 8 цифр — мало, і простий sha256 з бази перебрався б
    # за хвилину. Без ключа сервера хеш нічого не дає.
    return hmac.new(A.SECRET_KEY.encode('utf-8'), code.encode('utf-8'), hashlib.sha256).hexdigest()

def prystrii():
    """Активований пристрій із куки або None. Кешується на запит."""
    if 'prystrii' in g:
        return g.prystrii
    g.prystrii = None
    tok = request.cookies.get(DEV_COOKIE) or ''
    if 20 <= len(tok) <= 100:
        row = nv().execute('SELECT * FROM prystroi WHERE token_hash=? AND revoked_at IS NULL',
                           (_sha(tok),)).fetchone()
        if row:
            g.prystrii = row
            # last_seen — не частіше разу на годину: писати в базу на кожен
            # запит (а їх сотні за урок — звуки) нема чого
            hour_ago = (datetime.now() - timedelta(hours=1)).strftime('%Y-%m-%d %H:%M:%S')
            if not row['last_seen'] or row['last_seen'] < hour_ago:
                nv().execute('UPDATE prystroi SET last_seen=? WHERE id=?', (A.now(), row['id']))
                nv().commit()
    return g.prystrii


# ============================================================
#  ЗАСТАВА — викликається з gate() в app.py для всього під /uroky
# ============================================================
PUBLIC = {'/uroky/aktyvatsiia', '/uroky/api/aktyvatsiia', '/uroky/manifest.webmanifest',
          '/uroky/sw.js', '/uroky/icon-192.png', '/uroky/icon-512.png'}
NO_LOGIN = {'/uroky/vkhid', '/uroky/api/vkhid', '/uroky/vykhid'}
# персонал може бути тут і без обраної дитини
NO_KID = {'/uroky/dity', '/uroky/api/zaniattia', '/uroky/api/pidhotovka'}

def _is_api(p):
    return p.startswith('/uroky/api/') or p.startswith('/uroky/audio/')

def zastava():
    p = request.path
    if p in PUBLIC:
        return None
    if not prystrii():
        if _is_api(p):
            return jsonify(ok=False, error='prystrii',
                           message='Пристрій не активовано або доступ відкликано.'), 403
        # SameSite=Strict: перехід за посиланням з Viber чи пошти куку пристрою
        # НЕ несе, і активований телефон побачив би сторінку активації. Тому
        # для такого переходу один раз перезавантажуємо ту саму адресу вже
        # зсередини сайту — тоді кука їде. Без циклу: позначка ?s=1.
        if (request.method == 'GET' and request.headers.get('Sec-Fetch-Site') == 'cross-site'
                and request.args.get('s') != '1'):
            sep = '&' if request.query_string else '?'
            url = request.full_path.rstrip('?') + sep + 's=1'
            return make_response(
                '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">'
                '<meta http-equiv="refresh" content="0;url={0}"><script>location.replace({1})</script>'
                .format(A.esc(url), json.dumps(url)))
        return redirect('/uroky/aktyvatsiia')
    if p in NO_LOGIN:
        return None
    kind = session.get('kind')
    if kind not in ('mama', 'staff') or (kind == 'staff' and not session.get('login')):
        if _is_api(p):
            return jsonify(ok=False, error='vkhid', message='Потрібно увійти.'), 401
        return redirect('/uroky/vkhid')
    if p == '/uroky/dity' and kind != 'staff':
        return redirect('/uroky')
    if kind == 'staff' and not session.get('dytyna') and p not in NO_KID and not p.startswith('/uroky/audio/'):
        if _is_api(p):
            return jsonify(ok=False, error='dytyna', message='Оберіть дитину.'), 409
        return redirect('/uroky/dity')
    return None


def dytyna_sesii():
    """Дитина, з якою зараз працюють. Мамі — лише своя, з сесії;
    параметр від клієнта тут не читається ніде."""
    did = session.get('dytyna')
    if not did:
        return None
    return nv().execute('SELECT * FROM dity WHERE id=?', (did,)).fetchone()


# ============================================================
#  ПРОГРЕС: правило засвоєння, рекомендація
# ============================================================
def _sesii(did):
    """Усі заняття дитини в порядку часу: [{id, vyd, urok, den, khto, items}]."""
    out, by = [], {}
    rows = nv().execute(
        'SELECT z.id, z.vyd, z.urok, z.pochatok, z.khto, n.navychka, n.pershi, n.usogo '
        'FROM zaniattia z LEFT JOIN zaniattia_navychky n ON n.zaniattia_id = z.id '
        'WHERE z.dytyna_id=? ORDER BY z.pochatok, z.id', (did,)).fetchall()
    for r in rows:
        s = by.get(r['id'])
        if s is None:
            dt = parse_z(r['pochatok'])
            s = by[r['id']] = {'id': r['id'], 'vyd': r['vyd'], 'urok': r['urok'],
                               'den': kyiv_day(dt), 'khto': r['khto'], 'items': {}}
            out.append(s)
        if r['navychka']:
            s['items'][r['navychka']] = (r['pershi'], r['usogo'])
    return out


def _lesson_state(st, lid):
    sks = [st[sk]['st'] for sk in LESSON[lid]['skills']]
    if all(x == '—' for x in sks):
        return 'new'
    if all(x == 'засвоєно' for x in sks):
        return 'ok'
    if any(x == 'застряг' for x in sks):
        return 'stuck'
    return 'learn'


def _check_start(c, area=None):
    for sk in CHECK_ORDER:
        if area and LESSON[SKILL[sk]['lesson']]['area'] != area:
            continue
        if sk in c['items'] and not (c['items'][sk] and sum(c['items'][sk]) == 2):
            return SKILL[sk]['lesson']
    return None


def stan(did, today=None):
    """Стан дитини. Повторює правило з uroky.html (docs/kabinet-uroky.md §6):
      засвоєно — ≥3 правильні з першої спроби щонайменше у 2 різні дні (Київ);
      застряг  — останні 3 заняття з навичкою без жодної правильної;
      вчиться  — є заняття, але ні те, ні інше; «—» — не почато.
    Рахуються ЛИШЕ уроки педагога. Перевірки в засвоєння не йдуть, заняття
    мами — окремий лічильник vdoma."""
    today = today or today_kyiv()
    ses = _sesii(did)
    teach = [s for s in ses if s['khto'] == 'vchytel' and s['vyd'] == 'urok']
    mama = [s for s in ses if s['khto'] == 'mama' and s['vyd'] == 'urok']

    skills = {}
    for sk in SKILL:
        w = [s for s in teach if sk in s['items'] and s['items'][sk][1] > 0]
        okof = lambda s: s['items'][sk][0]
        total = sum(okof(s) for s in w)
        days = len({s['den'] for s in w if okof(s) > 0})
        last3 = w[-3:]
        if not w:
            st = '—'
        elif total >= 3 and days >= 2:
            st = 'засвоєно'
        elif len(last3) == 3 and all(okof(s) == 0 for s in last3):
            st = 'застряг'
        else:
            st = 'вчиться'
        skills[sk] = {'st': st, 'days': days, 'n': len(w),
                      'todayOk': sum(okof(s) for s in w if s['den'] == today),
                      'vdoma': sum(1 for s in mama if sk in s['items']),
                      'ostannie': w[-1]['den'] if w else None}

    today_lessons = sorted({s['urok'] for s in teach if s['den'] == today})
    checks = []
    for s in ses:
        if s['vyd'] in ('start', 'povtor') and s['khto'] == 'vchytel':
            items = {}
            for sk, (p, u) in s['items'].items():
                items[sk] = ([1] * p + [0] * (u - p)) if u else None
            checks.append({'date': s['den'], 'kind': 'repeat' if s['vyd'] == 'povtor' else 'start',
                           'items': items})

    # ---- рекомендований урок (uroky-12.md §D): лінії по колу Г → М → Ф → А
    last = checks[-1] if checks else None

    def line_rec(area, any_day):
        fresh = lambda lid: any_day or lid not in today_lessons
        def passed(lid):
            return bool(last) and all(last['items'].get(sk) and sum(last['items'][sk]) == 2
                                      for sk in LESSON[lid]['skills'])
        x = _check_start(last, area) if last else None
        if x and avail(x) and _lesson_state(skills, x) not in ('ok', 'stuck') and fresh(x):
            return x
        opn = [lid for lid in ORDER if LESSON[lid]['area'] == area and avail(lid)
               and _lesson_state(skills, lid) != 'ok' and not passed(lid)]
        free = [lid for lid in opn if _lesson_state(skills, lid) != 'stuck' and fresh(lid)]
        if not free:
            return None
        lvl = min(LESSON[lid]['level'] for lid in free)
        return next(lid for lid in free if LESSON[lid]['level'] == lvl)

    areas = [a for a, _ in LINES]
    k0 = 0
    if teach:
        k0 = (areas.index(LESSON[teach[-1]['urok']]['area']) + 1) % len(areas)
    rec = None
    for any_day in (False, True):
        for k in range(len(areas)):
            rec = line_rec(areas[(k0 + k) % len(areas)], any_day)
            if rec:
                break
        if rec:
            break
    if not rec:
        av = [lid for lid in ORDER if avail(lid)]
        rec = next((lid for lid in av if _lesson_state(skills, lid) != 'ok'), av[0] if av else None)

    # ---- мамі: лише уроки, які педагог уже провів (§0 п. 7)
    taught = {}
    for s in teach:
        taught[s['urok']] = s['den']                     # остання дата заняття педагога
    m_lessons = [lid for lid in ORDER if lid in taught and avail(lid)]
    learning = [lid for lid in m_lessons
                if any(skills[sk]['st'] == 'вчиться' for sk in LESSON[lid]['skills'])]
    fresh_first = lambda ids: sorted(ids, key=lambda lid: taught[lid], reverse=True)
    m_rec = (fresh_first(learning) or fresh_first(m_lessons) or [None])[0]
    vdoma = {}
    for s in mama:
        vdoma[s['urok']] = vdoma.get(s['urok'], 0) + 1

    # ---- календар (для сторінки стану)
    kal = {}
    for s in ses:
        k = kal.setdefault(s['den'], {'v': 0, 'm': 0})
        k['v' if s['khto'] == 'vchytel' else 'm'] += 1

    return {'today': today, 'skills': skills, 'today_lessons': today_lessons,
            'rec': rec, 'checks': checks,
            'mama': {'lessons': m_lessons, 'rec': m_rec, 'vdoma': vdoma},
            'kalendar': kal,
            'zasvoeno': sum(1 for v in skills.values() if v['st'] == 'засвоєно'),
            'ostannie': ses[-1]['den'] if ses else None}


def stan_json(row):
    s = stan(row['id'])
    s.pop('kalendar', None)
    out = {'ok': True, 'rol': session.get('kind'),
           'dytyna': {'id': row['id'], 'imia': row['imia'], 'vik': row['vik'],
                      'bukvar': BUKVAR_CLIENT.get(row['bukvar'], '?'),
                      'bukvar_name': BUKVAR_NAME.get(row['bukvar'], '')},
           'stan': s, 'dev': DEV}
    if session.get('kind') == 'staff':
        out['staff'] = {'login': session.get('login'), 'name': session.get('name')}
        out['prep'] = {r['urok']: r['data'] for r in nv().execute(
            'SELECT urok, data FROM pidhotovka WHERE staff_login=?', (session.get('login'),))}
    else:
        out['prep'] = {}
        # мамі не віддаємо рекомендацію й стани непройдених уроків: вперед вона не йде
        s['rec'] = s['mama']['rec']
    return out


# ============================================================
#  ЛОГІНИ Й ПАРОЛІ ДІТЕЙ
# ============================================================
def make_child_login(prizv):
    """Той самий make_login, що й для учнів 1–11. Логін не має збігтися ні
    з іншою дитиною, ні з учнем у children (там своя мама могла б плутатись),
    тож номер беремо наступний вільний."""
    n = (nv().execute('SELECT COALESCE(MAX(id), 0) FROM dity').fetchone()[0] or 0) + 1
    while True:
        cand = A.make_login(prizv, n)
        if not nv().execute('SELECT 1 FROM dity WHERE login=?', (cand,)).fetchone() and \
           not A.db().execute('SELECT 1 FROM children WHERE login=?', (cand,)).fetchone():
            return cand
        n += 1


def _since15():
    return (datetime.now() - timedelta(minutes=15)).strftime('%Y-%m-%d %H:%M:%S')

def _fails(ip=None, login=None):
    q, a = 'SELECT COUNT(*) c FROM login_attempts WHERE ts>? AND ok=0', [_since15()]
    if ip is not None:
        q += ' AND ip=?'; a.append(ip)
    if login is not None:
        q += ' AND login=?'; a.append(login)
    return A.db().execute(q, a).fetchone()['c']

def _attempt(ok, login):
    A.db().execute('INSERT INTO login_attempts (ip, ts, ok, login) VALUES (?,?,?,?)',
                   (A.client_ip(), A.now(), 1 if ok else 0, login))
    A.db().commit()


# ============================================================
#  МАРШРУТИ
# ============================================================
def _send(name, mime=None, cache='no-cache'):
    resp = make_response(send_from_directory(UROKY_DIR, name, mimetype=mime))
    resp.headers['Cache-Control'] = cache
    return resp


def init(app, appmod):
    global A, NAVCH_DB_PATH, AUDIO_DIR, UROKY_URL, DEV
    A = appmod
    DEV = appmod.DEV
    NAVCH_DB_PATH = os.environ.get('NAVCH_DB_PATH',
                                   os.path.join(os.path.dirname(appmod.DB_PATH), 'navchannia.db'))
    AUDIO_DIR = os.environ.get('UROKY_AUDIO_DIR', '/var/www/lab/audio')
    UROKY_URL = os.environ.get('UROKY_URL', 'https://lab.mudryk.iprostir.pp.ua/uroky')
    load_katalog()
    init_navch()
    app.session_interface = SesiiZMamoiu()
    app.teardown_appcontext(_close_nv)

    @app.after_request
    def _noindex(resp):
        p = request.path
        if p == '/uroky' or p.startswith('/uroky/'):
            resp.headers['X-Robots-Tag'] = 'noindex, nofollow'
        return resp

    # ---------------- статика оболонки ----------------
    @app.get('/uroky/manifest.webmanifest')
    def uroky_manifest():
        resp = make_response(json.dumps({
            'name': 'Мудрик', 'short_name': 'Мудрик', 'lang': 'uk',
            'start_url': '/uroky', 'scope': '/uroky', 'display': 'standalone',
            'background_color': '#FFF8EE', 'theme_color': '#C77D2E',
            'icons': [{'src': '/uroky/icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
                      {'src': '/uroky/icon-512.png', 'sizes': '512x512', 'type': 'image/png'}]
        }, ensure_ascii=False))
        resp.headers['Content-Type'] = 'application/manifest+json; charset=utf-8'
        resp.headers['Cache-Control'] = 'no-cache'
        return resp

    @app.get('/uroky/sw.js')
    def uroky_sw():
        resp = _send('sw.js', 'application/javascript')
        # sw лежить у /uroky/, а керувати має й самою /uroky (без скісної)
        resp.headers['Service-Worker-Allowed'] = '/uroky'
        return resp

    @app.get('/uroky/icon-<int:n>.png')
    def uroky_icon(n):
        if n not in (192, 512):
            abort(404)
        return _send('icon-{}.png'.format(n), 'image/png', 'public, max-age=86400')

    @app.get('/uroky/audio/<name>')
    def uroky_audio(name):
        if not re.fullmatch(r'snd_[a-z_]{1,12}\.wav', name):
            abort(404)
        resp = make_response(send_from_directory(AUDIO_DIR, name, mimetype='audio/wav'))
        resp.headers['Cache-Control'] = 'private, max-age=86400'
        return resp

    # ---------------- активація пристрою ----------------
    @app.get('/uroky/aktyvatsiia')
    def uroky_aktyvatsiia():
        return render_template('uroky/aktyvatsiia.html', active=bool(prystrii()))

    @app.post('/uroky/api/aktyvatsiia')
    def uroky_api_aktyvatsiia():
        ip = A.client_ip()
        if _fails(ip=ip, login='#kod') >= CODE_TRIES:
            return jsonify(ok=False, error='Забагато спроб. Спробуйте за 15 хвилин.'), 429
        body = request.get_json(silent=True) or request.form
        code = re.sub(r'\D', '', str(body.get('kod') or ''))[:8]
        row = None
        if len(code) == 8:
            row = nv().execute('SELECT * FROM kody WHERE code_hash=? AND used_at IS NULL AND expires_at>?',
                               (_code_hash(code), A.now())).fetchone()
        if not row:
            _attempt(False, '#kod')
            return jsonify(ok=False, error='Код не підходить: можливо, помилка в цифрах, '
                                           'код уже використано або минуло 24 години.'), 400
        tok = secrets.token_urlsafe(32)
        conn = nv()
        # «used_at IS NULL» ще раз — у самому UPDATE: два пристрої з одним
        # кодом в одну секунду не мають отримати обидва
        n = conn.execute('UPDATE kody SET used_at=? WHERE id=? AND used_at IS NULL',
                         (A.now(), row['id'])).rowcount
        if n != 1:
            conn.rollback()
            _attempt(False, '#kod')
            return jsonify(ok=False, error='Код уже використано.'), 400
        cur = conn.execute('INSERT INTO prystroi (nazva, token_hash, created_at, created_by, last_seen) '
                           'VALUES (?,?,?,?,?)', (row['nazva'], _sha(tok), A.now(), row['created_by'], A.now()))
        conn.execute('UPDATE kody SET prystrii_id=? WHERE id=?', (cur.lastrowid, row['id']))
        conn.commit()
        _attempt(True, '#kod')
        A.log('уроки: активовано пристрій «{}»'.format(row['nazva']), who='пристрій')
        resp = jsonify(ok=True, redirect='/uroky')
        resp.set_cookie(DEV_COOKIE, tok, max_age=DEV_DAYS * 86400, path='/uroky',
                        secure=not DEV, httponly=True, samesite='Strict')
        return resp

    # ---------------- вхід ----------------
    @app.get('/uroky/vkhid')
    def uroky_vkhid():
        return render_template('uroky/vkhid.html', nazva=prystrii()['nazva'])

    @app.post('/uroky/api/vkhid')
    def uroky_api_vkhid():
        body = request.get_json(silent=True) or request.form
        hto = body.get('hto')
        if hto == 'mama':
            login_ = re.sub(r'[^a-z0-9]', '', A.clean(body.get('login'), 40).lower())
            passwd = A.norm_pass(body.get('password'))
            if not login_ or not passwd:
                return jsonify(ok=False, error='Введіть логін і пароль дитини'), 400
            key = 'mama:' + login_
            if _fails(login=key) >= MAMA_TRIES:
                return jsonify(ok=False, error='Забагато спроб. Спробуйте за 15 хвилин '
                                               'або зверніться до педагога.'), 429
            row = nv().execute('SELECT * FROM dity WHERE login=?', (login_,)).fetchone()
            ok = bool(row) and check_password_hash(row['pass_hash'], passwd)
            _attempt(ok, key)
            if not ok:
                return jsonify(ok=False, error='Невірний логін або пароль'), 401
            session.clear()
            session.permanent = True
            session['kind'] = 'mama'
            session['dytyna'] = row['id']
            session['name'] = row['imia']
            nv().execute('UPDATE dity SET last_login=? WHERE id=?', (A.now(), row['id']))
            nv().commit()
            A.log('уроки: вхід мами (дитина {}, пристрій «{}»)'.format(row['login'], prystrii()['nazva']),
                  who='мама ' + row['login'])
            return jsonify(ok=True, redirect='/uroky')
        if hto == 'staff':
            ip = A.client_ip()
            if A.attempts_recently(ip) >= STAFF_TRIES:
                return jsonify(ok=False, error='Забагато спроб. Спробуйте за 15 хвилин.'), 429
            login_ = A.clean(body.get('login'), 60)
            passwd = body.get('password') or ''
            row = A.db().execute('SELECT * FROM admins WHERE login=?', (login_,)).fetchone()
            ok = bool(row) and check_password_hash(row['pass_hash'], passwd)
            # login NULL — так само, як вхід в адмінку: це спроба персоналу
            A.db().execute('INSERT INTO login_attempts (ip, ts, ok) VALUES (?,?,?)', (ip, A.now(), 1 if ok else 0))
            A.db().commit()
            if not ok:
                return jsonify(ok=False, error='Невірний логін або пароль'), 401
            session.clear()
            session.permanent = True
            session['kind'] = 'staff'
            session['login'] = row['login']
            session['role'] = row['role']
            session['name'] = row['full_name'] or row['login']
            A.db().execute('UPDATE admins SET last_login=? WHERE id=?', (A.now(), row['id']))
            A.db().commit()
            A.log('уроки: вхід педагога (пристрій «{}»)'.format(prystrii()['nazva']))
            return jsonify(ok=True, redirect='/uroky/dity')
        return jsonify(ok=False, error='Оберіть, хто входить'), 400

    @app.get('/uroky/vykhid')
    def uroky_vykhid():
        session.clear()
        return redirect('/uroky/vkhid')

    # ---------------- вибір дитини (персонал) ----------------
    @app.get('/uroky/dity')
    def uroky_dity():
        rows = nv().execute('SELECT * FROM dity ORDER BY imia').fetchall()
        dity = []
        for r in rows:
            s = stan(r['id'])
            dity.append({'id': r['id'], 'imia': r['imia'], 'vik': r['vik'],
                         'ostannie': s['ostannie'], 'zasvoeno': s['zasvoeno']})
        return render_template('uroky/dity.html', dity=dity, who=session.get('name'),
                               current=session.get('dytyna'))

    @app.post('/uroky/dity')
    def uroky_dity_obraty():
        did = request.form.get('id', type=int)
        if not did or not nv().execute('SELECT 1 FROM dity WHERE id=?', (did,)).fetchone():
            return redirect('/uroky/dity')
        session['dytyna'] = did
        return redirect('/uroky')

    # ---------------- оболонка уроків і стан ----------------
    @app.get('/uroky')
    def uroky_shell():
        if not dytyna_sesii():
            return _lost()
        return _send('uroky.html', 'text/html')

    @app.get('/uroky/')
    def uroky_slash():
        return redirect('/uroky')

    @app.get('/uroky/stan')
    def uroky_stan():
        row = dytyna_sesii()
        if not row:
            return _lost()
        s = stan(row['id'])
        return render_template('uroky/stan.html', d=row, s=s, kal=_kalendar(s['kalendar'], s['today']),
                               lines=_lines_for_page(s), staff=session.get('kind') == 'staff',
                               bukvar=BUKVAR_NAME.get(row['bukvar'], ''))

    @app.get('/uroky/api/stan')
    def uroky_api_stan():
        row = dytyna_sesii()
        if not row:
            return _lost(api=True)
        return jsonify(stan_json(row))

    @app.post('/uroky/api/pidhotovka')
    def uroky_api_pidhotovka():
        if session.get('kind') != 'staff':
            return jsonify(ok=False, error='Лише для педагога'), 403
        body = request.get_json(silent=True) or {}
        lid = body.get('urok')
        if lid not in LESSON:
            return jsonify(ok=False, error='Немає такого уроку'), 400
        nv().execute('INSERT OR REPLACE INTO pidhotovka (staff_login, urok, data) VALUES (?,?,?)',
                     (session['login'], lid, today_kyiv()))
        nv().commit()
        return jsonify(ok=True)

    @app.post('/uroky/api/zaniattia')
    def uroky_api_zaniattia():
        return _pryiniaty()

    # ---------------- лише для розробки ----------------
    @app.post('/uroky/api/dev/zavtra')
    def uroky_dev_zavtra():
        if not DEV:
            abort(404)
        # «завтра» = усі заняття дитини на день раніше: правило «2 різні дні»
        # і повторну перевірку так видно без очікування доби
        did = session.get('dytyna')
        nv().execute("UPDATE zaniattia SET pochatok=strftime('%Y-%m-%dT%H:%M:%SZ', pochatok, '-1 day') "
                     "WHERE dytyna_id=?", (did,))
        nv().commit()
        return jsonify(ok=True)

    # ---------------- адміністратор: /admin/mudryk ----------------
    init_admin(app)


def _lost(api=False):
    """Дитину видалили, поки сесія жила."""
    kind = session.get('kind')
    if kind == 'staff':
        session.pop('dytyna', None)
        return (jsonify(ok=False, error='dytyna'), 409) if api else redirect('/uroky/dity')
    session.clear()
    return (jsonify(ok=False, error='vkhid'), 401) if api else redirect('/uroky/vkhid')


# ------------------------------------------------------------
#  Прийом підсумку заняття (§6, §7)
# ------------------------------------------------------------
def _pryiniaty():
    b = request.get_json(silent=True)
    if not isinstance(b, dict):
        return jsonify(ok=False, error='Порожній запит'), 400
    kid = str(b.get('klient_id') or '')
    if not re.fullmatch(r'[A-Za-z0-9-]{8,64}', kid):
        return jsonify(ok=False, error='klient_id'), 400

    kind = session.get('kind')
    try:
        did = int(b.get('dytyna'))
    except (TypeError, ValueError):
        return jsonify(ok=False, error='dytyna'), 400
    if kind == 'mama' and did != session.get('dytyna'):
        # з черги прийшло заняття іншої дитини: на цьому телефоні входили
        # під іншим логіном. Чужій дитині його не записуємо.
        return jsonify(ok=False, error='insha',
                       message='Заняття іншої дитини — не прийнято.'), 403
    row = nv().execute('SELECT * FROM dity WHERE id=?', (did,)).fetchone()
    if not row:
        return jsonify(ok=False, error='dytyna', message='Такої дитини вже немає в базі.'), 403

    dup = nv().execute('SELECT 1 FROM zaniattia WHERE klient_id=?', (kid,)).fetchone()
    if dup:
        return jsonify(ok=False, error='vzhe', stan=stan_json(row) if did == session.get('dytyna') else None), 409

    vyd = b.get('vyd')
    lid = b.get('urok')
    if vyd not in ('urok', 'start', 'povtor'):
        return jsonify(ok=False, error='vyd'), 400
    if vyd == 'urok':
        if lid not in LESSON:
            return jsonify(ok=False, error='urok'), 400
        allowed = set(LESSON[lid]['skills'])
    else:
        lid = None
        allowed = set(CHECK_ORDER)

    if kind == 'mama':
        if vyd != 'urok':
            return jsonify(ok=False, error='Перевірку проводить лише педагог'), 403
        taught = nv().execute("SELECT 1 FROM zaniattia WHERE dytyna_id=? AND urok=? AND khto='vchytel' "
                              "AND vyd='urok' LIMIT 1", (did, lid)).fetchone()
        if not taught:
            return jsonify(ok=False, error='Цей урок ще не пройдено з педагогом'), 403

    nav = b.get('navychky')
    if not isinstance(nav, dict) or not nav or len(nav) > 40:
        return jsonify(ok=False, error='navychky'), 400
    clean = {}
    for sk, v in nav.items():
        if sk not in allowed or not isinstance(v, dict):
            return jsonify(ok=False, error='navychka ' + str(sk)[:10]), 400
        p, u = v.get('pershi'), v.get('usogo')
        if not isinstance(p, int) or not isinstance(u, int) or isinstance(p, bool) or isinstance(u, bool):
            return jsonify(ok=False, error='lichylnyky'), 400
        # перевірка може пропустити навичку (0 з 0); урок — ні
        if not (0 <= p <= u <= 20) or (vyd == 'urok' and u == 0):
            return jsonify(ok=False, error='lichylnyky'), 400
        clean[sk] = (p, u)

    try:
        dt = datetime.fromisoformat(str(b.get('pochatok') or '').replace('Z', '+00:00'))
    except ValueError:
        return jsonify(ok=False, error='pochatok'), 400
    if dt.tzinfo is None:
        return jsonify(ok=False, error='pochatok без часового поясу'), 400
    nw = utcnow()
    if dt > nw + timedelta(minutes=5) or dt < nw - timedelta(days=14):
        return jsonify(ok=False, error='pochatok поза межами'), 400

    if vyd != 'urok':
        # стартова чи повторна — вирішує сервер: чи були перевірки раніше
        had = nv().execute("SELECT 1 FROM zaniattia WHERE dytyna_id=? AND vyd IN ('start','povtor') LIMIT 1",
                           (did,)).fetchone()
        vyd = 'povtor' if had else 'start'

    conn = nv()
    try:
        cur = conn.execute(
            'INSERT INTO zaniattia (dytyna_id, vyd, urok, pochatok, kinets, khto, staff_login, prystrii_id, klient_id) '
            'VALUES (?,?,?,?,?,?,?,?,?)',
            (did, vyd, lid, iso_z(dt), iso_z(nw), 'vchytel' if kind == 'staff' else 'mama',
             session.get('login') if kind == 'staff' else None, prystrii()['id'], kid))
        conn.executemany('INSERT INTO zaniattia_navychky (zaniattia_id, navychka, pershi, usogo) VALUES (?,?,?,?)',
                         [(cur.lastrowid, sk, p, u) for sk, (p, u) in clean.items()])
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()             # той самий klient_id у ту саму мить — уже прийнято
        return jsonify(ok=False, error='vzhe'), 409
    out = stan_json(row) if did == session.get('dytyna') else {'ok': True}
    return jsonify(out)


# ------------------------------------------------------------
#  Сторінка стану: календар 8 тижнів і лінії
# ------------------------------------------------------------
def _kalendar(kal, today):
    t = datetime.strptime(today, '%Y-%m-%d')
    monday = t - timedelta(days=t.weekday())
    start = monday - timedelta(weeks=7)
    weeks = []
    for w in range(8):
        row = []
        for d in range(7):
            day = start + timedelta(weeks=w, days=d)
            key = day.strftime('%Y-%m-%d')
            k = kal.get(key, {'v': 0, 'm': 0})
            row.append({'d': key, 'n': day.day, 'v': k['v'], 'm': k['m'], 'future': key > today})
        weeks.append(row)
    return weeks


def _lines_for_page(s):
    out = []
    for area, name in LINES:
        items = []
        for lid in ORDER:
            if LESSON[lid]['area'] != area:
                continue
            for sk, v in LESSON[lid]['skills'].items():
                st = s['skills'][sk]
                items.append({'code': v['code'], 'nazva': v['nazva'], 'st': st['st'],
                              'human': ST_HUMAN[st['st']], 'porada': v['porada'],
                              'vdoma': st['vdoma']})
        out.append({'name': name, 'items': items})
    return out


# ============================================================
#  АДМІНКА /admin/mudryk — діти, пристрої, коди
#  Під заставою персоналу вже через gate() (/admin*). Змінює дані
#  лише роль admin; teacher бачить список.
# ============================================================
def _need_admin():
    if session.get('kind') != 'staff':
        return jsonify(ok=False, error='Потрібно увійти'), 401
    if session.get('role') != 'admin':
        return jsonify(ok=False, error='Лише для адміністратора'), 403
    return None


def init_admin(app):
    @app.get('/admin/mudryk')
    def admin_mudryk():
        r = A.require_login()
        if r: return r
        dity = []
        for row in nv().execute('SELECT * FROM dity ORDER BY imia'):
            s = stan(row['id'])
            dity.append(dict(row, ostannie=s['ostannie'], zasvoeno=s['zasvoeno'],
                             bukvar_name=BUKVAR_NAME.get(row['bukvar'], row['bukvar'])))
        pr = nv().execute('SELECT * FROM prystroi ORDER BY revoked_at IS NOT NULL, created_at DESC').fetchall()
        kody = nv().execute('SELECT * FROM kody WHERE used_at IS NULL AND expires_at>? ORDER BY created_at DESC',
                            (A.now(),)).fetchall()
        return render_template('mudryk_admin.html', dity=dity, prystroi=pr, kody=kody,
                               who=session.get('name'), admin=session.get('role') == 'admin',
                               url=UROKY_URL, n_skills=len(SKILL))

    @app.post('/admin/mudryk/dytyna')
    def admin_mudryk_dytyna():
        r = _need_admin()
        if r: return r
        im = A.clean(request.form.get('imia'), 60)
        pr = A.clean(request.form.get('prizvyshche'), 60)
        vik = request.form.get('vik', type=int)
        bk = request.form.get('bukvar')
        if not im or not pr:
            return jsonify(ok=False, error="Вкажіть ім'я і прізвище"), 400
        if vik not in (5, 6, 7, 8):
            return jsonify(ok=False, error='Вік — від 5 до 8'), 400
        if bk not in BUKVAR_NAME:
            return jsonify(ok=False, error='Оберіть буквар'), 400
        login_ = make_child_login(pr)
        passwd = A.gen_password()
        cur = nv().execute('INSERT INTO dity (imia, vik, login, pass_hash, bukvar, created_at, created_by) '
                     'VALUES (?,?,?,?,?,?,?)',
                     (im + ' ' + pr, vik, login_, generate_password_hash(A.norm_pass(passwd)), bk,
                      A.now(), session.get('login')))
        nv().commit()
        A.log('Мудрик: створено дитину {} ({})'.format(im + ' ' + pr, login_))
        return jsonify(ok=True, id=cur.lastrowid, imia=im + ' ' + pr, login=login_, password=passwd, url=UROKY_URL)

    @app.post('/admin/mudryk/<int:did>/parol')
    def admin_mudryk_parol(did):
        r = _need_admin()
        if r: return r
        row = nv().execute('SELECT * FROM dity WHERE id=?', (did,)).fetchone()
        if not row:
            return jsonify(ok=False, error='Такої дитини немає'), 404
        passwd = A.gen_password()
        nv().execute('UPDATE dity SET pass_hash=? WHERE id=?',
                     (generate_password_hash(A.norm_pass(passwd)), did))
        nv().commit()
        A.log('Мудрик: новий пароль для {}'.format(row['login']))
        return jsonify(ok=True, imia=row['imia'], login=row['login'], password=passwd, url=UROKY_URL)

    @app.post('/admin/mudryk/<int:did>/bukvar')
    def admin_mudryk_bukvar(did):
        r = _need_admin()
        if r: return r
        bk = request.form.get('bukvar')
        if bk not in BUKVAR_NAME:
            return jsonify(ok=False, error='Оберіть буквар'), 400
        n = nv().execute('UPDATE dity SET bukvar=? WHERE id=?', (bk, did)).rowcount
        nv().commit()
        return jsonify(ok=bool(n))

    @app.post('/admin/mudryk/<int:did>/vydalyty')
    def admin_mudryk_vydalyty(did):
        r = _need_admin()
        if r: return r
        conn = nv()
        row = conn.execute('SELECT * FROM dity WHERE id=?', (did,)).fetchone()
        if not row:
            return jsonify(ok=False, error='Такої дитини вже немає'), 404
        try:
            # каскаду тут немає (і через файл його б не було) — тому явно і разом
            conn.execute('DELETE FROM zaniattia_navychky WHERE zaniattia_id IN '
                         '(SELECT id FROM zaniattia WHERE dytyna_id=?)', (did,))
            conn.execute('DELETE FROM zaniattia WHERE dytyna_id=?', (did,))
            conn.execute('DELETE FROM dity WHERE id=?', (did,))
            conn.commit()
        except Exception as e:
            conn.rollback()
            return jsonify(ok=False, error='Не вдалося видалити: {}'.format(e)), 500
        A.log('Мудрик: видалено дитину {} ({}) разом із заняттями'.format(row['imia'], row['login']))
        return jsonify(ok=True)

    @app.post('/admin/mudryk/kod')
    def admin_mudryk_kod():
        r = _need_admin()
        if r: return r
        nazva = A.clean(request.form.get('nazva'), 80)
        if not nazva:
            return jsonify(ok=False, error='Напишіть назву пристрою'), 400
        for _ in range(20):
            code = '{:08d}'.format(secrets.randbelow(10 ** 8))
            if not nv().execute('SELECT 1 FROM kody WHERE code_hash=?', (_code_hash(code),)).fetchone():
                break
        exp = (datetime.now() + timedelta(hours=CODE_HOURS)).strftime('%Y-%m-%d %H:%M:%S')
        nv().execute('INSERT INTO kody (code_hash, nazva, created_at, created_by, expires_at) VALUES (?,?,?,?,?)',
                     (_code_hash(code), nazva, A.now(), session.get('login'), exp))
        nv().commit()
        A.log('Мудрик: створено код активації для «{}»'.format(nazva))
        return jsonify(ok=True, kod=code, nazva=nazva, expires=exp, url=UROKY_URL)

    @app.post('/admin/mudryk/kod/<int:kid>/skasuvaty')
    def admin_mudryk_kod_skasuvaty(kid):
        r = _need_admin()
        if r: return r
        # «використаний» без пристрою — так скасований код уже не спрацює
        n = nv().execute('UPDATE kody SET used_at=? WHERE id=? AND used_at IS NULL', (A.now(), kid)).rowcount
        nv().commit()
        if n:
            A.log('Мудрик: скасовано код активації № {}'.format(kid))
        return jsonify(ok=bool(n))

    @app.post('/admin/mudryk/prystrii/<int:pid>/vidklykaty')
    def admin_mudryk_vidklykaty(pid):
        r = _need_admin()
        if r: return r
        row = nv().execute('SELECT * FROM prystroi WHERE id=?', (pid,)).fetchone()
        n = nv().execute('UPDATE prystroi SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
                         (A.now(), pid)).rowcount
        nv().commit()
        if n:
            A.log('Мудрик: відкликано пристрій «{}»'.format(row['nazva']))
        return jsonify(ok=bool(n))

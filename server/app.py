#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ГО «Берегиня» — бекенд групи подовженого дня.

Що вміє:
  POST /api/zayavka   приймає анкету з form.html, пише в SQLite, шле лист адміну
  POST /api/login     вхід в адмінку за паролем
  GET  /admin         список заявок (потрібен вхід)
  GET  /admin/<id>    одна заявка (потрібен вхід)
  GET  /admin/export  вивантаження CSV (потрібен вхід, лише role=admin)

Запуск для розробки:   python3 app.py
Створити користувача:  python3 app.py adduser <логін> <пароль> [admin|teacher]
На сервері працює під gunicorn — див. deploy/beregynia.service
"""

import os, re, csv, json, sqlite3, smtplib, secrets, io
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr

from flask import (Flask, request, session, redirect, url_for,
                   render_template, jsonify, abort, Response, g)
from werkzeug.security import generate_password_hash, check_password_hash

# ============================================================
#  НАЛАШТУВАННЯ (з файла .env або зі змінних середовища)
# ============================================================
BASE = os.path.dirname(os.path.abspath(__file__))

def load_env():
    path = os.path.join(BASE, '.env')
    if not os.path.exists(path):
        return
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())

load_env()

DB_PATH     = os.environ.get('DB_PATH', os.path.join(BASE, 'beregynia.db'))
SECRET_KEY  = os.environ.get('SECRET_KEY', '')
ADMIN_MAIL  = os.environ.get('ADMIN_MAIL', '')        # кому слати нові заявки (можна кілька через кому)
SMTP_HOST   = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
SMTP_PORT   = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER   = os.environ.get('SMTP_USER', '')
SMTP_PASS   = os.environ.get('SMTP_PASS', '')
MAIL_FROM   = os.environ.get('MAIL_FROM', SMTP_USER)
SITE_URL    = os.environ.get('SITE_URL', 'https://children.pp.ua')
PHONE_1     = os.environ.get('PHONE_1', '+380 97 382 33 79')
PHONE_2     = os.environ.get('PHONE_2', '+380 95 484 01 03')
DEV         = os.environ.get('DEV', '') == '1'

if not SECRET_KEY:
    if DEV:
        SECRET_KEY = 'dev-only-not-secret'
    else:
        raise SystemExit('Не задано SECRET_KEY. Створіть .env за зразком .env.example')

app = Flask(__name__)
app.config.update(
    SECRET_KEY=SECRET_KEY,
    SESSION_COOKIE_HTTPONLY=True,          # кука недоступна з JavaScript
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=not DEV,         # лише через HTTPS
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    MAX_CONTENT_LENGTH=256 * 1024,         # анкета не може важити більше 256 КБ
)

# ============================================================
#  БАЗА
# ============================================================
def db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys = ON')
        # Якщо базу саме зараз хтось пише (бекап, ручний sqlite3), не падаємо
        # одразу, а чекаємо до 5 секунд. Інакше батько побачив би помилку
        # надсилання через те, що адміністратор відкрив базу в консолі.
        g.db.execute('PRAGMA busy_timeout = 5000')
    return g.db

@app.teardown_appcontext
def close_db(exc):
    conn = g.pop('db', None)
    if conn is not None:
        conn.close()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(open(os.path.join(BASE, 'schema.sql'), encoding='utf-8').read())
    conn.commit()
    _migrate(conn)
    conn.close()

def _cleanup_orphans(conn):
    """Прибирає рядки дочірніх таблиць, у яких більше немає дитини.

    Каскадне видалення в SQLite працює лише коли для з'єднання ввімкнено
    PRAGMA foreign_keys. Консольний sqlite3 його НЕ вмикає, тому після
    ручного `DELETE FROM children` алергії та контакти лишаються висіти.
    Далі новій дитині може дістатися той самий id — і в її картці
    з'являться чужі медичні нотатки. Тому підчищаємо на кожному старті."""
    total = 0
    for table in ('sensitive', 'nmt', 'pickup_persons', 'schedule', 'attendance'):
        try:
            n = conn.execute(
                'DELETE FROM {} WHERE child_id NOT IN (SELECT id FROM children)'.format(table)
            ).rowcount
            total += max(n, 0)
        except sqlite3.OperationalError:
            pass       # таблиці ще немає
    if total:
        conn.commit()
        app.logger.warning('Прибрано %d осиротілих рядків у дочірніх таблицях', total)


def _migrate(conn):
    """Догоняє наявну базу до поточного набору полів.

    CREATE TABLE IF NOT EXISTS нову колонку в стару таблицю не додасть, тому
    після кожного розширення анкети треба ALTER TABLE. Тут це робиться саме,
    за списками колонок вище — вручну нічого писати не доведеться."""
    # Порожня таблиця → скидаємо лічильник, щоб наступна заявка була № 1.
    # Робимо це ТІЛЬКИ коли рядків немає: тоді номери ні з чим не зіткнуться.
    # Поки в базі є хоч одна заявка, номери не переспользовуються ніколи —
    # інакше лист «заявка № 5» через місяць вказував би на іншу дитину.
    _cleanup_orphans(conn)

    try:
        if conn.execute('SELECT COUNT(*) FROM children').fetchone()[0] == 0:
            n = conn.execute("DELETE FROM sqlite_sequence WHERE name='children'").rowcount
            if n:
                app.logger.warning('База порожня — нумерацію заявок скинуто, наступна буде № 1')
    except sqlite3.OperationalError:
        pass          # sqlite_sequence ще немає — база щойно створена

    for table, cols in (('children', CHILD_COLS + ['program', 'school_year']),
                        ('sensitive', SENS_COLS), ('nmt', NMT_COLS)):
        have = {r[1] for r in conn.execute('PRAGMA table_info({})'.format(table))}
        if not have:                       # таблиці ще немає — її щойно створив скрипт
            continue
        for col in cols:
            if col not in have:
                conn.execute('ALTER TABLE {} ADD COLUMN {} TEXT'.format(table, col))
                app.logger.warning('База: додано колонку %s.%s', table, col)

    # Усі заявки, подані до появи напрямів, — це ГПД.
    # ALTER TABLE ADD COLUMN не проставляє DEFAULT наявним рядкам,
    # тому проставляємо самі, інакше вони випадуть з усіх фільтрів.
    try:
        n = conn.execute(
            "UPDATE children SET program='ГПД' WHERE program IS NULL OR program=''").rowcount
        if n:
            app.logger.warning('База: %d заявкам проставлено напрям «ГПД»', n)
        # індекси на щойно доданих колонках — тільки тут, коли колонки вже є
        conn.execute('CREATE INDEX IF NOT EXISTS idx_children_program ON children(program)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_children_year ON children(school_year)')
        # заявки, подані до появи цієї колонки, — цьогорічні
        n2 = conn.execute("UPDATE children SET school_year=? WHERE school_year IS NULL OR school_year=''",
                          (school_year(),)).rowcount
        if n2:
            app.logger.warning('База: %d заявкам проставлено навчальний рік %s', n2, school_year())
    except sqlite3.OperationalError:
        pass

    conn.commit()

def now():
    return datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M:%S')

def client_ip():
    # за Caddy справжня адреса приходить у X-Forwarded-For
    fwd = request.headers.get('X-Forwarded-For', '')
    return (fwd.split(',')[0].strip() if fwd else request.remote_addr) or '?'

def log(action, child_id=None, who=None):
    db().execute(
        'INSERT INTO audit (ts, who, action, child_id, ip) VALUES (?,?,?,?,?)',
        (now(), who or session.get('login', '—'), action, child_id, client_ip()))
    db().commit()

# ============================================================
#  ПОЛЯ АНКЕТИ — один список, з якого все й будується
# ============================================================
FIELDS = [
    # (ключ у формі, підпис у листі й адмінці, чутливе?)
    ('child_name',     'Прізвище та ім’я дитини',     False),
    ('child_dob',      'Дата народження',              False),
    ('grade',          'Клас',                         False),
    ('school',         'Заклад освіти',                False),
    ('school_addr',    'Адреса закладу',               False),
    ('pickup_school',  'Забирати зі школи',            False),
    ('parent_name',    'ПІБ заявника',                 False),
    ('parent_role',    'Ким доводиться дитині',        False),
    ('parent_dob',     'Дата народження заявника',     False),
    ('parent_phone',   'Телефон',                      False),
    ('parent_email',   'Пошта',                        False),
    ('student_phone',  'Телефон учня',                 False),
    ('student_email',  'Пошта учня',                   False),
    ('contact2_name',  'Другий контакт',               False),
    ('contact2_phone', 'Телефон другого контакту',     False),
    ('address',        'Адреса проживання',            False),
    ('pickup',         'Хто забирає дитину',           False),
    ('self_leave',     'Може йти додому сама',         False),
    ('self_time',      'Не раніше',                    False),
    ('has_allergy',    'Алергії',                      True),
    ('allergy_details','Деталі алергії',               True),
    ('meal_limits',    'Чого не їсть',                 True),
    ('health_notes',   'Що ще варто знати',            True),
    ('do_not_release', 'Кому не віддавати дитину',     True),
    ('expectations',   'Що важливо для батьків',       False),
    ('comment',        'Коментар',                     False),
    # --- довузівська підготовка (НМТ) ---
    ('career_help',    'Профорієнтаційна консультація', False),
    ('career_interest','Які професії цікавлять',       False),
    ('subjects',       'Предмети для підготовки',      False),
    ('needs',          'Чого очікує від навчання',     False),
    ('needs_other',    'Інше (потреби)',               False),
    ('level',          'Самооцінка рівня',             False),
    ('hard_topics',    'Що дається найважче',          False),
    ('format_pref',    'Бажаний формат занять',        False),
    ('time_pref',      'Бажаний час занять',           False),
    ('goal',           'Очікуваний результат',         False),
    ('speciality',     'Бажана спеціальність',         False),
    ('university',     'Заклад вищої освіти',          False),
    ('c_true',         'Згода: достовірність',         False),
    ('c_data',         'Згода: обробка даних',         False),
    ('c_health',       'Згода: дані про здоров’я',     False),
    ('c_medical',      'Згода: екстрена допомога',     False),
    ('c_photo',        'Згода: фото та відео',         False),
]
LABEL = {k: v for k, v, _ in FIELDS}

# ============================================================
#  НАПРЯМИ
#  ГПД — група подовженого дня, 1–8 клас.
#  НМТ — офлайн-підготовка до НМТ, 9–11 клас: інші поля,
#        інший перелік обов'язкових, окремі списки в адмінці.
#  Напрям НЕ приходить із форми, а виводиться з класу на сервері:
#  так його неможливо підмінити й неможливо забути передати.
# ============================================================
PROGRAMS = ('ГПД', 'НМТ')

def school_year(d=None):
    """Навчальний рік у вигляді «2026/27».

    Рахуємо, а не зашиваємо: інакше щовересня хтось мав би правити код,
    і рано чи пізно не виправив би. Новий рік починається в серпні —
    тоді ж відкривається набір.
    """
    d = d or datetime.now()
    y = d.year - (1 if d.month < 8 else 0)
    return '{}/{}'.format(y, str(y + 1)[2:])


def program_for(grade):
    try:
        return 'НМТ' if int(grade) >= 9 else 'ГПД'
    except (TypeError, ValueError):
        return 'ГПД'

# Обов'язкові поля відрізняються: одинадцятикласник іде додому сам,
# вимагати від нього перелік осіб, які його забирають, безглуздо.
# Однаковий для обох напрямів: дані учня, один із батьків і все.
# Решту питаємо, але не тримаємо людину — перевантажена анкета
# просто не заповнюється до кінця.
REQUIRED_BY_PROGRAM = {
    'ГПД': ['child_name', 'child_dob', 'grade', 'school',
            'parent_name', 'parent_role', 'parent_phone'],
    'НМТ': ['child_name', 'child_dob', 'grade', 'school',
            'parent_name', 'parent_role', 'parent_phone'],
}

CHILD_COLS = ['child_name','child_dob','grade','school','school_addr','pickup_school',
              'parent_name','parent_role','parent_dob','parent_phone','parent_email',
              'student_phone','student_email',
              'contact2_name','contact2_phone','address',
              'self_leave','self_time','expectations','comment',
              'c_true','c_data','c_health','c_medical','c_photo']

SENS_COLS  = ['has_allergy','allergy_details','meal_limits','health_notes','do_not_release']

# усе, що стосується лише довузівської підготовки — в окрему таблицю
NMT_COLS   = ['career_help','career_interest','subjects','needs','needs_other','level',
              'hard_topics','format_pref','time_pref','goal','speciality','university']

# застарілий загальний перелік лишається як запобіжник,
# фактично використовується REQUIRED_BY_PROGRAM
REQUIRED   = ['child_name', 'parent_name', 'parent_phone']

def clean(v, limit=2000):
    """Обрізаємо довжину й прибираємо керівні символи. Порожнє → ''."""
    if v is None:
        return ''
    v = str(v).replace('\x00', '').strip()
    return v[:limit]

# ============================================================
#  ПРИЙОМ АНКЕТИ
# ============================================================
@app.post('/api/zayavka')
def zayavka():
    f = request.form

    # --- антиспам ---
    if clean(f.get('website')):                       # honeypot: людина його не бачить
        return jsonify(ok=True, id=0)                 # боту показуємо «успіх» і мовчки викидаємо
    try:
        secs = int(f.get('fill_seconds') or 0)
    except ValueError:
        secs = 0
    if secs < 8:                                      # анкету неможливо заповнити за 8 секунд
        return jsonify(ok=False, error='too_fast'), 400

    # --- мінімальна перевірка ---
    data = {k: clean(f.get(k)) for k, _, _ in FIELDS}
    program = program_for(data.get('grade'))
    for k in REQUIRED_BY_PROGRAM.get(program, REQUIRED):
        if not data[k]:
            return jsonify(ok=False, error='missing:' + k), 400
    if data['parent_email'] and not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$', data['parent_email']):
        data['parent_email'] = ''                     # крива пошта не привід втрачати заявку

    conn = db()
    cur = conn.cursor()

    # Якщо заявок не лишилось (усе видалили), скидаємо лічильник — щоб наступна
    # була № 1, а не продовжувала стару нумерацію. Поки в базі є хоч один рядок,
    # номери не переспользовуються: інакше лист «заявка № 5» через місяць
    # указував би на іншу дитину.
    if cur.execute('SELECT COUNT(*) FROM children').fetchone()[0] == 0:
        cur.execute("DELETE FROM sqlite_sequence WHERE name='children'")

    # --- сира копія: комітимо ОКРЕМО й одразу.
    #     Навіть якщо далі щось піде не так, заявка не зникне безслідно. ---
    cur.execute('INSERT INTO raw_submissions (child_id, created_at, ip, payload) VALUES (?,?,?,?)',
                (None, now(), client_ip(), json.dumps(dict(f), ensure_ascii=False)))
    raw_id = cur.lastrowid
    conn.commit()

    try:
        # Порожня таблиця → скидаємо лічильник, щоб наступна заявка була № 1.
        # Поки в базі є хоч один рядок, номери не переспользовуються ніколи:
        # інакше лист «заявка № 5» через місяць указував би на іншу дитину.
        if cur.execute('SELECT COUNT(*) FROM children').fetchone()[0] == 0:
            _cleanup_orphans(conn)
            cur.execute("DELETE FROM sqlite_sequence WHERE name='children'")

        cols = ['created_at', 'source', 'fill_seconds', 'program', 'school_year'] + CHILD_COLS
        vals = [now(), 'site', secs, program, school_year()] + [data[c] for c in CHILD_COLS]
        cur.execute('INSERT INTO children ({}) VALUES ({})'.format(
            ','.join(cols), ','.join('?' * len(cols))), vals)
        child_id = cur.lastrowid

        # чутливе — в окрему таблицю
        cur.execute('INSERT INTO sensitive (child_id, {}) VALUES (?,{})'.format(
            ','.join(SENS_COLS), ','.join('?' * len(SENS_COLS))),
            [child_id] + [data[c] for c in SENS_COLS])

        # довузівська підготовка — теж окремо, і тільки для свого напряму
        if program == 'НМТ':
            cur.execute('INSERT INTO nmt (child_id, {}) VALUES (?,{})'.format(
                ','.join(NMT_COLS), ','.join('?' * len(NMT_COLS))),
                [child_id] + [data[c] for c in NMT_COLS])

        # хто забирає: рядок «Ім’я · телефон · ким доводиться | ...»
        for i, part in enumerate(p for p in data['pickup'].split('|') if p.strip()):
            bits = [b.strip() for b in part.split('·')]
            bits += [''] * (3 - len(bits))
            cur.execute('INSERT INTO pickup_persons (child_id, ord, name, phone, relation) '
                        'VALUES (?,?,?,?,?)', (child_id, i + 1, bits[0], bits[1], bits[2]))

        cur.execute('UPDATE raw_submissions SET child_id=? WHERE id=?', (child_id, raw_id))
        conn.commit()

    except Exception as e:
        # Відкат обов'язковий: інакше незавершена транзакція тримає базу
        # заблокованою, і наступні батьки взагалі не зможуть подати заявку.
        conn.rollback()
        app.logger.error('Заявку не збережено (сира копія № %s уціліла): %s', raw_id, e)
        return jsonify(ok=False, error='save_failed'), 500

    log('нова заявка', child_id, who='форма')

    # жоден лист не має права зламати прийом заявки — вона вже в базі
    try:
        send_admin_mail(child_id, data)
    except Exception as e:
        app.logger.error('Лист адміністратору не надіслано: %s', e)

    if data.get('parent_email'):
        try:
            send_parent_mail(child_id, data)
        except Exception as e:
            app.logger.error('Лист батькам не надіслано: %s', e)

    return jsonify(ok=True, id=child_id)

# ============================================================
#  ЛИСТ АДМІНІСТРАТОРУ
# ============================================================
def send_admin_mail(child_id, data):
    if not (SMTP_USER and SMTP_PASS and ADMIN_MAIL):
        app.logger.warning('Пошта не налаштована — лист пропущено')
        return

    rows = []
    for key, label, _sens in FIELDS:
        val = data.get(key, '')
        if not val:
            continue      # порожні поля іншого напряму просто не показуємо
        rows.append(
            '<tr><td style="padding:7px 12px;border-bottom:1px solid #E4E7EC;'
            'color:#475467;font-size:14px;white-space:nowrap;vertical-align:top">{}</td>'
            '<td style="padding:7px 12px;border-bottom:1px solid #E4E7EC;'
            'color:#101828;font-size:15px">{}</td></tr>'.format(
                esc(label), esc(val).replace('\n', '<br>')))

    html = """<!doctype html><html><body style="margin:0;background:#F5F6F7;
padding:24px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;
border:1px solid #E4E7EC">
  <div style="background:#2F6F4E;color:#fff;padding:20px 24px">
    <div style="font-size:13px;opacity:.85;letter-spacing:.04em;text-transform:uppercase">Нова заявка № {id}</div>
    <div style="font-size:21px;font-weight:700;margin-top:4px">{name}</div>
  </div>
  <table style="width:100%;border-collapse:collapse">{rows}</table>
  <div style="padding:18px 24px;background:#FAFAF7;border-top:1px solid #E4E7EC">
    <a href="{url}/admin/{id}" style="display:inline-block;background:#2F6F4E;color:#fff;
       text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:15px">
       Відкрити в адмінці</a>
  </div>
</div>
<div style="max-width:640px;margin:14px auto 0;color:#98A2B3;font-size:12px;text-align:center">
  Лист містить персональні дані дитини. Не пересилайте його далі.
</div>
</body></html>""".format(id=child_id, name=esc(data['child_name']),
                         rows=''.join(rows), url=SITE_URL)

    msg = MIMEText(html, 'html', 'utf-8')
    msg['Subject'] = Header('Нова заявка № {} — {}'.format(child_id, data['child_name']), 'utf-8')
    msg['From']    = formataddr((str(Header('ГПД «Берегиня»', 'utf-8')), MAIL_FROM))
    msg['To']      = ADMIN_MAIL

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(MAIL_FROM, [a.strip() for a in ADMIN_MAIL.split(',')], msg.as_string())

# ============================================================
#  ЛИСТ-ПІДТВЕРДЖЕННЯ БАТЬКАМ
#  Надсилається, лише якщо батько лишив пошту — вона необов'язкова.
#  Навмисно без чутливих полів: у листі немає ні алергій, ні
#  «кому не віддавати». Пошта — не найбезпечніше місце.
# ============================================================
def send_parent_mail(child_id, data):
    if not (SMTP_USER and SMTP_PASS):
        return

    who = data.get('parent_name', '').split()
    greeting = who[1] if len(who) > 1 else (who[0] if who else '')

    school = data.get('school', '')
    grade  = data.get('grade', '')
    line_school = '{}{}'.format(school, ', {} клас'.format(grade) if grade else '') if school else ''

    html = """<!doctype html><html><body style="margin:0;background:#F5F6F7;
padding:24px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;
overflow:hidden;border:1px solid #E4E7EC">

  <div style="background:#2F6F4E;color:#fff;padding:22px 26px">
    <div style="font-size:13px;opacity:.85">ГО «Берегиня» · Освітній простір Покров</div>
    <div style="font-size:20px;font-weight:700;margin-top:6px">Заявку прийнято</div>
  </div>

  <div style="padding:24px 26px;color:#101828;font-size:16px;line-height:1.55">
    <p style="margin:0 0 16px">Доброго дня{greet}!</p>

    <p style="margin:0 0 16px">Ми отримали заявку на <b>{child}</b>.
    Номер заявки — <b>№&nbsp;{id}</b>.{school}</p>

    <p style="margin:0 0 8px"><b>Що далі</b></p>
    <p style="margin:0 0 16px">Ми зателефонуємо протягом двох робочих днів, щоб
    узгодити дні та години відвідування й відповісти на ваші запитання.</p>

    <p style="margin:0 0 16px">При першій зустрічі попросимо заповнити паперову
    картку дитини — там детальніше про здоров'я та перелік осіб, які можуть її
    забирати. Це займе близько п'яти хвилин.</p>

    <p style="margin:0 0 6px"><b>Якщо треба щось змінити</b></p>
    <p style="margin:0 0 20px">Просто зателефонуйте:<br>
      <a href="{h1}" style="color:#2F6F4E;font-weight:600;text-decoration:none">{p1}</a><br>
      <a href="{h2}" style="color:#2F6F4E;font-weight:600;text-decoration:none">{p2}</a>
    </p>

    <p style="margin:0;color:#667085;font-size:14px">
      Дані дитини ми обробляємо відповідно до
      <a href="{url}/dani.html" style="color:#475467">повідомлення про обробку
      персональних даних</a>.
    </p>
  </div>
</div>

<div style="max-width:560px;margin:14px auto 0;color:#98A2B3;font-size:12px;text-align:center">
  Цей лист надіслано автоматично, відповідати на нього не потрібно.
</div>
</body></html>""".format(
        greet=(', ' + esc(greeting)) if greeting else '',
        child=esc(data.get('child_name', '')),
        id=child_id,
        school=(' Заклад: ' + esc(line_school) + '.') if line_school else '',
        p1=PHONE_1, h1='tel:' + PHONE_1.replace(' ', ''),
        p2=PHONE_2, h2='tel:' + PHONE_2.replace(' ', ''),
        url=SITE_URL)

    msg = MIMEText(html, 'html', 'utf-8')
    msg['Subject'] = Header('Заявку до групи подовженого дня прийнято, № {}'.format(child_id), 'utf-8')
    msg['From']    = formataddr((str(Header('ГО «Берегиня»', 'utf-8')), MAIL_FROM))
    msg['To']      = data['parent_email']

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(MAIL_FROM, [data['parent_email']], msg.as_string())
    app.logger.info('Лист батькам надіслано: заявка %s', child_id)


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
                  .replace('>', '&gt;').replace('"', '&quot;'))

# ============================================================
#  ВХІД
# ============================================================
def attempts_recently(ip):
    since = (datetime.now(timezone.utc).astimezone() - timedelta(minutes=15)).strftime('%Y-%m-%d %H:%M:%S')
    row = db().execute('SELECT COUNT(*) c FROM login_attempts WHERE ip=? AND ts>? AND ok=0',
                       (ip, since)).fetchone()
    return row['c']

@app.post('/api/login')
def login():
    ip = client_ip()
    if attempts_recently(ip) >= 7:
        return jsonify(ok=False, error='Забагато спроб. Спробуйте за 15 хвилин.'), 429

    login_ = clean(request.form.get('login'), 60)
    passwd = request.form.get('password') or ''
    row = db().execute('SELECT * FROM admins WHERE login=?', (login_,)).fetchone()
    ok = bool(row) and check_password_hash(row['pass_hash'], passwd)

    db().execute('INSERT INTO login_attempts (ip, ts, ok) VALUES (?,?,?)', (ip, now(), 1 if ok else 0))
    db().commit()

    if not ok:
        return jsonify(ok=False, error='Невірний логін або пароль'), 401

    session.clear()
    session.permanent = True
    session['login'] = row['login']
    session['role']  = row['role']
    session['name']  = row['full_name'] or row['login']
    db().execute('UPDATE admins SET last_login=? WHERE id=?', (now(), row['id']))
    db().commit()
    log('вхід')
    return jsonify(ok=True, redirect='/admin')

@app.get('/api/logout')
@app.post('/api/logout')
def logout():
    if session.get('login'):
        log('вихід')
    session.clear()
    return redirect('/enter.html')

def require_login():
    if not session.get('login'):
        return redirect('/enter.html')
    return None

# ============================================================
#  АДМІНКА
# ============================================================
@app.get('/admin')
def admin_list():
    r = require_login()
    if r: return r

    q      = clean(request.args.get('q'), 60)
    status = clean(request.args.get('status'), 30)
    grade  = clean(request.args.get('grade'), 4)
    prog   = clean(request.args.get('program'), 8)
    year   = clean(request.args.get('year'), 9)

    sql, args = ('SELECT c.*, s.has_allergy FROM children c '
                 'LEFT JOIN sensitive s ON s.child_id=c.id WHERE 1=1'), []
    if prog in PROGRAMS:
        sql += ' AND c.program=?'
        args.append(prog)
    if year:
        sql += ' AND c.school_year=?'
        args.append(year)
    if q:
        sql += ' AND (c.child_name LIKE ? OR c.parent_name LIKE ? OR c.parent_phone LIKE ?)'
        args += ['%' + q + '%'] * 3
    if status:
        sql += ' AND c.status=?'
        args.append(status)
    if grade:
        sql += ' AND c.grade=?'
        args.append(grade)
    # за прізвищем, а не за номером: список для друку має бути за абеткою
    sql += ' ORDER BY c.child_name COLLATE NOCASE'

    rows = db().execute(sql, args).fetchall()
    counts = {r['status']: r['n'] for r in
              db().execute('SELECT status, COUNT(*) n FROM children GROUP BY status')}
    # класи показуємо лише ті, що є в межах обраного напряму —
    # інакше у фільтрі ГПД висіли б 9–11, яких там ніколи не буде
    gsql = 'SELECT DISTINCT grade FROM children WHERE grade<>""'
    gargs = []
    if prog in PROGRAMS:
        gsql += ' AND program=?'
        gargs.append(prog)
    grades = [r['grade'] for r in db().execute(
        gsql + ' ORDER BY CAST(grade AS INTEGER)', gargs)]

    progs = {r['program']: r['n'] for r in db().execute(
        'SELECT program, COUNT(*) n FROM children GROUP BY program')}

    # Перемикач років показуємо лише коли років справді кілька —
    # у перший рік роботи він був би зайвим елементом на екрані.
    years = [r['school_year'] for r in db().execute(
        'SELECT DISTINCT school_year FROM children '
        'WHERE school_year IS NOT NULL AND school_year<>"" ORDER BY school_year DESC')]

    log('перегляд списку')
    return render_template('admin.html', rows=rows, q=q, status=status, grade=grade,
                           program=prog, programs=PROGRAMS, prog_counts=progs,
                           year=year, years=years, this_year=school_year(),
                           grades=grades, counts=counts, total=sum(counts.values()),
                           monday=_monday(), role=session.get('role'), who=session.get('name'))


def _monday(d=None):
    """Найближчий понеділок, від якого зручно починати тижневий список."""
    d = d or datetime.now().date()
    return (d - timedelta(days=d.weekday())).isoformat()


# ============================================================
#  СПИСОК НА ДРУК
#  Тільки те, що потрібно педагогу на аркуші: діти, контакти
#  і п'ять порожніх колонок під дати. Жодних статусів,
#  номерів заявок та іншої службової інформації.
# ============================================================
MONTHS = ['січня','лютого','березня','квітня','травня','червня',
          'липня','серпня','вересня','жовтня','листопада','грудня']

@app.get('/admin/spysok')
def admin_spysok():
    r = require_login()
    if r: return r

    raw = clean(request.args.get('ids'), 4000)
    ids = [int(x) for x in raw.split(',') if x.strip().isdigit()][:200]
    if not ids:
        return redirect('/admin')

    ph = ','.join('?' * len(ids))
    rows = [dict(x) for x in db().execute(
        'SELECT id, child_name, grade, school, program, parent_name, parent_phone, '
        'contact2_name, contact2_phone FROM children WHERE id IN ({}) '
        'ORDER BY CAST(grade AS INTEGER), child_name COLLATE NOCASE'.format(ph), ids)]

    pickups = {}
    for p in db().execute(
            'SELECT child_id, name, phone, relation FROM pickup_persons '
            'WHERE child_id IN ({}) ORDER BY child_id, ord'.format(ph), ids):
        pickups.setdefault(p['child_id'], []).append(dict(p))
    for row in rows:
        row['pickup'] = pickups.get(row['id'], [])

    # п'ять робочих днів від обраної дати; вихідні пропускаємо —
    # група працює лише з понеділка до п'ятниці
    try:
        start = datetime.strptime(clean(request.args.get('from'), 10), '%Y-%m-%d').date()
    except ValueError:
        start = datetime.strptime(_monday(), '%Y-%m-%d').date()

    days, d = [], start
    while len(days) < 5:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)

    # у заголовку — перелік класів, які потрапили до списку:
    # «3 клас», «3 і 4 клас» або «2, 3, 7 клас»
    gset = sorted({row['grade'] for row in rows if row['grade']},
                  key=lambda x: int(x) if x.isdigit() else 99)
    if not gset:
        grades_label = ''
    elif len(gset) == 1:
        grades_label = '{} клас'.format(gset[0])
    elif len(gset) == 2:
        grades_label = '{} і {} клас'.format(*gset)
    else:
        grades_label = '{} клас'.format(', '.join(gset))

    # якщо всі в списку одного напряму — пишемо його в заголовку аркуша
    pset = {row['program'] for row in rows if row.get('program')}
    program_label = list(pset)[0] if len(pset) == 1 else ''

    short = request.args.get('mode') == 'short'
    other = '/admin/spysok?ids={}&from={}'.format(raw, request.args.get('from', ''))
    if not short:
        other = other.replace('?', '?mode=short&', 1)

    today = datetime.now().date()
    log('список на друк ({}): {} дітей'.format('короткий' if short else 'повний', len(rows)))
    return render_template(
        'spysok.html',
        rows=rows,
        short=short,
        other_url=other,
        days=['{:02d}.{:02d}'.format(x.day, x.month) for x in days],
        period='{} – {} {}'.format(days[0].day, days[-1].day, MONTHS[days[-1].month - 1]),
        grades_label=grades_label,
        program_label=program_label,
        today='{} {} {}'.format(today.day, MONTHS[today.month - 1], today.year),
        role=session.get('role'), who=session.get('name'))

@app.get('/admin/<int:cid>')
def admin_child(cid):
    r = require_login()
    if r: return r

    child = db().execute('SELECT * FROM children WHERE id=?', (cid,)).fetchone()
    if not child:
        abort(404)
    sens   = db().execute('SELECT * FROM sensitive WHERE child_id=?', (cid,)).fetchone()
    pickup = db().execute('SELECT * FROM pickup_persons WHERE child_id=? ORDER BY ord', (cid,)).fetchall()
    nmt    = db().execute('SELECT * FROM nmt WHERE child_id=?', (cid,)).fetchone()

    log('перегляд заявки', cid)
    return render_template('child.html', c=child, s=sens, pickup=pickup, nmt=nmt,
                           label=LABEL, role=session.get('role'), who=session.get('name'))

@app.post('/admin/<int:cid>/status')
def admin_status(cid):
    r = require_login()
    if r: return r
    st = clean(request.form.get('status'), 30)
    if st in ('нова', 'підтверджена', 'зарахована', 'відмова', 'архів'):
        db().execute('UPDATE children SET status=? WHERE id=?', (st, cid))
        db().commit()
        log('статус → ' + st, cid)
    return redirect('/admin/{}'.format(cid))

@app.post('/admin/<int:cid>/note')
def admin_note(cid):
    r = require_login()
    if r: return r
    db().execute('UPDATE children SET note_admin=? WHERE id=?',
                 (clean(request.form.get('note_admin')), cid))
    db().commit()
    log('коментар', cid)
    return redirect('/admin/{}'.format(cid))

@app.get('/admin/export.csv')
def admin_export():
    r = require_login()
    if r: return r
    if session.get('role') != 'admin':
        abort(403)

    rows = db().execute(
        'SELECT c.*, s.has_allergy, s.allergy_details, s.meal_limits, s.health_notes, s.do_not_release '
        'FROM children c LEFT JOIN sensitive s ON s.child_id=c.id ORDER BY c.id').fetchall()

    buf = io.StringIO()
    buf.write('﻿')                       # BOM, щоб Excel побачив кирилицю
    if rows:
        w = csv.DictWriter(buf, fieldnames=rows[0].keys(), delimiter=';')
        w.writeheader()
        for row in rows:
            w.writerow(dict(row))
    log('вивантаження CSV')
    return Response(buf.getvalue(), mimetype='text/csv; charset=utf-8',
                    headers={'Content-Disposition':
                             'attachment; filename="gpd-{}.csv"'.format(datetime.now().strftime('%Y-%m-%d'))})

@app.get('/api/whoami')
def whoami():
    return jsonify(login=session.get('login'), role=session.get('role'))

# ============================================================
#  КОМАНДНИЙ РЯДОК
# ============================================================
def cli():
    import sys
    args = sys.argv[1:]
    init_db()

    if not args:
        print('База готова:', DB_PATH)
        print('Запуск для розробки:  DEV=1 python3 app.py run')
        print('Створити користувача: python3 app.py adduser <логін> <пароль> [admin|teacher]')
        return

    if args[0] == 'adduser':
        if len(args) < 3:
            print('python3 app.py adduser <логін> <пароль> [admin|teacher] ["Повне ім’я"]'); return
        login_, passwd = args[1], args[2]
        role = args[3] if len(args) > 3 else 'admin'
        name = args[4] if len(args) > 4 else login_
        if len(passwd) < 10:
            print('Пароль закороткий — щонайменше 10 символів.'); return
        conn = sqlite3.connect(DB_PATH)
        try:
            conn.execute('INSERT INTO admins (login, pass_hash, role, full_name, created_at) VALUES (?,?,?,?,?)',
                         (login_, generate_password_hash(passwd), role, name,
                          datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
            conn.commit()
            print('Створено:', login_, '/', role)
        except sqlite3.IntegrityError:
            print('Такий логін уже є.')
        conn.close()

    elif args[0] == 'passwd':
        if len(args) < 3:
            print('python3 app.py passwd <логін> <новий пароль>'); return
        conn = sqlite3.connect(DB_PATH)
        n = conn.execute('UPDATE admins SET pass_hash=? WHERE login=?',
                         (generate_password_hash(args[2]), args[1])).rowcount
        conn.commit(); conn.close()
        print('Оновлено' if n else 'Немає такого логіна')

    elif args[0] == 'run':
        app.run(host='127.0.0.1', port=int(os.environ.get('PORT', '8000')), debug=DEV)

    else:
        print('Невідома команда:', args[0])

if __name__ == '__main__':
    cli()
else:
    init_db()      # під gunicorn база теж має існувати

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
    conn.close()

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
    ('parent_phone',   'Телефон',                      False),
    ('parent_email',   'Пошта',                        False),
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
    ('c_true',         'Згода: достовірність',         False),
    ('c_data',         'Згода: обробка даних',         False),
    ('c_health',       'Згода: дані про здоров’я',     False),
    ('c_medical',      'Згода: екстрена допомога',     False),
    ('c_messenger',    'Згода: месенджер',             False),
]
LABEL = {k: v for k, v, _ in FIELDS}

CHILD_COLS = ['child_name','child_dob','grade','school','school_addr','pickup_school',
              'parent_name','parent_role','parent_phone','parent_email',
              'contact2_name','contact2_phone','address',
              'self_leave','self_time','expectations','comment',
              'c_true','c_data','c_health','c_medical','c_messenger']

SENS_COLS  = ['has_allergy','allergy_details','meal_limits','health_notes','do_not_release']

REQUIRED   = ['child_name','parent_name','parent_phone','contact2_name','contact2_phone']

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
    for k in REQUIRED:
        if not data[k]:
            return jsonify(ok=False, error='missing:' + k), 400
    if data['parent_email'] and not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$', data['parent_email']):
        data['parent_email'] = ''                     # крива пошта не привід втрачати заявку

    conn = db()
    cur = conn.cursor()

    # --- сира копія: страховка на випадок зміни набору полів ---
    cur.execute('INSERT INTO raw_submissions (child_id, created_at, ip, payload) VALUES (?,?,?,?)',
                (None, now(), client_ip(), json.dumps(dict(f), ensure_ascii=False)))
    raw_id = cur.lastrowid

    # --- основний запис ---
    cols = ['created_at', 'source', 'fill_seconds'] + CHILD_COLS
    vals = [now(), 'site', secs] + [data[c] for c in CHILD_COLS]
    cur.execute('INSERT INTO children ({}) VALUES ({})'.format(
        ','.join(cols), ','.join('?' * len(cols))), vals)
    child_id = cur.lastrowid

    # --- чутливе — в окрему таблицю ---
    cur.execute('INSERT INTO sensitive (child_id, {}) VALUES (?,{})'.format(
        ','.join(SENS_COLS), ','.join('?' * len(SENS_COLS))),
        [child_id] + [data[c] for c in SENS_COLS])

    # --- хто забирає: рядок «Ім’я · телефон · ким доводиться | ...» ---
    for i, part in enumerate(p for p in data['pickup'].split('|') if p.strip()):
        bits = [b.strip() for b in part.split('·')]
        bits += [''] * (3 - len(bits))
        cur.execute('INSERT INTO pickup_persons (child_id, ord, name, phone, relation) VALUES (?,?,?,?,?)',
                    (child_id, i + 1, bits[0], bits[1], bits[2]))

    cur.execute('UPDATE raw_submissions SET child_id=? WHERE id=?', (child_id, raw_id))
    conn.commit()
    log('нова заявка', child_id, who='форма')

    # лист не має права зламати прийом заявки
    try:
        send_admin_mail(child_id, data)
    except Exception as e:
        app.logger.error('Лист не надіслано: %s', e)

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
            continue
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

    sql, args = 'SELECT c.*, s.has_allergy FROM children c LEFT JOIN sensitive s ON s.child_id=c.id WHERE 1=1', []
    if q:
        sql += ' AND (c.child_name LIKE ? OR c.parent_name LIKE ? OR c.parent_phone LIKE ?)'
        args += ['%' + q + '%'] * 3
    if status:
        sql += ' AND c.status=?'
        args.append(status)
    sql += ' ORDER BY c.id DESC'

    rows = db().execute(sql, args).fetchall()
    counts = {r['status']: r['n'] for r in
              db().execute('SELECT status, COUNT(*) n FROM children GROUP BY status')}
    log('перегляд списку')
    return render_template('admin.html', rows=rows, q=q, status=status,
                           counts=counts, total=sum(counts.values()),
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

    log('перегляд заявки', cid)
    return render_template('child.html', c=child, s=sens, pickup=pickup,
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

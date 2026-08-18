#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Діагностика пошти. Запуск на сервері:

    cd /opt/beregynia
    sudo -u beregynia venv/bin/python mailtest.py

Нічого не змінює — тільки перевіряє й друкує, де саме ламається.
"""
import os, sys, socket, smtplib, ssl
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr

BASE = os.path.dirname(os.path.abspath(__file__))

def load_env():
    p = os.path.join(BASE, '.env')
    if not os.path.exists(p):
        print('  ✗ Файла .env немає:', p); sys.exit(1)
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

load_env()
HOST = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
PORT = int(os.environ.get('SMTP_PORT', '587'))
USER = os.environ.get('SMTP_USER', '')
PASS = os.environ.get('SMTP_PASS', '')
FROM = os.environ.get('MAIL_FROM', USER)
ADMIN = os.environ.get('ADMIN_MAIL', '')

def mask(s):
    if not s: return '(порожньо)'
    return s[:2] + '·' * max(0, len(s) - 4) + s[-2:]

print('\n=== 1. Що записано в .env ===')
print('  SMTP_HOST  :', HOST or '(порожньо)')
print('  SMTP_PORT  :', PORT)
print('  SMTP_USER  :', USER or '(порожньо)')
print('  SMTP_PASS  :', mask(PASS), '— довжина', len(PASS))
print('  MAIL_FROM  :', FROM or '(порожньо)')
print('  ADMIN_MAIL :', ADMIN or '(порожньо)')

problems = []
if not USER:  problems.append('не заданий SMTP_USER')
if not PASS:  problems.append('не заданий SMTP_PASS')
if not ADMIN: problems.append('не заданий ADMIN_MAIL')
if PASS and ' ' in PASS:
    problems.append('у SMTP_PASS є ПРОБІЛИ — Google показує пароль групами по 4, '
                    'але вписувати треба суцільним рядком')
if PASS and 'gmail' in HOST and len(PASS.replace(' ', '')) != 16:
    problems.append('пароль додатка Google має рівно 16 символів, у вас {} — '
                    'схоже, це звичайний пароль від акаунта, він для SMTP не працює'
                    .format(len(PASS.replace(' ', ''))))
if problems:
    print('\n  ⚠ Одразу видно:')
    for p in problems: print('    •', p)

print('\n=== 2. Чи взагалі відкриті поштові порти назовні ===')
print('  (Hetzner на нових акаунтах блокує вихідні 25 і 465, інколи й 587)')
for port in (587, 465, 25):
    s = socket.socket(); s.settimeout(8)
    try:
        s.connect((HOST, port))
        banner = s.recv(200).decode('utf-8', 'replace').strip()[:60]
        print('  ✓ {}:{:<4} відкритий  — {}'.format(HOST, port, banner))
    except socket.timeout:
        print('  ✗ {}:{:<4} ТАЙМАУТ — порт заблоковано провайдером'.format(HOST, port))
    except Exception as e:
        print('  ✗ {}:{:<4} {}'.format(HOST, port, e))
    finally:
        s.close()

print('\n  (для порівняння — звичайний HTTPS)')
s = socket.socket(); s.settimeout(8)
try:
    s.connect(('smtp.gmail.com', 443) if False else ('api.brevo.com', 443))
    print('  ✓ 443 відкритий — інтернет із сервера є')
except Exception as e:
    print('  ✗ 443 теж не працює — проблема не в пошті, а в мережі:', e)
finally:
    s.close()

if not (USER and PASS):
    print('\n=== Далі не йдемо: не заповнені SMTP_USER / SMTP_PASS ===\n')
    sys.exit(0)

print('\n=== 3. Пробуємо увійти й надіслати ===')
try:
    with smtplib.SMTP(HOST, PORT, timeout=20) as srv:
        srv.ehlo()
        if PORT == 587:
            srv.starttls(context=ssl.create_default_context())
            srv.ehlo()
        print('  ✓ з’єднання встановлено')
        srv.login(USER, PASS.replace(' ', ''))
        print('  ✓ вхід прийнято')

        msg = MIMEText('Якщо ви це читаєте — пошта з сервера працює.', 'plain', 'utf-8')
        msg['Subject'] = Header('Перевірка пошти ГПД «Берегиня»', 'utf-8')
        msg['From'] = formataddr((str(Header('ГПД «Берегиня»', 'utf-8')), FROM))
        msg['To'] = ADMIN
        srv.sendmail(FROM, [a.strip() for a in ADMIN.split(',')], msg.as_string())
        print('  ✓ лист надіслано на', ADMIN)
        print('\n  Перевірте пошту, зокрема теку «Спам».\n')

except smtplib.SMTPAuthenticationError as e:
    print('  ✗ ВІДМОВА В АВТЕНТИФІКАЦІЇ:', e.smtp_code, e.smtp_error.decode('utf-8', 'replace')[:200])
    print('\n  Найчастіші причини:')
    print('   • у SMTP_PASS звичайний пароль, а треба «пароль додатка» (16 символів)')
    print('   • двоетапна перевірка не ввімкнена — без неї паролі додатків не існують')
    print('   • пароль скопійований із пробілами\n')
except (socket.timeout, TimeoutError):
    print('  ✗ ТАЙМАУТ. Порт {} заблоковано — це вихідна фільтрація провайдера,'.format(PORT))
    print('    а не помилка налаштувань. Дивіться розділ 2 вище.\n')
except Exception as e:
    print('  ✗ {}: {}\n'.format(type(e).__name__, e))

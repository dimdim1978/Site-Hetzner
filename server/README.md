# Бекенд ГПД «Берегиня» — розгортання

SQLite + Flask + Caddy на сервері Hetzner ARM. Усе, що тут є, — це один
процес Python і один файл бази. Ніякого Docker, ніякої окремої СУБД.

---

## 0. Що з чим працює

```
браузер батька
      │  POST /api/zayavka
      ▼
   Caddy :443  ──── статика (index, form, style, enter) з /var/www/beregynia
      │
      │ /api/*, /admin*  →  proxy 127.0.0.1:8000
      ▼
   gunicorn → app.py (Flask)
      │
      ├── SQLite: /var/lib/beregynia/beregynia.db
      └── SMTP → лист адміністратору
```

Форма й адмінка живуть на одному домені, тому CORS не потрібен зовсім.

---

## 1. Сервер

Увімкнути CAX11 (або створити наново з Ubuntu 24.04 LTS, ARM64).

```bash
apt update && apt -y upgrade
apt -y install python3-venv python3-pip git caddy ufw sqlite3

ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

adduser --system --group --home /opt/beregynia beregynia
mkdir -p /var/lib/beregynia /var/www/beregynia
chown beregynia:beregynia /var/lib/beregynia
```

## 2. Код

```bash
cd /opt
git clone https://github.com/dimdim1978/Site-Hetzner-77.42.40.229 site
cp -r /opt/site/server/* /opt/beregynia/

# статика — окремо, її роздає Caddy
cp /opt/site/*.html /opt/site/*.css /var/www/beregynia/

cd /opt/beregynia
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

## 3. Налаштування

```bash
cp .env.example .env
python3 -c "import secrets; print(secrets.token_hex(32))"   # → SECRET_KEY
nano .env
chmod 600 .env
chown beregynia:beregynia .env
```

**Пошта.** Для Gmail потрібен «пароль додатка», а не звичайний пароль:
акаунт Google → Безпека → увімкнути двоетапну перевірку → Паролі додатків.
Отриманий 16-символьний рядок іде в `SMTP_PASS`.

Це найпростіший робочий варіант. Надсилати листи напряму з VPS не варто:
у нового сервера немає репутації, і листи майже гарантовано підуть у спам.

## 4. База й перший користувач

```bash
cd /opt/beregynia
sudo -u beregynia venv/bin/python app.py                        # створює базу
sudo -u beregynia venv/bin/python app.py adduser dim '<пароль>' admin 'Дмитро'
sudo -u beregynia venv/bin/python app.py adduser olena '<пароль>' teacher 'Олена'
```

Пароль — щонайменше 10 символів, зберігається у вигляді scrypt-хешу.
Змінити пізніше: `app.py passwd <логін> <новий пароль>`.

**Ролі.** `admin` бачить усе й вивантажує CSV. `teacher` бачить список і картки,
але **не бачить** поле «кому не віддавати дитину» і не має доступу до CSV.
Алергії педагог бачить — без них він не зможе працювати.

## 5. Служба

```bash
cp deploy/beregynia.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now beregynia
systemctl status beregynia
```

## 6. Caddy і домен

Спершу DNS: `children.pp.ua` → IP сервера (запис A). Дочекатись поширення.

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -f          # видно, як береться сертифікат
```

Caddy сам отримає сертифікат Let's Encrypt і оновлюватиме його далі.

## 7. Перевірка

```bash
curl -sI https://children.pp.ua/form.html | head -3
curl -s https://children.pp.ua/api/whoami
```

Далі — пройти анкету з телефона по-справжньому, від відкриття до листа.
Вхід в адмінку: `https://children.pp.ua/enter.html`

---

## Оновлення сайту

```bash
cd /opt/site && git pull
cp /opt/site/*.html /opt/site/*.css /var/www/beregynia/
# якщо змінювався бекенд:
cp -r /opt/site/server/* /opt/beregynia/ && systemctl restart beregynia
```

Зручно загорнути в `/opt/deploy.sh`.

---

## Резервні копії

База — це один файл. Раз на добу:

```bash
cat > /etc/cron.daily/beregynia-backup <<'EOS'
#!/bin/sh
D=/var/backups/beregynia; mkdir -p $D
sqlite3 /var/lib/beregynia/beregynia.db ".backup '$D/db-$(date +%F).db'"
find $D -name 'db-*.db' -mtime +30 -delete
EOS
chmod +x /etc/cron.daily/beregynia-backup
```

`.backup` — правильний спосіб копіювати SQLite: він не ловить базу
посеред запису, на відміну від звичайного `cp`.

Раз на місяць копію варто забирати з сервера — інакше це не резервна копія,
а просто друга копія на тому самому диску.

---

## Що робити, коли щось не так

| Симптом | Куди дивитись |
|---|---|
| Форма каже «не вдалося надіслати» | `journalctl -u beregynia -n 50` |
| Не приходять листи | там само; шукати «Лист не надіслано» |
| Не пускає в адмінку | 7 невдалих спроб з однієї адреси = блок на 15 хв |
| Сертифікат не береться | `journalctl -u caddy -n 50`; перевірити A-запис |
| Заявка загубилась | таблиця `raw_submissions` — там усе, як прийшло |

---

## Структура бази

`children` — анкети · `pickup_persons` — хто забирає · `sensitive` — алергії,
харчування, «кому не віддавати» · `raw_submissions` — сирі заявки на випадок
помилки розбору · `admins`, `login_attempts`, `audit` — доступ і журнал.

Порожніми створено `schedule` (день тижня → час виходу) і `attendance`
(події дня: зі школи / у групі / додому / забрали) — під наступні дві задачі:
окрему форму графіка й телеграм-бота. Структура вже готова, міняти не доведеться.

`audit` пише, хто коли дивився дані дитини. Це не перестраховка: володілець
персональних даних має вміти показати, хто мав до них доступ.

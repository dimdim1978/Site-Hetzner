# Розгортання бекенду ГПД «Берегиня»

Ubuntu 24.04 LTS, x86 (CX22 або будь-який інший — 2 ядра / 4 ГБ вистачає з великим запасом).
Стек: Caddy → gunicorn → Flask → SQLite. Ніякого Docker.

Кроки виконуються один за одним. Кожен закінчується перевіркою — якщо вона не пройшла,
далі не йдіть.

---

## Крок 0. Створити сервер у панелі Hetzner

- **Location** — Nuremberg або Falkenstein (ближче до України, ніж Гельсінкі).
- **Image** — Ubuntu 24.04.
- **Type** — Shared vCPU, будь-який із 2 ядрами й 4 ГБ.
- **SSH key** — обов'язково додайте свій ключ. Якщо ключа немає, на своєму комп'ютері:
  ```
  ssh-keygen -t ed25519
  ```
  і вставте вміст `~/.ssh/id_ed25519.pub` (у Windows — `C:\Users\Dim\.ssh\id_ed25519.pub`).
  Пароль замість ключа — погана ідея: бота почнуть підбирати його за годину після старту.
- **Firewall** — можна не створювати, нижче налаштуємо `ufw` на самому сервері.
- **Backups** — за бажанням, +20 % до ціни. У нас є свій бекап бази, тож не обов'язково.

Запишіть IP-адресу, яку видала панель.

---

## Крок 1. Перший вхід і оновлення

```bash
ssh root@<IP>

apt update && apt -y upgrade
timedatectl set-timezone Europe/Kyiv
hostnamectl set-hostname beregynia
```

Якщо ядро оновилось — `reboot` і зайдіть знову.

**Перевірка:** `date` показує київський час.

---

## Крок 2. Автоматичні оновлення безпеки

Щоб не стежити за латками вручну:

```bash
apt -y install unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades      # відповісти «Yes»
```

---

## Крок 3. Мережевий екран

```bash
apt -y install ufw
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
ufw status
```

**Перевірка:** у списку три правила. Порт 8000 (Flask) назовні НЕ відкриваємо —
до нього ходить лише Caddy зсередини.

---

## Крок 4. Пакети

```bash
apt -y install python3-venv python3-pip git sqlite3
```

**Caddy у стандартних репозиторіях Ubuntu відсутній** — його ставлять з офіційного
репозиторію Cloudsmith. П'ять рядків, виконати підряд:

```bash
apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt -y install caddy
```

**Перевірка:** `caddy version` друкує версію.

---

## Крок 5. Користувач і теки

Застосунок працює під окремим користувачем без права входу — щоб навіть у разі
дірки в коді зловмисник не отримав повноцінного облікового запису.

```bash
adduser --system --group --home /opt/beregynia beregynia
mkdir -p /var/lib/beregynia /var/www/beregynia
chown beregynia:beregynia /var/lib/beregynia
```

---

## Крок 6. Код

```bash
cd /opt
git clone https://github.com/dimdim1978/Site-Hetzner.git site
cp -r /opt/site/server/* /opt/beregynia/
cp /opt/site/*.html /opt/site/*.css /var/www/beregynia/
```

**Перевірка:** `ls /var/www/beregynia` показує index, form, mudryk, dani, enter, style.css.

---

## Крок 7. Віртуальне середовище

```bash
cd /opt/beregynia
python3 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.txt
```

**Перевірка:** `venv/bin/pip list` — у списку мають бути `Flask` і `gunicorn`.

> Не використовуйте `flask.__version__` — у Flask 3.0 цей атрибут оголошено застарілим
> і він друкує попередження. На роботу це не впливає, але лякає.

---

## Крок 8. Налаштування

```bash
cd /opt/beregynia
cp .env.example .env
python3 -c "import secrets; print(secrets.token_hex(32))"     # скопіювати рядок
nano .env
```

Заповнити:

| Змінна | Що вписати |
|---|---|
| `SECRET_KEY` | згенерований рядок |
| `ADMIN_MAIL` | куди слати нові заявки (можна кілька через кому) |
| `SMTP_USER` | ваша адреса Gmail |
| `SMTP_PASS` | **пароль додатка**, не звичайний пароль (див. нижче) |
| `MAIL_FROM` | та сама адреса Gmail |
| `SITE_URL` | `https://children.pp.ua` |
| `DB_PATH` | `/var/lib/beregynia/beregynia.db` |

**Пароль додатка Gmail:** акаунт Google → Безпека → увімкнути двоетапну перевірку →
Паролі додатків → створити. Отримаєте 16 символів. Звичайний пароль від акаунта
Google для SMTP не працює з 2022 року.

```bash
chmod 600 .env
chown beregynia:beregynia .env
```

---

## Крок 9. База й користувачі

```bash
cd /opt/beregynia
sudo -u beregynia venv/bin/python app.py
sudo -u beregynia venv/bin/python app.py adduser dim 'ДовгийПароль123' admin 'Дмитро'
sudo -u beregynia venv/bin/python app.py adduser olena 'ІншийПароль456' teacher 'Олена'
```

Пароль — від 10 символів. Зберігається як scrypt-хеш, у відкритому вигляді ніде не лежить.

**Перевірка:**
```bash
ls -l /var/lib/beregynia/          # має бути beregynia.db
```

> Історія команд зберігає паролі. Після створення користувачів:
> `history -c && rm -f ~/.bash_history`

---

## Крок 10. Служба

```bash
cp /opt/beregynia/deploy/beregynia.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now beregynia
systemctl status beregynia
```

**Перевірка:** статус `active (running)`. І одразу локально:

```bash
curl -s http://127.0.0.1:8000/api/whoami
```
Має відповісти `{"login":null,"role":null}`. Якщо відповіло — застосунок живий.

Якщо ні:
```bash
journalctl -u beregynia -n 40 --no-pager
```

---

## Крок 11. DNS

У панелі реєстратора домену `children.pp.ua` створити запис:

| Тип | Ім'я | Значення |
|---|---|---|
| A | `children` (у зоні `pp.ua`) | IP вашого сервера |

**Перевірка** — з вашого комп'ютера:
```
nslookup children.pp.ua
```
Має показати IP сервера. Розходиться DNS до доби; далі не йдіть, поки не покаже.

---

## Крок 12. Caddy

```bash
cp /opt/beregynia/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -f
```

У журналі видно, як береться сертифікат Let's Encrypt. Ctrl+C, щоб вийти.

**Перевірка:**
```bash
curl -sI https://children.pp.ua/ | head -3
```
Має бути `HTTP/2 200`.

> **Якщо DNS ще не готовий**, а перевірити хочеться зараз — тимчасово замініть
> перший рядок Caddyfile з `children.pp.ua {` на `:80 {`, приберіть блок `www.`,
> `systemctl reload caddy` — і відкрийте `http://<IP>/`. Потім поверніть назад.

---

## Крок 13. Наскрізна перевірка

1. Відкрити `https://children.pp.ua/` з телефона.
2. Натиснути «Записати дитину», заповнити анкету по-справжньому.
3. Дочекатись екрана «Заявку прийнято» з номером — **номер має бути числом, а не «демо»**.
4. Перевірити пошту — має прийти лист із усіма полями.
5. Зайти на `https://children.pp.ua/enter.html`, увійти, побачити заявку в списку.
6. Видалити тестову заявку:
   ```bash
   sqlite3 /var/lib/beregynia/beregynia.db "DELETE FROM children WHERE id=1;"
   ```

Якщо на кроці 3 написано «демо» — сторінка відкрита не з домену.
Якщо «Не вдалося надіслати» — `journalctl -u beregynia -n 30`.

---

## Крок 14. Резервні копії

```bash
cat > /etc/cron.daily/beregynia-backup <<'EOS'
#!/bin/sh
D=/var/backups/beregynia; mkdir -p $D
sqlite3 /var/lib/beregynia/beregynia.db ".backup '$D/db-$(date +%F).db'"
find $D -name 'db-*.db' -mtime +30 -delete
EOS
chmod +x /etc/cron.daily/beregynia-backup
/etc/cron.daily/beregynia-backup && ls -l /var/backups/beregynia/
```

`.backup` — правильний спосіб копіювати SQLite: він не ловить базу посеред запису,
на відміну від `cp`.

**Раз на місяць забирайте копію із сервера** — зі свого комп'ютера:
```
scp root@<IP>:/var/backups/beregynia/db-*.db D:\backup\
```
Копія, що лежить на тому самому диску, що й оригінал, — це не резервна копія.

---

## Оновлення сайту

Один раз створити скрипт:

```bash
cp /opt/beregynia/deploy/deploy.sh /opt/deploy.sh
chmod +x /opt/deploy.sh
```

Далі після кожного `git push` з комп'ютера — на сервері просто:

```bash
/opt/deploy.sh
```

---

## Якщо щось не так

| Симптом | Що робити |
|---|---|
| Служба не стартує | `journalctl -u beregynia -n 40 --no-pager` |
| `systemctl restart` висить | перевірити тип служби: `systemctl show beregynia -p Type` — має бути `exec`. Якщо `notify`, значить юніт старий: `cp /opt/beregynia/deploy/beregynia.service /etc/systemd/system/ && systemctl daemon-reload` |
| «Не задано SECRET_KEY» | не заповнений `.env` — це навмисно, застосунок без ключа не працює |
| Сертифікат не береться | `journalctl -u caddy -n 40`; перевірити `nslookup children.pp.ua` |
| Не приходять листи | `journalctl -u beregynia | grep -i лист`; найчастіше — звичайний пароль замість пароля додатка |
| Не пускає в адмінку | 7 невдалих спроб з IP = блок на 15 хв. Скинути: `sqlite3 /var/lib/beregynia/beregynia.db "DELETE FROM login_attempts;"` |
| Не пускає учня | 10 невдалих спроб на цей логін = блок на 15 хв. Спроби учнів рахуються за логіном, а не за IP, тому один учень не блокує клас. Скинути: `sqlite3 … "DELETE FROM login_attempts WHERE login='shevchenko12';"` |
| Учень «не заходить», пароль правильний | найімовірніше, заявка за минулий навчальний рік — доступ діє лише в поточному. Перевірити: `sqlite3 … "SELECT child_name, school_year, login FROM children WHERE login='…';"` |
| Забули пароль | `cd /opt/beregynia && sudo -u beregynia venv/bin/python app.py passwd dim 'НовийПароль'` |
| Заявка загубилась | таблиця `raw_submissions` — там усе, як прийшло з форми |

Корисне:
```bash
systemctl restart beregynia          # перезапустити застосунок
journalctl -u beregynia -f           # дивитись журнал наживо
sqlite3 /var/lib/beregynia/beregynia.db "SELECT id,created_at,child_name,status FROM children;"
```

---

## Оновлення від 19 серпня 2026: доступ учнів і копія бази

Змінилися три речі поза кодом застосунку — після `git pull` їх треба зробити
руками **один раз**.

**1. Caddy має пропускати кабінет учня.** У `Caddyfile` з'явився блок
`handle /kabinet*`. Без нього сторінка кабінету віддаватиметься як статика,
тобто її побачить будь-хто без входу.

```bash
cp /opt/site/server/deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile     # спочатку перевірити
systemctl reload caddy
```

**2. Бібліотека для xlsx.** Кнопка «копія бази на пошту» надсилає таблицю
Excel, якщо є `openpyxl`, і ZIP із CSV, якщо його немає. Обидва варіанти
робочі, але xlsx зручніший:

```bash
/opt/beregynia/venv/bin/pip install openpyxl
systemctl restart beregynia
```

`deploy.sh` зробить це сам, бо змінився `requirements.txt`.

**3. Нові колонки в базі.** `login`, `pass_hash`, `pass_set_at`, `pass_by`,
`last_seen` у `children` і `login` у `login_attempts` додаються автоматично
при старті — робити нічого не треба, старі дані не чіпаються.

### Як видати учневі доступ

1. В адмінці позначити чекбокс **рівно навпроти одного** учня.
2. Натиснути **«Видати пароль»** у нижній панелі.
3. Логін і пароль показуються **один раз**. Кнопка «Друк талона» друкує
   аркушик, який можна віддати дитині.
4. Дитина заходить на children.pp.ua → **«Увійти»** → `uchen.html`.

Пароль зберігається лише хешем, тому подивитися виданий раніше пароль
неможливо — тільки видати новий (старий при цьому одразу перестає діяти).
Доступ прив'язаний до навчального року: заявка минулого року паролем не
відкривається, і адмінка про це попереджає при видачі.

### Видалення заявок

Кнопка **«Видалити обраних»** у нижній панелі, тільки для ролі `admin`
(педагог її не бачить). Потрібна насамперед проти сміття: посилання на анкету
ходить по руках учнів, і рано чи пізно хтось напише туди дурницю.

Позначаєте чекбокси, тиснете кнопку — вікно показує **поіменний список** тих,
кого видаляєте. Погоджуватися наосліп із «видалити 4 записи» надто легко.

Видаляється все, що повʼязано з дитиною: анкета, дані про здоровʼя, перелік
осіб, які забирають, дані НМТ і сира копія з `raw_submissions`. Це навмисно:
лишати в базі те, що людина видалила саме через його зміст, безглуздо.

Кожне видалення пишеться в журнал доступу разом з іменем — сам рядок уже
зникне, і без цього в журналі лишився б тільки номер.

Якщо після видалення в базі не лишилось нічого, нумерація скидається й
наступна заявка знову буде № 1. Поки є хоч одна заявка, номери не
переспользовуються ніколи.

**Повернути видалене можна лише з копії бази.** Тому перед чисткою варто
натиснути «Зробити копію бази» → «Ні, тільки на сервері» — це секунда.

### Копія бази

Кнопка **«Зробити копію бази»** внизу списку заявок, тільки для ролі `admin`.
Питає, чи слати копію на пошту:

* **«Ні, тільки на сервері»** — знімає копію в `/var/lib/beregynia/backups/`
  і на цьому все. Це щоденний варіант: швидко, нічого нікуди не летить.
* **«Так, на пошту»** — те саме, плюс лист на `ADMIN_MAIL` із двома
  вкладеннями: таблиця всіх заявок для Excel і сама копія `.db`.

Копія на сервер робиться **завжди й першою**. Якщо пошта не працює або лист
завеликий, копія на диску вже є, і адмінка чесно скаже, що саме не вдалося.

Знімок робиться через `sqlite3.backup()`, а не `cp`: у режимі WAL просте
копіювання файла дало б биту копію, і виявилося б це вже під час відновлення.

Зберігаються останні **10** копій (`BACKUP_KEEP`), старіші прибираються самі —
диск не забʼється. База на 50 дітей важить кілька мегабайт, тож уся тека —
десятки мегабайт.

Хеші паролів учнів у таблицю Excel навмисно не потрапляють. Кожне натискання
пишеться в журнал доступу (`audit`).

Лист містить персональні дані всіх дітей — його не можна пересилати далі
й не варто тримати у скриньці, до якої має доступ хтось іще.

**Відновлення з копії:**

```bash
systemctl stop beregynia
cp /var/lib/beregynia/backups/beregynia-2026-09-14-213045.db \
   /var/lib/beregynia/beregynia.db
chown beregynia:beregynia /var/lib/beregynia/beregynia.db
rm -f /var/lib/beregynia/beregynia.db-wal /var/lib/beregynia/beregynia.db-shm
systemctl start beregynia
```

---

## Скільки ресурсів це насправді їсть

Flask під gunicorn із двома робітниками — близько 120 МБ пам'яті. SQLite на
50 дітей — кілька мегабайт на диску, і росте вона повільніше, ніж накопичуються
системні журнали. Тобто 2 ядра й 4 ГБ — запас у десятки разів, і це нормально:
менше Hetzner просто не продає.

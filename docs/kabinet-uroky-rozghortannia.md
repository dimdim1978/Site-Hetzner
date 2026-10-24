# Уроки 5–8: розгортання (робимо разом із Дмитром)

Код — у гілці `program-5-8` (проходи 4 і 5, `docs/kabinet-uroky.md`). Нічого з
цього хмара не виконувала: правило 11 у `START-HERE.md` — розгортання лише
в спільній сесії. Команди — для сервера Hetzner (root), у тому порядку, в
якому їх варто робити. Перед кожним кроком читаємо, після кожного — перевіряємо.

---

## 0. Перед початком

* В адмінці (`https://iprostir.pp.ua/admin`) — «Зробити копію бази» (лише на сервер).
* Прогнати перевірку локально з гілки, яку зливаємо:
  ```
  NODE_PATH=$(npm root -g) node lab/perevirka-uroky.js
  ```
  Наприкінці має бути «УСЕ ГАРАЗД».

## 1. Ключ «тільки читання» → `git pull` через нього → репозиторій приватний

Порядок важливий: спершу ключ і перевірений `git pull`, і лише потім «Private» —
інакше `deploy.sh` перестане тягнути зміни.

```bash
ssh-keygen -t ed25519 -f /root/.ssh/github_site -N "" -C "hetzner-site-readonly"
cat /root/.ssh/github_site.pub
```
GitHub → репозиторій → Settings → Deploy keys → Add deploy key → вставити ключ,
**«Allow write access» НЕ ставити**.

```bash
cat >> /root/.ssh/config <<'EOF'
Host github-site
  HostName github.com
  User git
  IdentityFile /root/.ssh/github_site
  IdentitiesOnly yes
EOF
chmod 600 /root/.ssh/config
ssh -T git@github-site                # «Hi dimdim1978/Site-Hetzner! You've successfully authenticated…»
cd /opt/site
git remote -v                         # запамʼятати, що було
git remote set-url origin git@github-site:dimdim1978/Site-Hetzner.git
git fetch origin && git status        # має пройти без пароля
```
Лише тепер: GitHub → Settings → General → Danger Zone → Change visibility → Private.
Перевірка: `cd /opt/site && git fetch origin` — і далі працює.

## 2. `.env`: друга база і записи звуків

```bash
cd /opt/beregynia
cp .env .env.bak-$(date +%F)
cat >> .env <<'EOF'

# Уроки 5–8
NAVCH_DB_PATH=/var/lib/beregynia/navchannia.db
UROKY_AUDIO_DIR=/var/www/lab/audio
UROKY_URL=https://lab.mudryk.iprostir.pp.ua/uroky
EOF
```
Записи читає служба `beregynia`, а вона не власник `/var/www/lab`, тож вони мають
бути доступні всім на читання:
```bash
mkdir -p /var/www/lab/audio
chmod 755 /var/www/lab /var/www/lab/audio
chmod 644 /var/www/lab/audio/*.wav 2>/dev/null; ls -la /var/www/lab/audio
```
`navchannia.db` створиться сам при старті служби в `/var/lib/beregynia`
(вона вже в `ReadWritePaths`, юніт міняти не треба).

## 3. Caddy: `/uroky*` на піддомені lab → Flask

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
nano /etc/caddy/Caddyfile
```
У блоці `lab.mudryk.iprostir.pp.ua` — **перед** загальним `handle { … }` — додати:
```
	handle /uroky* {
		reverse_proxy 127.0.0.1:8000
	}
```
Решта lab — статика з паролем Caddy. **`basic_auth` має стояти всередині
загального `handle { … }`, а не на рівні всього блоку** — інакше мамі на
телефоні вискочить вікно пароля Caddy ще до сторінки уроків. Зразок — у
`server/deploy/Caddyfile` (там `basic_auth` закоментований; хеш — `caddy hash-password`).
Бойовий Caddyfile уже розходився з репозиторієм (`kabinet-navchannia.md` §10) —
не копіювати файл цілком, а вписати лише цей шматок.

```bash
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
systemctl reload caddy && systemctl status caddy --no-pager --lines=5
```

## 4. Злиття й деплой

Злиття `program-5-8` → `main` — разом (pull request на GitHub або локально).
Потім на сервері:
```bash
/opt/deploy.sh
curl -s http://127.0.0.1:8000/api/whoami          # {"login":null,"role":null}
ls -la /var/lib/beregynia/navchannia.db            # зʼявився
journalctl -u beregynia -n 30 --no-pager           # без Traceback
curl -sI https://lab.mudryk.iprostir.pp.ua/uroky | grep -iE '^(HTTP|location|x-robots)'
#   HTTP/2 302 · location: /uroky/aktyvatsiia · x-robots-tag: noindex, nofollow
curl -sI https://lab.mudryk.iprostir.pp.ua/uroky/manifest.webmanifest | head -1   # 200
```
Основний сайт: відкрити анкету, адмінку, кабінет учня — нічого не змінилось.
В адмінці вгорі зʼявилось «Мудрик 5–8».

## 5. Стара сторінка в пісочниці

```bash
mv /var/www/lab/uroky.html /var/www/lab/uroky_old.html
# (за бажанням) стрічка-редірект на нову адресу:
cp /opt/site/lab/uroky.html /var/www/lab/uroky.html
```
Прогрес пілоту, записаний у `localStorage` старої сторінки на планшеті, **на
сервер не переноситься** — нова сторінка його не читає (прогрес тепер лише в базі).

## 6. Перший код, планшет ГО, перша дитина

1. `https://iprostir.pp.ua/admin/mudryk` → «Коди активації» → назва «Планшет ГО» →
   «Новий код». Код (8 цифр) видно один раз, діє 24 години.
2. На планшеті: `https://lab.mudryk.iprostir.pp.ua/uroky` → сторінка активації →
   код. (На iPhone — спершу «На екран „Додому“», потім код уже в значку.)
3. Вхід «Я — педагог» своїм логіном персоналу.
4. В адмінці «Діти» → ім'я, прізвище, вік, буквар → «Додати дитину» → логін і
   пароль один раз → «Друкувати картку для мами».
5. На планшеті «Діти» → дитина → перший урок. Після нього мама з картки
   зможе повторювати цей урок удома (її телефону — окремий код).
6. «Зробити копію бази» — тепер у `backups/` дві копії з однаковим часом:
   `beregynia-….db` і `navchannia-….db`.

## Що варто знати після запуску

* **Код не підходить** — 5 невдалих спроб з однієї адреси блокують активацію на
  15 хвилин (усім, хто за тією самою адресою, наприклад у Wi-Fi ГО).
* **Мама «вилетіла»** — сесія мами 30 днів; очищення даних браузера знімає й
  активацію пристрою (потрібен новий код).
* **Відкликати пристрій** — «Пристрої» → «Відкликати»: наступний запит із нього
  піде на активацію.
* На пошту кнопка копії й далі шле лише основну базу; `navchannia-….db` лежить
  на сервері поруч.
* **Урок зник зі списку після правки** — зіпсований `server/uroky/lessons/<id>.json`:
  `journalctl -u beregynia -n 50 | grep Уроки` покаже, який файл і що не так.

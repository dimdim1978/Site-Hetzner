#!/bin/bash
# ============================================================
#  Звірка сервера з репозиторієм. Покласти як /opt/zvirka.sh
#  Запуск:  /opt/zvirka.sh
#
#  НІЧОГО НЕ МІНЯЄ. Тільки читає й показує, де розійшлося.
#  Сенс: deploy.sh оновлює лише статику й бекенд. Конфіги
#  (Caddyfile, сам deploy.sh, systemd-юніт) він не чіпає —
#  саме вони й розходяться з репозиторієм непомітно.
# ============================================================
set -uo pipefail        # без -e: хочемо побачити ВСІ розбіжності, а не впасти на першій

SITE=/opt/site
WWW=/var/www/beregynia
APP=/opt/beregynia

ok(){ echo "  ✓ $1"; }
no(){ echo "  ✗ $1"; }

echo
echo "=============================================="
echo " 1. Гілка й звірка з GitHub"
echo "=============================================="
cd "$SITE" || { echo "Немає $SITE"; exit 1; }
git fetch --quiet origin 2>/dev/null || echo "  (не вдалося сходити на GitHub — показую те, що знаю локально)"
echo "  тут:     $(git log -1 --format='%h %s')"
echo "  GitHub:  $(git log -1 --format='%h %s' origin/main 2>/dev/null || echo '?')"
echo "  стан:    $(git status -sb | head -1)"

CHANGES=$(git status --short)
if [ -z "$CHANGES" ]; then
  ok "робоча копія чиста — на сервері руками нічого не правили"
else
  no "у /opt/site є зміни, зроблені повз git:"
  echo "$CHANGES" | sed 's/^/      /'
  echo "      (ці правки git pull --ff-only або перезапише, або впаде)"
fi

echo
echo "=============================================="
echo " 2. Конфіги: живий проти репозиторію"
echo "=============================================="
zvir(){                       # $1 — живий файл, $2 — копія в репозиторії
  if [ ! -f "$1" ]; then no "немає $1"; return; fi
  if [ ! -f "$2" ]; then no "немає копії $2"; return; fi
  if diff -q "$1" "$2" >/dev/null; then
    ok "$1 збігається"
  else
    no "$1 РОЗІЙШОВСЯ з $2"
    diff -u "$2" "$1" | sed 's/^/      /'
  fi
}
zvir /etc/caddy/Caddyfile                    "$SITE/server/deploy/Caddyfile"
zvir /opt/deploy.sh                          "$SITE/server/deploy/deploy.sh"
zvir /etc/systemd/system/beregynia.service   "$SITE/server/deploy/beregynia.service"

echo
echo "=============================================="
echo " 3. Розгорнуте проти репозиторію"
echo "=============================================="
echo "  -- статика ($WWW) --"
D=0
for f in "$WWW"/*; do
  b=$(basename "$f")
  if [ -f "$SITE/$b" ]; then
    diff -q "$f" "$SITE/$b" >/dev/null || { no "$b відрізняється"; D=1; }
  elif [ -d "$f" ]; then
    no "тека $b/ є на сервері, але немає в репозиторії ($(find "$f" -type f | wc -l) файлів) — існує В ОДНОМУ ЕКЗЕМПЛЯРІ"; D=1
  else
    no "$b є на сервері, але немає в репозиторії"; D=1
  fi
done
# зворотний бік: що є в репозиторії, але так і не доїхало на сервер.
# Без цього не видно, що deploy.sh чогось не копіює (напр. старий deploy.sh
# без циклу для картинок мовчки лишає og.png на сервері відсутнім).
for f in "$SITE"/*.html "$SITE"/*.css "$SITE"/*.png "$SITE"/*.svg "$SITE"/*.ico; do
  [ -e "$f" ] || continue
  b=$(basename "$f")
  [ -e "$WWW/$b" ] || { no "$b є в репозиторії, але НЕ доїхав на сервер"; D=1; }
done
[ "$D" = 0 ] && ok "статика збігається"

echo "  -- бекенд ($APP) --"
diff -rq "$SITE/server" "$APP" \
  --exclude=venv --exclude=__pycache__ --exclude='*.pyc' \
  --exclude='.env' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
  2>/dev/null | sed 's/^/      /' | grep . && no "бекенд розійшовся (див. вище)" || ok "бекенд збігається"

echo
echo "=============================================="
echo " 4. Служба й база"
echo "=============================================="
echo "  служба:  $(systemctl is-active beregynia 2>/dev/null)"
echo "  caddy:   $(systemctl is-active caddy 2>/dev/null)"
echo "  база:    $(ls -la /var/lib/beregynia/beregynia.db 2>/dev/null | awk '{print $5" байт, "$6" "$7" "$8}')"
if [ ! -d /var/lib/beregynia/backups ]; then
  no "теки /var/lib/beregynia/backups НЕМАЄ — копій бази не існує взагалі"
elif [ -z "$(ls -A /var/lib/beregynia/backups 2>/dev/null)" ]; then
  no "тека копій порожня — жодної копії живої бази з дітьми"
else
  ok "копій: $(ls -1 /var/lib/beregynia/backups | wc -l) шт, остання: $(ls -1t /var/lib/beregynia/backups | head -1)"
fi

echo
echo "=============================================="
echo " 5. Чи приймає Caddy свій конфіг"
echo "=============================================="
# Важливо: якщо reload не пройшов, Caddy ЛИШАЄТЬСЯ на старому конфізі
# і далі показує active. «Працює» не означає «читає те, що на диску».
if caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile 2>&1 | tail -5 | grep -qi 'valid'; then
  ok "конфіг синтаксично приймається"
else
  no "caddy validate лається:"
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile 2>&1 | tail -15 | sed 's/^/      /'
fi
echo "  файл змінено:   $(stat -c %y /etc/caddy/Caddyfile 2>/dev/null | cut -d. -f1)"
echo "  caddy стартував: $(systemctl show caddy -p ActiveEnterTimestamp --value 2>/dev/null)"
echo "  (якщо файл новіший за старт і reload падав — у памʼяті стара версія)"

echo
echo "Готово. Усе, що позначено ✗ — це те, що треба перенести в репозиторій."
echo

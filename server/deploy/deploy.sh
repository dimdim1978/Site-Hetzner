#!/bin/bash
# ============================================================
#  Оновлення сайту з GitHub. Покласти як /opt/deploy.sh
#  Запуск:  /opt/deploy.sh
# ============================================================
set -euo pipefail

SITE=/opt/site                  # робоча копія репозиторію
WWW=/var/www/beregynia          # статика, яку роздає Caddy
APP=/opt/beregynia              # бекенд

echo "→ Тягнемо зміни з GitHub"
cd "$SITE"
BEFORE=$(git rev-parse HEAD)
git pull --ff-only
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "  Нічого нового. Виходимо."
  exit 0
fi

CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")

echo "→ Оновлюємо статику"
cp "$SITE"/*.html "$SITE"/*.css "$WWW"/

if grep -q '^server/' <<< "$CHANGED"; then
  echo "→ Змінився бекенд — оновлюємо файли"
  cp -r "$SITE"/server/* "$APP"/
  chown -R beregynia:beregynia "$APP"/templates

  if grep -q 'requirements.txt' <<< "$CHANGED"; then
    echo "→ Змінились залежності — доставляємо"
    "$APP"/venv/bin/pip install -q -r "$APP"/requirements.txt
  fi

  echo "→ Перезапускаємо службу"
  # Обмежуємо час: якщо systemd із якоїсь причини затримається,
  # скрипт не повисне мовчки, а скаже про це.
  if ! timeout 45 systemctl restart beregynia; then
    echo "  ✗ Перезапуск не завершився за 45 с"
    systemctl status beregynia --no-pager --lines=15 || true
    exit 1
  fi

  # Чекаємо, поки застосунок реально почне відповідати —
  # «active» ще не означає, що він працює.
  echo -n "→ Перевіряємо відповідь"
  for i in $(seq 1 15); do
    if curl -fsS --max-time 2 http://127.0.0.1:8000/api/whoami >/dev/null 2>&1; then
      echo " — відповідає"
      break
    fi
    echo -n "."
    sleep 1
    if [ "$i" = 15 ]; then
      echo " ✗ не відповідає"
      journalctl -u beregynia -n 25 --no-pager
      exit 1
    fi
  done
else
  echo "→ Бекенд не змінювався, перезапуск не потрібен"
fi

echo "✓ Готово: $(git log -1 --format='%h %s')"

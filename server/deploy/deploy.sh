#!/bin/bash
# ============================================================
#  Оновлення сайту з GitHub. Покласти як /opt/deploy.sh
#  Запуск:  /opt/deploy.sh
# ============================================================
set -e

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

echo "→ Оновлюємо статику"
cp "$SITE"/*.html "$SITE"/*.css "$WWW"/

# бекенд чіпаємо лише якщо в ньому справді щось змінилось
if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^server/'; then
  echo "→ Змінився бекенд — оновлюємо й перезапускаємо"
  cp -r "$SITE"/server/* "$APP"/
  chown -R beregynia:beregynia "$APP"/templates
  # .env і venv не чіпаємо: їх немає в репозиторії
  if git diff --name-only "$BEFORE" "$AFTER" | grep -q 'requirements.txt'; then
    echo "→ Змінились залежності"
    "$APP"/venv/bin/pip install -q -r "$APP"/requirements.txt
  fi
  systemctl restart beregynia
  sleep 2
  systemctl is-active --quiet beregynia \
    && echo "  Служба піднялась" \
    || { echo "  ПОМИЛКА: служба не стартувала"; journalctl -u beregynia -n 20 --no-pager; exit 1; }
else
  echo "→ Бекенд не змінювався, перезапуск не потрібен"
fi

echo "✓ Готово: $(git log -1 --format='%h %s')"

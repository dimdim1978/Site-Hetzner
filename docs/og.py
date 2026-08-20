#!/usr/bin/env python3
"""Малює og.png — картинку, яку показують Viber, Telegram і Facebook
під посиланням на сайт.

Вихідника в проєкту не було: картинка лежала тільки як PNG, і щоб
поміняти в ній слово, доводилось перемальовувати вручну. Тепер текст
угорі цього файла — правите рядок, запускаєте, отримуєте нову картинку.

    pip install pillow
    python3 docs/og.py            # перезаписує og.png у корені репозиторію

Це інструмент для роботи на місці, а не частина сервера: у
server/requirements.txt pillow НЕ додається, на Hetzner він не потрібен.
"""

import os
from PIL import Image, ImageDraw, ImageFont

# ============================================================
#  ТЕКСТ — те, що міняється найчастіше
# ============================================================
MISTO      = 'ПОКРОВ'
ZAHOLOVOK  = ['Освітній простір', '«Берегиня»']
PIDZAHOLOVOK = ['Від перших кроків у житті',
                'до впевненого вступу до ВНЗ']
NAPRIAMY   = ['Дитячий центр «Мудрик»', 'Група подовженого дня', 'Підготовка до НМТ']

# ============================================================
#  ПАЛІТРА — та сама, що в style.css
# ============================================================
ZELENYI    = (47, 111, 78)     # --green      #2F6F4E
TEMNYI     = (37, 90, 62)      # --green-dark #255A3E
BILYI      = (255, 255, 255)
SVITLO_ZEL = (206, 226, 214)   # підзаголовок
SMUHA_TEKST= (190, 217, 200)   # напис у нижній смузі

# «Покров» навмисно теплий, а не зелений: на зеленому тлі він має
# відділятися, а не зливатись. Пісок із палітри (#C77D2E) тут не
# годиться — на цьому тлі його контраст 1.83, тобто ГІРШЕ, ніж було.
# Цей відтінок дає 4.18 при нормі 3.0 для великого тексту.
MISTO_KOLIR = (255, 208, 138)  # #FFD08A

W, H       = 1200, 630
SMUHA_Y    = 518               # де починається темна смуга
LIVE_POLE  = 94

SHRYFTY = '/usr/share/fonts/truetype/dejavu/'
SERIF_B  = SHRYFTY + 'DejaVuSerif-Bold.ttf'
SANS     = SHRYFTY + 'DejaVuSans.ttf'
SANS_B   = SHRYFTY + 'DejaVuSans-Bold.ttf'


def shyryna(draw, tekst, shr, rozriadka=0):
    w = draw.textlength(tekst, font=shr)
    return w + rozriadka * max(0, len(tekst) - 1)


def pysaty(draw, xy, tekst, shr, kolir, rozriadka=0):
    """Пише рядок. rozriadka — відстань між літерами понад звичайну:
    Pillow сам такого не вміє, тому за потреби малюємо по літері."""
    x, y = xy
    if not rozriadka:
        draw.text((x, y), tekst, font=shr, fill=kolir)
        return
    for ch in tekst:
        draw.text((x, y), ch, font=shr, fill=kolir)
        x += draw.textlength(ch, font=shr) + rozriadka


def vpysaty(draw, tekst, shliakh, kegl, dostupno, rozriadka=0):
    """Зменшує кегль, поки рядок не вміститься в задану ширину.
    Потрібне, бо «Дитячий центр» довший за «Садочок» на шість літер,
    і без цього нижній напис виліз би за поле."""
    while kegl > 8:
        shr = ImageFont.truetype(shliakh, kegl)
        if shyryna(draw, tekst, shr, rozriadka) <= dostupno:
            return shr, kegl
        kegl -= 1
    return ImageFont.truetype(shliakh, 8), 8


def namaliuvaty(vyhid):
    im = Image.new('RGB', (W, H), ZELENYI)
    d = ImageDraw.Draw(im)
    d.rectangle([0, SMUHA_Y, W, H], fill=TEMNYI)

    # --- місто ---
    # було: кегль ~30, висота літер 22 px, блідо-зелений.
    # стало: помітно більше й тепліше — це прохання Дмитра.
    shr = ImageFont.truetype(SANS_B, 40)
    pysaty(d, (LIVE_POLE, 88), MISTO, shr, MISTO_KOLIR, rozriadka=4)

    # --- заголовок ---
    shr = ImageFont.truetype(SERIF_B, 80)
    for i, ryadok in enumerate(ZAHOLOVOK):
        d.text((LIVE_POLE, 158 + i * 104), ryadok, font=shr, fill=BILYI)

    # --- підзаголовок ---
    shr = ImageFont.truetype(SANS, 31)
    for i, ryadok in enumerate(PIDZAHOLOVOK):
        d.text((LIVE_POLE, 384 + i * 51), ryadok, font=shr, fill=SVITLO_ZEL)

    # --- нижня смуга: напрями через крапку ---
    ryadok = '  ·  '.join(NAPRIAMY)
    shr, kegl = vpysaty(d, ryadok, SANS_B, 25, W - 2 * LIVE_POLE)
    verkh = SMUHA_Y + (H - SMUHA_Y - (shr.getbbox(ryadok)[3] - shr.getbbox(ryadok)[1])) // 2
    d.text((LIVE_POLE, verkh - 6), ryadok, font=shr, fill=SMUHA_TEKST)

    im.save(vyhid, 'PNG', optimize=True)
    return kegl


if __name__ == '__main__':
    korin = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    shliakh = os.path.join(korin, 'og.png')
    kegl = namaliuvaty(shliakh)
    print('Готово:', shliakh)
    print('Кегль нижнього рядка:', kegl, '(зменшується сам, якщо текст довгий)')

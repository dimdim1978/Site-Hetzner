-- ============================================================
--  navchannia.db — друга база: уроки 5–8 (docs/kabinet-uroky.md §2)
--
--  Окремий файл від beregynia.db: інша мета обробки й інший строк
--  зберігання (docs/kabinet-navchannia.md §4). Зовнішніх ключів на
--  children тут немає й бути не може — через файл вони не працюють.
--
--  Правило з START-HERE §6.1 діє й тут: індекс на колонці, доданій
--  пізніше, — лише в _migrate_navch(), ніколи в цьому файлі.
-- ============================================================

-- діти програми 5–8 (у children їх немає: анкети садочка не існує)
CREATE TABLE IF NOT EXISTS dity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  imia        TEXT NOT NULL,           -- ім'я і прізвище, як скаже мама
  vik         INTEGER,                 -- 5, 6, 7, 8
  login       TEXT UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  bukvar      TEXT NOT NULL DEFAULT 'bolshakova',  -- bolshakova | vashulenko
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,           -- логін адміністратора
  last_login  TEXT
);

-- активовані пристрої
CREATE TABLE IF NOT EXISTS prystroi (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nazva       TEXT NOT NULL,           -- «Планшет ГО», «Телефон мами Олі»
  token_hash  TEXT UNIQUE NOT NULL,    -- sha256 токена; сам токен лише в куці
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  last_seen   TEXT,
  revoked_at  TEXT
);

-- одноразові коди активації
CREATE TABLE IF NOT EXISTS kody (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash   TEXT UNIQUE NOT NULL,
  nazva       TEXT NOT NULL,           -- стане назвою пристрою
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,           -- +24 год
  used_at     TEXT,
  prystrii_id INTEGER
);

-- заняття: одне на урок, стартову або повторну перевірку
CREATE TABLE IF NOT EXISTS zaniattia (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dytyna_id   INTEGER NOT NULL,
  vyd         TEXT NOT NULL,           -- urok | start | povtor
  urok        TEXT,                    -- id уроку з каталогу (для vyd='urok')
  pochatok    TEXT NOT NULL,           -- час із клієнта, перевірений сервером (UTC, …Z)
  kinets      TEXT NOT NULL,           -- пише СЕРВЕР при прийомі (UTC, …Z)
  khto        TEXT NOT NULL,           -- mama | vchytel
  staff_login TEXT,                    -- хто з персоналу проводив
  prystrii_id INTEGER NOT NULL,
  klient_id   TEXT UNIQUE NOT NULL     -- для повторних відправок з черги
);
CREATE INDEX IF NOT EXISTS idx_zaniattia_dytyna ON zaniattia(dytyna_id, pochatok);

-- підсумок заняття по навичках: лише лічильники
CREATE TABLE IF NOT EXISTS zaniattia_navychky (
  zaniattia_id INTEGER NOT NULL,
  navychka     TEXT NOT NULL,          -- G01, M05, F01, A04 …
  pershi       INTEGER NOT NULL,       -- правильних з першої спроби
  usogo        INTEGER NOT NULL,       -- завдань цієї навички в занятті
  PRIMARY KEY (zaniattia_id, navychka)
);

-- «Я підготувався» — на сервері й окремо для кожного педагога
CREATE TABLE IF NOT EXISTS pidhotovka (
  staff_login TEXT NOT NULL,
  urok        TEXT NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (staff_login, urok)
);

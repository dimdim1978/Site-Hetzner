-- ============================================================
--  ГО «Берегиня» — база даних групи подовженого дня
--  SQLite. Створюється автоматично при першому запуску app.py.
-- ============================================================

PRAGMA journal_mode = WAL;      -- читання не блокує запис
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
--  ДІТИ — основна таблиця, одна анкета = один рядок
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS children (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'нова',   -- нова / підтверджена / зарахована / відмова / архів

  -- дитина
  child_name     TEXT NOT NULL,
  child_dob      TEXT,
  grade          TEXT,
  school         TEXT,
  school_addr    TEXT,
  pickup_school  TEXT,          -- «так» / «ні» — чи забирати зі школи

  -- батьки та контакти
  parent_name    TEXT,
  parent_role    TEXT,
  parent_phone   TEXT,
  parent_email   TEXT,
  contact2_name  TEXT,
  contact2_phone TEXT,
  address        TEXT,

  -- безпека
  self_leave     TEXT,          -- ні / так / після
  self_time      TEXT,

  -- очікування
  expectations   TEXT,
  comment        TEXT,

  -- згоди
  c_true         TEXT,
  c_data         TEXT,
  c_health       TEXT,
  c_medical      TEXT,
  c_messenger    TEXT,

  -- службове
  source         TEXT,          -- 'site'
  fill_seconds   INTEGER,
  note_admin     TEXT           -- внутрішній коментар адміністратора
);

CREATE INDEX IF NOT EXISTS idx_children_status  ON children(status);
CREATE INDEX IF NOT EXISTS idx_children_created ON children(created_at);
CREATE INDEX IF NOT EXISTS idx_children_name    ON children(child_name);

-- ------------------------------------------------------------
--  ХТО ЗАБИРАЄ ДИТИНУ — 1..4 записи на дитину
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pickup_persons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id  INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,
  name      TEXT,
  phone     TEXT,
  relation  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pickup_child ON pickup_persons(child_id);

-- ------------------------------------------------------------
--  ЧУТЛИВЕ — окрема таблиця, окремий рівень доступу.
--  Педагог (role='teacher') бачить лише позначку «є / немає».
--  Повний текст бачить лише role='admin'.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sensitive (
  child_id        INTEGER PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
  has_allergy     TEXT,
  allergy_details TEXT,
  meal_limits     TEXT,
  health_notes    TEXT,
  do_not_release  TEXT           -- кому дитину віддавати не можна
);

-- ------------------------------------------------------------
--  СИРІ ЗАЯВКИ — усе, як прийшло з форми.
--  Страховка: якщо колись зміниться набір полів, нічого не втратиться.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id   INTEGER,
  created_at TEXT NOT NULL,
  ip         TEXT,
  payload    TEXT NOT NULL      -- JSON
);

-- ------------------------------------------------------------
--  ДОСТУП
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  login      TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'admin',   -- admin | teacher
  full_name  TEXT,
  created_at TEXT,
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, ts);

-- ------------------------------------------------------------
--  ЖУРНАЛ ДОСТУПУ — хто коли дивився дані дитини.
--  Не забаганка: за ЗУ «Про захист персональних даних» володілець
--  має вміти показати, хто мав доступ до даних.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  who       TEXT,
  action    TEXT,
  child_id  INTEGER,
  ip        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);

-- ============================================================
--  НА МАЙБУТНЄ — створюємо зараз порожніми, щоб потім не міняти
--  структуру. Заповнюватиме окрема форма графіка й телеграм-бот.
-- ============================================================

-- графік: день тижня → час виходу
CREATE TABLE IF NOT EXISTS schedule (
  child_id  INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  weekday   INTEGER NOT NULL,        -- 1=Пн … 5=Пт
  out_time  TEXT,                    -- '16:00'
  PRIMARY KEY (child_id, weekday)
);

-- події дня: забрали зі школи / у групі / пішов додому / забрали батьки
CREATE TABLE IF NOT EXISTS attendance (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id  INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,           -- '2026-09-02'
  ts        TEXT NOT NULL,           -- повна мітка часу події
  event     TEXT NOT NULL,           -- 'зі школи' | 'у групі' | 'додому' | 'забрали'
  by_whom   TEXT,                    -- хто зафіксував або хто забрав
  note      TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_day   ON attendance(day);
CREATE INDEX IF NOT EXISTS idx_att_child ON attendance(child_id, day);

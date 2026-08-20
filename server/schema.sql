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
  program        TEXT NOT NULL DEFAULT 'ГПД',    -- ГПД (1–8 клас) / НМТ (9–11 клас)
  school_year    TEXT,                           -- «2026/27»: на який навчальний рік заявка

  -- дитина
  -- child_name — повне ім'я, яке ЗБИРАЄ СЕРВЕР із трьох полів нижче.
  -- Лишили окремою колонкою навмисно: на неї спираються листи, кабінет,
  -- друковані списки й журнал. Правити її напряму не можна — тільки
  -- через povne_imia() разом зі складовими, інакше вони розійдуться.
  child_name     TEXT NOT NULL,
  child_last     TEXT,          -- прізвище: за ним сортуються списки й будується логін
  child_first    TEXT,          -- ім'я
  child_mid      TEXT,          -- по батькові; НЕ обов'язкове — його має не кожен
  child_dob      TEXT,
  grade          TEXT,
  school         TEXT,
  school_addr    TEXT,
  pickup_school  TEXT,          -- «так» / «ні» — чи забирати зі школи

  -- батьки та контакти
  parent_name    TEXT,          -- теж збирає сервер, див. коментар до child_name
  parent_last    TEXT,
  parent_first   TEXT,
  parent_mid     TEXT,
  parent_role    TEXT,
  parent_dob     TEXT,          -- дата народження того з батьків, хто подав заявку
  parent_phone   TEXT,
  parent_email   TEXT,
  student_phone  TEXT,          -- телефон самого учня (напрям НМТ)
  student_email  TEXT,          -- пошта самого учня (напрям НМТ)
  -- другий контакт — це «кому дзвонити, якщо не додзвонились».
  -- По батькові тут свідомо не питаємо: документів на нього не оформлюють.
  contact2_name  TEXT,
  contact2_last  TEXT,
  contact2_first TEXT,
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
  c_photo        TEXT,          -- необов'язкова згода на фото- й відеофіксацію
  c_messenger    TEXT,

  -- службове
  source         TEXT,          -- 'site'
  fill_seconds   INTEGER,
  note_admin     TEXT           -- внутрішній коментар адміністратора
);

CREATE INDEX IF NOT EXISTS idx_children_status  ON children(status);
-- індекс на program створюється в міграції (app.py, _migrate):
-- на наявній базі колонки ще немає, і CREATE INDEX тут зламав би запуск
CREATE INDEX IF NOT EXISTS idx_children_created ON children(created_at);
CREATE INDEX IF NOT EXISTS idx_children_name    ON children(child_name);

-- ------------------------------------------------------------
--  ХТО ЗАБИРАЄ ДИТИНУ — 1..4 записи на дитину
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pickup_persons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id  INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,
  -- name збирає сервер; складові — нижче. Ці люди показують паспорт,
  -- коли забирають дитину, тому по батькові тут доречне.
  name      TEXT,
  last      TEXT,
  first     TEXT,
  mid       TEXT,
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
--  ДОВУЗІВСЬКА ПІДГОТОВКА — усе, що стосується лише напряму НМТ.
--  Окрема таблиця, а не 11 колонок у children: для заявок ГПД
--  вони були б завжди порожні.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nmt (
  child_id        INTEGER PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
  career_help     TEXT,          -- чи потрібна профорієнтаційна консультація
  career_interest TEXT,          -- які професії цікавлять
  subjects        TEXT,          -- предмети для підготовки, через кому
  needs           TEXT,          -- що хоче отримати від навчання
  needs_other     TEXT,          -- варіант «інше»
  level           TEXT,          -- самооцінка рівня підготовки
  hard_topics     TEXT,          -- що дається найважче
  format_pref     TEXT,          -- бажаний формат занять
  time_pref       TEXT,          -- бажаний час занять
  goal            TEXT,          -- очікуваний результат
  speciality      TEXT,          -- бажана спеціальність
  university      TEXT           -- заклад вищої освіти
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
  ip    TEXT NOT NULL,
  ts    TEXT NOT NULL,
  ok    INTEGER NOT NULL,
  login TEXT                       -- для учнів рахуємо спроби за логіном, а не за IP:
);                                 -- цілий клас сидить під однією адресою школи
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, ts);
-- Індекс по login навмисно НЕ тут, а в _migrate() після ALTER TABLE.
-- На вже наявній базі колонки login ще немає, і цей рядок повалив би
-- увесь запуск застосунку — сайт ліг би на живому сервері.
-- Те саме стосується індексів по children(program) і children(login).

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

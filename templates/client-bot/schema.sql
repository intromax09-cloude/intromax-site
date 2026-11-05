-- Клиентский бот записи: полная схема D1 одним файлом (для новой базы).
-- Применить: npx wrangler d1 execute client-bot-db --remote --file=schema.sql
-- Для обновлений существующей базы используйте migrations/.
-- Все моменты времени — миллисекунды UTC (INTEGER). Локальное время считает код по часовому поясу из config.json.

-- Клиенты: персональные данные лежат только здесь.
CREATE TABLE IF NOT EXISTS clients (
  tg_id      INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  username   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Записи. master_id = '_' для бизнеса без мастеров. service_name/price — снимок на момент записи.
CREATE TABLE IF NOT EXISTS appointments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL,
  service_id   TEXT NOT NULL,
  service_name TEXT NOT NULL,
  price        REAL,
  master_id    TEXT NOT NULL,
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  cancelled_by TEXT,                 -- 'client' | 'staff'
  booked_at    INTEGER NOT NULL,     -- когда клиент (или владелец) выбрал это время; сдвигается при переносе
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- Защита от двойной записи на одно и то же время к одному мастеру (гонка двух клиентов).
CREATE UNIQUE INDEX IF NOT EXISTS appt_slot_unique ON appointments (master_id, start_ts) WHERE status IN ('pending', 'confirmed');
CREATE INDEX IF NOT EXISTS appt_start ON appointments (start_ts);
CREATE INDEX IF NOT EXISTS appt_client ON appointments (client_id, start_ts);

-- Ручные блокировки: час, часть дня или весь день. master_id NULL = для всех.
CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id  TEXT,
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('slot', 'day')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_range ON blocks (start_ts, end_ts);

-- Журнал напоминаний: один раз на (запись, вид). kind: 'r24' | 'r2' | 'review'.
-- status: 'sending' (захвачено запуском) | 'sent' | 'failed' (будет повтор до 3 попыток).
CREATE TABLE IF NOT EXISTS reminders_log (
  appointment_id INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts       INTEGER NOT NULL DEFAULT 1,
  ts             INTEGER NOT NULL,
  PRIMARY KEY (appointment_id, kind)
);

-- Состояние диалога записи (шаг, выбранная услуга и т.д.). Живёт сутки.
CREATE TABLE IF NOT EXISTS sessions (
  chat_id    INTEGER PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Счётчик запросов для ограничения частоты (окно — минута).
CREATE TABLE IF NOT EXISTS rate_limit (
  k TEXT NOT NULL,
  w INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (k, w)
);

-- Карточки заявок, отправленные владельцу/мастеру: чтобы после «Підтвердити» убрать кнопки на всех карточках.
CREATE TABLE IF NOT EXISTS cards (
  appointment_id INTEGER NOT NULL,
  chat_id        INTEGER NOT NULL,
  message_id     INTEGER NOT NULL,
  PRIMARY KEY (appointment_id, chat_id, message_id)
);

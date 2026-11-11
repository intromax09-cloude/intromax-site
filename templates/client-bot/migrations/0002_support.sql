-- Поддержка: журнал событий для отчёта, передача человеку, мониторинг сайта, журнал отчётов.
-- Применить: npx wrangler d1 migrations apply <база> --remote

-- Журнал событий для ежемесячного отчёта. kind: 'moved' | 'cancelled' | 'unanswered' | 'handoff'.
-- actor: 'client' | 'staff'. chat_id и text — только у 'unanswered'/'handoff' (вопрос клиента, цифры телефона замаскированы);
-- через 100 дней обезличиваются уборкой (text, chat_id → NULL), счётчики для отчёта остаются.
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  appointment_id INTEGER,
  actor          TEXT,
  chat_id        INTEGER,
  text           TEXT
);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts);

-- Передача человеку: какое сообщение у персонала относится к какому клиенту (ответ реплаем → уходит клиенту).
CREATE TABLE IF NOT EXISTS relays (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  client_id  INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

-- Мониторинг сайта клиента: каждая проверка (для % доступности) …
CREATE TABLE IF NOT EXISTS uptime_checks (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  ok     INTEGER NOT NULL,          -- 1 | 0
  status INTEGER NOT NULL,          -- HTTP-код; 0 — нет ответа (таймаут, сеть)
  ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uptime_checks_ts ON uptime_checks (ts);

-- … и падения: одно сообщение на падение (alerted), одно на восстановление (end_ts). Открытое падение — end_ts IS NULL.
CREATE TABLE IF NOT EXISTS uptime_incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts    INTEGER NOT NULL,     -- первая неудачная проверка
  end_ts      INTEGER,
  fails       INTEGER NOT NULL DEFAULT 1,
  alerted     INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER NOT NULL DEFAULT 0,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS uptime_incidents_open ON uptime_incidents (end_ts);

-- Ежемесячный отчёт: один раз на месяц (как reminders_log: захват → отправка → sent/failed, до 3 попыток).
CREATE TABLE IF NOT EXISTS reports_log (
  month    TEXT PRIMARY KEY,        -- 'ГГГГ-ММ' — за какой месяц отчёт
  status   TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  ts       INTEGER NOT NULL
);

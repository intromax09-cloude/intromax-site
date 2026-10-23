-- Таблиці AI-агента в D1 intromax-chat (поруч із chat / msg / tgm живого чату).
-- Застосувати: npx -y wrangler@latest d1 execute intromax-chat --remote --file inbox/intromax-site/ai/schema.sql
CREATE TABLE IF NOT EXISTS ai_use (day TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, k));
CREATE TABLE IF NOT EXISTS ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sid TEXT, q TEXT, a TEXT, status TEXT, lang TEXT, page TEXT, mid INTEGER);
CREATE INDEX IF NOT EXISTS ai_log_mid ON ai_log (mid);
CREATE INDEX IF NOT EXISTS ai_log_ts ON ai_log (ts);
CREATE TABLE IF NOT EXISTS ai_kb (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, q TEXT NOT NULL, a TEXT NOT NULL);

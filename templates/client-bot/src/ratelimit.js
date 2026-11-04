/**
 * Ограничение частоты запросов от одного пользователя: фиксированное окно (по умолчанию 60 с).
 * Счётчик хранится в D1 (rate_limit), здесь — чистая арифметика и один запрос в базу.
 */

export const WINDOW_MS = 60000;

export function windowId(now, windowMs = WINDOW_MS) { return Math.floor(now / windowMs); }

/** n — сколько запросов уже было в окне ВКЛЮЧАЯ текущий. → 'ok' | 'warn' (первое превышение: скажем один раз) | 'drop' */
export function decide(n, max) {
  if (n <= max) return 'ok';
  if (n === max + 1) return 'warn';
  return 'drop';
}

/** Учитывает запрос и возвращает решение. db — интерфейс D1. */
export async function hit(db, key, now, max, windowMs = WINDOW_MS) {
  const w = windowId(now, windowMs);
  const row = await db.prepare(
    'INSERT INTO rate_limit (k, w, n) VALUES (?, ?, 1) ON CONFLICT(k, w) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(key, w).first();
  return decide(row ? row.n : 1, max);
}

export async function purgeOld(db, now, windowMs = WINDOW_MS) {
  await db.prepare('DELETE FROM rate_limit WHERE w < ?').bind(windowId(now, windowMs) - 2).run();
}

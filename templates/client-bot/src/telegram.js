/**
 * Вызов Telegram Bot API. Токен нигде не логируем и не кладём в сообщения об ошибках.
 * Возвращает разобранный JSON ответа ({ok, result|description}) или null при сетевой ошибке/таймауте.
 */
export const DEFAULT_API_BASE = 'https://api.telegram.org';

/** apiBase нужен только для локальных проверок (мок-сервер); в бою не задаётся. */
export function makeTg(token, fetchImpl, apiBase) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  return async function tg(method, body) {
    try {
      const res = await f(base + '/bot' + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000)
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  };
}

/** Сравнение секретов за постоянное время (через SHA-256, чтобы длина не выдавала содержимое). */
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a))), crypto.subtle.digest('SHA-256', enc.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

/** Меню команд бота (кнопка «Меню» в Telegram). Команды — только латиница: так требует Bot API. */
export const BOT_COMMANDS = [
  { command: 'start', description: 'Меню / Menu' },
  { command: 'today', description: 'Записи на сьогодні (власник, майстри)' },
  { command: 'tomorrow', description: 'Записи на завтра (власник, майстри)' },
  { command: 'block', description: 'Заблокувати час (власник, майстри)' }
];

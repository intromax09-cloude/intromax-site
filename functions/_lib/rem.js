/**
 * Спільне для нагадувань про дзвінок: /api/lead ставить нагадування в KV,
 * /api/tg (вебхук бота) привʼязує чат клієнта, /api/tick (кожні 5 хв) надсилає те, що настало.
 * KV-простір REM привʼязується до проєкту Pages у панелі Cloudflare (Settings → Bindings).
 * Ключі: rem:<код> — нагадування, tg:me — username бота, tg:webhook — вебхук уже зареєстровано.
 */

export const TZ = 'Europe/Kyiv';
export const BEFORE_MS = 60 * 60 * 1000;      // нагадуємо за годину
export const STALE_MS = 2 * 60 * 60 * 1000;   // дзвінок минув понад дві години тому — нагадування забути

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* секрет вебхука виводиться з токена бота: окремої змінної оточення не потрібно */
export async function webhookSecret(env) {
  return (await sha256('intromax-webhook:' + env.TG_TOKEN)).slice(0, 48);
}

/* зсув часового поясу у хвилинах на момент ms */
export function tzOffset(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - ms) / 60000);
}

/* «2026-10-19» + «12:00» за Києвом → мітка часу UTC (з урахуванням літнього часу) */
export function kyivToUtc(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - tzOffset(guess, TZ) * 60000;
  ms = guess - tzOffset(ms, TZ) * 60000;
  return ms;
}

export function kyivTime(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p.hour + ':' + p.minute;
}

export async function tg(env, method, body) {
  const res = await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) return null;
  try { return await res.json(); } catch (e) { return null; }
}

export async function send(env, chatId, text) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

/* username бота — для посилання t.me/<бот>?start=…; кешується в KV на місяць */
export async function botName(env) {
  if (!env.REM) return '';
  let name = await env.REM.get('tg:me');
  if (name) return name;
  const r = await tg(env, 'getMe', {});
  name = (r && r.result && r.result.username) || '';
  if (name) await env.REM.put('tg:me', name, { expirationTtl: 30 * 86400 });
  return name;
}

/* код нагадування: 8 символів без схожих літер */
export function newCode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/* нагадування за годину до дзвінка або, якщо дзвінок ближче, одразу */
export function dueAt(rem) {
  return rem.at - BEFORE_MS;
}

export function minutesLeft(rem, now) {
  return Math.max(0, Math.round((rem.at - now) / 60000));
}

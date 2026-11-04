import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHarness, barberRaw, OWNER } from './helpers/harness.js';
import { safeError } from '../src/bot.js';
import { runTick } from '../src/tick.js';

const ROOT = new URL('../', import.meta.url);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.wrangler') continue;
    const u = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? '/' : ''), dir);
    if (name.endsWith('/')) continue;
    if (statSync(u).isDirectory()) walk(u, out); else out.push(u);
  }
  return out;
}
const files = walk(ROOT).filter((u) => /\.(js|mjs|json|toml|example|sql|md)$/.test(u.pathname));

test('в шаблоне нет зашитых токенов и ключей', () => {
  assert.ok(files.length > 30);
  const tokenRe = /\b\d{8,11}:[A-Za-z0-9_-]{30,}\b/;                 // формат токена BotFather
  const keyRe = /\b(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})\b/;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!tokenRe.test(text), 'похоже на токен Telegram: ' + f.pathname);
    assert.ok(!keyRe.test(text), 'похоже на ключ: ' + f.pathname);
  }
});

test('секреты читаются только из окружения; адрес Bot API и подстановка токена — в одном месте', () => {
  const src = files.filter((u) => /\/(src|functions|cron-worker|scripts)\//.test(u.pathname) && u.pathname.endsWith('.js') || u.pathname.endsWith('.mjs') && /\/scripts\//.test(u.pathname));
  const withBotUrl = src.filter((u) => readFileSync(u, 'utf8').includes('api.telegram.org'));
  assert.deepEqual(withBotUrl.map((u) => u.pathname.split('/').slice(-2).join('/')), ['src/telegram.js']);
  for (const u of src) {
    const t = readFileSync(u, 'utf8');
    assert.ok(!/(TG_TOKEN|WEBHOOK_SECRET|TICK_SECRET)\s*[:=]\s*['"][^'"]+['"]/.test(t.replace(/process\.env|env\./g, '')), 'зашитый секрет в ' + u.pathname);
  }
});

test('в src и functions нет console.log; console.error не печатает данные клиентов', () => {
  const src = files.filter((u) => /\/(src|functions|cron-worker)\//.test(u.pathname) && u.pathname.endsWith('.js'));
  for (const u of src) {
    const t = readFileSync(u, 'utf8');
    assert.ok(!/console\.(log|info|debug|warn)\(/.test(t), 'console.* в ' + u.pathname);
    for (const m of t.matchAll(/console\.error\(([^)]*)\)/g)) {
      assert.ok(!/\b(text|phone|name|contact|body|update|msg|message\b(?!\s*\))|username)\b/.test(m[1].replace(/\b(err|e)\.(message|name)\b/g, '').replace(/safeError\([^)]*\)/g, '')), 'console.error с данными: ' + m[0] + ' в ' + u.pathname);
    }
  }
});

test('safeError вырезает телефоны, id и токены из текста ошибки', () => {
  const fakeToken = ['123456789', 'AAFh3kd8s9sdf8s9d8f7s9d8f7s9d8f7sdf'].join(':');   // собран на лету, чтобы сам тест не выглядел утечкой
  const e = new Error('сбой для +380501234567, chat 123456789, token ' + fakeToken);
  const s = safeError(e);
  assert.doesNotMatch(s, /380501234567|123456789|AAFh3k/);
  assert.match(s, /^Error:/);
});

test('полный сценарий (запись, подтверждение, тик, ошибка): в console попадает только обезличенная ошибка', async () => {
  const spied = [];
  const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => spied.push(a.join(' ')); }
  try {
    const h = createHarness({ logs: undefined });
    await h.book(5001, { name: 'Секретна Людина', phone: '0509998877', date: '2026-11-04', time: '1200' });
    await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
    await runTick({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now + 40 * 3600000 });
    const real = h.db.prepare;
    h.db.prepare = (q) => { if (/FROM sessions/.test(q)) throw new Error('db error for +380509998877'); return real(q); };
    // свой логгер не передаём — проверяем поведение по умолчанию
    const { createBot } = await import('../src/bot.js');
    const bot = createBot({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: () => h.clock.now });
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, from: { id: 5001 }, chat: { id: 5001, type: 'private' }, text: 'Секретна Людина 0509998877' } });
  } finally { for (const k of Object.keys(orig)) console[k] = orig[k]; }
  const out = spied.join('\n');
  assert.ok(spied.length >= 1, 'ошибка залогирована');
  assert.doesNotMatch(out, /0509998877|380509998877|Секретна/);
});

test('персональные данные клиентов лежат только в таблицах clients (имя, телефон, username) и не попадают в журнал напоминаний/сессии', async () => {
  const h = createHarness();
  await h.book(5001, { name: 'Дані Тест', phone: '0501112233', date: '2026-11-04', time: '1200' });
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  await runTick({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now + 40 * 3600000 });
  for (const t of ['appointments', 'blocks', 'reminders_log', 'rate_limit', 'cards', 'sessions']) {
    const dump = JSON.stringify((await h.db.prepare('SELECT * FROM ' + t).all()).results);
    assert.doesNotMatch(dump, /Дані Тест|0501112233|380501112233/, 'ПДн в таблице ' + t);
  }
  assert.match(JSON.stringify((await h.db.prepare('SELECT * FROM clients').all()).results), /Дані Тест/);
});

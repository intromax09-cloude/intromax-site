import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook } from '../src/webhook.js';
import { makeTg, safeEqual } from '../src/telegram.js';
import { parseConfig } from '../src/config.js';
import { createD1 } from './helpers/d1.js';
import { createFakeTelegram, installFetchMock, messageUpdate, callbackUpdate } from './helpers/fake-telegram.js';
import { barberRaw, at, OWNER } from './helpers/harness.js';

const TOKEN = 'TEST_TOKEN_NOT_REAL';
const SECRET = 'sekret_for_tests_0123456789abcdef';
const cfg = parseConfig(barberRaw());
const NOW = at('2026-11-02', '09:00');

function setup(envExtra) {
  const fake = createFakeTelegram();
  const net = installFetchMock(fake);
  const db = createD1();
  const env = Object.assign({ TG_TOKEN: TOKEN, WEBHOOK_SECRET: SECRET, DB: db }, envExtra);
  const call = (body, { secret = SECRET, method = 'POST', headers = {}, raw } = {}) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret }, headers);
    return handleWebhook({
      request: new Request('https://bot.example/api/tg', { method, headers: h, body: method === 'GET' ? undefined : (raw !== undefined ? raw : JSON.stringify(body)) }),
      env, cfg, tg: makeTg(TOKEN), now: () => NOW, log: () => {}
    });
  };
  return { fake, net, db, env, call };
}

test('верный секрет: update обработан, ответ 200, вызов ушёл в Bot API с токеном из окружения', async () => {
  const s = setup();
  try {
    const res = await s.call(messageUpdate(5001, '/start'));
    assert.equal(res.status, 200);
    assert.equal(s.fake.sent(5001).length, 1);
    assert.equal(s.fake.calls[0].token, TOKEN);
    assert.deepEqual(s.net.outside, []);
  } finally { s.net.restore(); }
});

test('секрет вебхука: без заголовка, неверный, другой длины, пустой — 403, и бот не делает ничего', async () => {
  const s = setup();
  try {
    for (const secret of [null, '', 'wrong', SECRET + 'x', SECRET.slice(0, -1), SECRET.toUpperCase()]) {
      const res = await s.call(messageUpdate(5001, '/start'), { secret });
      assert.equal(res.status, 403, 'секрет: ' + JSON.stringify(secret));
    }
    assert.equal(s.fake.calls.length, 0, 'ни одного вызова Telegram');
    assert.equal((await s.db.prepare('SELECT COUNT(*) AS n FROM rate_limit').first()).n, 0, 'база не тронута');
  } finally { s.net.restore(); }
});

test('секрет не настроен — бот не принимает ничего (даже пустой заголовок)', async () => {
  const s = setup({ WEBHOOK_SECRET: undefined });
  try {
    for (const secret of [null, '', 'x']) assert.equal((await s.call(messageUpdate(5001, '/start'), { secret })).status, 500);
    assert.equal(s.fake.calls.length, 0);
  } finally { s.net.restore(); }
  const s2 = setup({ TG_TOKEN: undefined });
  try { assert.equal((await s2.call(messageUpdate(5001, '/start'))).status, 500); } finally { s2.net.restore(); }
  const s3 = setup({ DB: undefined });
  try { assert.equal((await s3.call(messageUpdate(5001, '/start'))).status, 500); } finally { s3.net.restore(); }
});

test('safeEqual: сравнение по содержимому', async () => {
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('', ''), true);
  assert.equal(await safeEqual('abc', 'abcd'), false);
});

test('плохой метод, не-JSON, слишком большое тело, не-объект', async () => {
  const s = setup();
  try {
    assert.equal((await s.call(null, { method: 'GET' })).status, 405);
    assert.equal((await s.call(null, { raw: '{не json' })).status, 400);
    assert.equal((await s.call(null, { raw: '"строка"' })).status, 400);
    assert.equal((await s.call(null, { raw: 'null' })).status, 400);
    assert.equal((await s.call(null, { raw: JSON.stringify({ message: { text: 'x'.repeat(70000) } }) })).status, 413);
    assert.equal(s.fake.calls.length, 0);
  } finally { s.net.restore(); }
});

test('неизвестные типы update принимаются молча (200), чтобы Telegram не повторял их', async () => {
  const s = setup();
  try {
    assert.equal((await s.call({ update_id: 1, my_chat_member: {} })).status, 200);
    assert.equal((await s.call({ update_id: 2, edited_message: { text: 'x' } })).status, 200);
    assert.equal(s.fake.calls.length, 0);
  } finally { s.net.restore(); }
});

test('TG_CHAT_ID из окружения тоже считается владельцем и получает заявки', async () => {
  const s = setup({ TG_CHAT_ID: '777000111' });
  try {
    const step = (u) => s.call(u);
    let mid = 50;
    const press = (data) => step(callbackUpdate(5001, data, mid));
    await step(messageUpdate(5001, '/start'));
    await press('book'); await press('svc:beard'); await press('mst:any'); await press('day:2026-11-03'); await press('slot:1000');
    await step(messageUpdate(5001, 'Анна')); await step(messageUpdate(5001, '0931112233'));
    await press('ok');
    assert.ok(s.fake.sent(777000111).some((m) => /Нова заявка #1/.test(m.body.text)));
    assert.ok(s.fake.sent(OWNER).some((m) => /Нова заявка #1/.test(m.body.text)), 'и владелец из config.json');
    // персонал по TG_CHAT_ID видит меню персонала
    await step(messageUpdate(777000111, '/start'));
    const kb = s.fake.sent(777000111).at(-1).body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(kb.includes('st:today'));
  } finally { s.net.restore(); }
});

test('Telegram недоступен: бот не падает, отвечает 200', async () => {
  const s = setup();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const res = await s.call(messageUpdate(5001, '/start'));
    assert.equal(res.status, 200);
  } finally { globalThis.fetch = orig; s.net.restore(); }
});

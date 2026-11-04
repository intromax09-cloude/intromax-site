import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, hit, windowId, purgeOld, WINDOW_MS } from '../src/ratelimit.js';
import { createD1 } from './helpers/d1.js';

test('decide: ok до лимита, одно предупреждение, дальше молча', () => {
  assert.equal(decide(1, 3), 'ok');
  assert.equal(decide(3, 3), 'ok');
  assert.equal(decide(4, 3), 'warn');
  assert.equal(decide(5, 3), 'drop');
  assert.equal(decide(500, 3), 'drop');
});

test('hit: считает по ключу и окну, другой пользователь не страдает, новое окно сбрасывает', async () => {
  const db = createD1();
  const t0 = 10 * WINDOW_MS + 5;
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(await hit(db, 'u:1', t0 + i, 3));
  assert.deepEqual(seq, ['ok', 'ok', 'ok', 'warn', 'drop', 'drop']);
  assert.equal(await hit(db, 'u:2', t0, 3), 'ok');
  assert.equal(await hit(db, 'u:1', t0 + WINDOW_MS, 3), 'ok');
});

test('purgeOld удаляет старые окна', async () => {
  const db = createD1();
  await hit(db, 'u:1', 0, 5);
  await hit(db, 'u:1', 20 * WINDOW_MS, 5);
  await purgeOld(db, 20 * WINDOW_MS);
  const left = (await db.prepare('SELECT w FROM rate_limit').all()).results.map((r) => r.w);
  assert.deepEqual(left, [windowId(20 * WINDOW_MS)]);
});

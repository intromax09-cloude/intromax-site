import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createD1, SCHEMA } from './helpers/d1.js';

const names = (db) => db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r }));
const columns = (db, t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name + ':' + c.type + ':' + c.notnull);

test('migrations/ в сумме дают ровно ту же схему, что schema.sql', () => {
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 1);
  assert.match(files[0], /^0001_/);
  const a = new DatabaseSync(':memory:'); a.exec(SCHEMA);
  const b = new DatabaseSync(':memory:');
  for (const f of files) b.exec(readFileSync(new URL(f, dir), 'utf8'));
  assert.deepEqual(names(b), names(a));
  for (const t of names(a).filter((x) => x.type === 'table').map((x) => x.name)) assert.deepEqual(columns(b, t), columns(a, t), t);
});

test('схема содержит все нужные таблицы клиентских данных', () => {
  const d = new DatabaseSync(':memory:'); d.exec(SCHEMA);
  const t = names(d).filter((x) => x.type === 'table').map((x) => x.name);
  for (const need of ['clients', 'appointments', 'blocks', 'reminders_log', 'sessions', 'rate_limit', 'cards']) assert.ok(t.includes(need), need);
});

test('schema.sql можно применять повторно (IF NOT EXISTS)', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA); d.exec(SCHEMA);
});

test('уникальный индекс не даёт записать двоих к одному мастеру на одно время, но отменённая не мешает', async () => {
  const db = createD1();
  const ins = (status, master = 'a', start = 1000) => db.prepare(
    "INSERT INTO appointments (client_id, service_id, service_name, master_id, start_ts, end_ts, status, booked_at, created_at, updated_at) VALUES (1,'s','S',?,?,?,?,0,0,0)"
  ).bind(master, start, start + 10, status).run();
  await ins('pending');
  await assert.rejects(ins('confirmed'), /UNIQUE/);
  await ins('pending', 'b');                 // другой мастер — можно
  await ins('cancelled');                    // отменённая — можно
  await db.prepare("UPDATE appointments SET status='cancelled' WHERE master_id='a' AND status='pending'").run();
  await ins('confirmed');                    // место освободилось
});

test('CHECK на статусы: произвольный статус не пройдёт', async () => {
  const db = createD1();
  await assert.rejects(db.prepare("INSERT INTO appointments (client_id, service_id, service_name, master_id, start_ts, end_ts, status, booked_at, created_at, updated_at) VALUES (1,'s','S','a',1,2,'weird',0,0,0)").run(), /CHECK/);
});

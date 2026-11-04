/**
 * Обёртка над встроенным node:sqlite с интерфейсом D1 (prepare().bind().first()/all()/run(), batch).
 * Так тесты гоняют НАСТОЯЩИЕ SQL-запросы шаблона и настоящую schema.sql, без Cloudflare.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export const SCHEMA = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

export function createD1(schema = SCHEMA) {
  const db = new DatabaseSync(':memory:');
  if (schema) db.exec(schema);
  const statement = (query, params) => ({
    bind: (...p) => statement(query, p),
    async first() { const r = db.prepare(query).get(...params); return r === undefined ? null : { ...r }; },
    async all() { return { results: db.prepare(query).all(...params).map((r) => ({ ...r })) }; },
    async run() { const r = db.prepare(query).run(...params); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
  });
  return {
    prepare: (q) => statement(q, []),
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: (sql) => db.exec(sql),
    raw: db
  };
}

/**
 * Склейка с Cloudflare Pages: конфиг клиента (config.json вшивается при сборке) и вызов Telegram.
 * Вся логика — в ../../src; здесь ничего, что нужно тестировать отдельно.
 */
import raw from '../../config.json';
import { parseConfig, ConfigError } from '../../src/config.js';
import { makeTg } from '../../src/telegram.js';

let cached;
export function getConfig() {
  if (!cached) cached = parseConfig(raw);   // ConfigError с перечнем проблем, если config.json неверный
  return cached;
}

export function respondConfigError(err) {
  if (err instanceof ConfigError) console.error(err.message);   // в конфиге нет персональных данных
  else console.error('config', err && err.name);
  return new Response('Config error', { status: 500 });
}

export { makeTg };

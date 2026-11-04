#!/usr/bin/env node
/**
 * Проверка config.json (или файла из аргумента) без запуска чего-либо в сети.
 *   node scripts/check-config.mjs [путь/к/config.json]
 * Печатает все найденные проблемы разом; код выхода 1, если они есть.
 */
import { readFileSync } from 'node:fs';
import { parseConfig, ConfigError } from '../src/config.js';

const file = process.argv[2] || new URL('../config.json', import.meta.url).pathname;
let raw;
try { raw = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error('Не удалось прочитать ' + file + ': ' + (e.name === 'SyntaxError' ? 'это не корректный JSON (' + e.message + ')' : e.message)); process.exit(1); }
try {
  const cfg = parseConfig(raw);
  const owners = cfg.owner.chatIds.length;
  console.log('OK: ' + file);
  console.log('  ' + cfg.business.name + ' · ниша ' + cfg.business.niche + ' · язык ' + cfg.business.language + ' · пояс ' + cfg.business.timezone);
  console.log('  услуг: ' + cfg.services.length + ', мастеров: ' + cfg.masters.length + ', владельцев в конфиге: ' + owners + (owners ? '' : ' (задайте TG_CHAT_ID в окружении)'));
  console.log('  напоминания: ' + (cfg.reminders.enabled ? 'за ' + cfg.reminders.beforeHours.join(' ч и за ') + ' ч' : 'выключены') + (cfg.reminders.reviewUrl ? ', отзыв после визита' : ', без просьбы об отзыве'));
} catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(1); }
  throw e;
}

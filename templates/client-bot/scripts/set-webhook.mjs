#!/usr/bin/env node
/**
 * Регистрирует вебхук бота в Telegram и меню команд. Запускается ВАМИ локально один раз после деплоя:
 *   TG_TOKEN=... WEBHOOK_SECRET=... node scripts/set-webhook.mjs https://<проект>.pages.dev
 * Токен и секрет берутся только из переменных окружения; в вывод они не попадают.
 * Методы Bot API: setWebhook (secret_token, allowed_updates), setMyCommands.
 */
import { makeTg, BOT_COMMANDS } from '../src/telegram.js';

const { TG_TOKEN, WEBHOOK_SECRET } = process.env;
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!TG_TOKEN || !WEBHOOK_SECRET || !/^https:\/\/\S+$/.test(base)) {
  console.error('Использование: TG_TOKEN=… WEBHOOK_SECRET=… node scripts/set-webhook.mjs https://<проект>.pages.dev');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{16,256}$/.test(WEBHOOK_SECRET)) {
  console.error('WEBHOOK_SECRET: 16–256 символов, только A-Z a-z 0-9 _ - (требование Telegram). Сгенерировать: openssl rand -hex 24');
  process.exit(1);
}
const tg = makeTg(TG_TOKEN);
const hook = await tg('setWebhook', { url: base + '/api/tg', secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
console.log('setWebhook:', hook && hook.ok ? 'ok' : 'ОШИБКА — ' + (hook && hook.description ? hook.description : 'нет ответа'));
const cmds = await tg('setMyCommands', { commands: BOT_COMMANDS });
console.log('setMyCommands:', cmds && cmds.ok ? 'ok' : 'ОШИБКА — ' + (cmds && cmds.description ? cmds.description : 'нет ответа'));
const info = await tg('getWebhookInfo', {});
if (info && info.ok) console.log('getWebhookInfo: url=' + info.result.url + ', ожидающих обновлений=' + info.result.pending_update_count + (info.result.last_error_message ? ', последняя ошибка: ' + info.result.last_error_message : ''));
process.exit(hook && hook.ok ? 0 : 1);

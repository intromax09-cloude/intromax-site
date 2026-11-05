/**
 * Эмулятор Telegram для тестов: принимает вызовы Bot API, записывает их и отвечает как Telegram.
 * В сеть не ходит. installFetchMock() подменяет глобальный fetch и валит тест, если код полез куда-либо,
 * кроме api.telegram.org (и только в эмулятор).
 */
export function createFakeTelegram() {
  let mid = 1000;
  const calls = [];
  const failures = new Map();            // chat_id → {error_code, description}: ответить ошибкой на sendMessage этому чату
  const fake = {
    calls,
    failFor(chatId, error_code = 403, description = 'Forbidden: bot was blocked by the user') { failures.set(Number(chatId), { error_code, description }); },
    clearFailures() { failures.clear(); },
    reset() { calls.length = 0; },
    async tg(method, body) {
      const call = { method, body: JSON.parse(JSON.stringify(body || {})) };
      calls.push(call);
      if (method === 'sendMessage') {
        const f = failures.get(Number(body.chat_id));
        if (f) return { ok: false, error_code: f.error_code, description: f.description };
        call.mid = ++mid;
        return { ok: true, result: { message_id: call.mid, chat: { id: body.chat_id }, text: body.text } };
      }
      return { ok: true, result: true };
    },
    /** Все sendMessage в чат. */
    sent(chatId) { return calls.filter((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === Number(chatId)); },
    texts(chatId) { return fake.sent(chatId).map((c) => c.body.text); },
    methods() { return calls.map((c) => c.method); }
  };
  return fake;
}

export function installFetchMock(fake) {
  const original = globalThis.fetch;
  const outside = [];
  globalThis.fetch = async (url, init) => {
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(String(url));
    if (!m) { outside.push(String(url)); throw new Error('Тест не должен ходить в сеть: ' + url); }
    const body = init && init.body ? JSON.parse(init.body) : {};
    const r = await fake.tg(m[2], body);
    fake.calls[fake.calls.length - 1].token = m[1];
    return new Response(JSON.stringify(r), { status: r.ok ? 200 : (r.error_code || 400), headers: { 'Content-Type': 'application/json' } });
  };
  return { outside, restore() { globalThis.fetch = original; } };
}

/* ---- конструкторы update-ов, как их присылает Telegram ---- */
let uid = 1;
export function messageUpdate(userId, text, extra = {}) {
  const from = Object.assign({ id: userId, is_bot: false, first_name: 'Тест' + userId }, extra.from);
  return { update_id: uid++, message: Object.assign({ message_id: uid + 5000, from, chat: { id: extra.chatId || userId, type: extra.chatType || 'private' }, date: 0, text }, extra.message) };
}
export function contactUpdate(userId, phone, contactUserId) {
  const u = messageUpdate(userId, undefined);
  delete u.message.text;
  u.message.contact = { phone_number: phone, first_name: 'Тест', user_id: contactUserId === undefined ? userId : contactUserId };
  return u;
}
export function callbackUpdate(userId, data, messageId, extra = {}) {
  const from = Object.assign({ id: userId, is_bot: false, first_name: 'Тест' + userId }, extra.from);
  return { update_id: uid++, callback_query: { id: 'cb' + uid, from, message: { message_id: messageId, chat: { id: extra.chatId || userId, type: extra.chatType || 'private' }, date: 0 }, chat_instance: 'x', data } };
}

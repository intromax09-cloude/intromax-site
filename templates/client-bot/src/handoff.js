/**
 * Передача диалога человеку («Звʼязатися з адміністратором») и журнал вопросов, на которые бот не ответил.
 *
 * Клиент просит человека (кнопка, команда /admin или слова «людина», «оператор», «менеджер»…) →
 * владельцу(ам) уходит карточка-выжимка из двух строк: ЧТО ХОЧЕТ (его вопрос) и ЧТО УЖЕ ВЫБРАЛ/СДЕЛАЛ
 * (услуга, мастер, время из незавершённой записи или ближайшая запись), чтобы клиенту не пришлось повторять.
 * Живой чат: оператор отвечает реплаем на карточку — бот пересылает клиенту; клиент дописывает — бот пересылает
 * оператору (сессия 'live' до /start или сутки). Связь «сообщение у оператора → клиент» — таблица relays.
 */
import { getClient, setSession, getSession, saveRelay, relayTarget, lastQuestion, nextForClient, logEvent, maskQuestion } from './store.js';
import { dateLabel, hm, dateOf, usernameLine, cleanName } from './format.js';
import { raw } from './texts.js';

const HUMAN_RE = /(людин|оператор|адмін|админ|менеджер|человек|живий|живой|живим|живым|зв.?яж|связат|покличте|позовите)/i;
const SHORT_REQUEST = 40;                    // «покличте людину» — просьба без сути; длиннее — уже и есть вопрос
const RECENT_Q_MS = 30 * 60000;              // неотвеченный вопрос за последние 30 минут подставляется в выжимку
const SMALL_TALK = /^(привіт|привет|вітаю|здрасту?йте|здравствуйте|добр\S*( день| ранок| вечір| утро| вечер)?|дякую|спасибі|спасибо|дуже дякую|ок|окей|ok|добре|хорошо|ясно|зрозуміло|понятно|так|да|ні|нет|hi|hello|thanks)[\s!.)👍🙏]*$/i;

/** Просит ли клиент живого человека. */
export function wantsHuman(text) { return HUMAN_RE.test(String(text || '')); }

/** Похоже ли на вопрос/просьбу (а не «привіт», «дякую», «ок»), чтобы не засорять отчёт. */
export function isQuestion(text) {
  const t = String(text || '').trim();
  if (SMALL_TALK.test(t)) return false;
  return (t.match(/\p{L}/gu) || []).length >= 4;
}

/** Свободный текст, на который у бота нет ответа в меню: в журнал для ежемесячного отчёта. */
export async function logUnanswered(c, u, text) {
  if (!isQuestion(text)) return false;
  await logEvent(c.db, 'unanswered', c.now(), { chatId: u.chat, actor: 'client', text });
  return true;
}

/** Вторая строка выжимки: что клиент уже выбрал или сделал (HTML). */
export async function doneLine(c, chatId, sess) {
  const cfg = c.cfg;
  if (sess && sess.svc && cfg.servicesById[sess.svc]) {
    const parts = [];
    if (sess.resched) parts.push('#' + sess.resched);
    parts.push(cfg.servicesById[sess.svc].name);
    const m = cfg.mastersById[sess.mst];
    if (m) parts.push(m.name);
    if (sess.start) parts.push(dateLabel(cfg, dateOf(cfg, sess.start)) + ', ' + hm(cfg, sess.start));
    else if (sess.date) parts.push(dateLabel(cfg, sess.date));
    return c.t(sess.resched ? 'human_done_resched' : 'human_done_flow', { parts: parts.join(' · ') });
  }
  const a = await nextForClient(c.db, chatId, c.now());
  if (a) return c.t('human_done_appt', { when: dateLabel(cfg, dateOf(cfg, a.start_ts)), time: hm(cfg, a.start_ts), service: a.service_name, status: raw(c.statusText(a)) });
  return c.t('human_done_none');
}

async function whoIs(c, u) {
  const cl = await getClient(c.db, u.chat);
  return {
    name: (cl && cl.name) || cleanName(u.from && u.from.first_name) || ('id ' + u.chat),
    phone: cl && cl.phone ? ', ' + cl.phone : '',
    username: (cl && cl.username) || (u.from && u.from.username) || null
  };
}

const operators = (c) => [...c.ownerIds];

/** Сделать сессию клиента «живым чатом» (сохранив незавершённую запись на случай выжимки по повторной просьбе). */
async function goLive(c, chatId, flow) {
  await setSession(c.db, chatId, { step: 'live', flow: flow || null }, c.now());
}

/**
 * Клиент просит человека. text — его сообщение (null — нажата кнопка), asked — ответ на «напишіть, що потрібно».
 * Шлёт выжимку операторам; если сути нет (ни вопроса в сообщении, ни недавнего неотвеченного) — сначала спрашивает.
 */
export async function startHandoff(c, u, sess, text, asked) {
  const cfg = c.cfg, now = c.now();
  const chats = operators(c);
  if (!chats.length) {
    console.error('handoff: нет получателей — задайте owner.chatIds в config.json или TG_CHAT_ID в окружении');
    await c.send(u.chat, c.t('human_none', { phone: cfg.business.phone || '—' }));
    return;
  }
  const flow = sess && (sess.step === 'human_ask' || sess.step === 'live') ? sess.flow : sess;
  let want = text && (asked || text.length > SHORT_REQUEST || !wantsHuman(text)) ? text : null;
  if (!want) want = await lastQuestion(c.db, u.chat, now - RECENT_Q_MS);
  if (!want && !asked && (!sess || sess.step !== 'live')) {
    await setSession(c.db, u.chat, { step: 'human_ask', flow: flow || null }, now);
    await c.send(u.chat, c.t('human_ask'));
    return;
  }
  const who = await whoIs(c, u);
  const card = c.t('human_card', {
    want: want ? '«' + maskQuestion(want) + '»' : cfg.texts.human_want_none,
    done: raw(await doneLine(c, u.chat, flow)),
    client: who.name, phone: who.phone, username: raw(usernameLine({ username: who.username }))
  });
  let delivered = 0;
  for (const chat of chats) {
    const mid = await c.send(chat, card);
    if (mid) { delivered++; await saveRelay(c.db, chat, mid, u.chat, now); }
  }
  if (!delivered) { await c.send(u.chat, c.t('human_none', { phone: cfg.business.phone || '—' })); return; }
  await logEvent(c.db, 'handoff', now, { actor: 'client' });
  await goLive(c, u.chat, flow);
  await c.send(u.chat, c.t('human_sent'), { inline_keyboard: [[{ text: c.p('back'), callback_data: 'menu' }]] });
}

/** Клиент в «живом чате» что-то дописал — переслать операторам (на их сообщение можно ответить реплаем). */
export async function relayFromClient(c, u, sess, text) {
  const now = c.now();
  const who = await whoIs(c, u);
  for (const chat of operators(c)) {
    const mid = await c.send(chat, c.t('human_client_msg', { client: who.name, text: text.slice(0, 1000) }));
    await saveRelay(c.db, chat, mid, u.chat, now);
  }
  await goLive(c, u.chat, sess && sess.flow);
}

/** Оператор ответил реплаем на карточку/сообщение клиента — отправить клиенту. true — это был такой ответ. */
export async function relayFromStaff(c, msg) {
  const reply = msg.reply_to_message;
  if (!reply || !c.isStaff(msg.chat.id)) return false;
  const target = await relayTarget(c.db, msg.chat.id, reply.message_id);
  if (!target) return false;
  const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 3000) : '';
  if (!text) return true;                      // фото/стикеры не пересылаем
  const ok = await c.send(target, c.t('human_reply', { biz: c.cfg.business.name, text }));
  if (ok && !(await getSession(c.db, target, c.now()))) await goLive(c, target, null);   // ответ клиента снова уйдёт оператору
  await c.send(msg.chat.id, c.t(ok ? 'human_delivered' : 'human_failed'));
  return true;
}

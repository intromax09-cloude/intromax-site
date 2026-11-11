/**
 * Разбор и проверка config.json клиента. Чистый JS.
 * parseConfig(raw) → нормализованный конфиг или ConfigError со СПИСКОМ всех найденных проблем
 * (каждая — с путём в файле и понятным текстом по-русски), чтобы Максим исправил всё за один заход.
 */
import { NICHES, LANGS, TEXT_KEYS, buildTexts, checkHtml } from './texts.js';
import { isValidTimeZone, parseHM, WEEKDAYS } from './time.js';

export class ConfigError extends Error {
  constructor(errors) {
    super('Ошибки в config.json:\n - ' + errors.join('\n - '));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ID_RE = /^[a-z0-9_]{1,16}$/;
const RESERVED_IDS = ['_', 'any'];

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x) => Number.isInteger(x);

/** Часы одного дня → {open, close, breaks:[[a,b]]} в минутах, либо null (выходной). Ошибки пишет в errs. */
function parseDay(v, path, errs) {
  if (v === null) return null;
  if (!isObj(v)) { errs.push(path + ': ожидается объект {"open":"10:00","close":"20:00"} или null (выходной)'); return undefined; }
  const open = parseHM(v.open), close = parseHM(v.close);
  let ok = true;
  if (open === null || open >= 1440) { errs.push(path + '.open: нужно время вида "09:00", получено ' + JSON.stringify(v.open)); ok = false; }
  if (close === null) { errs.push(path + '.close: нужно время вида "20:00" (или "24:00"), получено ' + JSON.stringify(v.close)); ok = false; }
  if (!ok) return undefined;
  if (close <= open) { errs.push(path + ': закрытие (' + v.close + ') должно быть позже открытия (' + v.open + '). Работа через полночь не поддерживается — закрытие максимум 24:00'); return undefined; }
  const breaks = [];
  if (v.breaks !== undefined) {
    if (!Array.isArray(v.breaks)) { errs.push(path + '.breaks: ожидается список [{"from":"14:00","to":"15:00"}]'); return undefined; }
    v.breaks.forEach((b, i) => {
      const p = path + '.breaks[' + i + ']';
      const f = isObj(b) ? parseHM(b.from) : null, t = isObj(b) ? parseHM(b.to) : null;
      if (f === null || t === null) { errs.push(p + ': нужен вид {"from":"14:00","to":"15:00"}'); ok = false; return; }
      if (t <= f) { errs.push(p + ': конец перерыва (' + b.to + ') должен быть позже начала (' + b.from + ')'); ok = false; return; }
      if (f < open || t > close) { errs.push(p + ': перерыв ' + b.from + '–' + b.to + ' выходит за рабочие часы ' + v.open + '–' + v.close); ok = false; return; }
      breaks.push([f, t]);
    });
    if (!ok) return undefined;
    breaks.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i][0] < breaks[i - 1][1]) { errs.push(path + '.breaks: перерывы пересекаются'); return undefined; }
    }
  }
  return { open, close, breaks };
}

/**
 * Раскрывает ключи вида "mon", "mon-fri" в семь дней. partial=true — для мастера (можно задать не все дни).
 * Возвращает объект {mon:…|null|undefined, …}; undefined = «не задано».
 */
function parseHours(h, path, errs, partial) {
  const out = {};
  if (!isObj(h)) { errs.push(path + ': ожидается объект с днями недели'); return out; }
  for (const key of Object.keys(h)) {
    let days;
    const m = /^(mon|tue|wed|thu|fri|sat|sun)(?:-(mon|tue|wed|thu|fri|sat|sun))?$/.exec(key);
    if (!m) { errs.push(path + '.' + key + ': неизвестный ключ; допустимы mon, tue, wed, thu, fri, sat, sun и диапазоны вроде "mon-fri"'); continue; }
    if (m[2]) {
      const a = DAYS.indexOf(m[1]), b = DAYS.indexOf(m[2]);
      if (b < a) { errs.push(path + '.' + key + ': диапазон должен идти по порядку недели (например "mon-fri")'); continue; }
      days = DAYS.slice(a, b + 1);
    } else days = [m[1]];
    const val = parseDay(h[key], path + '.' + key, errs);
    for (const d of days) {
      if (d in out) { errs.push(path + ': день ' + d + ' задан дважды (в "' + key + '" и ещё раз)'); continue; }
      out[d] = val;
    }
  }
  if (!partial) {
    const missing = DAYS.filter((d) => !(d in out));
    if (missing.length) errs.push(path + ': не заданы дни: ' + missing.join(', ') + '. Для выходного укажите null');
  }
  return out;
}

function parseChatIds(v, path, errs) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { errs.push(path + ': ожидается список чисел, например [123456789]'); return []; }
  const out = [];
  v.forEach((x, i) => {
    if (!Number.isSafeInteger(x) || x === 0) errs.push(path + '[' + i + ']: chat id — целое число (не строка, не 0); получено ' + JSON.stringify(x));
    else out.push(x);
  });
  return out;
}

function num(v, path, errs, { def, min, max, int = true, name }) {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || (int && !isInt(v)) || v < min || v > max) {
    errs.push(path + ': ' + (name || 'число') + ' от ' + min + ' до ' + max + (int ? ' (целое)' : '') + '; получено ' + JSON.stringify(v));
    return def;
  }
  return v;
}

export function parseConfig(raw) {
  const errs = [];
  if (!isObj(raw)) throw new ConfigError(['корень config.json должен быть объектом { ... }']);

  const known = ['business', 'hours', 'booking', 'services', 'masters', 'owner', 'reminders', 'limits', 'privacy', 'faq', 'texts', 'support', 'monitor', 'handoff'];
  for (const k of Object.keys(raw)) {
    if (k !== '$comment' && !known.includes(k)) errs.push(k + ': неизвестный раздел (возможна опечатка). Допустимы: ' + known.join(', '));
  }

  /* --- business --- */
  const b = isObj(raw.business) ? raw.business : (errs.push('business: обязательный раздел'), {});
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) errs.push('business.name: укажите название бизнеса (строка)');
  else if (name.length > 80) errs.push('business.name: не длиннее 80 символов');
  const niche = b.niche === undefined ? 'other' : b.niche;
  if (!NICHES.includes(niche)) errs.push('business.niche: допустимо одно из ' + NICHES.join(', ') + '; получено ' + JSON.stringify(b.niche));
  const language = b.language === undefined ? 'uk' : b.language;
  if (!LANGS.includes(language)) errs.push('business.language: допустимо ' + LANGS.join(' или ') + '; получено ' + JSON.stringify(b.language));
  const timezone = b.timezone === undefined ? 'Europe/Kyiv' : b.timezone;
  if (!isValidTimeZone(timezone)) errs.push('business.timezone: неизвестный часовой пояс ' + JSON.stringify(b.timezone) + ' (пример: "Europe/Kyiv")');
  for (const k of ['address', 'phone', 'currency']) {
    if (b[k] !== undefined && typeof b[k] !== 'string') errs.push('business.' + k + ': ожидается строка');
  }
  const business = {
    name, niche, language, timezone,
    address: (b.address || '').trim(), phone: (b.phone || '').trim(),
    currency: (typeof b.currency === 'string' && b.currency.trim()) || 'грн'
  };

  /* --- hours --- */
  const hoursParsed = raw.hours === undefined ? (errs.push('hours: обязательный раздел (часы работы по дням)'), {}) : parseHours(raw.hours, 'hours', errs, false);
  const hours = {};
  for (const d of DAYS) hours[d] = hoursParsed[d] === undefined ? null : hoursParsed[d];

  /* --- booking --- */
  const bk = isObj(raw.booking) ? raw.booking : {};
  if (raw.booking !== undefined && !isObj(raw.booking)) errs.push('booking: ожидается объект');
  const booking = {
    stepMin: num(bk.stepMin, 'booking.stepMin', errs, { def: 30, min: 5, max: 120, name: 'шаг сетки слотов, минут' }),
    minLeadMin: num(bk.minLeadMin, 'booking.minLeadMin', errs, { def: 60, min: 0, max: 10080, name: 'минимум минут до записи' }),
    horizonDays: num(bk.horizonDays, 'booking.horizonDays', errs, { def: 30, min: 1, max: 120, name: 'на сколько дней вперёд' }),
    bufferMin: num(bk.bufferMin, 'booking.bufferMin', errs, { def: 0, min: 0, max: 120, name: 'пауза между записями, минут' }),
    clientChangeMinHours: num(bk.clientChangeMinHours, 'booking.clientChangeMinHours', errs, { def: 2, min: 0, max: 168, name: 'за сколько часов клиент ещё может отменить/перенести' }),
    maxActivePerClient: num(bk.maxActivePerClient, 'booking.maxActivePerClient', errs, { def: 3, min: 1, max: 20, name: 'активных записей на клиента' }),
    chooseMaster: bk.chooseMaster === undefined ? true : bk.chooseMaster,
    autoConfirm: bk.autoConfirm === undefined ? false : bk.autoConfirm
  };
  for (const k of ['chooseMaster', 'autoConfirm']) {
    if (typeof booking[k] !== 'boolean') { errs.push('booking.' + k + ': true или false'); booking[k] = k === 'chooseMaster'; }
  }

  /* --- masters --- */
  const masters = [];
  const masterIds = new Set();
  if (raw.masters !== undefined && !Array.isArray(raw.masters)) errs.push('masters: ожидается список');
  (Array.isArray(raw.masters) ? raw.masters : []).forEach((m, i) => {
    const p = 'masters[' + i + ']';
    if (!isObj(m)) { errs.push(p + ': ожидается объект'); return; }
    if (typeof m.id !== 'string' || !ID_RE.test(m.id) || RESERVED_IDS.includes(m.id)) errs.push(p + '.id: латиница/цифры/«_», до 16 символов, не "_" и не "any"; получено ' + JSON.stringify(m.id));
    else if (masterIds.has(m.id)) errs.push(p + '.id: "' + m.id + '" повторяется');
    else masterIds.add(m.id);
    if (typeof m.name !== 'string' || !m.name.trim()) errs.push(p + '.name: укажите имя');
    let hrs = null;
    if (m.hours !== undefined) hrs = parseHours(m.hours, p + '.hours', errs, true);
    masters.push({
      id: m.id, name: typeof m.name === 'string' ? m.name.trim() : '',
      chatId: m.chatId === undefined || m.chatId === null ? null : (Number.isSafeInteger(m.chatId) && m.chatId !== 0 ? m.chatId : (errs.push(p + '.chatId: целое число (или уберите поле); получено ' + JSON.stringify(m.chatId)), null)),
      hours: hrs, services: Array.isArray(m.services) ? m.services.slice() : null,
      _servicesRaw: m.services, _p: p
    });
  });

  /* --- services --- */
  const services = [];
  const serviceIds = new Set();
  if (!Array.isArray(raw.services) || !raw.services.length) errs.push('services: нужен непустой список услуг');
  (Array.isArray(raw.services) ? raw.services : []).forEach((s, i) => {
    const p = 'services[' + i + ']';
    if (!isObj(s)) { errs.push(p + ': ожидается объект'); return; }
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) errs.push(p + '.id: латиница/цифры/«_», до 16 символов; получено ' + JSON.stringify(s.id));
    else if (serviceIds.has(s.id)) errs.push(p + '.id: "' + s.id + '" повторяется');
    else serviceIds.add(s.id);
    if (typeof s.name !== 'string' || !s.name.trim()) errs.push(p + '.name: укажите название услуги');
    else if (s.name.length > 60) errs.push(p + '.name: не длиннее 60 символов');
    const durationMin = num(s.durationMin, p + '.durationMin', errs, { def: undefined, min: 5, max: 720, name: 'длительность в минутах' });
    if (s.durationMin === undefined) errs.push(p + '.durationMin: обязательное поле — длительность услуги в минутах');
    let price = null;
    if (s.price !== undefined && s.price !== null) {
      if (typeof s.price !== 'number' || !Number.isFinite(s.price) || s.price < 0) errs.push(p + '.price: число не меньше 0 (или уберите поле); получено ' + JSON.stringify(s.price));
      else price = s.price;
    }
    if (s.masters !== undefined && !Array.isArray(s.masters)) errs.push(p + '.masters: ожидается список id мастеров');
    services.push({
      id: s.id, name: typeof s.name === 'string' ? s.name.trim() : '', durationMin, price,
      masters: Array.isArray(s.masters) ? s.masters.slice() : null, _p: p
    });
  });

  /* перекрёстные ссылки услуг ↔ мастеров */
  for (const s of services) {
    (s.masters || []).forEach((id, i) => { if (!masterIds.has(id)) errs.push(s._p + '.masters[' + i + ']: мастер "' + id + '" не описан в masters'); });
  }
  for (const m of masters) {
    if (m._servicesRaw !== undefined && !Array.isArray(m._servicesRaw)) errs.push(m._p + '.services: ожидается список id услуг');
    (m.services || []).forEach((id, i) => { if (!serviceIds.has(id)) errs.push(m._p + '.services[' + i + ']: услуга "' + id + '" не описана в services'); });
  }
  const resources = masters.length ? masters.map((m) => m.id) : ['_'];
  for (const s of services) {
    if (!s.id) continue;
    const ok = resources.some((rid) => serviceEligible(s, masters.find((m) => m.id === rid) || null));
    if (!ok) errs.push(s._p + ': ни один мастер не может выполнять услугу "' + s.id + '" (проверьте masters у услуги и services у мастеров)');
  }
  masters.forEach((m) => { delete m._servicesRaw; delete m._p; });
  services.forEach((s) => { delete s._p; });

  /* --- owner --- */
  const ow = isObj(raw.owner) ? raw.owner : {};
  if (raw.owner !== undefined && !isObj(raw.owner)) errs.push('owner: ожидается объект {"chatIds":[...]}');
  const owner = { chatIds: parseChatIds(ow.chatIds, 'owner.chatIds', errs) };

  /* --- reminders --- */
  const rm = isObj(raw.reminders) ? raw.reminders : {};
  if (raw.reminders !== undefined && !isObj(raw.reminders)) errs.push('reminders: ожидается объект');
  let beforeHours = [24, 2];
  if (rm.beforeHours !== undefined) {
    if (!Array.isArray(rm.beforeHours) || rm.beforeHours.some((x) => typeof x !== 'number' || !isFinite(x) || x <= 0 || x > 168)) {
      errs.push('reminders.beforeHours: список положительных чисел часов до визита (до 168), например [24, 2]');
    } else beforeHours = [...new Set(rm.beforeHours)].sort((a, b) => b - a);
  }
  let reviewUrl = null;
  if (rm.reviewUrl !== undefined && rm.reviewUrl !== null && rm.reviewUrl !== '') {
    if (typeof rm.reviewUrl !== 'string' || !/^https:\/\/\S+$/.test(rm.reviewUrl)) errs.push('reminders.reviewUrl: ссылка вида https://… (или уберите поле, чтобы не просить отзыв)');
    else reviewUrl = rm.reviewUrl;
  }
  const reminders = {
    enabled: rm.enabled === undefined ? true : rm.enabled,
    beforeHours, reviewUrl,
    reviewAfterMin: num(rm.reviewAfterMin, 'reminders.reviewAfterMin', errs, { def: 120, min: 0, max: 2880, name: 'через сколько минут после визита просить отзыв' })
  };
  if (typeof reminders.enabled !== 'boolean') { errs.push('reminders.enabled: true или false'); reminders.enabled = true; }

  /* --- limits / privacy --- */
  const lm = isObj(raw.limits) ? raw.limits : {};
  const limits = { perMinute: num(lm.perMinute, 'limits.perMinute', errs, { def: 30, min: 5, max: 300, name: 'запросов в минуту от одного пользователя' }) };
  const pv = isObj(raw.privacy) ? raw.privacy : {};
  const privacy = { retentionDays: num(pv.retentionDays, 'privacy.retentionDays', errs, { def: 730, min: 30, max: 3650, name: 'сколько дней хранить прошедшие записи' }) };

  /* --- support: Intromax на поддержке (ежемесячный отчёт, копии тревог о сайте) --- */
  const sp = isObj(raw.support) ? raw.support : {};
  if (raw.support !== undefined && !isObj(raw.support)) errs.push('support: ожидается объект {"chatIds":[...],"report":true}');
  if (sp.contact !== undefined && (typeof sp.contact !== 'string' || sp.contact.length > 60)) errs.push('support.contact: строка до 60 символов (например "@intromax_support"), или уберите поле');
  const support = {
    chatIds: parseChatIds(sp.chatIds, 'support.chatIds', errs),
    contact: typeof sp.contact === 'string' ? sp.contact.trim().slice(0, 60) : '',
    report: sp.report === undefined ? true : sp.report,
    reportHour: num(sp.reportHour, 'support.reportHour', errs, { def: 10, min: 0, max: 23, name: 'час отправки отчёта 1-го числа' })
  };
  if (typeof support.report !== 'boolean') { errs.push('support.report: true или false'); support.report = true; }

  /* --- monitor: проверка доступности сайта клиента из тика --- */
  const mo = isObj(raw.monitor) ? raw.monitor : {};
  if (raw.monitor !== undefined && !isObj(raw.monitor)) errs.push('monitor: ожидается объект {"url":"https://…"}');
  let monUrl = '';
  if (mo.url !== undefined && mo.url !== null && mo.url !== '') {
    if (typeof mo.url !== 'string' || !/^https?:\/\/[^\s/]+\.[^\s]+$/.test(mo.url)) errs.push('monitor.url: адрес сайта вида https://example.com (или уберите поле, чтобы не проверять)');
    else monUrl = mo.url;
  }
  let expectText = null;
  if (mo.expectText !== undefined && mo.expectText !== null && mo.expectText !== '') {
    if (typeof mo.expectText !== 'string' || mo.expectText.length > 100) errs.push('monitor.expectText: строка до 100 символов, которая должна быть на странице (или уберите поле)');
    else expectText = mo.expectText;
  }
  const monitor = {
    url: monUrl, expectText,
    failAfter: num(mo.failAfter, 'monitor.failAfter', errs, { def: 2, min: 1, max: 10, name: 'сколько неудачных проверок подряд считать падением' }),
    timeoutSec: num(mo.timeoutSec, 'monitor.timeoutSec', errs, { def: 10, min: 3, max: 25, name: 'сколько секунд ждать ответа сайта' }),
    notifyOwner: mo.notifyOwner === undefined ? true : mo.notifyOwner
  };
  if (typeof monitor.notifyOwner !== 'boolean') { errs.push('monitor.notifyOwner: true или false'); monitor.notifyOwner = true; }

  /* --- handoff: «Звʼязатися з адміністратором» --- */
  const ho = isObj(raw.handoff) ? raw.handoff : {};
  if (raw.handoff !== undefined && !isObj(raw.handoff)) errs.push('handoff: ожидается объект {"enabled":true}');
  const handoff = { enabled: ho.enabled === undefined ? true : ho.enabled };
  if (typeof handoff.enabled !== 'boolean') { errs.push('handoff.enabled: true или false'); handoff.enabled = true; }

  /* --- faq --- */
  const faq = [];
  if (raw.faq !== undefined && !Array.isArray(raw.faq)) errs.push('faq: ожидается список {"q":"…","a":"…"}');
  (Array.isArray(raw.faq) ? raw.faq : []).forEach((f, i) => {
    const p = 'faq[' + i + ']';
    if (!isObj(f) || typeof f.q !== 'string' || !f.q.trim() || typeof f.a !== 'string' || !f.a.trim()) { errs.push(p + ': нужен вид {"q":"вопрос","a":"ответ"}'); return; }
    if (f.q.length > 60) errs.push(p + '.q: вопрос — подпись кнопки, не длиннее 60 символов');
    const bad = checkHtml(f.a); if (bad) errs.push(p + '.a: ' + bad);
    faq.push({ q: f.q.trim(), a: f.a.trim() });
  });
  if (faq.length > 10) errs.push('faq: не больше 10 вопросов');

  /* --- texts --- */
  const overrides = {};
  if (raw.texts !== undefined && !isObj(raw.texts)) errs.push('texts: ожидается объект {"ключ":"текст"}');
  for (const [k, v] of Object.entries(isObj(raw.texts) ? raw.texts : {})) {
    if (!TEXT_KEYS.includes(k)) { errs.push('texts.' + k + ': нет такого текста. Список ключей — в src/texts.js'); continue; }
    if (typeof v !== 'string' || !v.trim()) { errs.push('texts.' + k + ': ожидается непустая строка'); continue; }
    const bad = checkHtml(v); if (bad) { errs.push('texts.' + k + ': ' + bad); continue; }
    overrides[k] = v;
  }

  if (errs.length) throw new ConfigError(errs);

  /* ресурсы: мастера либо один безымянный «_» со своими (общими) часами */
  const cfg = {
    business, hours, booking, masters, services, owner, reminders, limits, privacy, faq, support, monitor, handoff,
    texts: buildTexts(language, niche, overrides),
    servicesById: Object.fromEntries(services.map((s) => [s.id, s])),
    mastersById: Object.fromEntries(masters.map((m) => [m.id, m])),
    resources
  };
  return cfg;
}

/** Может ли ресурс (мастер или null для безымянного) выполнять услугу. */
export function serviceEligible(service, master) {
  if (!master) return true;
  if (service.masters && !service.masters.includes(master.id)) return false;
  if (master.services && !master.services.includes(service.id)) return false;
  return true;
}

export { DAYS, WEEKDAYS };

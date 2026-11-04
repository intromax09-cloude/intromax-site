/**
 * Тексты бота. Базовый язык — украинский (uk); есть полный русский (ru).
 * Слои (поздний перекрывает ранний): базовый словарь языка → поправки ниши → config.texts клиента.
 * Подстановки {name} экранируются под parse_mode=HTML автоматически; готовый HTML передают через raw().
 * Тексты из config.texts — доверенный HTML (разрешены только <b> <i> <u> <code>), это проверяет config.js.
 */

export const NICHES = ['salon', 'barbershop', 'dental', 'sto', 'vet', 'cosmetology', 'furniture', 'other'];
export const LANGS = ['uk', 'ru'];

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function raw(s) { return { __raw: String(s == null ? '' : s) }; }

const BASE = {
  uk: {
    welcome: 'Вітаємо у «{biz}»! 👋\nЗапишіться онлайн за хвилину — оберіть у меню.',
    menu_book: '📅 Записатися',
    menu_my: '📋 Мої записи',
    menu_info: 'ℹ️ Контакти й години',
    menu_prices: '💰 Послуги та ціни',
    menu_faq: '❓ Часті питання',
    menu_staff_today: '📅 Сьогодні',
    menu_staff_tomorrow: '📅 Завтра',
    menu_staff_block: '🚫 Блок часу',
    back: '◀️ Назад',
    cancel_flow: '✖️ Скасувати',
    pick_service: 'Оберіть послугу:',
    pick_master: 'Оберіть {master_acc}:',
    any_master: '🎲 Будь-хто (найближчий вільний)',
    master_nom: 'Майстер',
    master_acc: 'майстра',
    master_any: 'будь-хто',
    pick_day: 'Оберіть день:',
    days_next: 'Далі ▶️',
    days_prev: '◀️ Раніше',
    no_slots: 'На жаль, найближчим часом вільних місць немає. Зателефонуйте нам: {phone}',
    pick_time: 'Оберіть час на {date}:',
    day_full: 'На цей день вільних місць уже немає — оберіть інший.',
    ask_name: 'Як до вас звертатися?',
    name_keep: 'Залишити «{name}»',
    bad_name: 'Напишіть, будь ласка, імʼя (до 60 символів).',
    ask_phone: 'Залиште номер телефону: натисніть кнопку нижче або напишіть його вручну.',
    share_contact: '📱 Поділитися контактом',
    bad_phone: 'Не схоже на номер. Приклад: 0501234567 або +380501234567.',
    foreign_contact: 'Це не ваш контакт. Натисніть кнопку «Поділитися контактом» або напишіть свій номер.',
    summary: 'Перевірте запис:\n{details}\n\n👤 {client}, {phone}',
    confirm_booking: '✅ Записатися',
    booked_pending: 'Дякуємо! Запис створено ✅\n{details}\n\nМи підтвердимо його найближчим часом — напишемо вам сюди.',
    booked_confirmed: 'Дякуємо! Запис підтверджено ✅\n{details}\n\nЗа добу та за 2 години до візиту надішлемо нагадування.',
    slot_taken: 'Цей час щойно зайняли 😕 Оберіть інший.',
    limit_active: 'У вас уже є {n} активних записів. Скасуйте один із них у «Мої записи» або зателефонуйте: {phone}',
    my_empty: 'Активних записів немає. Запишіться — це швидко 👇',
    my_title: 'Ваші записи — оберіть, щоб змінити:',
    appt_view: '{details}\nСтатус: {status}',
    status_pending: '⏳ очікує підтвердження',
    status_confirmed: '✅ підтверджено',
    btn_reschedule: '🔄 Перенести',
    btn_cancel: '❌ Скасувати',
    cancel_ask: 'Скасувати цей запис?\n{details}',
    cancel_yes: 'Так, скасувати',
    cancel_no: 'Ні, залишити',
    cancelled_client: 'Запис скасовано. Чекатимемо вас іншим разом!',
    too_late: 'До візиту менше {h} год — змінити запис тут уже не можна. Зателефонуйте нам: {phone}',
    resched_title: 'Переносимо запис:\n{details}\nОберіть новий день:',
    resched_done_pending: 'Запис перенесено ✅\n{details}\n\nМи підтвердимо новий час найближчим часом.',
    resched_done_confirmed: 'Запис перенесено ✅\n{details}',
    appt_gone: 'Цей запис уже неактуальний.',
    detail_line: '🗓 {when}, {time}\n🔹 {service}{price}\n{master_nom}: {master}',
    detail_no_master: '🗓 {when}, {time}\n🔹 {service}{price}',
    price_suffix: ' — {price} {cur}',
    session_expired: 'Сесія застаріла. Почнімо спочатку 👇',
    unknown: 'Скористайтеся меню 👇',
    your_id: 'Ваш chat id: <code>{id}</code>\nВласник бота вписує його в config.json (owner.chatIds або chatId майстра).',
    too_many: 'Забагато запитів. Зачекайте хвилину, будь ласка.',
    error: 'Щось пішло не так. Спробуйте ще раз або зателефонуйте: {phone}',
    info: '<b>{biz}</b>\n{address}{phone_line}\n\n<b>Години роботи</b>\n{hours}',
    info_phone: '📞 {phone}\n',
    info_address: '📍 {address}\n',
    hours_row: '{day}: {open}–{close}{breaks}',
    hours_off: '{day}: вихідний',
    hours_breaks: ' (перерва {breaks})',
    prices_title: '<b>Послуги та ціни</b>',
    prices_row: '• {name} — {dur} хв{price}',
    faq_title: 'Оберіть питання:',
    faq_back: '◀️ До питань',
    reminder: '🔔 Нагадуємо: ви записані {when} о {time}.\n{details}\n\nЯкщо плани змінилися — скасуйте або перенесіть запис: /start',
    review: 'Дякуємо, що були у «{biz}»! 🙏\nЯкщо вам сподобалось — залиште, будь ласка, відгук: {url}',
    when_today: 'сьогодні',
    when_tomorrow: 'завтра',
    staff_new: '🆕 <b>Нова заявка #{id}</b>\n{details}\n\n👤 {client}\n📞 {phone}{username}',
    staff_changed: '✏️ <b>Клієнт переніс запис #{id}</b>\n{details}\n\n👤 {client}\n📞 {phone}{username}',
    staff_client_cancelled: '🚫 <b>Клієнт скасував запис #{id}</b>\n{details}\n\n👤 {client}\n📞 {phone}',
    staff_card: '<b>Запис #{id}</b> · {status}\n{details}\n\n👤 {client}\n📞 {phone}{username}',
    staff_ok: '✅ Підтвердити',
    staff_move: '🔄 Перенести',
    staff_cancel: '❌ Скасувати',
    staff_cancel_ask: 'Скасувати запис #{id}? Клієнт отримає повідомлення.',
    staff_cancel_yes: 'Так, скасувати',
    staff_cancel_no: 'Ні',
    staff_confirmed_note: '✅ Підтверджено',
    staff_cancelled_note: '❌ Скасовано',
    staff_no_access: 'Немає доступу.',
    staff_resched_title: 'Переносимо запис #{id}:\n{details}\nОберіть новий день:',
    staff_moved: 'Перенесено ✅ Клієнт отримав повідомлення.',
    client_confirmed: 'Ваш запис підтверджено ✅\n{details}',
    client_cancelled_by_staff: 'На жаль, ми змушені скасувати ваш запис:\n{details}\n\nЗвʼяжіться з нами, щоб обрати інший час: {phone}',
    client_moved_by_staff: 'Ваш запис перенесено на інший час:\n{details}\n\nЯкщо цей час не підходить — змініть у «Мої записи» (/start).',
    list_header: '📅 <b>{when}, {date}</b> — записів: {n}',
    list_empty: '📅 <b>{when}, {date}</b> — записів немає.',
    list_row: '{icon} {from}–{to} · {service} · {client}{master}',
    list_more: '… і ще {n}',
    list_open: 'Натисніть на запис, щоб відкрити:',
    today: 'Сьогодні',
    tomorrow: 'Завтра',
    block_scope: 'Кому блокуємо час?',
    block_all: 'Усім (закладу)',
    block_day: 'Оберіть день:',
    block_menu: '🚫 Блок часу: <b>{who}</b>, {date}\nНатисніть на час, щоб заблокувати або розблокувати.\n⬜ вільно · 🚫 заблоковано · 🔒 зайнято записом',
    block_whole: '🚫 Заблокувати весь день',
    block_unwhole: '✅ Зняти блок з усього дня',
    block_has_appts: '⚠️ У цей день уже є записи: {n}. Вони залишаються в силі — скасуйте їх вручну.',
    block_done: 'Готово',
    block_none: 'У цей день немає робочих годин.',
    day_off: 'вихідний',
    weekdays: 'нд,пн,вт,ср,чт,пт,сб',
    weekdays_long: 'неділя,понеділок,вівторок,середа,четвер,пʼятниця,субота',
    months: 'січня,лютого,березня,квітня,травня,червня,липня,серпня,вересня,жовтня,листопада,грудня'
  },
  ru: {
    welcome: 'Добро пожаловать в «{biz}»! 👋\nЗапишитесь онлайн за минуту — выберите в меню.',
    menu_book: '📅 Записаться',
    menu_my: '📋 Мои записи',
    menu_info: 'ℹ️ Контакты и часы',
    menu_prices: '💰 Услуги и цены',
    menu_faq: '❓ Частые вопросы',
    menu_staff_today: '📅 Сегодня',
    menu_staff_tomorrow: '📅 Завтра',
    menu_staff_block: '🚫 Блок времени',
    back: '◀️ Назад',
    cancel_flow: '✖️ Отмена',
    pick_service: 'Выберите услугу:',
    pick_master: 'Выберите {master_acc}:',
    any_master: '🎲 Любой (ближайший свободный)',
    master_nom: 'Мастер',
    master_acc: 'мастера',
    master_any: 'любой',
    pick_day: 'Выберите день:',
    days_next: 'Дальше ▶️',
    days_prev: '◀️ Раньше',
    no_slots: 'К сожалению, в ближайшее время свободных мест нет. Позвоните нам: {phone}',
    pick_time: 'Выберите время на {date}:',
    day_full: 'На этот день свободных мест уже нет — выберите другой.',
    ask_name: 'Как к вам обращаться?',
    name_keep: 'Оставить «{name}»',
    bad_name: 'Напишите, пожалуйста, имя (до 60 символов).',
    ask_phone: 'Оставьте номер телефона: нажмите кнопку ниже или напишите его вручную.',
    share_contact: '📱 Поделиться контактом',
    bad_phone: 'Не похоже на номер. Пример: 0501234567 или +380501234567.',
    foreign_contact: 'Это не ваш контакт. Нажмите «Поделиться контактом» или напишите свой номер.',
    summary: 'Проверьте запись:\n{details}\n\n👤 {client}, {phone}',
    confirm_booking: '✅ Записаться',
    booked_pending: 'Спасибо! Запись создана ✅\n{details}\n\nМы подтвердим её в ближайшее время — напишем вам сюда.',
    booked_confirmed: 'Спасибо! Запись подтверждена ✅\n{details}\n\nЗа сутки и за 2 часа до визита пришлём напоминание.',
    slot_taken: 'Это время только что заняли 😕 Выберите другое.',
    limit_active: 'У вас уже {n} активных записей. Отмените одну в «Мои записи» или позвоните: {phone}',
    my_empty: 'Активных записей нет. Запишитесь — это быстро 👇',
    my_title: 'Ваши записи — выберите, чтобы изменить:',
    appt_view: '{details}\nСтатус: {status}',
    status_pending: '⏳ ожидает подтверждения',
    status_confirmed: '✅ подтверждена',
    btn_reschedule: '🔄 Перенести',
    btn_cancel: '❌ Отменить',
    cancel_ask: 'Отменить эту запись?\n{details}',
    cancel_yes: 'Да, отменить',
    cancel_no: 'Нет, оставить',
    cancelled_client: 'Запись отменена. Будем рады видеть вас в другой раз!',
    too_late: 'До визита меньше {h} ч — изменить запись здесь уже нельзя. Позвоните нам: {phone}',
    resched_title: 'Переносим запись:\n{details}\nВыберите новый день:',
    resched_done_pending: 'Запись перенесена ✅\n{details}\n\nМы подтвердим новое время в ближайшее время.',
    resched_done_confirmed: 'Запись перенесена ✅\n{details}',
    appt_gone: 'Эта запись уже неактуальна.',
    detail_line: '🗓 {when}, {time}\n🔹 {service}{price}\n{master_nom}: {master}',
    detail_no_master: '🗓 {when}, {time}\n🔹 {service}{price}',
    price_suffix: ' — {price} {cur}',
    session_expired: 'Сессия устарела. Начнём сначала 👇',
    unknown: 'Воспользуйтесь меню 👇',
    your_id: 'Ваш chat id: <code>{id}</code>\nВладелец бота вписывает его в config.json (owner.chatIds или chatId мастера).',
    too_many: 'Слишком много запросов. Подождите минуту, пожалуйста.',
    error: 'Что-то пошло не так. Попробуйте ещё раз или позвоните: {phone}',
    info: '<b>{biz}</b>\n{address}{phone_line}\n\n<b>Часы работы</b>\n{hours}',
    info_phone: '📞 {phone}\n',
    info_address: '📍 {address}\n',
    hours_row: '{day}: {open}–{close}{breaks}',
    hours_off: '{day}: выходной',
    hours_breaks: ' (перерыв {breaks})',
    prices_title: '<b>Услуги и цены</b>',
    prices_row: '• {name} — {dur} мин{price}',
    faq_title: 'Выберите вопрос:',
    faq_back: '◀️ К вопросам',
    reminder: '🔔 Напоминаем: вы записаны {when} в {time}.\n{details}\n\nЕсли планы изменились — отмените или перенесите запись: /start',
    review: 'Спасибо, что были у нас в «{biz}»! 🙏\nЕсли понравилось — оставьте, пожалуйста, отзыв: {url}',
    when_today: 'сегодня',
    when_tomorrow: 'завтра',
    staff_new: '🆕 <b>Новая заявка #{id}</b>\n{details}\n\n👤 {client}\n📞 {phone}{username}',
    staff_changed: '✏️ <b>Клиент перенёс запись #{id}</b>\n{details}\n\n👤 {client}\n📞 {phone}{username}',
    staff_client_cancelled: '🚫 <b>Клиент отменил запись #{id}</b>\n{details}\n\n👤 {client}\n📞 {phone}',
    staff_card: '<b>Запись #{id}</b> · {status}\n{details}\n\n👤 {client}\n📞 {phone}{username}',
    staff_ok: '✅ Подтвердить',
    staff_move: '🔄 Перенести',
    staff_cancel: '❌ Отменить',
    staff_cancel_ask: 'Отменить запись #{id}? Клиент получит сообщение.',
    staff_cancel_yes: 'Да, отменить',
    staff_cancel_no: 'Нет',
    staff_confirmed_note: '✅ Подтверждено',
    staff_cancelled_note: '❌ Отменено',
    staff_no_access: 'Нет доступа.',
    staff_resched_title: 'Переносим запись #{id}:\n{details}\nВыберите новый день:',
    staff_moved: 'Перенесено ✅ Клиент получил сообщение.',
    client_confirmed: 'Ваша запись подтверждена ✅\n{details}',
    client_cancelled_by_staff: 'К сожалению, мы вынуждены отменить вашу запись:\n{details}\n\nСвяжитесь с нами, чтобы выбрать другое время: {phone}',
    client_moved_by_staff: 'Ваша запись перенесена на другое время:\n{details}\n\nЕсли время не подходит — измените в «Мои записи» (/start).',
    list_header: '📅 <b>{when}, {date}</b> — записей: {n}',
    list_empty: '📅 <b>{when}, {date}</b> — записей нет.',
    list_row: '{icon} {from}–{to} · {service} · {client}{master}',
    list_more: '… и ещё {n}',
    list_open: 'Нажмите на запись, чтобы открыть:',
    today: 'Сегодня',
    tomorrow: 'Завтра',
    block_scope: 'Кому блокируем время?',
    block_all: 'Всем (заведению)',
    block_day: 'Выберите день:',
    block_menu: '🚫 Блок времени: <b>{who}</b>, {date}\nНажмите на время, чтобы заблокировать или разблокировать.\n⬜ свободно · 🚫 заблокировано · 🔒 занято записью',
    block_whole: '🚫 Заблокировать весь день',
    block_unwhole: '✅ Снять блок со всего дня',
    block_has_appts: '⚠️ На этот день уже есть записи: {n}. Они остаются в силе — отмените их вручную.',
    block_done: 'Готово',
    block_none: 'В этот день нет рабочих часов.',
    day_off: 'выходной',
    weekdays: 'вс,пн,вт,ср,чт,пт,сб',
    weekdays_long: 'воскресенье,понедельник,вторник,среда,четверг,пятница,суббота',
    months: 'января,февраля,марта,апреля,мая,июня,июля,августа,сентября,октября,ноября,декабря'
  }
};

/* Поправки ниши: как называем исполнителя. Остальные тексты клиент правит в config.texts. */
const NICHE = {
  uk: {
    dental: { master_nom: 'Лікар', master_acc: 'лікаря' },
    vet: { master_nom: 'Лікар', master_acc: 'лікаря' },
    cosmetology: { master_nom: 'Косметолог', master_acc: 'косметолога' },
    furniture: { master_nom: 'Менеджер', master_acc: 'менеджера' }
  },
  ru: {
    dental: { master_nom: 'Врач', master_acc: 'врача' },
    vet: { master_nom: 'Врач', master_acc: 'врача' },
    cosmetology: { master_nom: 'Косметолог', master_acc: 'косметолога' },
    furniture: { master_nom: 'Менеджер', master_acc: 'менеджера' }
  }
};

export const TEXT_KEYS = Object.keys(BASE.uk);

export function baseTexts(lang) { return BASE[lang] || BASE.uk; }

/** Итоговый словарь: язык + ниша + переопределения клиента. */
export function buildTexts(lang, niche, overrides) {
  return Object.assign({}, BASE[lang] || BASE.uk, (NICHE[lang] || {})[niche] || {}, overrides || {});
}

/** Подстановка {x}; значения экранируются, raw() — нет. */
export function fmt(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => {
    if (!vars || !(k in vars)) return '';
    const v = vars[k];
    if (v && typeof v === 'object' && '__raw' in v) return v.__raw;
    return escapeHtml(v);
  });
}

/** Доверенный HTML из config.texts: только <b> <i> <u> <code>, без «голых» < и &. Возвращает текст ошибки или ''. */
export function checkHtml(s) {
  const rest = String(s).replace(/<\/?(b|i|u|code)>/g, '').replace(/&(amp|lt|gt);/g, '');
  if (rest.includes('<') || rest.includes('>')) return 'допустимы только теги <b>, <i>, <u>, <code>; символы < и > пишите как &lt; и &gt;';
  if (/&/.test(rest)) return 'символ & пишите как &amp;';
  const open = {};
  String(s).replace(/<(\/?)(b|i|u|code)>/g, (m, c, t) => { open[t] = (open[t] || 0) + (c ? -1 : 1); return m; });
  if (Object.values(open).some((n) => n !== 0)) return 'незакрытый или лишний HTML-тег';
  return '';
}

/** Для подписей кнопок (там HTML не разбирается): подстановка без экранирования. */
export function fmtPlain(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => {
    if (!vars || !(k in vars)) return '';
    const v = vars[k];
    return v && typeof v === 'object' && '__raw' in v ? v.__raw : String(v);
  });
}

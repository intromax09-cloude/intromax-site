/**
 * Планировщик напоминаний. Чистая функция: что нужно отправить прямо сейчас.
 *
 * planReminders(appointments, log, now, opts) → [{id, kind}]
 *   appointments: [{id, status, start_ts, end_ts, booked_at}]
 *   log:          [{appointment_id, kind, status, attempts}]   (таблица reminders_log)
 *   opts:         {beforeHours:[24,2], reviewUrl, reviewAfterMin, enabled, maxAttempts?}
 *
 * Правила:
 *  - kind 'r24', 'r2' … — за N часов до визита; 'review' — один раз после визита;
 *  - напоминание «за N часов» не шлём, если запись создана/перенесена уже ПОСЛЕ момента start-N
 *    (клиент и так только что узнал время) или визит уже начался;
 *  - если из-за простоя крона наступили сразу два напоминания, уходит только самое позднее (r2),
 *    «позавчерашнее» не отправляем;
 *  - отменённые (и любые не pending/confirmed) не напоминаем; отзыв просим только по confirmed;
 *  - то, что уже отправлено ('sent') или захвачено другим запуском ('sending'), не повторяем;
 *    'failed' повторяем до maxAttempts раз.
 */

export const HOUR = 3600000;
export const REVIEW_GRACE_MS = 48 * HOUR;   // просить отзыв позже чем через двое суток после визита уже поздно
export const MAX_ATTEMPTS = 3;

export function kindFor(hours) { return 'r' + hours; }

export function planReminders(appointments, log, now, opts) {
  if (!opts || opts.enabled === false) return [];
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const state = new Map();
  for (const l of log || []) state.set(l.appointment_id + ':' + l.kind, l);
  const open = (id, kind) => {
    const l = state.get(id + ':' + kind);
    if (!l) return true;
    return l.status === 'failed' && (l.attempts || 0) < maxAttempts;
  };

  const before = (opts.beforeHours || []).slice().sort((a, b) => b - a);
  const out = [];
  for (const a of appointments) {
    if (a.status !== 'pending' && a.status !== 'confirmed') continue;

    if (now < a.start_ts) {
      const dueNow = before.filter((h) => {
        const due = a.start_ts - h * HOUR;
        return due <= now && a.booked_at <= due;
      });
      if (dueNow.length) {
        const latest = dueNow[dueNow.length - 1];           // наименьшее число часов = самое позднее
        // если оно уже отправлено, более ранние тем более не нужны
        if (open(a.id, kindFor(latest))) out.push({ id: a.id, kind: kindFor(latest) });
      }
    }

    if (opts.reviewUrl && a.status === 'confirmed') {
      const due = a.end_ts + (opts.reviewAfterMin || 0) * 60000;
      if (now >= due && now < a.end_ts + REVIEW_GRACE_MS && open(a.id, 'review')) out.push({ id: a.id, kind: 'review' });
    }
  }
  return out;
}

/** Окно выборки записей для тика: что вообще может понадобиться (не грузим всю базу). */
export function tickWindow(now, opts) {
  const maxBefore = Math.max(0, ...(opts.beforeHours || [0]));
  return { from: now - REVIEW_GRACE_MS - 6 * HOUR, to: now + maxBefore * HOUR + HOUR };
}

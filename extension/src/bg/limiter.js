/**
 * Лимиты, прогрев и предохранитель.
 *
 * Три идеи, ради которых всё это существует.
 *
 * Первая — прогрев. Аккаунт, который вчера комментировал ноль раз, а сегодня
 * сорок, помечается тривиальным пороговым правилом. Лимит поднимается линейно
 * от warmupStartPerDay до perDay за warmupDays суток.
 *
 * Вторая — джиттер суточного лимита. Ровно 25 комментариев каждый день — это
 * подпись счётчика, а не человека. Фактический лимит разыгрывается заново
 * каждые сутки в окрестности базового.
 *
 * Третья — предохранитель. При первых признаках проблем агент останавливается
 * сам, а не долбится в стену, накапливая флаги на аккаунте.
 */

import { jitter, clamp } from '../common/rng.js';
import { todayKey, daysSince } from '../common/storage.js';
import { HALT } from '../common/messages.js';
import { rollDay } from './rhythm.js';

/* ------------------------------- Прогрев --------------------------------- */

/**
 * Базовый дневной лимит с учётом прогрева, до джиттера.
 * День 0 = warmupStartPerDay, день warmupDays и дальше = perDay.
 */
export function warmupLimit(settings, state) {
  const { perDay, warmupDays, warmupStartPerDay, warmupCurve } = settings.limits;
  if (!warmupDays || warmupDays <= 0) return perDay;

  const day = warmupDay(state);
  if (day >= warmupDays) return perDay;

  const start = Math.min(warmupStartPerDay, perDay);

  /*
   * Форма кривой.
   *
   * Показатель 1 — прямая: к середине срока агент уже на половине нормы.
   * Для нового аккаунта это годилось, для возвращения после ограничения — нет:
   * там важно, чтобы первая неделя была почти пустой, а рост пришёлся на
   * конец. Показатель больше единицы прижимает кривую к началу — при 1.6 и
   * трёхнедельном прогреве первая неделя даёт один-два комментария в день, а
   * норма набирается только к третьей.
   */
  const t = (day / warmupDays) ** Math.max(0.2, warmupCurve || 1);
  return Math.max(1, Math.round(start + (perDay - start) * t));
}

/**
 * Который день прогрева идёт.
 *
 * Считается от `restartDate`, если он есть, и только иначе — от первого
 * запуска. Смысл в том, что после ограничения платформы возраст аккаунта
 * перестаёт что-либо значить: Threads смотрит не на дату регистрации, а на
 * поведение после снятия санкции. Возвращаться на прежний темп в первый же
 * день — это то, за чем и следят.
 */
export function warmupDay(state) {
  const from = state?.restartDate || state?.firstRunDate;
  return daysSince(from);
}

/**
 * Начать прогрев заново.
 *
 * Вызывается, когда агент возвращается к работе после ограничения или когда
 * человек сам переключает режим: и то, и другое означает «считаем сначала».
 * Дата пишется в состояние, а не в настройки, — это факт биографии аккаунта,
 * а не желаемая величина.
 */
export function restartWarmup(state, now = Date.now()) {
  state.restartDate = todayKey(new Date(now));
  return state;
}

/**
 * Разыграть фактический лимит на сегодня.
 *
 * Поверх разброса лежит настроение дня. Джиттер в четверть даёт «примерно
 * столько же каждый день» — а нужно, чтобы дни отличались как у человека:
 * вчера залип и написал шесть, сегодня заглянул и не написал ничего. Ровный
 * ряд одинаковых дней виден со стороны лучше любого всплеска.
 *
 * Нижняя граница здесь — ноль, а не единица: выходной обязан быть настоящим.
 * Прежний `Math.max(1, ...)` означал «хотя бы один комментарий каждый день,
 * что бы ни случилось», то есть ровно ту непрерывность, от которой уходим.
 */
export function rollDailyLimit(settings, state) {
  const base = warmupLimit(settings, state);
  const j = clamp(settings.limits.dailyJitter, 0, 0.9);
  const rolled = jitter(base, j);

  const factor = settings.rhythm?.enabled && state?.rhythm ? (state.rhythm.factor ?? 1) : 1;
  if (factor <= 0) return 0;

  return Math.max(1, Math.round(rolled * factor));
}

/**
 * Пересчитать дневной лимит, если изменилась его основа.
 *
 * Лимит разыгрывается один раз в сутки и лежит в состоянии — так задумано:
 * иначе он менялся бы на каждом тике, и «осталось три комментария» ничего не
 * значило бы. Но у этого была цена, которую пользователь и заметил: сменив
 * режим с «Обычного» на «Осторожный», он видел прежние 14 вместо 8 — до самой
 * полуночи, потому что пересчёт происходил только со сменой суток.
 *
 * Отсюда `limitBasis`: запоминаем, из какого целевого числа лимит разыгран.
 * Совпадает — не трогаем и разброс остаётся прежним. Изменилось — разыгрываем
 * заново, потому что изменился сам режим.
 */
export function resyncDayLimit(settings, state) {
  const base = warmupLimit(settings, state);
  if (state.limitBasis === base && state.dayLimit) return state;

  state.limitBasis = base;
  state.dayLimit = rollDailyLimit(settings, state);
  return state;
}

/* ---------------------------- Смена суток -------------------------------- */

/**
 * Перевести состояние на новые сутки, если они наступили.
 * Возвращает изменённое состояние (мутирует переданный объект).
 */
export function rolloverDay(settings, state, now = Date.now()) {
  const key = todayKey(new Date(now));
  if (state.day === key) return state;

  // Сдаём вчерашний день в историю.
  if (state.day) {
    state.history = state.history || {};
    state.history[state.day] = {
      comments: state.dayCount || 0,
      likes: state.dayLikes || 0,
      views: state.dayViews || 0,
      posts: state.dayPosts || 0,
      spend: Math.round((state.daySpend || 0) * 10000) / 10000,
      limit: state.dayLimit || 0,
    };
    // Держим 90 дней, дальше не интересно.
    const keys = Object.keys(state.history).sort();
    while (keys.length > 90) delete state.history[keys.shift()];
  }

  state.day = key;
  state.dayCount = 0;
  state.dayLikes = 0;
  state.dayViews = 0;
  state.dayPosts = 0;
  /* Ответы своим читателям считаются отдельно от комментариев в чужих ветках:
     у них свой предел и своя логика, но сутки у всех одни. */
  state.dayHostReplies = 0;
  state.daySpend = 0;
  state.hourStamps = [];

  /*
   * Распорядок разыгрывается раньше лимита: настроение дня на него влияет.
   * Порядок здесь существенный, и поменять его местами — значит получить
   * выходной с полной дневной нормой.
   */
  state.rhythm = rollDay(settings, new Date(now));

  state.limitBasis = warmupLimit(settings, state);
  state.dayLimit = rollDailyLimit(settings, state);

  // Бюджетная остановка снимается с новыми сутками, остальные — нет.
  if (state.halt?.reason === HALT.BUDGET) state.halt = null;

  return state;
}

/* ------------------------------- Проверки -------------------------------- */

/**
 * Можно ли прямо сейчас опубликовать комментарий.
 * @returns {{ok: boolean, reason?: string, retryIn?: number}}
 */
export function canComment(settings, state, now = Date.now()) {
  if (state.halt) {
    const until = state.halt.until || 0;
    if (!until || now < until) {
      return { ok: false, reason: `остановлен: ${state.halt.reason}`, retryIn: until ? until - now : null };
    }
  }

  if (state.breaker === 'open' && now < (state.breakerUntil || 0)) {
    return { ok: false, reason: 'предохранитель разомкнут', retryIn: state.breakerUntil - now };
  }

  if ((state.dayCount || 0) >= (state.dayLimit || 0)) {
    return { ok: false, reason: `дневной лимит ${state.dayLimit} исчерпан`, retryIn: msUntilMidnight(now) };
  }

  const hourAgo = now - 3600000;
  const inHour = (state.hourStamps || []).filter((t) => t > hourAgo);
  const hourCap = hourLimit(settings, now);
  if (inHour.length >= hourCap) {
    const oldest = Math.min(...inHour);
    return { ok: false, reason: `часовой лимит ${hourCap}`, retryIn: oldest + 3600000 - now };
  }

  if ((state.daySpend || 0) >= settings.ai.dailyBudgetUsd) {
    return { ok: false, reason: 'исчерпан дневной бюджет AI', retryIn: msUntilMidnight(now) };
  }

  if (!settings.ai.apiKey) return { ok: false, reason: 'не задан ключ API' };

  return { ok: true };
}

/**
 * Сколько комментариев допустимо в этот конкретный час.
 *
 * Ровно N комментариев каждый час — это ритм машины: человек то оживляется, то
 * уходит по делам. Поэтому потолок разыгрывается в коридоре `perHourMin`…
 * `perHour`, и разыгрывается **детерминированно по дате и часу**: в течение
 * часа число не должно меняться от вызова к вызову, иначе агент, которому
 * только что отказали, через минуту получил бы разрешение.
 *
 * Тот же приём, что у сдвига слотов публикации: случайность, выведенная из
 * времени, а не разыгранная заново.
 */
export function hourLimit(settings, now = Date.now()) {
  const max = Math.max(1, settings.limits.perHour ?? 3);
  const min = Math.max(1, Math.min(settings.limits.perHourMin ?? max, max));
  if (min === max) return max;

  const d = new Date(now);
  const s = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}#${d.getHours()}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }

  return min + ((h >>> 0) % (max - min + 1));
}

/** Хватает ли бюджета, чтобы вообще обращаться к ИИ. */
export function canSpend(settings, state) {
  return (state.daySpend || 0) < settings.ai.dailyBudgetUsd;
}

export function msUntilMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 30);
  return next.getTime() - now;
}

/* ------------------------- Запись факта действия ------------------------- */

/** Зафиксировать опубликованный комментарий. Мутирует state. */
export function recordComment(state, { author, postId, text }, now = Date.now()) {
  state.dayCount = (state.dayCount || 0) + 1;
  state.hourStamps = [...(state.hourStamps || []), now].filter((t) => t > now - 3600000);

  if (author) {
    const h = String(author).replace(/^@/, '').toLowerCase();
    state.authorCooldown = { ...(state.authorCooldown || {}), [h]: now };
  }
  if (postId) {
    state.seenPosts = [...(state.seenPosts || []), postId].slice(-800);
  }
  if (text) {
    state.recentTexts = [...(state.recentTexts || []), text].slice(-60);
  }

  state.totals = state.totals || {};
  state.totals.comments = (state.totals.comments || 0) + 1;
  return state;
}

export function recordLike(state) {
  state.dayLikes = (state.dayLikes || 0) + 1;
  state.totals = state.totals || {};
  state.totals.likes = (state.totals.likes || 0) + 1;
  return state;
}

export function recordViews(state, n = 1) {
  state.dayViews = (state.dayViews || 0) + n;
  state.totals = state.totals || {};
  state.totals.views = (state.totals.views || 0) + n;
  return state;
}

export function recordSpend(state, usd) {
  state.daySpend = (state.daySpend || 0) + usd;
  state.totals = state.totals || {};
  state.totals.spend = (state.totals.spend || 0) + usd;
  return state;
}

export function recordSkip(state) {
  state.totals = state.totals || {};
  state.totals.skipped = (state.totals.skipped || 0) + 1;
  return state;
}

/** Запомнить пост как виденный, даже если комментировать не стали. */
export function markSeen(state, postId) {
  if (!postId) return state;
  state.seenPosts = [...new Set([...(state.seenPosts || []), postId])].slice(-800);
  return state;
}

/* ----------------------------- Предохранитель ---------------------------- */

/**
 * Три состояния. closed — норма. open — пауза после серии ошибок.
 * half — пробный проход: одна удача возвращает в closed, одна ошибка снова
 * размыкает, причём с удвоенной паузой.
 */
export function onSuccess(state) {
  state.consecutiveErrors = 0;
  state.consecutiveShadowFails = 0;
  if (state.breaker !== 'closed') {
    state.breaker = 'closed';
    state.breakerUntil = 0;
  }
  return state;
}

export function onError(settings, state, now = Date.now()) {
  state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
  state.totals = state.totals || {};
  state.totals.errors = (state.totals.errors || 0) + 1;

  const wasHalf = state.breaker === 'half';
  if (wasHalf || state.consecutiveErrors >= settings.safety.breakerThreshold) {
    const base = settings.safety.breakerCooldownMinutes * 60000;
    state.breaker = 'open';
    state.breakerUntil = now + (wasHalf ? base * 2 : base);
  }
  return state;
}

/** Вызывать перед действием: переводит истёкший open в half. */
export function refreshBreaker(state, now = Date.now()) {
  if (state.breaker === 'open' && now >= (state.breakerUntil || 0)) {
    state.breaker = 'half';
    state.breakerUntil = 0;
  }
  return state;
}

/**
 * Отправка прошла, но комментарий в ветке не появился.
 * Классический признак теневого ограничения. Несколько подряд — стоп.
 */
export function onShadowFail(settings, state, now = Date.now()) {
  state.consecutiveShadowFails = (state.consecutiveShadowFails || 0) + 1;
  if (state.consecutiveShadowFails >= settings.safety.shadowFailThreshold) {
    state.halt = {
      reason: HALT.SHADOW_BAN,
      at: now,
      until: now + settings.safety.onShadowFailPauseHours * 3600000,
      detail: `${state.consecutiveShadowFails} отправок подряд не подтвердились`,
    };
  }
  return state;
}

export function halt(state, reason, detail, untilMs = 0) {
  state.halt = { reason, detail: detail || '', at: Date.now(), until: untilMs };
  return state;
}

/** Причины, которые агент вообще умеет ставить и показывать. */
const KNOWN_HALTS = new Set(Object.values(HALT));

/**
 * Снять остановки, которые больше не действуют.
 *
 * Два случая, и второй появился не от хорошей жизни.
 *
 * **Срок вышел.** Обычное дело: разлогин ставит паузу на две минуты,
 * ограничение действий — на сутки, теневое — на несколько часов.
 *
 * **Причина не из перечня.** Такая остановка неисправна по построению: её
 * нечем показать (`HALT_LABEL` о ней не знает, в плашке видно «остановка:
 * undefined»), с ней не совпадёт ни одна проверка вида `reason === HALT.X`, а
 * если ей вдобавок не проставили срок — снять её может только рука в
 * настройках. Именно так агент простоял четырнадцать часов 03.08: опечатка
 * `HALT.SHADOW` вместо `HALT.SHADOW_BAN` дала `reason: undefined`.
 *
 * Держать такую остановку не за что: она означает не «работать нельзя», а
 * «в коде ошибка». Ошибку чинит правка и проверка перечней в `syntax.mjs`,
 * а агент в это время должен работать, а не стоять.
 */
export function refreshHalt(state, now = Date.now()) {
  const h = state.halt;
  if (!h) return state;

  if (h.until && now >= h.until) state.halt = null;
  else if (!KNOWN_HALTS.has(h.reason)) state.halt = null;

  return state;
}

export function clearHalt(state) {
  state.halt = null;
  state.breaker = 'closed';
  state.breakerUntil = 0;
  state.consecutiveErrors = 0;
  state.consecutiveShadowFails = 0;
  return state;
}

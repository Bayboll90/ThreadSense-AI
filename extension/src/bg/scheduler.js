/**
 * Планировщик активности.
 *
 * Модель поведения — не «одно действие раз в N минут», а «сессия — перерыв».
 * Человек заходит в соцсеть всплесками: открыл, полистал десять минут, что-то
 * написал, ушёл на полтора часа. Ровный интервал между действиями — самая
 * заметная подпись автоматизации, какие бы человечные задержки ни стояли
 * внутри самого клика.
 *
 * Поверх сессий лежат две модуляции: окно активности (жёсткое) и циркадная
 * кривая (мягкая, вероятностная). Ночью агент не «выключен» формально, у него
 * просто почти нулевая вероятность начать сессию, и редкое позднее сообщение
 * выглядит естественно, а не как сбой расписания.
 */

import { expDelay, chance, randInt, uniform } from '../common/rng.js';
import { planFresh } from './rhythm.js';

/* --------------------------- Окна и циркадика ---------------------------- */

/**
 * Расписание с поправкой на сегодняшний распорядок.
 *
 * Окно активности в настройках — это привычка, а не приказ: человек встаёт то
 * раньше, то позже. Разыгранный на сутки план подменяет границы окна, всё
 * остальное — циркадная кривая, длительности сессий, перерывы — остаётся
 * прежним.
 *
 * Если ритм выключен или план протух (не тот день, состояние сброшено),
 * возвращается неподвижная рамка из настроек. Это осознанный запасной путь:
 * агент без ритма заметнее, но работоспособен полностью.
 */
export function effectiveTiming(settings, state) {
  const t = settings.timing;
  const plan = state?.rhythm;
  if (!settings.rhythm?.enabled || !planFresh(plan)) return t;
  return { ...t, activeFrom: plan.wake ?? t.activeFrom, activeTo: plan.sleep ?? t.activeTo };
}

/** Внутри ли мы разрешённого окна по дню недели и часу. */
export function inActiveWindow(timing, at = new Date()) {
  const day = at.getDay();
  if (Array.isArray(timing.activeWeekdays) && !timing.activeWeekdays.includes(day)) return false;

  const h = at.getHours() + at.getMinutes() / 60;
  const { activeFrom, activeTo } = timing;

  // Окно через полночь, например 22:00–03:00.
  if (activeTo <= activeFrom) return h >= activeFrom || h < activeTo;
  return h >= activeFrom && h < activeTo;
}

/** Множитель активности текущего часа, 0..1. */
export function circadianFactor(timing, at = new Date()) {
  const arr = timing.circadian;
  if (!Array.isArray(arr) || arr.length !== 24) return 1;

  // Линейная интерполяция между соседними часами: иначе на границе часа
  // активность прыгает скачком, что само по себе регулярность.
  const h = at.getHours();
  const frac = at.getMinutes() / 60;
  const a = Number(arr[h]) || 0;
  const b = Number(arr[(h + 1) % 24]) || 0;
  return Math.max(0, Math.min(1, a + (b - a) * frac));
}

/**
 * Сколько ждать до ближайшего момента, когда окно снова откроется, мс.
 * Нужно, чтобы не тикать вхолостую всю ночь.
 */
export function msUntilWindowOpens(timing, from = new Date()) {
  const probe = new Date(from.getTime());
  probe.setSeconds(0, 0);
  for (let i = 0; i < 24 * 8; i++) {
    probe.setTime(probe.getTime() + 15 * 60000);
    if (inActiveWindow(timing, probe) && circadianFactor(timing, probe) > 0.05) {
      return probe.getTime() - from.getTime();
    }
  }
  return 60 * 60000;
}

/**
 * Человеческая подпись к ожиданию: во сколько агент проснётся.
 *
 * Команда простоя режется десятью минутами, чтобы тикер не засыпал намертво и
 * пережил перезагрузку вкладки. Плашка честно показывает этот тик — и
 * восьмичасовое ожидание выглядит как «дальше через 10 мин», повторяющееся
 * снова и снова. Отличить это от зависшего агента снаружи невозможно, что и
 * произошло: сон до утра приняли за поломку.
 *
 * Поэтому час пробуждения пишется в саму причину простоя, а не выводится из
 * длины тика.
 */
export function wakeLabel(timing, from = new Date()) {
  const at = new Date(from.getTime() + msUntilWindowOpens(timing, from));
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/* -------------------------------- Сессии --------------------------------- */

/**
 * Розыгрыш новой сессии.
 * @returns {{active, idle, startedAt, endsAt, plannedActions, doneActions}}
 */
export function planSession(settings, now = Date.now()) {
  const t = settings.timing;
  const idle = chance(settings.limits.idleSessionChance);

  const minutes = uniform(t.sessionMinMinutes, t.sessionMaxMinutes);
  const actions = idle ? 0 : randInt(t.sessionMinActions, t.sessionMaxActions);

  return {
    active: true,
    idle,
    startedAt: now,
    endsAt: now + minutes * 60000,
    plannedActions: actions,
    doneActions: 0,
    // Счётчики нормы. Обнуляются с каждой сессией: иначе норма просмотров
    // выбирается один раз, и дальше агент пишет без всякого чтения.
    browseCount: 0,
    likeCount: 0,
  };
}

/** Пауза до следующей сессии, мс. Экспоненциальная. */
export function planBreak(settings) {
  const t = settings.timing;
  return expDelay(t.breakMeanMinutes, t.breakMinMinutes, t.breakMaxMinutes) * 60000;
}

/** Пауза между действиями внутри сессии, мс. Тоже экспоненциальная. */
export function planInSessionDelay(settings) {
  const t = settings.timing;
  return expDelay(t.inSessionMeanSec, t.inSessionMinSec, t.inSessionMaxSec) * 1000;
}

/**
 * Пора ли открывать новую сессию.
 *
 * Циркадная кривая работает как вероятностный фильтр: даже когда время
 * формально пришло, при factor = 0.2 сессия стартует лишь в одном случае из
 * пяти, а остальные попытки сдвигают старт вперёд. Получается плавное
 * затухание активности к ночи вместо резкой отсечки по часам.
 */
export function shouldStartSession(settings, state, now = Date.now()) {
  const at = new Date(now);
  // Границы окна — сегодняшние: подъём и отбой разыграны при смене суток.
  const timing = effectiveTiming(settings, state);

  if (!inActiveWindow(timing, at)) {
    return {
      start: false,
      retryIn: msUntilWindowOpens(timing, at),
      why: `вне окна активности, до ${wakeLabel(timing, at)}`,
    };
  }

  const factor = circadianFactor(timing, at);
  if (factor <= 0.02) {
    return {
      start: false,
      retryIn: msUntilWindowOpens(timing, at),
      why: `ночной провал активности, до ${wakeLabel(timing, at)}`,
    };
  }

  if (now < (state.nextSessionAt || 0)) {
    return { start: false, retryIn: state.nextSessionAt - now, why: 'перерыв между сессиями' };
  }

  if (!chance(factor)) {
    // Не в этот раз. Сдвигаем на небольшой случайный интервал и пробуем снова.
    return { start: false, retryIn: expDelay(9 * 60000, 3 * 60000, 25 * 60000), why: 'циркадный отказ' };
  }

  return { start: true, factor };
}

/** Пора ли завершить текущую сессию. */
export function shouldEndSession(session, now = Date.now()) {
  if (!session?.active) return false;
  if (now >= session.endsAt) return true;
  if (session.plannedActions > 0 && session.doneActions >= session.plannedActions) return true;
  // Холостая сессия ограничена только временем.
  return false;
}

/* ------------------------- Соотношение действий -------------------------- */

/**
 * Что делать на текущем шаге внутри сессии.
 *
 * Аккаунт, который только пишет комментарии и ничего не читает и не лайкает,
 * аномален по любой поведенческой метрике. Соотношение задаётся настройками
 * viewsPerComment и likesPerComment: на каждый комментарий приходится N
 * «прочитанных» постов и M лайков. Розыгрыш вероятностный, а не по счётчику —
 * жёсткая последовательность «просмотр, просмотр, лайк, комментарий» тоже
 * была бы паттерном.
 *
 * @returns {'comment'|'like'|'browse'}
 */
export function pickAction(settings, session) {
  if (session.idle) return 'browse';
  if (session.plannedActions > 0 && session.doneActions >= session.plannedActions) return 'browse';

  const { viewsPerComment, likesPerComment } = settings.limits;
  const views = session.browseCount || 0;
  const likes = session.likeCount || 0;

  /*
   * Норма просмотров отсчитывается, а не разыгрывается.
   *
   * Чисто вероятностный выбор здесь не работает, и это видно на арифметике.
   * При двенадцати просмотрах на комментарий шанс попасть на комментарий —
   * один к тринадцати за слот; чтобы он выпал, нужно порядка тринадцати
   * слотов. При семиминутном интервале это полтора часа, тогда как сессия
   * длится двадцать-тридцать минут. Комментарий внутри сессии оказывался
   * практически невозможен: агент открывал сессию, листал ленту и уходил
   * на перерыв, так ничего и не написав.
   *
   * Счётчик решает это прямо: набрал норму просмотров — пора писать.
   * Случайность при этом остаётся, но работает в другую сторону: комментарий
   * может выпасть и раньше срока, поэтому интервалы между ними не выстраиваются
   * в ровную сетку.
   */
  if (views >= Math.max(1, viewsPerComment)) return 'comment';

  const wComment = 1;
  // В режиме проверки черновиков агент не совершает никаких социальных
  // действий без подтверждения. Лайк нельзя положить в очередь, поэтому он
  // появляется только вместе с явно включённым автопилотом.
  const wLike = settings.autopilot && likes < likesPerComment ? Math.max(0, likesPerComment) : 0;
  const wBrowse = Math.max(1, viewsPerComment - likes);

  const total = wComment + wLike + wBrowse;
  let r = Math.random() * total;
  if ((r -= wComment) <= 0) return 'comment';
  if ((r -= wLike) <= 0) return 'like';
  return 'browse';
}

/* ------------------------------ Диагностика ------------------------------ */

/**
 * Оценка среднего числа действий в сутки при текущих настройках.
 * Показывается в UI, чтобы было видно: подкрутил перерывы — вот столько выйдет
 * на самом деле, а не столько, сколько написано в поле «лимит в день».
 */
export function estimateDailyActions(settings) {
  const t = settings.timing;
  const l = settings.limits;

  const avgSessionMin = (t.sessionMinMinutes + t.sessionMaxMinutes) / 2;
  const avgBreakMin = Math.min(
    Math.max(t.breakMeanMinutes, t.breakMinMinutes),
    t.breakMaxMinutes,
  );
  const cycleMin = avgSessionMin + avgBreakMin;

  // Сколько часов в сутки реально «живых» с учётом окна и циркадики.
  let awake = 0;
  for (let h = 0; h < 24; h++) {
    const probe = new Date();
    probe.setHours(h, 30, 0, 0);
    if (!inActiveWindow(t, probe)) continue;
    awake += circadianFactor(t, probe);
  }

  const sessionsPerDay = (awake * 60) / Math.max(1, cycleMin);
  const avgActions = (t.sessionMinActions + t.sessionMaxActions) / 2;
  const workingSessions = sessionsPerDay * (1 - l.idleSessionChance);

  /*
   * Сколько комментариев успевает поместиться в одну сессию.
   *
   * Норма просмотров отсчитывается, поэтому до первого комментария проходит
   * viewsPerComment коротких пауз плюс сами лайки. Если этот путь длиннее
   * сессии, комментария не будет вовсе — именно так и выглядела ошибка,
   * из-за которой агент листал ленту всю ночь и ничего не писал.
   */
  const browseGapSec = t.inSessionMeanSec * 0.12;
  const likeGapSec = t.inSessionMeanSec * 0.35;
  const toFirstCommentSec = l.viewsPerComment * browseGapSec + l.likesPerComment * likeGapSec;
  const perCommentSec = toFirstCommentSec + t.inSessionMeanSec;

  const sessionSec = ((t.sessionMinMinutes + t.sessionMaxMinutes) / 2) * 60;
  const fitPerSession = Math.min(avgActions, Math.floor(sessionSec / Math.max(1, perCommentSec)));

  const comments = workingSessions * Math.max(0, fitPerSession);

  return {
    sessionsPerDay: Math.round(sessionsPerDay * 10) / 10,
    awakeHours: Math.round(awake * 10) / 10,
    estimatedComments: Math.round(comments * 10) / 10,
    cycleMinutes: Math.round(cycleMin),
    // Видно, укладывается ли норма просмотров в длину сессии.
    minutesToFirstComment: Math.round(perCommentSec / 60),
    fitPerSession,
  };
}

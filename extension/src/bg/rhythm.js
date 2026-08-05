/**
 * Ритм жизни: чем сегодняшний день отличается от вчерашнего.
 *
 * Планировщик уже умеет главное — сессии и перерывы вместо ровного интервала
 * между действиями. Но поверх него лежала неподвижная рамка: окно активности
 * 7:00–01:00, все семь дней недели, одна и та же циркадная кривая, один и тот
 * же дневной лимит с разбросом в четверть. За девять дней это дало ровно то,
 * что и должно было: 122 комментария, ни одного пропущенного дня, восемнадцать
 * часов присутствия в сутки — и проверку «Confirm you're human» 04.08.2026.
 *
 * Живой человек так не выглядит. Он встаёт то в восемь, то в одиннадцать,
 * пропадает на обед и на дорогу, в среду залипает в ленте, в четверг заходит
 * дважды по минуте, а в выходные его либо нет, либо он там весь день.
 * Разброс — не украшение, а само содержание правдоподобия: одинаковость
 * заметна даже там, где каждое отдельное действие безупречно.
 *
 * Что здесь разыгрывается на сутки вперёд:
 *
 *  - **подъём и отбой** — своё время каждый день, сдвиг до полутора часов;
 *  - **настроение дня** — множитель нормы: выходной, вялый, обычный, залипание;
 *  - **отлучки** — один-три провала по часу-полтора: обед, дорога, дела.
 *
 * Почему на сутки вперёд и в состояние, а не по функции от текущего времени.
 * План должен пережить перезагрузку браузера: агент перезапускается по
 * несколько раз в день (выкат, сторож, восстановление), и распорядок,
 * вычисляемый заново при каждом старте, дал бы человека, у которого обед
 * трижды за вечер. Разыгранное лежит в состоянии и видно в журнале — то есть
 * на вопрос «почему агент молчал с 14 до 16» есть ответ, а не догадка.
 */

import { uniform, gauss, randInt, clamp } from '../common/rng.js';

/**
 * Настроения дня и их вес.
 *
 * Числа подобраны из простого требования: за неделю должен получаться хотя бы
 * один почти пустой день и хотя бы один заметно живой, а среднее по неделе —
 * оставаться близким к дневной норме. При равномерном распределении «то густо,
 * то пусто» не выходит: семь одинаково средних дней подряд и есть та самая
 * ровность, от которой уходим.
 */
export const MOODS = {
  /* Человека нет: заглянул на минуту или не заходил вовсе. */
  off: { weight: 12, factor: 0, label: 'выходной' },
  /* Заглядывал мельком. */
  low: { weight: 26, factor: 0.45, label: 'вялый день' },
  /* Обычный день. */
  normal: { weight: 44, factor: 1, label: 'обычный день' },
  /* Залип в ленте. */
  high: { weight: 18, factor: 1.35, label: 'залипание' },
};

function rollMood(rhythm) {
  const weights = { ...MOODS };
  // Настройки могут двигать долю пустых дней, не трогая остальные.
  if (Number.isFinite(rhythm?.offDayChance)) {
    weights.off = { ...weights.off, weight: Math.max(0, rhythm.offDayChance * 100) };
  }

  const total = Object.values(weights).reduce((a, m) => a + m.weight, 0);
  let r = Math.random() * total;
  for (const [key, m] of Object.entries(weights)) {
    if ((r -= m.weight) <= 0) return key;
  }
  return 'normal';
}

/**
 * Разыграть распорядок на сутки.
 *
 * @param {object} settings
 * @param {Date} at начало суток, для которых разыгрываем
 * @returns {object} план дня
 */
export function rollDay(settings, at = new Date()) {
  const t = settings.timing || {};
  const r = settings.rhythm || {};

  if (!r.enabled) {
    return { day: dayKey(at), mood: 'normal', factor: 1, wake: t.activeFrom, sleep: t.activeTo, gaps: [] };
  }

  const mood = rollMood(r);
  const drift = Math.max(0, r.driftHours ?? 1.5);

  /*
   * Выходной — это не «агент выключен на сутки».
   *
   * Аккаунт, исчезающий ровно на календарный день и возвращающийся к
   * прежнему темпу, выглядит не отдыхом, а расписанием. У человека выходной
   * означает другое: он заглянул вечером на час, полистал, может быть ответил
   * кому-то одному. Поэтому окно сжимается до одного короткого визита в
   * случайное время, а не закрывается совсем.
   */
  if (mood === 'off') {
    const from = uniform(t.activeFrom + 2, sleepAsHours(t.activeFrom, t.activeTo) - 2);
    const len = uniform(0.5, 2);
    return {
      day: dayKey(at),
      mood,
      factor: 0,
      wake: round2(from % 24),
      sleep: round2((from + len) % 24),
      gaps: [],
    };
  }

  /*
   * Подъём и отбой.
   *
   * Гауссово смещение, а не равномерное: чаще человек встаёт около
   * привычного часа, реже — заметно раньше или позже. Хвосты обрезаны, чтобы
   * «сдвиг на полтора часа» не превращался в круглосуточную доступность.
   */
  const wake = clamp(t.activeFrom + gauss(0, drift / 2), t.activeFrom - drift, t.activeFrom + drift);
  const sleep = clamp(t.activeTo + gauss(0, drift / 2), t.activeTo - drift, t.activeTo + drift);

  /*
   * Отлучки.
   *
   * Провал в середине дня — самое человеческое, чего у агента не было вовсе.
   * Он присутствовал ровным фоном все часы окна, и в этом смысле был заметнее
   * любого всплеска: у людей день разорван работой, дорогой и едой.
   */
  const gaps = [];
  const count = randInt(r.gapsMin ?? 1, r.gapsMax ?? 3);
  for (let i = 0; i < count; i++) {
    const from = uniform(wake + 1, Math.max(wake + 1.5, sleepAsHours(wake, sleep) - 1.5));
    const len = uniform(r.gapMinMinutes ?? 40, r.gapMaxMinutes ?? 150) / 60;
    gaps.push({ from: round2(from), to: round2(from + len) });
  }
  gaps.sort((a, b) => a.from - b.from);

  return {
    day: dayKey(at),
    mood,
    factor: MOODS[mood]?.factor ?? 1,
    wake: round2(wake),
    sleep: round2(sleep),
    gaps: mergeGaps(gaps),
  };
}

/** Ключ суток — тот же, что у состояния. */
function dayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Конец окна в часах от подъёма.
 * Окно через полночь (7:00–01:00) — обычное дело, и «до часа ночи» означает
 * двадцать пятый час, а не первый.
 */
function sleepAsHours(wake, sleep) {
  return sleep <= wake ? sleep + 24 : sleep;
}

/** Слить пересекающиеся отлучки: два обеда подряд — это один длинный обед. */
function mergeGaps(gaps) {
  const out = [];
  for (const g of gaps) {
    const last = out[out.length - 1];
    if (last && g.from <= last.to + 0.1) last.to = Math.max(last.to, g.to);
    else out.push({ ...g });
  }
  return out;
}

/* ------------------------------ Применение -------------------------------- */

/**
 * Действует ли план на текущие сутки.
 * Разыгранный вчера распорядок сегодня не годится, а перепутать их легко:
 * состояние переживает и полночь, и перезагрузку.
 */
export function planFresh(plan, at = new Date()) {
  return !!plan && plan.day === dayKey(at);
}

/** Внутри ли момент одной из отлучек. */
export function inGap(plan, at = new Date()) {
  if (!plan?.gaps?.length) return null;
  const h = at.getHours() + at.getMinutes() / 60;
  for (const g of plan.gaps) {
    const from = g.from;
    const to = g.to > 24 ? g.to - 24 : g.to;
    const hit = g.to > 24 ? (h >= from || h < to) : (h >= from && h < to);
    if (hit) return g;
  }
  return null;
}

/*
 * Окно активности с поправкой на план дня живёт в `scheduler.effectiveTiming`,
 * а не здесь: там оно нужно вместе с циркадной кривой и длительностями
 * сессий, и разводить два способа получить одно и то же — верный путь к
 * расхождению между ними.
 */

/** Час дробным числом в «чч:мм». */
export function hhmm(h) {
  const x = ((h % 24) + 24) % 24;
  return `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.round((x % 1) * 60)).padStart(2, '0')}`;
}

/**
 * Сколько миллисекунд до указанного часа суток.
 * Час уже прошёл — значит речь про завтра.
 */
export function msUntilHour(h, from = new Date()) {
  const target = new Date(from);
  const x = ((h % 24) + 24) % 24;
  target.setHours(Math.floor(x), Math.round((x % 1) * 60), 0, 0);
  if (target <= from) target.setDate(target.getDate() + 1);
  return target - from;
}

/**
 * Человеческое описание плана — для журнала.
 * Пишется один раз в сутки: по нему потом видно, почему день вышел таким.
 */
export function describePlan(plan) {
  if (!plan) return 'ритм выключен';
  const gaps = plan.gaps?.length
    ? plan.gaps.map((g) => `${hhmm(g.from)}–${hhmm(g.to)}`).join(', ')
    : 'без отлучек';
  return `${MOODS[plan.mood]?.label || plan.mood}: ${hhmm(plan.wake)}–${hhmm(plan.sleep)}, ${gaps}`;
}

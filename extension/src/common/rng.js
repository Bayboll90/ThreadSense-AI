/**
 * Случайные величины.
 *
 * Ключевая мысль всего проекта: человек не действует по таймеру. Любая
 * равномерная сетка задержек — это подпись скрипта. Поэтому паузы берутся из
 * экспоненциального распределения (пуассоновский поток событий), задержки между
 * нажатиями клавиш — из логнормального (так реально выглядит человеческий
 * набор), а выбор цели — из softmax, а не argmax.
 */

/** Равномерное [0,1), но никогда ровно 0 — нужно для ln(). */
export function u01() {
  let u = 0;
  while (u === 0) u = Math.random();
  return u;
}

/** Равномерное в [a,b). */
export function uniform(a, b) {
  return a + (b - a) * Math.random();
}

/** Целое в [a,b] включительно. */
export function randInt(a, b) {
  return Math.floor(a + Math.random() * (b - a + 1));
}

/** Событие с вероятностью p. */
export function chance(p) {
  return Math.random() < p;
}

/**
 * Экспоненциальное распределение со средним `mean`, обрезанное в [min,max].
 *
 * Обрезка через повторный розыгрыш, а не через clamp: clamp сажает массу
 * вероятности ровно на границы и создаёт заметные пики на min и max. До 12
 * попыток, потом честный clamp как страховка от зависания.
 */
export function expDelay(mean, min, max) {
  if (!(mean > 0)) return min;
  for (let i = 0; i < 12; i++) {
    const x = -mean * Math.log(u01());
    if (x >= min && x <= max) return x;
  }
  return Math.min(max, Math.max(min, -mean * Math.log(u01())));
}

/** Нормальное распределение, преобразование Бокса — Мюллера. */
export function gauss(mu = 0, sigma = 1) {
  const u = u01();
  const v = u01();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Нормальное, обрезанное в [min,max] повторным розыгрышем. */
export function gaussClamped(mu, sigma, min, max) {
  for (let i = 0; i < 12; i++) {
    const x = gauss(mu, sigma);
    if (x >= min && x <= max) return x;
  }
  return Math.min(max, Math.max(min, mu));
}

/**
 * Логнормальное со средним `mean` и коэффициентом вариации `cv`.
 * Именно так распределены межклавишные интервалы у людей: длинный правый хвост
 * (задумался), плотное ядро (привычные сочетания).
 */
export function lognormal(mean, cv = 0.55) {
  const sigma2 = Math.log(1 + cv * cv);
  const mu = Math.log(mean) - sigma2 / 2;
  return Math.exp(gauss(mu, Math.sqrt(sigma2)));
}

/** Логнормальное, обрезанное. */
export function lognormalClamped(mean, cv, min, max) {
  for (let i = 0; i < 12; i++) {
    const x = lognormal(mean, cv);
    if (x >= min && x <= max) return x;
  }
  return Math.min(max, Math.max(min, mean));
}

/** Случайный элемент массива. */
export function pick(arr) {
  if (!arr || !arr.length) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Взвешенный выбор.
 * @param {Array<[any, number]>} pairs пары [значение, вес]
 */
export function weightedPick(pairs) {
  const usable = pairs.filter(([, w]) => w > 0);
  if (!usable.length) return pairs.length ? pairs[0][0] : undefined;
  const total = usable.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of usable) {
    r -= w;
    if (r <= 0) return v;
  }
  return usable[usable.length - 1][0];
}

/**
 * Softmax-выбор индекса по скорам.
 *
 * Всегда брать максимум — предсказуемо и, что важнее, приводит к однотипным
 * целям: агент вечно висит на одних и тех же крупных авторах. Температура T
 * задаёт разброс: T→0 это argmax, большие T это почти равномерный выбор.
 */
export function softmaxPick(scores, T = 0.35) {
  if (!scores.length) return -1;
  const t = Math.max(1e-6, T);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / t));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (!isFinite(sum) || sum <= 0) return scores.indexOf(max);
  let r = Math.random() * sum;
  for (let i = 0; i < exps.length; i++) {
    r -= exps[i];
    if (r <= 0) return i;
  }
  return exps.length - 1;
}

/** Перемешивание Фишера — Йейтса, на месте. */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Умножить значение на случайный множитель из [1-j, 1+j]. */
export function jitter(value, j) {
  return value * (1 - j + 2 * j * Math.random());
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

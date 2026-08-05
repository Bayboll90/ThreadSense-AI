/**
 * Защита от самоповтора: не только «этот текст уже был».
 *
 * Сравнение по триграммам ловит перефразировку, но не ловит главного — того,
 * что человек замечает первым. Профиль, где каждый второй пост про Claude
 * Code, читается однообразным, даже если ни одна формулировка не повторилась.
 * И десяток ответов, начинающихся с «Короче,», выглядит шаблоном, хотя тексты
 * разные.
 *
 * Поэтому здесь три независимых измерения новизны:
 *
 *  - **Текст.** Похоже ли на что-то уже написанное. Обычное сходство.
 *  - **Тема.** Не сидим ли слишком долго на одном предмете. Считается по
 *    редким словам: частые слова есть везде и различать не помогают.
 *  - **Зачин.** Не начинаем ли раз за разом одинаково. Первые три слова.
 *
 * Все три возвращают одно число, потому что решение принимается одно:
 * публиковать или переписать.
 */

/* Слова, которые есть в любом тексте ниши и потому ничего не различают. */
const STOP = new Set([
  'это', 'что', 'как', 'так', 'вот', 'если', 'когда', 'потом', 'уже', 'ещё', 'еще',
  'меня', 'тебя', 'него', 'него', 'себя', 'свой', 'свои', 'своё', 'наш', 'мой',
  'быть', 'было', 'были', 'есть', 'стало', 'стал', 'будет', 'может', 'можно',
  'очень', 'просто', 'тоже', 'даже', 'только', 'больше', 'меньше', 'лучше',
  'него', 'них', 'для', 'при', 'над', 'под', 'без', 'про', 'после', 'перед',
  'ии', 'ai', 'the', 'and', 'for', 'you', 'not', 'but',
]);

/** Значимые слова текста: без стоп-слов и коротышей. */
export function keywords(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  )];
}

/** Зачин: первые три значащих слова. По ним узнаётся шаблон. */
export function opening(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

function trigrams(s) {
  const t = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function textSimilarity(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Насколько тема пересекается с недавними.
 *
 * Доля значимых слов кандидата, которые уже встречались. Свежая тема даёт
 * около нуля, повтор — близко к единице.
 */
export function topicOverlap(text, recent) {
  const mine = keywords(text);
  if (!mine.length) return 0;

  const seen = new Set();
  for (const r of recent) for (const w of keywords(r)) seen.add(w);
  if (!seen.size) return 0;

  return mine.filter((w) => seen.has(w)).length / mine.length;
}

/**
 * Оценка новизны: 1 — ни на что не похоже, 0 — уже было.
 *
 * Берём худшее из трёх измерений, а не среднее. Текст, повторяющий чужую
 * формулировку, не спасает свежая тема: заметят именно повтор.
 */
export function noveltyOf(text, recent = [], { openings = [] } = {}) {
  if (!recent.length && !openings.length) return { score: 1, worst: null };

  const maxSim = recent.reduce((m, r) => Math.max(m, textSimilarity(text, r)), 0);
  const overlap = topicOverlap(text, recent);

  const op = opening(text);
  const opRepeats = openings.filter((o) => o === op).length;
  // Один повтор зачина — совпадение, три — манера.
  const opPenalty = Math.min(1, opRepeats / 3);

  const parts = [
    { name: 'формулировка', v: 1 - maxSim },
    { name: 'тема', v: 1 - Math.max(0, overlap - 0.35) / 0.65 },
    { name: 'зачин', v: 1 - opPenalty },
  ];

  const worst = parts.reduce((a, b) => (a.v <= b.v ? a : b));
  return {
    score: Math.max(0, Math.min(1, worst.v)),
    worst: worst.name,
    similarity: maxSim,
    overlap,
    openingRepeats: opRepeats,
  };
}

/**
 * Темы, которых давно не было, — подсказка генератору.
 *
 * Не запрет, а именно подсказка: агент, которому нечего сказать нового по
 * теме, лучше скажет по соседней, чем повторит сказанное.
 */
export function tiredTopics(recent, limit = 6) {
  const count = {};
  for (const r of recent) for (const w of keywords(r)) count[w] = (count[w] || 0) + 1;

  return Object.entries(count)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

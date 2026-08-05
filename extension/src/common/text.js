/**
 * Работа с текстом: нормализация, схожесть, определение языка, хеши.
 */

/**
 * Нормализация для сравнения: нижний регистр, ё→е, только буквы и цифры,
 * одиночные пробелы. Убирает всю поверхностную вариативность, чтобы
 * «Согласен! Так и есть 🔥» и «согласен, так и есть» считались одинаковыми.
 */
export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Множество символьных триграмм нормализованной строки. */
export function trigrams(s) {
  const t = ` ${normalize(s)} `;
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

/**
 * Коэффициент Жаккара по триграммам, 0..1.
 *
 * Почему триграммы, а не слова: ИИ любит переставлять слова и менять окончания,
 * оставляя ту же фразу. Пословный Жаккар это пропускает, символьный — нет.
 */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : trigrams(a);
  const B = b instanceof Set ? b : trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Максимальная схожесть строки с любой из списка. */
export function maxSimilarity(text, list) {
  const t = trigrams(text);
  let best = 0;
  for (const other of list) {
    const s = jaccard(t, trigrams(other));
    if (s > best) best = s;
    if (best >= 0.999) break;
  }
  return best;
}

/** Грубое определение языка по алфавиту. Хватает, чтобы отделить ru от en. */
export function detectLang(s) {
  const text = (s || '').replace(/[^\p{L}]/gu, '');
  if (!text) return 'unknown';
  const cyr = (text.match(/[а-яё]/gi) || []).length;
  const lat = (text.match(/[a-z]/gi) || []).length;
  const total = cyr + lat;
  if (total < 4) return 'unknown';
  if (cyr / total > 0.55) return 'ru';
  if (lat / total > 0.75) return 'en';
  return 'mixed';
}

/** Есть ли хоть одно вхождение из списка. Регистронезависимо, по подстроке. */
export function hasAny(text, needles) {
  if (!needles || !needles.length) return false;
  const t = (text || '').toLowerCase().replace(/ё/g, 'е');
  return needles.some((n) => {
    const k = String(n).toLowerCase().replace(/ё/g, 'е').trim();
    return k && t.includes(k);
  });
}

/** Сколько разных вхождений из списка встретилось. */
export function countAny(text, needles) {
  if (!needles || !needles.length) return 0;
  const t = (text || '').toLowerCase().replace(/ё/g, 'е');
  let n = 0;
  for (const raw of needles) {
    const k = String(raw).toLowerCase().replace(/ё/g, 'е').trim();
    if (k && t.includes(k)) n++;
  }
  return n;
}

/** Быстрый строковый хеш FNV-1a, в hex. Для дедупа постов. */
export function hash(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Обрезать по границе слова, не разрывая слова пополам. */
export function truncateWords(s, maxLen) {
  const t = (s || '').trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const sp = cut.lastIndexOf(' ');
  return (sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?-]+$/, '');
}

/** Убрать управляющие символы и невидимые пробелы, схлопнуть переносы. */
export function sanitize(s) {
  return (s || '')
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const URL_RE = /(https?:\/\/|www\.)[^\s]+|[a-z0-9-]+\.(ru|com|net|org|io|dev|ai|me|co|xyz|app)\b/i;
export const MENTION_RE = /(^|\s)@[a-zA-Z0-9._]{2,}/;
export const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]{2,}/u;

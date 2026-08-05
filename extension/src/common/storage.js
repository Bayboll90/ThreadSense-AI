/**
 * Обёртка над chrome.storage.local с миграциями схемы и кешем в памяти.
 *
 * Три независимых ключа: settings, state, queue. Разделены намеренно —
 * сброс настроек не должен обнулять счётчики прогрева, а тяжёлая очередь не
 * должна переписываться при каждом изменении слайдера.
 */

import {
  DEFAULTS, DEFAULT_STATE, DEFAULT_QUEUE, SCHEMA_VERSION, deepMerge, migrateSettings,
} from './defaults.js';

const K_SETTINGS = 'settings';
const K_STATE = 'state';
const K_QUEUE = 'queue';
const K_LOG = 'log';

const cache = { settings: null, state: null, queue: null };

async function rawGet(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return got[key] === undefined ? fallback : got[key];
}

async function rawSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/* -------------------------------- Settings ------------------------------- */

export async function getSettings(force = false) {
  if (cache.settings && !force) return cache.settings;
  const stored = await rawGet(K_SETTINGS, null);
  const merged = migrateSettings(deepMerge(DEFAULTS, stored || {}), stored?.version ?? 0);
  cache.settings = merged;
  if (!stored || stored.version !== SCHEMA_VERSION) await rawSet(K_SETTINGS, merged);
  return merged;
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch);
  next.version = SCHEMA_VERSION;
  cache.settings = next;
  await rawSet(K_SETTINGS, next);
  return next;
}

/** Полная замена настроек — для импорта JSON и сброса. */
export async function replaceSettings(obj) {
  const next = deepMerge(DEFAULTS, obj || {});
  next.version = SCHEMA_VERSION;
  cache.settings = next;
  await rawSet(K_SETTINGS, next);
  return next;
}

// Сама миграция живёт в defaults.js рядом со схемой: там она остаётся чистой
// функцией и проверяется тестом без chrome.storage.

/* --------------------------------- State --------------------------------- */

export async function getState(force = false) {
  if (cache.state && !force) return cache.state;
  const stored = await rawGet(K_STATE, null);
  const merged = deepMerge(DEFAULT_STATE, stored || {});
  if (!merged.firstRunDate) merged.firstRunDate = todayKey();
  cache.state = merged;
  return merged;
}

export async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  cache.state = next;
  await rawSet(K_STATE, next);
  return next;
}

/**
 * Атомарное обновление состояния.
 * Все счётчики трогаем только через это — гонок между тикером content-скрипта
 * и пробуждениями service worker хватает, чтобы потерять инкремент.
 */
let stateLock = Promise.resolve();
export function updateState(fn) {
  const run = stateLock.then(async () => {
    const cur = await getState(true);
    const next = (await fn(cur)) || cur;
    cache.state = next;
    await rawSet(K_STATE, next);
    return next;
  });
  stateLock = run.catch(() => {});
  return run;
}

/**
 * Поля, которые сброс счётчиков обязан пережить.
 *
 * Это не счётчики, а память о сделанном: где мы уже отметились, о чём уже
 * написали, какие слоты отработали. Стереть её значит разрешить агенту сделать
 * то же самое второй раз.
 *
 * Живой случай, из-за которого список появился. Перезапуск обнулил
 * `postedSlots` и `postedNews`, слот 15:00 снова стал свободным, новость про
 * релиз Opus 5 — неиспользованной, и агент через двенадцать минут после первого
 * поста начал писать почти такой же. Спасло только то, что я смотрел в журнал.
 *
 * Кнопка называется «Сбросить счётчики». Счётчики — можно, память — нет.
 */
const KEEP_ON_RESET = [
  'seenPosts',      // где уже отметились
  'postedNews',     // о чём уже написали
  'postedSlots',    // какие слоты отработали
  'missedSlots',    // о каких потерянных уже сказали в журнале
  'recentPosts',    // тексты постов: защита от самоповтора
  'recentPostKinds',
  'lastPostKind',
  'published',      // ответы под наблюдением
  'authorCooldown', // кому недавно отвечали
  'recentTexts',    // тексты комментариев: защита от самоповтора
  'history',        // статистика прошлых дней
  'firstRunDate',   // возраст аккаунта: от него зависит прогрев
  'restartDate',    // когда прогрев начали заново после ограничения
];

export async function resetState() {
  const prev = await getState(true);
  const fresh = deepMerge(DEFAULT_STATE, { firstRunDate: prev?.firstRunDate || todayKey() });

  for (const k of KEEP_ON_RESET) {
    if (prev && prev[k] !== undefined) fresh[k] = prev[k];
  }

  cache.state = fresh;
  await rawSet(K_STATE, fresh);
  return fresh;
}

/* --------------------------------- Queue --------------------------------- */

export async function getQueue(force = false) {
  if (cache.queue && !force) return cache.queue;
  const stored = await rawGet(K_QUEUE, null);
  cache.queue = deepMerge(DEFAULT_QUEUE, stored || {});
  return cache.queue;
}

let queueLock = Promise.resolve();
export function updateQueue(fn) {
  const run = queueLock.then(async () => {
    const cur = await getQueue(true);
    const next = (await fn(cur)) || cur;
    cache.queue = next;
    await rawSet(K_QUEUE, next);
    return next;
  });
  queueLock = run.catch(() => {});
  return run;
}

/* ---------------------------------- Log ---------------------------------- */

export async function getLog() {
  return rawGet(K_LOG, []);
}

export async function clearLog() {
  await rawSet(K_LOG, []);
}

let logLock = Promise.resolve();

/**
 * Подавление повторов в журнале.
 *
 * Одна и та же ошибка в цикле пишется десятками строк в секунду и вытесняет
 * из кольцевого буфера всё остальное — включая ту запись, по которой можно
 * было бы понять причину. Повтор в пределах окна не пишется новой строкой,
 * а увеличивает счётчик у предыдущей.
 */
const DEDUP_WINDOW_MS = 8000;
const recentLog = new Map();

function logKey(entry) {
  return `${entry.level || 'info'}|${entry.event || ''}|${String(entry.msg || '').slice(0, 120)}`;
}

/** Кольцевой журнал событий. level: info | warn | error | success. */
export function pushLog(entry, maxSize = 400) {
  const run = logLock.then(async () => {
    const now = Date.now();
    const key = logKey(entry);
    const last = recentLog.get(key);

    const log = await rawGet(K_LOG, []);

    /*
     * Повтор подряд сворачивается всегда, а не только в восьмисекундном окне.
     *
     * Окно рассчитано на ошибку, бьющую очередью. Но есть и медленные повторы:
     * агент, упёршийся в часовой лимит, пишет «часовой лимит 2» каждые
     * двадцать-шестьдесят секунд, и за час молчания это сотня строк, которая
     * вытесняет из кольцевого буфера всю осмысленную историю. Поймано сразу
     * после снижения темпа 02.08: с 21:14 до 21:36 в журнале двадцать пять
     * одинаковых строк и ничего больше.
     *
     * Если запись повторяет **последнюю** в журнале — между ними не случилось
     * ни одного другого события, значит это то же самое положение дел, а не
     * новое. Время окончания обновляется, начало запоминается: по паре видно,
     * сколько молчание длится.
     */
    const lastEntry = log[log.length - 1];
    const sameAsLast = lastEntry && logKey(lastEntry) === key;

    if (sameAsLast || (last && now - last < DEDUP_WINDOW_MS)) {
      for (let i = log.length - 1; i >= 0 && i >= log.length - 5; i--) {
        if (logKey(log[i]) === key) {
          log[i].since = log[i].since || log[i].ts;
          log[i].repeats = (log[i].repeats || 1) + 1;
          log[i].ts = now;
          recentLog.set(key, now);
          await rawSet(K_LOG, log);
          return log;
        }
      }
    }

    recentLog.set(key, now);
    // Карта не должна расти бесконечно.
    if (recentLog.size > 200) {
      for (const [k, t] of recentLog) if (now - t > DEDUP_WINDOW_MS * 4) recentLog.delete(k);
    }

    log.push({ ts: now, level: 'info', ...entry });
    if (log.length > maxSize) log.splice(0, log.length - maxSize);
    await rawSet(K_LOG, log);
    return log;
  });
  logLock = run.catch(() => {});
  return run;
}

/* -------------------------------- Helpers -------------------------------- */

/** Ключ суток в локальном времени, YYYY-MM-DD. */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Сколько полных суток прошло с первого запуска. Первый день = 0. */
export function daysSince(isoDay) {
  if (!isoDay) return 0;
  const [y, m, d] = isoDay.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - start) / 86400000));
}

/** Сбросить кеш — после внешней записи в storage. */
export function invalidate() {
  cache.settings = null;
  cache.state = null;
  cache.queue = null;
}

// Настройки может поменять страница опций, пока SW спит.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[K_SETTINGS]) cache.settings = null;
    if (changes[K_STATE]) cache.state = null;
    if (changes[K_QUEUE]) cache.queue = null;
  });
}

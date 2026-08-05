/**
 * Материал для собственных постов из источников, выбранных пользователем.
 *
 * Встроенный запасной сбор использует тематику и ключевые слова из настроек,
 * затем дедуплицирует и ранжирует найденные публикации локально.
 *
 * Запасной путь нужен по простой причине: сайт может лежать, а профиль молчать
 * из-за чужого аптайма не должен. Запас намеренно узкий — два домена вместо
 * сорока трёх. Дело не в лени: каждый домен в манифесте это запрошенное у
 * пользователя право, и просить доступ к сорока сайтам ради страховки нечестно.
 * Google News покрывает и русское, и английское, Hacker News добавляет то, что
 * читают разработчики.
 *
 * Формат на выходе одинаков для обоих путей: расширению всё равно, откуда
 * пришёл материал, — дальше он попадает в один и тот же генератор.
 */

import { hash } from '../common/text.js';

const UA_TIMEOUT_MS = 12000;

/** Запрос с таймаутом: висящий фид не должен подвешивать публикацию. */
async function fetchText(url, { timeout = UA_TIMEOUT_MS, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers, credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------- Разбор RSS ------------------------------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#8217': '’',
};

export function decodeEntities(s) {
  return String(s || '').replace(/&(#?\w+);/g, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    if (/^#\d+$/.test(e)) return String.fromCharCode(Number(e.slice(1)));
    return m;
  });
}

export function stripHtml(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Разбор фида регулярками, а не DOMParser.
 *
 * В service worker разметку разобрать нечем: DOMParser там не существует, и это
 * не недосмотр спецификации, а следствие отсутствия документа. Для RSS этого
 * достаточно — структура плоская и предсказуемая.
 */
export function parseFeed(xml, source = {}) {
  const out = [];
  const items = String(xml).match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  for (const raw of items) {
    const pick = (tag) => {
      const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? stripHtml(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
    };

    const title = pick('title');
    if (!title) continue;

    // В Atom ссылка живёт в атрибуте, в RSS — в теле тега.
    let url = pick('link');
    if (!url) {
      const m = raw.match(/<link[^>]*href="([^"]+)"/i);
      url = m ? decodeEntities(m[1]) : '';
    }

    const dateStr = pick('pubDate') || pick('published') || pick('updated');
    const publishedAt = dateStr ? Date.parse(dateStr) : NaN;

    out.push({
      title,
      summary: pick('description') || pick('summary') || pick('content'),
      url: canonicalUrl(url),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      sourceId: source.id || 'rss',
      sourceName: source.name || 'RSS',
      tier: source.tier ?? 3,
    });
  }

  return out;
}

/** Убрать метки кампаний и якоря: один и тот же материал приходит помеченным по-разному. */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|yclid|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url || '');
  }
}

/* ------------------------------ Запасные фиды ----------------------------- */

function fallbackSources(settings) {
  const terms = [
    ...(settings.niche?.searchQueries || []),
    ...(settings.niche?.tags || []),
    ...(settings.niche?.includeKeywords || []),
  ].map((term) => String(term).trim()).filter((term) => term.length >= 2).slice(0, 8);
  if (!terms.length) return [];
  const query = `${terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ')} when:2d`;
  const language = settings.niche?.languages?.[0] || 'en';
  const ru = language.toLowerCase().startsWith('ru');
  return [{
    id: `gnews-${ru ? 'ru' : 'en'}`,
    name: 'Google News', tier: 3,
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${ru ? 'ru' : 'en-US'}&gl=${ru ? 'RU' : 'US'}&ceid=${ru ? 'RU:ru' : 'US:en'}`,
  }];
}

/** Hacker News отдаёт JSON и приносит то, что читают разработчики, а не пресс-релизы. */
async function fromHackerNews(queryTerms = []) {
  const url = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30';
  const txt = await fetchText(url);
  const j = JSON.parse(txt);

  return (j.hits || [])
    .filter((h) => (h.points || 0) >= 120)
    .filter((h) => !queryTerms.length || queryTerms.some((term) => String(h.title || '').toLowerCase().includes(String(term).toLowerCase())))
    .map((h) => ({
      title: h.title,
      summary: '',
      url: canonicalUrl(h.url || `https://news.ycombinator.com/item?id=${h.objectID}`),
      publishedAt: h.created_at_i ? h.created_at_i * 1000 : null,
      sourceId: 'hackernews',
      sourceName: 'Hacker News',
      tier: 2,
      points: h.points,
    }));
}

/* ------------------------------- Ранжирование ----------------------------- */

const TIER_WEIGHT = { 1: 1.0, 2: 0.75, 3: 0.5 };

const TOPIC_BOOST = [];

/* Заголовки, которые обещают больше, чем дают. */
const CLICKBAIT = [
  /вы не поверите/i, /шок/i, /you won'?t believe/i, /this changes everything/i,
  /\bhack\b/i, /секрет, который/i,
];

export function scoreItem(item, now = Date.now()) {
  const base = TIER_WEIGHT[item.tier] ?? 0.4;

  const ageH = item.publishedAt ? Math.max(0, (now - item.publishedAt) / 36e5) : 12;
  const recency = 1 / (1 + ageH / 18);

  const hay = `${item.title} ${item.summary || ''}`;
  let topic = 0;
  const tags = [];
  for (const t of TOPIC_BOOST) if (t.re.test(hay)) { topic += t.w; tags.push(t.tag); }

  let penalty = 0;
  if (CLICKBAIT.some((re) => re.test(item.title))) penalty += 0.3;
  // Заголовок без пояснения писать не из чего.
  if (!item.summary && item.title.length < 40) penalty += 0.15;

  const points = item.points ? Math.min(0.2, item.points / 1500) : 0;

  const score = base * (0.5 + 0.5 * recency) + topic + points - penalty;
  return { ...item, score: Math.round(score * 1000) / 1000, tags };
}

/* -------------------------------- Дедуп ---------------------------------- */

function trigrams(s) {
  const t = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function similarity(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Схлопнуть повторы.
 *
 * Одна новость приходит из нескольких мест с разными заголовками, и без этого
 * профиль напишет о запуске одной модели трижды за вечер. Совпадение считаем по
 * триграммам заголовка: перефразировка ловится, разные новости про одну
 * компанию — нет.
 */
export function dedupe(items, threshold = 0.5) {
  const out = [];
  for (const it of items) {
    const twin = out.find((o) => o.url === it.url || similarity(o.title, it.title) >= threshold);
    if (twin) {
      twin.alsoIn = [...(twin.alsoIn || []), it.sourceId];
      // Из двух версий оставляем ту, что от более авторитетного источника.
      if ((TIER_WEIGHT[it.tier] ?? 0) > (TIER_WEIGHT[twin.tier] ?? 0)) Object.assign(twin, it);
      continue;
    }
    out.push({ ...it });
  }
  return out;
}

/* --------------------------------- Сбор ---------------------------------- */

/**
 * Забрать материал с сайта.
 *
 * Эндпоинт отдаёт уже разобранное: собранное, дедуплицированное и
 * отранжированное по сорока трём источникам.
 */
async function fromSite(settings) {
  const base = String(settings.posting?.sourceUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('адрес источника не задан');

  const token = settings.posting?.sourceToken || '';
  const url = `${base}/api/feed/items?limit=25`;

  const txt = await fetchText(url, { headers: token ? { 'X-Feed-Token': token } : {} });
  const j = JSON.parse(txt);
  const items = Array.isArray(j) ? j : (j.items || []);
  if (!items.length) throw new Error('источник вернул пусто');

  return items.map((i) => ({
    title: String(i.title || ''),
    summary: String(i.summary || ''),
    url: canonicalUrl(i.url || ''),
    publishedAt: i.publishedAt || (i.published ? Date.parse(i.published) : null),
    sourceId: i.sourceId || 'site',
    sourceName: i.sourceName || i.source || 'источник',
    tier: i.tier ?? 2,
    points: i.points || 0,
  })).filter((i) => i.title);
}

/** Запасной сбор: два фида Google News плюс Hacker News. */
async function fromFallback(settings) {
  const sources = fallbackSources(settings);
  if (!sources.length) return [];
  const jobs = [
    ...sources.map((s) => fetchText(s.url).then((x) => parseFeed(x, s)).catch(() => [])),
  ];
  const chunks = await Promise.all(jobs);
  return chunks.flat();
}

/**
 * Свежий материал, отранжированный и без повторов.
 *
 * @returns {Promise<{items: object[], via: 'site'|'fallback', error?: string}>}
 */
export async function collectNews(settings, { now = Date.now() } = {}) {
  const maxAgeMs = (settings.posting?.newsMaxAgeHours ?? 48) * 3600000;
  let via = 'site';
  let error;
  let raw = [];

  try {
    raw = await fromSite(settings);
  } catch (e) {
    error = e.message;
    via = 'fallback';
    try {
      raw = await fromFallback(settings);
    } catch (e2) {
      return { items: [], via, error: `${e.message}; запас: ${e2.message}` };
    }
  }

  const fresh = raw.filter((i) => !i.publishedAt || now - i.publishedAt <= maxAgeMs);
  const items = dedupe(fresh)
    .map((i) => scoreItem(i, now))
    .sort((a, b) => b.score - a.score);

  // Идентификатор нужен реестру опубликованного: адрес бывает пустым.
  for (const i of items) i.id = hash(i.url || i.title);

  return { items, via, error };
}

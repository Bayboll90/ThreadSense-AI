/**
 * Скоринг постов и выбор цели.
 *
 * Три ступени, от бесплатной к дорогой.
 *
 * Первая — жёсткие фильтры: язык, стоп-слова, возраст, минимальные метрики,
 * дубли, кулдауны. Работают локально и отсеивают основную массу ленты, не
 * потратив ни одного токена.
 *
 * Вторая — импульс. Детерминированная оценка того, разгоняется пост или уже
 * остыл, из тех же счётчиков, что уже разобраны из DOM. Отсеять мёртвое до
 * обращения к модели — самая дешёвая экономия в проекте.
 *
 * Третья — оценка релевантности моделью, батчами. Только для выживших.
 *
 * Финальный выбор — softmax по скору, а не максимум: всегда брать лучшего
 * означает вечно комментировать одних и тех же авторов в одно и то же время,
 * а это ровно та регулярность, которую ищут антифрод-модели.
 */

import { softmaxPick, clamp } from '../common/rng.js';
import { detectLang, hasAny, countAny, normalize } from '../common/text.js';
import { classifyMomentum, momentumComponent } from '../common/momentum.js';
import { SKIP } from '../common/skipcodes.js';
import { statusSync } from './registry.js';

/* ------------------------------ Компоненты ------------------------------- */

/**
 * Свежесть: экспоненциальное затухание с постоянной tau.
 * Слишком свежий пост штрафуется — в первые минуты в ветке ещё нет обсуждения,
 * не от чего оттолкнуться и некому тебя увидеть.
 */
export function freshness(ageMinutes, cfg) {
  const { tauMinutes, minAgeMinutes, maxAgeHours } = cfg;
  if (ageMinutes > maxAgeHours * 60) return 0;
  const decay = Math.exp(-ageMinutes / Math.max(1, tauMinutes));
  if (ageMinutes >= minAgeMinutes) return decay;
  // Линейный разгон от 0 до полной свежести на интервале [0, minAgeMinutes].
  return decay * (ageMinutes / Math.max(1, minAgeMinutes));
}

/** Живость обсуждения по лайкам, лог-шкала: один вирусный пост не должен забивать всё. */
export function engagement(likes, cfg) {
  return clamp(Math.log1p(Math.max(0, likes)) / Math.log1p(cfg.likesCap), 0, 1);
}

/**
 * Шанс быть замеченным.
 *
 * Живой пост с малым числом ответов — идеальная цель: обсуждение уже есть,
 * но твой комментарий не утонет сорок седьмым. Поэтому это произведение
 * живости на дефицит ответов, а не отдельное «чем меньше ответов, тем лучше»
 * (иначе побеждают мёртвые посты с нулём всего).
 */
export function opportunity(likes, replies, cfg) {
  const alive = engagement(likes, cfg);
  const scarcity = 1 / (1 + Math.max(0, replies) / Math.max(1, cfg.replyScarcityK));
  return alive * scarcity;
}

/** Вес автора по числу подписчиков. Вес в настройках может быть отрицательным. */
export function authorValue(followers, cfg) {
  if (!followers) return 0.25; // неизвестно — считаем средним
  return clamp(Math.log1p(followers) / Math.log1p(cfg.followersCap), 0, 1);
}

/**
 * Риск. Возвращает 0..1, вычитается из скора с большим весом.
 * Каждое совпадение из стоп-листа добавляет 0.5, два совпадения — уже отсев.
 */
export function riskScore(post, niche) {
  let r = 0;
  const text = `${post.text || ''} ${post.authorName || ''}`;

  r += 0.5 * countAny(text, niche.excludeKeywords);

  if (post.authorHandle && niche.blockedAuthors?.length) {
    const h = post.authorHandle.replace(/^@/, '').toLowerCase();
    if (niche.blockedAuthors.some((a) => a.replace(/^@/, '').toLowerCase() === h)) r += 2;
  }

  // Рекламные маркеры: много ссылок, призывы подписаться, стена хэштегов.
  const links = (text.match(/https?:\/\/|t\.me\/|\bwww\./gi) || []).length;
  if (links >= 1) r += 0.25;
  if (links >= 2) r += 0.4;
  const tags = (text.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (tags >= 4) r += 0.35;

  // Каскад из капса — обычно кричащая реклама.
  const caps = (text.match(/[A-ZА-Я]{5,}/g) || []).length;
  if (caps >= 2) r += 0.2;

  return clamp(r, 0, 1.5);
}

/* --------------------------- Локальный префильтр -------------------------- */

/** Была ли метрика реально прочитана из DOM, а не подставлена нулём. */
function known(post, metric) {
  const a = post.availability;
  if (!a) return Number(post[metric]) > 0;   // старые данные без пометок
  return !!a[metric];
}

/**
 * Быстрая отбраковка без единого токена.
 * @returns {{ok: boolean, code?: string, detail?: string}}
 */
export function prefilter(post, settings, state, now = Date.now()) {
  const { niche, scoring, limits, style, filters } = settings;
  const text = (post.text || '').trim();

  if (!post.url) return no(SKIP.NO_URL);
  if (!text) return no(SKIP.NO_TEXT);

  const f = filters || {};
  const minLen = f.minTextLen ?? 25;
  const maxLen = f.maxTextLen ?? 3000;
  if (text.length < minLen) return no(SKIP.TOO_SHORT, `${text.length} < ${minLen}`);
  if (text.length > maxLen) return no(SKIP.TOO_LONG, `${text.length} > ${maxLen}`);

  const myHandle = (settings.handle || '').replace(/^@/, '').toLowerCase();
  const handle = (post.authorHandle || '').replace(/^@/, '').toLowerCase();
  if (handle && handle === myHandle) return no(SKIP.OWN_POST);

  if (post.isAd) return no(SKIP.AD);
  if (post.isNestedReply) return no(SKIP.NESTED_REPLY);
  if (post.alreadyRepliedByMe) return no(SKIP.ALREADY_REPLIED);

  // Реестр знает пост под несколькими ключами и переживает смену URL.
  const reg = statusSync(post, state);
  if (reg === 'commented') return no(SKIP.ALREADY_COMMENTED);
  if (reg === 'inflight') return no(SKIP.IN_FLIGHT);

  if (handle && state.authorCooldown?.[handle]) {
    const passed = (now - state.authorCooldown[handle]) / 3600000;
    if (passed < limits.authorCooldownHours) {
      return no(SKIP.AUTHOR_COOLDOWN, `ещё ${(limits.authorCooldownHours - passed).toFixed(1)} ч`);
    }
  }

  if (niche.languages?.length) {
    const lang = detectLang(text);
    if (lang !== 'unknown' && lang !== 'mixed' && !niche.languages.includes(lang)) {
      return no(SKIP.LANGUAGE, lang);
    }
  }

  if (hasAny(text, niche.excludeKeywords)) return no(SKIP.STOP_WORD);

  if (niche.includeKeywords?.length && !hasAny(text, niche.includeKeywords)) {
    return no(SKIP.NO_KEYWORDS);
  }

  /* --- Жёсткие фильтры по метрикам и содержимому --- */

  if (f.skipMedia && post.hasMedia) return no(SKIP.HAS_MEDIA);

  const ageMin = post.ageMinutes ?? Infinity;
  const maxAge = (f.maxAgeHours ?? scoring.maxAgeHours) * 60;
  if (ageMin > maxAge) return no(SKIP.TOO_OLD, `${Math.round(ageMin / 60)} ч`);
  if (f.minAgeMinutes && ageMin < f.minAgeMinutes) return no(SKIP.TOO_FRESH, `${Math.round(ageMin)} мин`);

  // Отсекаем по метрике только если она действительно прочитана: скрытый
  // счётчик и честный ноль — разные вещи, и путать их значит выбрасывать
  // половину годной ленты.
  if (f.minLikes > 0 && known(post, 'likes') && (post.likes || 0) < f.minLikes) {
    return no(SKIP.LOW_LIKES, `${post.likes} < ${f.minLikes}`);
  }
  if (f.minReplies > 0 && known(post, 'replies') && (post.replies || 0) < f.minReplies) {
    return no(SKIP.LOW_REPLIES, `${post.replies} < ${f.minReplies}`);
  }

  if (f.skipCold) {
    const m = classifyMomentum(post, settings.momentum);
    if (m.label === 'cold') return no(SKIP.COLD, m.reason);
  }
  if (f.hotOnly) {
    const m = classifyMomentum(post, settings.momentum);
    if (m.label !== 'hot') return no(SKIP.COLD, `режим «только горячие», сейчас ${m.label}`);
  }

  if ((post.myRepliesInThread || 0) >= limits.maxPerThread) return no(SKIP.THREAD_LIMIT);

  // Подстраховка: если пост совпадает с одним из наших недавних комментариев,
  // это почти наверняка наш же текст, отражённый лентой.
  if (style && state.recentTexts?.length) {
    const n = normalize(text).slice(0, 80);
    if (n && state.recentTexts.some((t) => normalize(t).slice(0, 80) === n)) {
      return no(SKIP.OWN_POST, 'это наш текст');
    }
  }

  return { ok: true };
}

const no = (code, detail) => ({ ok: false, code, detail, reason: detail ? `${code}: ${detail}` : code });

/* ------------------------------ Полный скор ------------------------------ */

/**
 * Итоговый скор поста.
 * relevance приходит от ИИ (0..1); если оценка ещё не получена, подставляется
 * грубая эвристика по числу попавших ключевых слов.
 */
export function scorePost(post, settings, relevance = null) {
  const cfg = settings.scoring;
  const w = cfg.weights;

  const rel = relevance !== null
    ? clamp(relevance, 0, 1)
    : clamp(countAny(post.text || '', settings.niche.includeKeywords) / 4, 0, 1);

  const fresh = freshness(post.ageMinutes ?? 999999, cfg);
  const eng = engagement(post.likes || 0, cfg);
  const opp = opportunity(post.likes || 0, post.replies || 0, cfg);
  const auth = authorValue(post.followers || 0, cfg);
  const mom = momentumComponent(post, cfg.momentumCap ?? 60);
  const risk = riskScore(post, settings.niche);

  const raw =
    w.relevance * rel +
    w.freshness * fresh +
    w.engagement * eng +
    w.opportunity * opp +
    w.authorValue * auth +
    (w.momentum || 0) * mom -
    w.risk * risk;

  // Нормируем на сумму положительных весов, чтобы порог minScore не приходилось
  // пересчитывать каждый раз, когда сдвинули один ползунок.
  const norm =
    Math.max(0, w.relevance) + Math.max(0, w.freshness) + Math.max(0, w.engagement) +
    Math.max(0, w.opportunity) + Math.max(0, w.authorValue) + Math.max(0, w.momentum || 0);

  const score = norm > 0 ? raw / norm : raw;
  const m = classifyMomentum(post, settings.momentum);

  return {
    score,
    momentum: m,
    parts: {
      relevance: rel, freshness: fresh, engagement: eng,
      opportunity: opp, authorValue: auth, momentum: mom, risk,
    },
  };
}

/**
 * Выбор цели из отскоренных кандидатов.
 *
 * @param {Array<{post, score, relevance}>} scored
 * @returns {{post, score, index}|null}
 */
export function pickTarget(scored, settings) {
  const cfg = settings.scoring;

  const eligible = scored.filter(
    (c) => c.score >= cfg.minScore && (c.relevance ?? 1) >= cfg.minRelevance,
  );
  if (!eligible.length) return null;

  eligible.sort((a, b) => b.score - a.score);
  const pool = eligible.slice(0, Math.max(1, cfg.topK));
  const idx = softmaxPick(pool.map((c) => c.score), cfg.softmaxT);
  if (idx < 0) return null;

  return { ...pool[idx], index: idx, poolSize: pool.length };
}

/** Разбить массив на батчи фиксированного размера. */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

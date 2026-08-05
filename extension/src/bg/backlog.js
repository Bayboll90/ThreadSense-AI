/**
 * Копилка кандидатов — сплошной обход ленты вместо выборочного.
 *
 * Как было. Скан собирал экран карточек, оценивал их, выбирал ровно одну цель,
 * а всё остальное помечал как виденное и выбрасывал. Пост, прошедший и
 * префильтр, и оценку релевантности, и порог отбора, но проигравший софтмаксу
 * долю секунды, больше не рассматривался никогда. За оценку уже заплачено
 * токенами, пост подходит — и он отправляется в мусор.
 *
 * Отсюда две беды сразу. Лента просеивалась выборочно: агент видел то, что
 * попалось в момент скана, а не то, что в ленте есть. И работа модели тратилась
 * впустую — на десять оценённых постов приходился один использованный.
 *
 * Как стало. Всё, что прошло отбор, складывается сюда и живёт до протухания.
 * Цель берётся из копилки, а не из текущего экрана, поэтому очередь до поста
 * определяется его качеством, а не тем, повезло ли ему попасть в скан, когда
 * агент был готов комментировать.
 *
 * Ценность записи со временем падает: оценка делалась по свежести и живости на
 * момент скана, и через два часа она уже не про этот пост. Поэтому к скору
 * применяется то же экспоненциальное затухание, что и к свежести самого поста —
 * запись не удаляется раньше срока, но уступает место более новым.
 *
 * Функции чистые и работают с обычным объектом состояния: так их можно гонять
 * тестами без браузера, а именно здесь ошибка была бы незаметной — копилка
 * молча копила бы мусор.
 */

/** Больше держать незачем: хвост всё равно протухнет раньше, чем дойдёт очередь. */
const MAX_ITEMS = 120;

/**
 * Свести кандидата к тому, что понадобится позже.
 *
 * Целиком карточку хранить нельзя: состояние пишется в storage на каждом шаге,
 * а в карточке лежит и полный текст, и разметка метрик. Сотня таких записей
 * превратит каждое сохранение в мегабайт.
 */
function trim(cand, now) {
  const p = cand.post || {};
  return {
    id: p.id,
    url: p.url || null,
    author: p.authorHandle || null,
    text: String(p.text || '').slice(0, 400),
    ageMinutes: p.ageMinutes ?? null,
    likes: p.likes ?? 0,
    replies: p.replies ?? 0,
    reposts: p.reposts ?? 0,
    mediaAlt: p.mediaAlt ? String(p.mediaAlt).slice(0, 200) : null,

    score: cand.score,
    relevance: cand.relevance ?? null,
    momentum: cand.momentum || null,
    topic: cand.topic || null,

    queuedAt: now,
    /** Возраст поста на момент оценки — по нему считаем, насколько запись устарела. */
    ageAtQueue: p.ageMinutes ?? null,
  };
}

/** Восстановить форму, которую ждёт остальной конвейер. */
export function toTarget(item) {
  return {
    post: {
      id: item.id,
      url: item.url,
      authorHandle: item.author,
      text: item.text,
      ageMinutes: item.ageMinutes,
      likes: item.likes,
      replies: item.replies,
      reposts: item.reposts,
      mediaAlt: item.mediaAlt,
    },
    score: item.score,
    relevance: item.relevance,
    momentum: item.momentum,
    topic: item.topic,
    fromBacklog: true,
    waitedMinutes: item.queuedAt ? Math.round((Date.now() - item.queuedAt) / 60000) : 0,
  };
}

/**
 * Затухание ценности записи со временем ожидания.
 *
 * Та же постоянная, что у свежести поста: оценка и делалась исходя из неё, и
 * стареть должна с той же скоростью. Иначе копилка превращается в кладбище, где
 * запись двухчасовой давности со скором 0.7 вечно обгоняет свежую с 0.6.
 */
export function effectiveScore(item, settings, now = Date.now()) {
  const tau = Math.max(1, settings.scoring?.tauMinutes || 360);
  const waited = Math.max(0, (now - (item.queuedAt || now)) / 60000);
  return item.score * Math.exp(-waited / tau);
}

/** Протухла ли запись: пост состарился сверх допустимого либо мы его уже трогали. */
export function isStale(item, settings, state, now = Date.now()) {
  const maxAge = (settings.filters?.maxAgeHours ?? 72) * 60;
  const waited = (now - (item.queuedAt || now)) / 60000;
  const age = (item.ageAtQueue ?? 0) + waited;

  if (age > maxAge) return true;
  // Пост, помеченный виденным где-то ещё, из копилки должен уйти: там и отказ
  // после разбора ветки, и уже опубликованный ответ.
  if (Array.isArray(state?.seenPosts) && state.seenPosts.includes(item.id)) return true;
  return false;
}

/**
 * Добавить кандидатов, не создавая дублей.
 *
 * Один и тот же пост приходит под разными адресами — из ленты, со страницы
 * ветки, после репоста, — поэтому сверяем и по идентификатору, и по адресу.
 * Повторная встреча не игнорируется: оценка могла вырасти, пост мог разогнаться.
 * Берём лучшую, но время постановки оставляем прежним, иначе запись сможет
 * омолаживать себя бесконечно и никогда не протухнет.
 */
export function addCandidates(state, cands, settings, now = Date.now()) {
  const items = Array.isArray(state.backlog) ? [...state.backlog] : [];
  let added = 0;
  let refreshed = 0;

  for (const c of cands) {
    if (!c?.post?.id) continue;
    const fresh = trim(c, now);

    const atId = items.findIndex((i) => i.id === fresh.id);
    const atUrl = fresh.url ? items.findIndex((i) => i.url && i.url === fresh.url) : -1;
    const at = atId >= 0 ? atId : atUrl;

    if (at >= 0) {
      const old = items[at];
      items[at] = { ...fresh, queuedAt: old.queuedAt, score: Math.max(old.score, fresh.score) };
      refreshed++;
    } else {
      items.push(fresh);
      added++;
    }
  }

  // Переполнение снимаем с хвоста по ценности, а не по времени: смысл копилки в
  // том, чтобы хороший пост дождался очереди, даже если попал в неё давно.
  let out = items;
  if (out.length > MAX_ITEMS) {
    out = [...out]
      .sort((a, b) => effectiveScore(b, settings, now) - effectiveScore(a, settings, now))
      .slice(0, MAX_ITEMS);
  }

  return { backlog: out, added, refreshed };
}

/** Выбросить протухшее. Возвращает новый список и сколько выкинули. */
export function pruneBacklog(state, settings, now = Date.now()) {
  const items = Array.isArray(state.backlog) ? state.backlog : [];
  const kept = items.filter((i) => !isStale(i, settings, state, now));
  return { backlog: kept, dropped: items.length - kept.length };
}

/**
 * Достать лучшего кандидата.
 *
 * Порог применяется к затухшей оценке, а не к исходной: запись, которая уже не
 * дотягивает до порога из-за ожидания, брать незачем — она и не пройдёт дальше.
 */
export function takeBest(state, settings, now = Date.now()) {
  const { backlog } = pruneBacklog(state, settings, now);
  if (!backlog.length) return { item: null, backlog };

  const min = settings.scoring?.minScore ?? 0.4;
  const ranked = [...backlog]
    .map((i) => ({ i, eff: effectiveScore(i, settings, now) }))
    .filter((x) => x.eff >= min)
    .sort((a, b) => b.eff - a.eff);

  if (!ranked.length) return { item: null, backlog };

  const chosen = ranked[0].i;
  return {
    item: chosen,
    effective: ranked[0].eff,
    ready: ranked.length,
    backlog: backlog.filter((i) => i.id !== chosen.id),
  };
}

/** Убрать конкретную запись — после публикации либо отказа. */
export function dropFromBacklog(state, id) {
  const items = Array.isArray(state.backlog) ? state.backlog : [];
  return items.filter((i) => i.id !== id);
}

/** Сводка для журнала и интерфейса. */
export function backlogStats(state, settings, now = Date.now()) {
  const items = Array.isArray(state.backlog) ? state.backlog : [];
  if (!items.length) return { size: 0, ready: 0, best: 0, topics: [] };

  const min = settings.scoring?.minScore ?? 0.4;
  const effs = items.map((i) => effectiveScore(i, settings, now));

  const topics = {};
  for (const i of items) {
    const t = (i.topic || '').trim();
    if (t) topics[t] = (topics[t] || 0) + 1;
  }

  return {
    size: items.length,
    ready: effs.filter((e) => e >= min).length,
    best: Math.max(...effs),
    topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

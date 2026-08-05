/**
 * Импульс поста: разгоняется он или уже остыл.
 *
 * Наш основной скоринг смотрит на состояние поста — сколько лайков, сколько
 * ответов, насколько свеж. Импульс отвечает на другой вопрос: с какой
 * скоростью он растёт. Это разные вещи. Пост с сорока лайками за двенадцать
 * часов и пост с сорока лайками за двадцать минут одинаковы по счётчикам, но
 * второй прямо сейчас показывают людям, а первый уже никто не увидит.
 *
 * Главное достоинство метрики — она детерминированная и бесплатная. Считается
 * из тех же счётчиков, что уже разобраны из DOM, и не стоит ни одного токена.
 * Отсеять заведомо мёртвые посты до обращения к ИИ — самая дешёвая экономия
 * в проекте.
 *
 * Веса подобраны по стоимости действия: лайк дешёв, ответ требует written
 * усилия, репост означает готовность показать пост своей аудитории. Поэтому
 * ответ весит втрое, репост вчетверо.
 */

/** Веса вовлечения. Отражают, сколько усилий стоит каждое действие. */
export const WEIGHTS = { likes: 1, replies: 3, reposts: 4, shares: 4 };

/**
 * Порог возраста при делении. Не даёт минутному посту с парой лайков
 * получить астрономическую скорость и обойти всё остальное.
 */
const MIN_AGE_HOURS = 0.35;

/**
 * Пороги классификации.
 *
 * Вынесены в объект намеренно: их приходится подкручивать под нишу.
 * В медленной нише двадцать очков за шесть часов — успех, в быстрой — провал.
 */
export const DEFAULT_THRESHOLDS = {
  // Ранний импульс: пост совсем свежий, но реакция уже пошла.
  earlyAgeHours: 1.5,
  earlyLikes: 5,
  earlyReplies: 2,
  earlyScore: 8,
  earlyPerHour: 6,

  // Сильная реакция: пост набрал заметный вес за разумное время.
  strongAgeHours: 6,
  strongScore: 22,
  strongPerHour: 5,
  strongReplies: 6,

  // Абсолютный порог: такие цифры делают пост горячим независимо от возраста.
  absLikes: 100,
  absReplies: 15,
  absScore: 140,

  // Остывание.
  deadAgeHours: 1,      // час прошёл, реакции нет вообще
  weakAgeHours: 3,      // три часа, почти ничего
  weakScore: 3,
  fadedAgeHours: 12,    // полдня, мало
  fadedScore: 8,
};

/**
 * Посчитать импульс.
 *
 * @param {object} post   { likes, replies, reposts, shares, ageMinutes }
 * @returns {{score: number, perHour: number, ageHours: number}}
 */
export function computeMomentum(post) {
  const likes = num(post.likes);
  const replies = num(post.replies);
  const reposts = num(post.reposts);
  const shares = num(post.shares);

  const score = likes * WEIGHTS.likes
    + replies * WEIGHTS.replies
    + reposts * WEIGHTS.reposts
    + shares * WEIGHTS.shares;

  const ageHours = Number.isFinite(post.ageMinutes)
    ? Math.max(0, post.ageMinutes) / 60
    : 24;

  return {
    score,
    perHour: score / Math.max(MIN_AGE_HOURS, ageHours),
    ageHours,
  };
}

/**
 * Отнести пост к горячим, остывшим или обычным.
 *
 * @returns {{label: 'hot'|'cold'|'neutral', reason: string, score, perHour, ageHours}}
 */
export function classifyMomentum(post, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const { score, perHour, ageHours } = computeMomentum(post);

  const likes = num(post.likes);
  const replies = num(post.replies);
  const reposts = num(post.reposts);

  const early = ageHours <= t.earlyAgeHours
    && (likes >= t.earlyLikes || replies >= t.earlyReplies
      || score >= t.earlyScore || perHour >= t.earlyPerHour);

  const strong = ageHours <= t.strongAgeHours
    && (score >= t.strongScore || perHour >= t.strongPerHour || replies >= t.strongReplies);

  const absolute = likes >= t.absLikes || replies >= t.absReplies || score >= t.absScore;

  if (early || strong || absolute) {
    const reason = early
      ? `ранний импульс: ${score} за ${ageHours.toFixed(1)} ч`
      : absolute && !strong
        ? `крупный пост: ${likes}♥ ${replies}💬`
        : `сильная реакция: ${score}, ${perHour.toFixed(1)}/ч`;
    return { label: 'hot', reason, score, perHour, ageHours };
  }

  const dead = ageHours >= t.deadAgeHours && likes === 0 && replies === 0 && reposts === 0;
  const weak = ageHours >= t.weakAgeHours && score < t.weakScore;
  const faded = ageHours >= t.fadedAgeHours && score < t.fadedScore;

  if (dead || weak || faded) {
    const reason = dead
      ? `нет реакции за ${ageHours.toFixed(1)} ч`
      : `слабая реакция: ${score} за ${ageHours.toFixed(1)} ч`;
    return { label: 'cold', reason, score, perHour, ageHours };
  }

  return { label: 'neutral', reason: `средний сигнал: ${score}`, score, perHour, ageHours };
}

/**
 * Нормированный вклад импульса в общий скор, 0..1.
 *
 * Логарифм по той же причине, что и в остальном скоринге: без него один
 * вирусный пост с тысячей лайков в час обнуляет разницу между всеми
 * остальными.
 */
export function momentumComponent(post, cap = 60) {
  const { perHour } = computeMomentum(post);
  return Math.min(1, Math.log1p(Math.max(0, perHour)) / Math.log1p(cap));
}

/**
 * Отобрать и упорядочить горячие посты.
 * Пригодится для отдельного режима «идти только по разгоняющимся».
 */
export function pickHot(posts, { limit = 60, thresholds } = {}) {
  return posts
    .map((p) => ({ post: p, m: classifyMomentum(p, thresholds) }))
    .filter((x) => x.m.label === 'hot')
    .sort((a, b) => (b.m.perHour - a.m.perHour) || (b.m.score - a.m.score))
    .slice(0, limit);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

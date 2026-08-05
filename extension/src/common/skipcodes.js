/**
 * Коды пропуска постов.
 *
 * Свободный текст в поле «причина» удобно писать и невозможно считать. Когда
 * агент за сутки отсеял четыреста постов, единственный полезный вопрос — по
 * каким причинам и в какой пропорции. По строкам вида «автор в кулдауне ещё
 * 12.4 ч» такую сводку не собрать: каждая уникальна.
 *
 * Отсюда разделение: код — для статистики и логики, текст — для человека.
 */

export const SKIP = {
  /* Опознание и дубли */
  NO_URL: 'no_url',
  NO_TEXT: 'no_text',
  TOO_SHORT: 'too_short',
  TOO_LONG: 'too_long',
  OWN_POST: 'own_post',
  ALREADY_COMMENTED: 'already_commented',
  IN_FLIGHT: 'in_flight',
  ALREADY_REPLIED: 'already_replied',
  THREAD_LIMIT: 'thread_limit',

  /* Ниша */
  LANGUAGE: 'language',
  NO_KEYWORDS: 'no_keywords',
  STOP_WORD: 'stop_word',
  BLOCKED_AUTHOR: 'blocked_author',
  AD: 'ad',

  /* Метрики и время */
  TOO_OLD: 'too_old',
  TOO_FRESH: 'too_fresh',
  LOW_LIKES: 'low_likes',
  LOW_REPLIES: 'low_replies',
  COLD: 'cold',
  HAS_MEDIA: 'has_media',

  /* Поведение */
  AUTHOR_COOLDOWN: 'author_cooldown',
  NESTED_REPLY: 'nested_reply',
  ABANDONED: 'abandoned',

  /* Отбор и генерация */
  BELOW_SCORE: 'below_score',
  AI_OFF_TOPIC: 'ai_off_topic',
  AI_NOT_WORTH: 'ai_not_worth',
  DUPLICATE_TEXT: 'duplicate_text',
  BAD_OUTPUT: 'bad_output',
  GEN_FAILED: 'gen_failed',

  /* Техника */
  NO_REPLY_BUTTON: 'no_reply_button',
  NO_EDITOR: 'no_editor',
  TYPE_MISMATCH: 'type_mismatch',
  TYPE_TIMEOUT: 'type_timeout',
  SUBMIT_FAILED: 'submit_failed',
  CONTEXT_LOST: 'context_lost',
};

/** Человеческие подписи. Используются в журнале и в UI. */
export const SKIP_LABEL = {
  [SKIP.NO_URL]: 'нет ссылки на пост',
  [SKIP.NO_TEXT]: 'текст не разобрался',
  [SKIP.TOO_SHORT]: 'слишком короткий пост',
  [SKIP.TOO_LONG]: 'слишком длинный пост',
  [SKIP.OWN_POST]: 'мой собственный пост',
  [SKIP.ALREADY_COMMENTED]: 'уже прокомментирован',
  [SKIP.IN_FLIGHT]: 'уже в обработке',
  [SKIP.ALREADY_REPLIED]: 'в ветке уже есть мой ответ',
  [SKIP.THREAD_LIMIT]: 'лимит комментариев на ветку',

  [SKIP.LANGUAGE]: 'чужой язык',
  [SKIP.NO_KEYWORDS]: 'нет ключевых слов ниши',
  [SKIP.STOP_WORD]: 'стоп-слово ниши',
  [SKIP.BLOCKED_AUTHOR]: 'автор в игноре',
  [SKIP.AD]: 'реклама',

  [SKIP.TOO_OLD]: 'слишком старый',
  [SKIP.TOO_FRESH]: 'ещё нет обсуждения',
  [SKIP.LOW_LIKES]: 'мало лайков',
  [SKIP.LOW_REPLIES]: 'мало ответов',
  [SKIP.COLD]: 'пост остыл',
  [SKIP.HAS_MEDIA]: 'пост с медиа',

  [SKIP.AUTHOR_COOLDOWN]: 'автор в кулдауне',
  [SKIP.NESTED_REPLY]: 'это ответ в ветке, а не пост',
  [SKIP.ABANDONED]: 'открыли и передумали',

  [SKIP.BELOW_SCORE]: 'скор ниже порога',
  [SKIP.AI_OFF_TOPIC]: 'ИИ: не по теме',
  [SKIP.AI_NOT_WORTH]: 'ИИ: ветка не стоит ответа',
  [SKIP.DUPLICATE_TEXT]: 'похоже на недавний комментарий',
  [SKIP.BAD_OUTPUT]: 'модель вернула негодный текст',
  [SKIP.GEN_FAILED]: 'генерация не удалась',

  [SKIP.NO_REPLY_BUTTON]: 'не найдена кнопка ответа',
  [SKIP.NO_EDITOR]: 'не появилось поле ввода',
  [SKIP.TYPE_MISMATCH]: 'текст не попал в поле',
  [SKIP.TYPE_TIMEOUT]: 'набор не уложился во время',
  [SKIP.SUBMIT_FAILED]: 'отправка не удалась',
  [SKIP.CONTEXT_LOST]: 'страница сменилась под руками',
};

/**
 * Коды, означающие проблему с самой страницей, а не с постом.
 * Три подряд — повод остановиться: скорее всего сломались селекторы либо
 * Threads начал мешать работе.
 */
export const TECHNICAL_SKIPS = new Set([
  SKIP.NO_REPLY_BUTTON,
  SKIP.NO_EDITOR,
  SKIP.TYPE_MISMATCH,
  SKIP.TYPE_TIMEOUT,
  SKIP.SUBMIT_FAILED,
  SKIP.CONTEXT_LOST,
]);

export function skipLabel(code, detail) {
  const base = SKIP_LABEL[code] || code || 'без причины';
  return detail ? `${base}: ${detail}` : base;
}

/** Свернуть список пропусков в сводку «причина: сколько раз». */
export function summarize(skips, limit = 5) {
  const counts = {};
  for (const s of skips) {
    const code = typeof s === 'string' ? s : s?.code;
    if (!code) continue;
    counts[code] = (counts[code] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([code, n]) => `${SKIP_LABEL[code] || code}: ${n}`)
    .join(', ');
}

/**
 * Последний рубеж перед публикацией.
 *
 * Всё, что сюда попадает, уже прошло генерацию и гуманизацию. Задача этого
 * модуля — не улучшить текст, а не дать опубликовать плохой. Любая проверка
 * тут работает на отказ: сомнительно — значит регенерируем или пропускаем пост.
 *
 * Самая важная проверка — на повторы. Модель при одинаковых входных условиях
 * сваливается в одну и ту же формулировку, и сорок почти идентичных
 * комментариев под разными постами видны платформе тривиальным группированием
 * по шинглам. Триграммный Жаккар ловит это надёжнее пословного сравнения,
 * потому что переставленные слова и другие окончания его не обманывают.
 */

import { maxSimilarity, URL_RE, MENTION_RE, HASHTAG_RE, hasAny } from '../common/text.js';
import { weightedPick } from '../common/rng.js';
import { ANGLES } from '../common/defaults.js';
import { endsDangling } from './humanizer.js';

/**
 * Проверка готового комментария.
 * @returns {{ok: boolean, reason?: string, retry?: boolean, similarity?: number}}
 *          retry = true означает «имеет смысл перегенерировать»,
 *          retry = false — «проблема не в формулировке, пост надо пропустить».
 */
export function checkComment(text, settings, state) {
  const s = settings.safety;
  const st = settings.style;
  const t = String(text || '').trim();

  if (!t) return { ok: false, reason: 'пустой текст', retry: true };

  /*
   * Сначала безусловные запреты, потом качество.
   *
   * Порядок не косметика, и это второй раз, когда он оказывается важен: в
   * `checkPost` его поправили ещё 28.07, а здесь он так и остался прежним.
   * Всплыло при подъёме `style.minLen` с 25 до 45 — тест, проверявший, что
   * @-упоминание опознаётся, вдруг стал получать «короче 45 символов».
   *
   * Комментарий со ссылкой не станет лучше от того, что он нужной длины, а
   * сообщение о длине уводит разбор не туда: правишь одно, а причина в другом.
   * Проверка обязана называть настоящее нарушение, а не первое попавшееся.
   */

  if (hasAny(t, s.stopWords)) {
    return { ok: false, reason: 'стоп-слово в тексте', retry: true };
  }

  if (s.banLinks && URL_RE.test(t)) {
    return { ok: false, reason: 'ссылка в комментарии', retry: true };
  }
  if (s.banMentions && MENTION_RE.test(t)) {
    return { ok: false, reason: '@-упоминание', retry: true };
  }
  if (s.banHashtags && HASHTAG_RE.test(t)) {
    return { ok: false, reason: 'хэштег', retry: true };
  }

  // Следы служебного формата: модель иногда возвращает JSON или разметку.
  if (/^[{[]/.test(t) || /```/.test(t) || /^\s*(комментарий|ответ)\s*:/i.test(t)) {
    return { ok: false, reason: 'служебная разметка в ответе', retry: true };
  }

  // Обращение к самому себе — значит, разбор ветки где-то ошибся.
  const my = (settings.handle || '').replace(/^@/, '').toLowerCase();
  if (my && t.toLowerCase().includes(`@${my}`)) {
    return { ok: false, reason: 'обращение к себе', retry: true };
  }

  // Хвост из эмодзи вместо смысла.
  const emojiCount = (t.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojiCount > 2) return { ok: false, reason: 'слишком много эмодзи', retry: true };

  /* --- Дальше качество: длина и наполнение. --- */

  if (t.length < st.minLen) {
    return { ok: false, reason: `короче ${st.minLen} символов`, retry: true };
  }
  if (t.length > st.maxLen * 1.35) {
    return { ok: false, reason: 'слишком длинный', retry: true };
  }

  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < st.minLen * 0.5) {
    return { ok: false, reason: 'мало букв, текст пустой', retry: true };
  }

  // Фраза, оборванная на союзе или предлоге, читается как сбой, а не как
  // сокращение. Гуманизатор такое подчищает, но модель может закончить так сама.
  if (endsDangling(t)) {
    return { ok: false, reason: 'фраза обрывается на служебном слове', retry: true };
  }

  // Повтор.
  const sim = maxSimilarity(t, (state.recentTexts || []).slice(-settings.safety.similarityWindow));
  if (sim >= s.similarityThreshold) {
    return {
      ok: false,
      reason: `похоже на недавний комментарий (${Math.round(sim * 100)}%)`,
      retry: true,
      similarity: sim,
    };
  }

  return { ok: true, similarity: sim };
}

/**
 * Выбор угла захода.
 *
 * Веса из настроек, но углы, встречавшиеся в последнем окне, приглушаются.
 * Без этого агент незаметно скатывается в один режим — обычно в «согласиться и
 * дополнить», потому что он безопаснее всего звучит для модели.
 */
export function pickAngle(settings, state, aiSuggestion = null) {
  const cfg = settings.angles;
  const recent = (state.recentAngles || []).slice(-cfg.antiRepeatWindow);

  if (aiSuggestion && cfg.allowAiOverride && ANGLES[aiSuggestion]) {
    const w = cfg.weights[aiSuggestion] ?? 0;
    // Подсказку ИИ принимаем, только если угол включён и не использовался
    // последние три раза подряд.
    if (w > 0 && !recent.slice(-3).includes(aiSuggestion)) return aiSuggestion;
  }

  const pairs = Object.keys(ANGLES).map((key) => {
    let w = cfg.weights[key] ?? 0;
    if (recent.includes(key)) {
      // Чем свежее повтор, тем сильнее штраф.
      const pos = recent.lastIndexOf(key);
      const recency = (pos + 1) / recent.length;
      w *= cfg.repeatPenalty + (1 - cfg.repeatPenalty) * (1 - recency);
    }
    return [key, w];
  });

  return weightedPick(pairs) || 'agree_add';
}

/** Запомнить использованный угол. Мутирует state. */
export function recordAngle(state, angle) {
  state.recentAngles = [...(state.recentAngles || []), angle].slice(-40);
  return state;
}

/* ---------------------------- Разбор ответа ИИ --------------------------- */

/**
 * Достать JSON из ответа модели.
 * Модели периодически оборачивают его в ```json или добавляют пояснение до и
 * после — при батчах на сотню постов это происходит достаточно часто, чтобы
 * ронять цикл, если не подстраховаться.
 */
export function extractJson(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  try { return JSON.parse(text); } catch { /* дальше */ }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* дальше */ }
  }

  const first = text.search(/[{[]/);
  if (first >= 0) {
    const open = text[first];
    const close = open === '{' ? '}' : ']';
    const last = text.lastIndexOf(close);
    if (last > first) {
      try { return JSON.parse(text.slice(first, last + 1)); } catch { /* дальше */ }
    }
  }
  return null;
}

/** Снять обёртки, которые модель добавляет вокруг готовой реплики. */
/**
 * Оставить в комментарии не больше одного вопроса.
 *
 * Правило «не задавай больше одного вопроса» лежит в промпте с самого начала и
 * проваливается всеми моделями подряд: замер на семи реальных постах по
 * четырнадцать генераций дал 43% нарушений у gpt-5.4-mini, 64% у gpt-5.6-luna
 * и 36% у gpt-5.6-terra. Провал на трёх моделях — это свойство задачи, а не
 * формулировки: угол «уточняющий вопрос» толкает модель спросить, а желание
 * быть полезной — спросить ещё раз. Третьей редакции текста промпта тут не
 * поможет, поэтому правило исполняется кодом.
 *
 * Второй вопрос стоит дорого именно в нашем случае: он же и самый ценный угол
 * захода — автор почти всегда отвечает на конкретный вопрос, но выбирает,
 * на какой из двух, и половина реплики остаётся без ответа.
 *
 * Режем по предложениям и только те, что идут ПОСЛЕ первого вопроса:
 * утверждения между ними — это опора, ради которой вопрос и задан.
 * Если после обрезки текст не дотягивает до минимальной длины, возвращаем
 * исходный: два вопроса лучше обрубка.
 */
export function trimExtraQuestions(text, minLen = 0) {
  const t = String(text || '').trim();
  if ((t.match(/\?/g) || []).length < 2) return t;

  const sentences = t.match(/[^.!?…]+[.!?…]*/g) || [t];
  const kept = [];
  let seenQuestion = false;

  for (const s of sentences) {
    const isQuestion = s.includes('?');
    if (isQuestion && seenQuestion) continue;
    if (isQuestion) seenQuestion = true;
    kept.push(s);
  }

  const out = kept.join('').trim();
  return out.length >= minLen && out.includes('?') ? out : t;
}

export function cleanGenerated(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  t = t.replace(/^(комментарий|ответ|reply|comment)\s*[:—-]\s*/i, '');
  t = t.replace(/^["«»'`]+/, '').replace(/["«»'`]+$/, '');
  // Иногда возвращает несколько вариантов списком — берём первый.
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => /^(\d+[.)]|[-*•])\s+/.test(l))) {
    t = lines[0].replace(/^(\d+[.)]|[-*•])\s+/, '');
  }
  return t.trim();
}

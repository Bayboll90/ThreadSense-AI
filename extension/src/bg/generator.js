/**
 * Генерация комментария и оценка релевантности.
 *
 * Здесь сходятся все слои: промпты идут в выбранный AI API, результат проходит очистку,
 * гуманизацию и фильтры безопасности, и только потом считается готовым.
 * Цикл регенерации живёт тоже здесь — если safety забраковал текст, имеет смысл
 * попробовать ещё раз с поднятой температурой, прежде чем бросать пост.
 */

import { chat, chatWithFallback } from './openai.js';
import {
  relevanceSystem, relevanceUser,
  analysisSystem, analysisUser,
  writeSystem, writeUser, singlePassUser, rollLength,
  hostSystem, hostUser,
  styleSystem, styleUser,
} from './prompts.js';
import { extractJson, cleanGenerated, checkComment, pickAngle, trimExtraQuestions } from './safety.js';
import { humanize } from './humanizer.js';
import { clamp } from '../common/rng.js';

function withCustomPrompt(base, settings, key) {
  const extra = String(settings?.ai?.promptOverrides?.[key] || '').trim();
  return extra ? `${base}\n\nДополнительные инструкции пользователя:\n${extra}` : base;
}

/* ------------------------------------------------------------------ *
 * Оценка релевантности пачкой
 * ------------------------------------------------------------------ */

/**
 * @returns {{map: Map<number, {score, worth, topic, reason}>, cost: number}}
 */
export async function scoreRelevance(posts, settings) {
  if (!posts.length) return { map: new Map(), cost: 0 };

  const r = await chat(settings.ai, {
    model: settings.ai.modelScore,
    system: withCustomPrompt(relevanceSystem(), settings, 'relevance'),
    messages: [{ role: 'user', content: relevanceUser(posts, settings.niche) }],
    // Оценка должна быть воспроизводимой, разброс тут вреден.
    temperature: 0.2,
    topP: 1,
    presencePenalty: 0,
    frequencyPenalty: 0,
    maxTokens: Math.min(2400, 90 * posts.length + 200),
    json: true,
  });

  const parsed = extractJson(r.text);
  const map = new Map();

  if (parsed?.items?.length) {
    for (const it of parsed.items) {
      const id = Number(it.id);
      if (!Number.isInteger(id) || id < 0 || id >= posts.length) continue;
      map.set(id, {
        score: clamp(Number(it.score) / 100, 0, 1),
        worth: it.worth !== false,
        topic: String(it.topic || '').slice(0, 80),
        reason: String(it.reason || '').slice(0, 160),
      });
    }
  }

  return { map, cost: r.cost, usage: r.usage };
}

/* ------------------------------------------------------------------ *
 * Разбор ветки
 * ------------------------------------------------------------------ */

export async function analyzeThread(thread, settings) {
  const r = await chat(settings.ai, {
    model: settings.ai.modelScore,
    system: withCustomPrompt(analysisSystem(), settings, 'analysis'),
    messages: [{ role: 'user', content: analysisUser(thread, settings) }],
    temperature: 0.5,
    topP: 1,
    presencePenalty: 0,
    frequencyPenalty: 0,
    maxTokens: 600,
    json: true,
  });

  const j = extractJson(r.text) || {};
  const my = (settings.handle || '').replace(/^@/, '').toLowerCase();

  let replyTo = j.reply_to;
  if (replyTo != null) {
    const idx = Number(replyTo);
    const target = thread.replies?.[idx];
    // Отвечать самому себе нельзя ни при каких обстоятельствах.
    const isMine = target && String(target.authorHandle || '').replace(/^@/, '').toLowerCase() === my;
    replyTo = Number.isInteger(idx) && target && !isMine ? idx : null;
  } else {
    replyTo = null;
  }

  return {
    analysis: {
      /*
       * Попадание в нишу по всей ветке, а не по карточке.
       *
       * В ленте текст поста виден обрезанным, и оценка релевантности делается
       * по этому обрезку. Ветка сплошь и рядом оказывается не о том: начинается
       * с совпадения отдельных слов и целиком уходит в другую тему. Проверять
       * это имеет смысл только после того, как обсуждение прочитано.
       *
       * Отсутствие поля — не повод отказывать: старые ответы модели его не
       * содержат, и трактовать пропуск как ноль значило бы отсеять всё подряд.
       */
      onTopic: j.on_topic == null ? null : clamp(Number(j.on_topic) / 100, 0, 1),
      worth: j.worth !== false,
      topic: String(j.topic || ''),
      sentiment: String(j.sentiment || ''),
      gap: String(j.gap || ''),
      reply_to: replyTo,
      reply_to_reason: String(j.reply_to_reason || ''),
      angle: String(j.angle || ''),
      facts: Array.isArray(j.facts) ? j.facts.slice(0, 6).map(String) : [],
      do_not_say: Array.isArray(j.do_not_say) ? j.do_not_say.slice(0, 8).map(String) : [],
    },
    cost: r.cost,
    usage: r.usage,
  };
}

/* ------------------------------------------------------------------ *
 * Полный цикл генерации комментария
 * ------------------------------------------------------------------ */

/**
 * @returns {{
 *   ok: boolean, text?: string, raw?: string, angle?: string,
 *   analysis?: object, replyTo?: number|null, cost: number,
 *   attempts: number, reason?: string, humanized?: string[], similarity?: number
 * }}
 */
export async function generateComment(thread, settings, state) {
  let cost = 0;
  let analysis = null;

  if (settings.ai.twoPass) {
    const res = await analyzeThread(thread, settings);
    cost += res.cost;
    analysis = res.analysis;

    if (!analysis.worth) {
      return { ok: false, reason: 'ИИ решил, что ветка не стоит ответа', cost, attempts: 0 };
    }

    // Отказ по теме стоит одного разбора и экономит генерацию, набор и
    // публикацию — то есть почти всю стоимость цикла.
    const minTopic = settings.scoring?.minThreadTopic ?? 0;
    if (analysis.onTopic != null && analysis.onTopic < minTopic) {
      return {
        ok: false,
        offTopic: true,
        reason: `ветка не про нишу: ${analysis.onTopic.toFixed(2)} при пороге ${minTopic}`,
        cost,
        attempts: 0,
      };
    }
  }

  const angle = pickAngle(settings, state, analysis?.angle);
  const maxAttempts = Math.max(1, settings.safety.maxRegen + 1);
  let lastReason = 'не удалось сгенерировать';
  let fellBack = null;

  let retryNote = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    /*
     * С каждой неудачей поднимаем температуру: та же формулировка при тех же
     * параметрах воспроизведётся почти наверняка. На линейке 5.6 температура
     * зафиксирована платформой и до запроса не доедет — там повтор разводит
     * только retryNote ниже, и это надёжнее: причина брака сказана вслух,
     * а не оставлена на волю разброса.
     */
    const temp = clamp(settings.ai.temperature + attempt * 0.15, 0.3, 1.6);

    // Генерация текста — единственный шаг, который нечем заменить: без него
    // нет комментария. Поэтому именно здесь есть переход на запасную модель.
    /*
     * Длина разыгрывается один раз на попытку и уходит в оба промпта.
     *
     * Порознь они разыграли бы разное, и модель получила бы «пиши до 80
     * символов» в одном месте и «25-220» в другом — то есть противоречие,
     * которое она разрешает в свою пользу, возвращая привычные две сотни.
     */
    const length = rollLength(settings.style);

    const r = await chatWithFallback(settings.ai, {
      model: settings.ai.modelWrite,
      system: withCustomPrompt(writeSystem(settings, length), settings, 'comment'),
      messages: [{
        role: 'user',
        content: settings.ai.twoPass
          ? writeUser(thread, analysis, angle, settings, retryNote, length)
          : singlePassUser(thread, angle, settings, length),
      }],
      temperature: temp,
      maxTokens: settings.ai.maxOutputTokens,
    }, settings.ai.fallbackChain);
    cost += r.cost;
    if (r.fellBack) fellBack = r.model;

    const raw = trimExtraQuestions(cleanGenerated(r.text), settings.style.minLen);
    const { text, applied } = humanize(raw, settings);
    const verdict = checkComment(text, settings, state);

    if (verdict.ok) {
      return {
        ok: true,
        text,
        raw,
        angle,
        analysis,
        replyTo: analysis?.reply_to ?? null,
        cost,
        attempts: attempt + 1,
        humanized: applied,
        similarity: verdict.similarity,
        fellBackTo: fellBack,
      };
    }

    lastReason = verdict.reason;
    retryNote = verdict.reason;
    if (!verdict.retry) break;
  }

  return { ok: false, reason: lastReason, cost, attempts: maxAttempts, angle, analysis };
}

/* ------------------------------------------------------------------ *
 * Обучение стиля
 * ------------------------------------------------------------------ */

/**
 * Построить style-profile из собранных с профиля текстов.
 * @param {string[]} samples тексты постов и ответов пользователя
 */
/**
 * Ответ своему читателю под собственным постом.
 *
 * Отдельная функция, а не флаг у `generateComment`, по той же причине, по
 * которой публикация поста живёт отдельно от ответа: задачи различаются не
 * параметром, а целиком. Там нужен разбор чужой ветки, выбор угла захода и
 * поиск того, чего в обсуждении не хватает; здесь ветка своя, угол очевиден —
 * ответить человеку, — а разбирать нечего, реплика перед глазами.
 *
 * Двухпроходность тоже не нужна: `gap` придуман против «согласен, отличная
 * мысль» в чужой ветке, а под своим постом дежурная вежливость лечится прямым
 * запретом благодарить.
 *
 * @param {string} myPost  текст нашего поста
 * @param {{author, text}} reply  реплика, на которую отвечаем
 * @param {object[]} others остальные реплики ветки — только для контекста
 */
export async function generateHostReply(myPost, reply, others, settings, state) {
  let cost = 0;
  let lastReason = null;
  let fellBack = null;

  const tries = Math.max(1, settings.safety.maxRegen);

  for (let attempt = 0; attempt < tries; attempt++) {
    const retryNote = attempt > 0 && lastReason ? lastReason : '';

    const r = await chatWithFallback(settings.ai, {
      model: settings.ai.modelWrite,
      system: withCustomPrompt(hostSystem(settings), settings, 'reply'),
      messages: [{ role: 'user', content: hostUser(myPost, reply, others, retryNote) }],
      temperature: settings.ai.temperature,
      maxTokens: settings.ai.maxOutputTokens,
    }, settings.ai.fallbackChain);

    cost += r.cost;
    if (r.fellBack) fellBack = r.model;

    /*
     * `trimExtraQuestions` здесь не применяется намеренно. Правило одного
     * вопроса писалось против чужих веток, где лишний вопрос выглядит
     * навязчиво. В своей ветке вопрос — это продолжение разговора, ради
     * которого всё и делается.
     */
    const raw = cleanGenerated(r.text);
    const { text, applied } = humanize(raw, settings);
    const verdict = checkComment(text, settings, state);

    if (verdict.ok) {
      return {
        ok: true, text, raw, cost, attempts: attempt + 1,
        humanized: applied, fellBackTo: fellBack,
      };
    }
    lastReason = verdict.reason;
  }

  return { ok: false, reason: lastReason || 'не удалось написать ответ', cost, attempts: tries };
}

export async function trainStyle(samples, settings, { hasReplies = true } = {}) {
  const clean = samples
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 15 && s.length <= 900);

  if (clean.length < 3) {
    return { ok: false, error: `Слишком мало текстов: ${clean.length}. Нужно хотя бы 3.` };
  }

  // Больше 60 образцов не улучшают результат, но заметно удорожают запрос.
  const use = clean.length > 60 ? shuffled(clean).slice(0, 60) : clean;

  /*
   * Отсутствие ответов в выборке меняет задачу, а не просто уменьшает её.
   *
   * Пост и комментарий пишутся в разных регистрах: пост человек готовит, а
   * комментарий бросает на ходу. Профиль, снятый с постов и применённый к
   * комментариям, даёт скованный «постовой» тон под чужой веткой — узнаваемо
   * неуместный. У нового аккаунта ответов ещё нет, и модели приходится
   * выводить манеру комментариев из манеры постов, а не копировать её.
   */
  const r = await chat(settings.ai, {
    model: settings.ai.modelStyle,
    system: withCustomPrompt(styleSystem({ hasReplies }), settings, 'comment'),
    messages: [{ role: 'user', content: styleUser(use, { hasReplies }) }],
    temperature: hasReplies ? 0.3 : 0.6,   // без ответов модель не копирует, а выводит
    topP: 1,
    presencePenalty: 0,
    frequencyPenalty: 0,
    maxTokens: 1600,
    json: true,
  });

  const j = extractJson(r.text);
  if (!j?.profileText) {
    return { ok: false, error: 'Модель вернула неразборчивый ответ', cost: r.cost };
  }

  const examples = (Array.isArray(j.bestExamples) ? j.bestExamples : [])
    .map(String)
    .filter((s) => s.length >= 15);

  /*
   * Запасной вариант — только когда в выборке были ответы.
   *
   * Без них nearMedian вернул бы куски постов, и агент начал бы подражать
   * им в комментариях: ровно та ошибка, ради ухода от которой всё это
   * и затевалось. Лучше оставить примеры пустыми и сказать об этом прямо,
   * чем подсунуть неверные образцы под видом рабочих.
   */
  const useExamples = examples.length >= 4
    ? examples
    : (hasReplies ? nearMedian(use, 8) : examples);

  return {
    ok: true,
    cost: r.cost,
    profile: {
      profileText: String(j.profileText).slice(0, 2000),
      examples: useExamples.slice(0, 14),
      fillers: uniqStrings(j.fillers, 12),
      emojis: uniqStrings(j.emojis, 10),
      targetLen: clampInt(j.targetLen, 40, 400, settings.style.targetLen),
      maxLen: clampInt(j.maxLen, 60, 500, settings.style.maxLen),
    },
    meta: {
      samples: use.length,
      hasReplies,
      avgLen: Math.round(use.reduce((s, t) => s + t.length, 0) / use.length),
      punctuation: String(j.punctuation || ''),
      quirks: uniqStrings(j.quirks, 10),
      // Примеры выведены моделью, а не взяты из выборки: их стоит вычитать.
      examplesAreSynthetic: !hasReplies && examples.length > 0,
    },
  };
}

/* -------------------------------- утилиты -------------------------------- */

function uniqStrings(arr, max) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nearMedian(list, n) {
  const sorted = list.slice().sort((a, b) => a.length - b.length);
  const mid = Math.floor(sorted.length / 2);
  const out = [];
  for (let d = 0; out.length < n && d < sorted.length; d++) {
    if (sorted[mid - d]) out.push(sorted[mid - d]);
    if (out.length < n && d > 0 && sorted[mid + d]) out.push(sorted[mid + d]);
  }
  return out;
}

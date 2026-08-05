/**
 * Генерация собственного поста в профиль.
 *
 * Отличие от комментария не только в том, что нет ветки. Комментарий читают
 * несколько человек в чужом обсуждении, пост — все, кто зайдёт в профиль, и он
 * остаётся там навсегда. Поэтому проверок здесь больше, а не меньше, и порог
 * брака выше.
 *
 * Формат целиком продиктован разведкой живых постов Threads: коротко, в одну
 * строку, без ссылок и списков. Подробности в `prompts.postSystem`.
 */

import { chatWithFallback } from './openai.js';
import { postSystem, postUser, threadSystem, threadUser, guideSystem, guideUser } from './prompts.js';

function withCustomPrompt(base, settings) {
  const extra = String(settings?.ai?.promptOverrides?.post || '').trim();
  return extra ? `${base}\n\nДополнительные инструкции пользователя:\n${extra}` : base;
}
import { humanize, smartTruncate } from './humanizer.js';
import { POST_KINDS, partsFor, lenLimits } from './postplan.js';
import { similarity } from './newsfeed.js';
import { noveltyOf, opening, tiredTopics } from './novelty.js';
import { extractJson } from './safety.js';

const URL_RE = /(https?:\/\/|www\.)\S+/i;
const HASHTAG_RE = /(^|\s)#[\p{L}\d_]+/u;

/**
 * Проверка готового поста.
 *
 * Часть правил дублирует то, что уже сказано модели словами. Это намеренно:
 * инструкция в промпте — просьба, а проверка — гарантия, и на длинной
 * дистанции модель нарушит любую просьбу.
 */
/**
 * @param {string[]} recent   прошлые посты: сравниваются и по теме, и по тексту
 * @param {string[]} openings зачины прошлых постов
 * @param {string[]} siblings другие части этой же ветки — только по тексту
 *
 * Разделение `recent` и `siblings` существенно. Части одной ветки обязаны
 * делить тему: в этом и смысл ветки. Прогонять их через проверку тематической
 * новизны значит браковать вторую часть за то, что она продолжает первую.
 * Повтор формулировки внутри ветки — по-прежнему брак.
 */
export function checkPost(text, kind, settings, recent = [], openings = [], siblings = []) {
  const t = String(text || '').trim();

  if (!t) return { ok: false, reason: 'пустой текст', retry: true };

  /*
   * Сначала безусловные запреты, потом качество.
   *
   * Порядок не косметика. Пост со ссылкой не станет лучше от того, что он
   * нужной длины, а сообщение «короче 63 символов» про текст со ссылкой уводит
   * разбор не туда: правишь длину, а причина в другом. Проверка обязана
   * называть настоящее нарушение, а не первое попавшееся.
   */

  if (URL_RE.test(t)) return { ok: false, reason: 'ссылка в посте', retry: true };
  if (HASHTAG_RE.test(t)) return { ok: false, reason: 'хэштег', retry: true };

  // Список — самый проигрышный признак по собранным данным.
  if (/(^|\n)\s*(?:[-–—•*]|\d+[.)])\s+/.test(t)) {
    return { ok: false, reason: 'список в посте', retry: true };
  }

  const lines = t.split('\n').filter((l) => l.trim()).length;
  if (lines > 3) return { ok: false, reason: `${lines} строк, нужно не больше трёх`, retry: true };

  if (/^[{[]/.test(t) || /```/.test(t) || /^\s*(пост|текст)\s*:/i.test(t)) {
    return { ok: false, reason: 'служебная разметка в ответе', retry: true };
  }

  if ((t.match(/\p{Extended_Pictographic}/gu) || []).length > 2) {
    return { ok: false, reason: 'слишком много эмодзи', retry: true };
  }

  const lim = lenLimits(kind, settings);

  if (t.length < lim.floor) {
    return { ok: false, reason: `короче ${lim.floor} символов`, retry: true };
  }

  /*
   * Верхняя граница без запаса, и вот почему.
   *
   * Сначала запас был полуторным: казалось, лишний заход к модели ради двадцати
   * символов дороже, чем чуть более длинный пост. Живой прогон показал цену
   * этой логики — вышел пост на 201 символ при целевых 165, то есть ровно в
   * группу 150–350, которая по собранным данным набирает вчетверо меньше
   * отклика, чем пост до 150.
   *
   * Целевые границы в промпте при таком запасе ни на что не влияли: модель
   * писала до жёсткого предела, а не до заявленного. Просьба без проверки
   * работает ровно до первого случая, когда её удобно нарушить.
   *
   * Теперь запаса нет вовсе: и промпт, и эта проверка спрашивают `lenLimits`,
   * то есть одно и то же число. Разница между «попросили» и «требуем» была
   * единственным источником брака по длине, а брак по длине стоил целого
   * слота — час без публикации из-за девятнадцати лишних символов.
   */
  if (t.length > lim.max) {
    // Код нужен вызывающему: перебор — единственная причина брака, которую
    // можно исправить без модели, аккуратно обрезав текст по границе фразы.
    return {
      ok: false, code: 'too_long', over: t.length - lim.max,
      reason: `${t.length} символов, потолок ${lim.max}`, retry: true,
    };
  }

  const stop = settings.safety?.stopWords || [];
  const low = t.toLowerCase();
  for (const w of stop) {
    if (w && low.includes(String(w).toLowerCase())) {
      return { ok: false, reason: `стоп-слово «${w}»`, retry: true };
    }
  }

  /*
   * Новизна по трём измерениям сразу.
   *
   * Сходства формулировок мало. Профиль, где каждый второй пост про одно и то
   * же, читается однообразным, даже если ни одна фраза не повторилась; а
   * десяток текстов, начинающихся одинаково, выглядит шаблоном при разных
   * темах. Поэтому считаются и тема, и зачин — и берётся худшее из трёх.
   */
  const nov = noveltyOf(t, recent, { openings: openings.length ? openings : recent.map(opening) });
  const min = settings.posting?.minNovelty ?? 0.55;

  if (nov.score < min) {
    return {
      ok: false,
      reason: `слишком похоже на недавнее (${nov.worst}, новизна ${nov.score.toFixed(2)})`,
      retry: true,
    };
  }

  // Прямое совпадение формулировки бракуем и при хорошей общей новизне.
  const maxSim = settings.posting?.maxSimilarity ?? 0.42;
  for (const prev of recent) {
    const sim = similarity(t, prev);
    if (sim >= maxSim) {
      return { ok: false, reason: `похоже на недавний пост (${sim.toFixed(2)})`, retry: true };
    }
  }

  // Соседние части ветки: тему делить можно, формулировку нельзя.
  for (const sib of siblings) {
    const sim = similarity(t, sib);
    if (sim >= maxSim) {
      return { ok: false, reason: `повторяет соседнюю часть (${sim.toFixed(2)})`, retry: true };
    }
  }

  return { ok: true };
}

/**
 * Настройки гуманизатора для поста: без опечаток.
 *
 * Опечатки в комментариях работают на достоверность и остаются. Комментарий
 * уходит в чужую ветку и назавтра его никто не найдёт.
 *
 * Пост — другое. Он остаётся в профиле навсегда, и читают его те, кто пришёл
 * посмотреть, чем человек занимается. Пропущенная буква в слове из собственной
 * профессиональной темы там читается не как живость, а как небрежность —
 * ровно в том месте, где хочется выглядеть наоборот.
 *
 * Остальная гуманизация сохраняется целиком: длинное тире, кавычки-лапки,
 * регистр, потерянная точка в конце, вычистка штампов. Именно она и делает
 * текст непохожим на машинный, а опечатки — лишь малая её часть.
 */
export function forPost(settings, { opener = false } = {}) {
  const h = {
    ...settings.humanize,
    typoPerWord: 0,
    typoMaxPerComment: 0,
  };

  /*
   * В открывающем сообщении ветки слов-паразитов быть не должно.
   *
   * Живой случай: разбор начался со слова «типа,». В комментарии это уместно —
   * там реплика в разговоре. В первой строке ветки, которая обещает читателю
   * разбор, оно сбивает крючок и делает автора несерьёзным ровно там, где он
   * собирается чему-то научить.
   *
   * Внутри ветки паразиты остаются: там уже идёт живая речь.
   */
  if (opener) {
    h.insertFiller = 0;
    h.stretchVowel = 0;
  }

  return { ...settings, humanize: h };
}

/**
 * Проверка разбора инструмента.
 *
 * Правила те же, что у обычного поста, кроме трёх мест, где обычные правила
 * прямо мешают формату.
 *
 * **Строк больше трёх.** Команда установки живёт на отдельной строке — иначе
 * её не скопировать, — и вокруг неё нужны хотя бы «что она делает» и «что
 * нужно заранее». Три строки на такое сообщение не хватает.
 *
 * **Ссылка внутри команды разрешена.** `git clone https://github.com/…` — это
 * не ссылка в посте, а часть инструкции. Всё остальное, что похоже на адрес,
 * по-прежнему запрещено: правило про ссылки писалось против «переходи ко мне»,
 * а не против команд.
 *
 * **Команда обязана присутствовать дословно.** Это главное: пост без рабочей
 * команды — не инструкция, а пересказ. Сверяется по нормализованным пробелам,
 * потому что перенос строки и двойной пробел смысла не меняют.
 */
export function checkGuide(text, kind, settings, material, recent = [], openings = [], siblings = []) {
  const t = String(text || '').trim();
  const install = String(material?.install || '').trim();

  if (!t) return { ok: false, reason: 'пустой текст', retry: true };

  const withoutCommand = install ? t.split(install).join(' ') : t;
  if (URL_RE.test(withoutCommand)) {
    return { ok: false, reason: 'ссылка вне команды установки', retry: true };
  }
  if (HASHTAG_RE.test(t)) return { ok: false, reason: 'хэштег', retry: true };

  const lines = t.split('\n').filter((l) => l.trim()).length;
  if (lines > 5) return { ok: false, reason: `${lines} строк, нужно не больше пяти`, retry: true };

  if (/^[{[]/.test(t) || /```/.test(t)) {
    return { ok: false, reason: 'служебная разметка в ответе', retry: true };
  }

  if ((t.match(/\p{Extended_Pictographic}/gu) || []).length > 2) {
    return { ok: false, reason: 'слишком много эмодзи', retry: true };
  }

  const lim = lenLimits(kind, settings);
  if (t.length < lim.floor) return { ok: false, reason: `короче ${lim.floor} символов`, retry: true };
  if (t.length > lim.max) {
    return {
      ok: false, code: 'too_long', over: t.length - lim.max,
      reason: `${t.length} символов, потолок ${lim.max}`, retry: true,
    };
  }

  const stop = settings.safety?.stopWords || [];
  const low = t.toLowerCase();
  for (const w of stop) {
    if (w && low.includes(String(w).toLowerCase())) {
      return { ok: false, reason: `стоп-слово «${w}»`, retry: true };
    }
  }

  /* Повтор внутри ветки — по-прежнему брак: второе сообщение, пересказывающее
     первое, отнимает место у того, ради чего пост писался. */
  for (const s of siblings) {
    if (similarity(t, s) > (settings.safety?.similarityThreshold ?? 0.5)) {
      return { ok: false, reason: 'сообщение повторяет соседнее', retry: true };
    }
  }

  return { ok: true };
}

/** Команда есть в ветке ровно в том виде, в каком её дали. */
export function hasInstallCommand(parts, install) {
  const want = norm(install);
  if (!want) return false;
  return parts.some((p) => norm(p).includes(want));
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Написать ветку из нескольких сообщений.
 *
 * Проверяется каждое сообщение по отдельности и все вместе: вторая часть,
 * похожая на первую, — та же вода, только длиннее.
 */
export async function generateThread(kind, material, settings, recent = [], parts) {
  const k = POST_KINDS[kind];
  const n = parts || partsFor(kind);

  let cost = 0;
  let lastReason = 'не удалось сгенерировать';
  let retryNote = '';
  const lim = lenLimits(kind, settings);
  const maxAttempts = Math.max(1, (settings.safety?.maxRegen ?? 2) + 1);

  /* Разбор инструмента пишется по фактам, а не сочиняется, — отсюда свой
     промпт и своя проверка. Всё остальное в конвейере общее. */
  const isGuide = kind === 'toolguide' && material?.kind === 'tool';
  const verify = (text, siblings) => (isGuide
    ? checkGuide(text, kind, settings, material, recent, recent.map(opening), siblings)
    : checkPost(text, kind, settings, recent, recent.map(opening), siblings));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const temp = Math.min(1.6, (settings.ai?.temperature ?? 0.9) + attempt * 0.15);
    const last = attempt === maxAttempts - 1;

    const r = await chatWithFallback(settings.ai, {
      model: settings.ai.modelWrite,
      system: withCustomPrompt(isGuide
        ? guideSystem(settings, k, n, lim)
        : threadSystem(settings, k, n, lim), settings),
      messages: [{
        role: 'user',
        content: isGuide
          ? guideUser(k, material, settings, recent, retryNote)
          : threadUser(k, material, settings, recent, retryNote),
      }],
      temperature: temp,
      maxTokens: 1200,
      json: true,
    }, settings.ai.fallbackChain);

    cost += r.cost;

    const j = extractJson(r.text);
    const raw = Array.isArray(j?.parts) ? j.parts.map(cleanPost).filter(Boolean) : [];
    if (raw.length < 2) { lastReason = 'модель вернула не ветку'; continue; }

    const texts = [];
    const applied = [];
    /* Части, в которых важен каждый знак: их нельзя ни гуманизировать, ни
       набирать с промахами, ни сверять «примерно». */
    const exact = [];
    let bad = null;

    for (const t of raw.slice(0, n)) {
      /*
       * Сообщение с командой установки гуманизации не подлежит.
       *
       * Опечатка по клавиатуре в `npx -y пакет` — это не живость, а неверная
       * команда: читатель скопирует её и получит ошибку. Живость здесь стоит
       * ровно столько же, сколько доверие, которое она уносит.
       */
      const holdsCommand = isGuide && norm(t).includes(norm(material.install));
      const h = holdsCommand
        ? { text: t, applied: ['без гуманизации: в сообщении команда'] }
        : humanize(t, forPost(settings, { opener: texts.length === 0 }));

      // Прошлые посты — по теме и тексту, соседние части — только по тексту.
      let candidate = h.text;
      let v = verify(candidate, texts);

      /*
       * Длинную часть спасаем только на последней попытке.
       *
       * У ветки цена брака выше, чем у одиночного поста: из-за одного длинного
       * сообщения выбрасываются все остальные, уже годные. Но и обрезать
       * раньше времени не стоит — сначала пусть модель перепишет, зная предел.
       */
      if (!v.ok && v.code === 'too_long' && last) {
        const fit = fitToLimit(candidate, t, lim.max);
        const second = verify(fit.text, texts);
        if (second.ok) {
          candidate = fit.text;
          v = second;
          if (fit.cut) h.applied.push(fit.cut);
        }
      }

      if (!v.ok) { bad = v.reason; break; }
      texts.push(candidate);
      exact.push(holdsCommand);
      applied.push(...h.applied);
    }

    if (bad) { lastReason = bad; retryNote = bad; continue; }
    if (texts.length < 2) { lastReason = 'после проверок осталось меньше двух сообщений'; continue; }

    /*
     * Разбор без команды — не разбор.
     *
     * Модель может пересказать установку своими словами («поставь через npx»),
     * и текст пройдёт все прочие проверки: он связный, нужной длины и по теме.
     * Но читатель не сможет ничего сделать, а формат обещает именно это.
     * Поэтому отсутствие дословной команды — брак с названной причиной, и
     * следующая попытка получает её текстом.
     */
    if (isGuide && !hasInstallCommand(texts, material.install)) {
      lastReason = 'в ветке нет команды установки дословно';
      retryNote = `команда обязана быть приведена ровно так: ${material.install}`;
      continue;
    }

    /*
     * Первое сообщение обязано обещать продолжение.
     *
     * Двоеточие в конце — самый воспроизводимый признак из разведки: ×2.33 на
     * выборке в 36 постов. Без него ветка читается как оборванный пост, а не
     * как начало разбора. Дописываем, если модель забыла.
     */
    if (!/[:…]\s*$/.test(texts[0])) {
      texts[0] = `${texts[0].replace(/[.\s]+$/, '')}:`;
      applied.push('обещание продолжения');
    }

    return {
      ok: true, parts: texts, exact, text: texts[0], kind, material: material || null,
      humanized: [...new Set(applied)], cost, attempts: attempt + 1,
      fellBack: r.fellBack ? r.model : null,
    };
  }

  return { ok: false, reason: lastReason, cost, attempts: maxAttempts };
}

/**
 * Уложить готовый текст в потолок, не ломая фразу.
 *
 * Три исхода, по убыванию желательности.
 *
 * Текст и так помещается — ничего не делаем.
 *
 * Помещается исходник, а вышел за предел уже гуманизированный вариант —
 * возвращаем исходник. Гуманизация вставляет паразитов, скобочные ремарки и
 * эмодзи, то есть умеет добавить полтора десятка символов на ровном месте, и
 * терять из-за косметики целый пост неразумно.
 *
 * Не помещается ничего — режем по границе предложения. Это последний рубеж и
 * применяется он только тогда, когда перегенерация уже не помогла: обрезка
 * всегда чем-то жертвует, а для формата «промпты» может отрезать ровно то,
 * ради чего пост писался.
 */
export function fitToLimit(humanized, raw, max) {
  const h = String(humanized || '').trim();
  if (h.length <= max) return { text: h, cut: null };

  const r = String(raw || '').trim();
  if (r && r.length <= max) return { text: r, cut: 'гуманизация откачена' };

  return { text: smartTruncate(h, max), cut: 'обрезано по границе фразы' };
}

/**
 * Написать пост.
 *
 * @param {string} kind      ключ из POST_KINDS
 * @param {object|null} material повод: новость из ленты источников
 * @param {object} settings
 * @param {string[]} recent  тексты последних постов — против самоповтора
 */
export async function generatePost(kind, material, settings, recent = []) {
  const k = POST_KINDS[kind];
  if (!k) return { ok: false, reason: `неизвестный формат «${kind}»`, cost: 0, attempts: 0 };

  // Многочастные форматы пишутся другим промптом и другой проверкой.
  if (Array.isArray(k.parts) || (k.parts ?? 1) > 1) {
    return generateThread(kind, material, settings, recent);
  }

  let cost = 0;
  let lastReason = 'не удалось сгенерировать';
  let retryNote = '';
  let rescued = null;
  const lim = lenLimits(kind, settings);
  const maxAttempts = Math.max(1, (settings.safety?.maxRegen ?? 2) + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // С каждой неудачей поднимаем температуру: та же формулировка при тех же
    // параметрах воспроизведётся почти наверняка.
    const temp = Math.min(1.6, (settings.ai?.temperature ?? 0.9) + attempt * 0.15);

    const r = await chatWithFallback(settings.ai, {
      model: settings.ai.modelWrite,
      system: withCustomPrompt(postSystem(settings, k, lim), settings),
      messages: [{ role: 'user', content: postUser(k, material, settings, recent, retryNote) }],
      temperature: temp,
      maxTokens: 400,
    }, settings.ai.fallbackChain);

    cost += r.cost;

    const raw = cleanPost(r.text);
    const { text, applied } = humanize(raw, forPost(settings));
    const verdict = checkPost(text, kind, settings, recent);

    if (verdict.ok) {
      return {
        // `parts` возвращается всегда: остальному коду не нужно знать, ветка
        // это или одиночный пост.
        ok: true, text, parts: [text], raw, kind, material: material || null,
        humanized: applied, cost, attempts: attempt + 1,
        fellBack: r.fellBack ? r.model : null,
      };
    }

    /*
     * Перебор по длине откладываем в запас, а не выбрасываем.
     *
     * Такой текст уже прошёл всё остальное — новизну, запреты, стиль, — и
     * единственная его беда чинится без модели. Но сначала честная попытка
     * получить нормальный вариант: обрезка портит концовку, а перегенерация с
     * названной причиной обычно попадает в предел.
     */
    if (verdict.code === 'too_long' && !rescued) {
      const fit = fitToLimit(text, raw, lim.max);
      const second = checkPost(fit.text, kind, settings, recent);
      if (second.ok) rescued = { ...fit, applied, raw, attempt: attempt + 1 };
    }

    lastReason = verdict.reason;
    retryNote = verdict.reason;
    if (!verdict.retry) break;
  }

  /*
   * Слот дороже красоты концовки.
   *
   * Живой случай: пост на 194 символа при потолке 175 забракован, слот
   * отмечен отработанным, следующая попытка — через час. Девятнадцать лишних
   * символов стоили публикации, хотя текст был готов и годен.
   */
  if (rescued) {
    return {
      ok: true, text: rescued.text, parts: [rescued.text], raw: rescued.raw,
      kind, material: material || null,
      humanized: [...rescued.applied, rescued.cut].filter(Boolean),
      cost, attempts: maxAttempts, trimmed: rescued.cut,
    };
  }

  return { ok: false, reason: lastReason, cost, attempts: maxAttempts };
}

/**
 * Прибрать типовой мусор модели.
 *
 * Кавычки вокруг всего текста и подпись формата встречаются постоянно, сколько
 * ни проси не делать этого. Дешевле снять, чем перезапрашивать.
 */
export function cleanPost(s) {
  let t = String(s || '').trim();

  t = t.replace(/^["«“']+|["»”']+$/g, '').trim();
  t = t.replace(/^(пост|текст поста|вариант\s*\d*)\s*:\s*/i, '').trim();
  t = t.replace(/\r/g, '');
  // Пустые строки внутри поста превращаются в лишние строки при вставке.
  t = t.replace(/\n{2,}/g, '\n').trim();

  return t;
}

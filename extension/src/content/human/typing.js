/**
 * Посимвольный набор текста.
 *
 * Одномоментная вставка готовой строки в поле — самый громкий сигнал
 * автоматизации из всех возможных: у человека между первым и последним
 * символом проходят десятки секунд, и каждый интервал уникален.
 *
 * Что моделируется здесь:
 *  - интервалы между символами берутся из логнормального распределения
 *    (плотное ядро на привычных сочетаниях, длинный хвост на паузах);
 *  - пробел набирается медленнее буквы, знак препинания вызывает паузу,
 *    заглавная требует времени на шифт;
 *  - изредка палец промахивается, человек это замечает через символ-другой
 *    и исправляет бэкспейсом;
 *  - перед отправкой текст перечитывается — это заметная пауза.
 *
 * Куда уходит символ. Основной путь — доверенный: нажатие клавиши порождает
 * браузер по просьбе фона (`lib/input.js`), и страница получает настоящий
 * ввод с `isTrusted: true`. Запасной путь — `execCommand('insertText')`:
 * Threads сделан на Lexical, и прямая запись в textContent не порождает
 * внутреннего события редактора, поэтому React затирает вставленное при
 * следующем рендере.
 *
 * Тайминги при этом общие для обоих путей: они и есть содержание этого файла,
 * а способ доставки символа — деталь.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.typing) return;
  const { uniform, gauss, chance, clamp, lognormalClamped, randInt, pick } = TA.rng;

  /**
   * Паузы идут через keepalive, а не через setTimeout.
   *
   * Chrome душит таймеры в неактивной вкладке, растягивая двести миллисекунд
   * до десятков секунд. Для набора это не мелочь: правдоподобность целиком
   * держится на точности межсимвольных интервалов, и растянутый вчетверо ввод
   * выглядит не человечнее, а страннее.
   */
  const sleep = (ms) => (TA.keepalive ? TA.keepalive.preciseSleep(ms) : TA.util.sleep(ms));

  const DEFAULTS = {
    wpm: 62,
    cv: 0.55,
    minCharMs: 28,
    maxCharMs: 900,
    spaceFactor: 1.35,
    punctPauseMs: [140, 520],
    shiftExtraMs: [40, 130],
    thinkChance: 0.045,
    thinkMs: [400, 2100],
    typoChance: 0.028,
    typoNoticeAfter: [1, 3],
    typoFixPauseMs: [180, 600],
    preTypeMs: [300, 1200],
    reviewMs: [900, 3400],

    /*
     * Потолок на весь набор.
     *
     * Человек не пишет один комментарий девять минут, и открытый всё это время
     * композер — сам по себе заметный след. Прогон, где набор растянулся
     * настолько, показал и вторую сторону: за такое время страница успевает
     * перестроиться несколько раз, и шансы довести пост до публикации падают
     * быстрее, чем растёт упорство. Лучше отступить и взять пост заново.
     */
    maxTotalMs: 200000,
  };

  /** Средний интервал между символами из скорости в словах в минуту. */
  function meanCharMs(wpm) {
    // Стандартное слово в метриках набора — пять символов вместе с пробелом.
    return 60000 / (Math.max(10, wpm) * 5);
  }

  /* --------------------------- Низкий уровень ----------------------------- */

  function keyEvent(el, type, ch) {
    const key = ch === '\n' ? 'Enter' : ch;
    const ev = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key,
      code: codeFor(ch),
      shiftKey: /[A-ZА-ЯЁ]/.test(ch),
    });
    el.dispatchEvent(ev);
  }

  function codeFor(ch) {
    if (ch === ' ') return 'Space';
    if (ch === '\n') return 'Enter';
    const lower = ch.toLowerCase();
    if (/[a-z]/.test(lower)) return `Key${lower.toUpperCase()}`;
    if (/[0-9]/.test(lower)) return `Digit${lower}`;
    return 'Unidentified';
  }

  /** Вставить один символ так, чтобы редактор это заметил. */
  async function insertChar(el, ch) {
    keyEvent(el, 'keydown', ch);

    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true,
      inputType: 'insertText', data: ch,
    }));

    let ok = false;
    try {
      ok = document.execCommand('insertText', false, ch);
    } catch { ok = false; }

    if (!ok) {
      // Резервный путь для полей, где execCommand заблокирован.
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const start = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, start) + ch + el.value.slice(el.selectionEnd ?? start);
        el.selectionStart = el.selectionEnd = start + 1;
      } else {
        const sel = window.getSelection();
        if (sel?.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(ch);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }

    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: ch,
    }));
    keyEvent(el, 'keyup', ch);
  }

  /** Удалить символ слева от каретки. */
  async function backspace(el) {
    keyEvent(el, 'keydown', 'Backspace');
    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, inputType: 'deleteContentBackward',
    }));

    let ok = false;
    try { ok = document.execCommand('delete', false); } catch { ok = false; }

    if (!ok) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const start = el.selectionStart ?? el.value.length;
        if (start > 0) {
          el.value = el.value.slice(0, start - 1) + el.value.slice(start);
          el.selectionStart = el.selectionEnd = start - 1;
        }
      } else {
        const sel = window.getSelection();
        if (sel?.rangeCount) {
          const r = sel.getRangeAt(0);
          r.setStart(r.startContainer, Math.max(0, r.startOffset - 1));
          r.deleteContents();
        }
      }
    }

    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'deleteContentBackward',
    }));
    keyEvent(el, 'keyup', 'Backspace');
  }

  /* ------------------------------ Тайминги -------------------------------- */

  /** Задержка перед конкретным символом с учётом контекста. */
  function delayFor(ch, prev, cfg, base) {
    let mean = base;

    if (ch === ' ') mean *= cfg.spaceFactor;
    if (/[A-ZА-ЯЁ]/.test(ch)) mean += uniform(...cfg.shiftExtraMs);
    // Смена алфавита требует переключения раскладки — заметная задержка.
    if (prev && isCyr(prev) !== isCyr(ch) && /\p{L}/u.test(ch) && /\p{L}/u.test(prev)) {
      mean += uniform(180, 600);
    }
    // Цифры и редкие символы набираются медленнее букв.
    if (/[0-9]/.test(ch)) mean *= 1.3;
    if (/[^\p{L}\p{N}\s.,!?]/u.test(ch)) mean *= 1.5;

    let d = lognormalClamped(mean, cfg.cv, cfg.minCharMs, cfg.maxCharMs);

    // После знака препинания — микропауза на осмысление следующей фразы.
    if (prev && '.!?'.includes(prev)) d += uniform(...cfg.punctPauseMs);
    else if (prev && ',;:'.includes(prev)) d += uniform(60, 240);

    return d;
  }

  const isCyr = (ch) => /[а-яё]/i.test(ch);

  /* ---------------------------- Верхний уровень --------------------------- */

  /**
   * Набрать текст в поле.
   *
   * @param {Element} el   поле ввода (contenteditable или textarea)
   * @param {string}  text что набрать
   * @param {object}  opts переопределения таймингов
   * @returns {Promise<{ok: boolean, ms: number, typos: number}>}
   */
  async function type(el, text, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const base = meanCharMs(cfg.wpm);
    const started = Date.now();
    let typos = 0;

    /*
     * Поле может смениться прямо посреди набора.
     *
     * React перерисовывает разметку когда сочтёт нужным: наш элемент
     * отваливается, а эквивалентный появляется рядом — часто уже с тем
     * текстом, что мы успели написать. Бросать пост в такой момент значит
     * терять его на ровном месте, поэтому поле переподхватывается, а набор
     * продолжается с той позиции, до которой реально дошёл.
     */
    let target = el;
    let swaps = 0;
    const MAX_SWAPS = 4;

    /* Сколько раз пришлось возвращать фокус: молчаливая потеря фокуса — это
       дефект страницы, и в отчёте она должна быть видна числом. */
    let refocused = 0;

    target.focus();
    // Каретка в конец: поле может быть не пустым, если пользователь что-то ввёл.
    placeCaretAtEnd(target);
    await sleep(uniform(...cfg.preTypeMs));

    const chars = [...String(text)];

    /**
     * Активная неисправленная опечатка.
     * from    — индекс символа, на котором промахнулись;
     * typed   — сколько символов уже стоит в поле начиная с from
     *           (первый из них ошибочный, остальные набраны поверх);
     * notice  — через сколько символов человек заметит ошибку.
     */
    let typo = null;

    /*
     * Потолок исправлений на один набор.
     *
     * Откат «начисто» возвращает набор к началу, где снова может выпасть
     * промах: при высокой вероятности опечаток это уходит в живую блокировку
     * и текст не дописывается никогда. После нескольких исправлений промахи
     * отключаются до конца текста — набор обязан завершаться при любой
     * настройке.
     */
    const MAX_CORRECTIONS = 4;
    let corrections = 0;

    /*
     * Полный перенабор — самое дорогое, что здесь может случиться: он стоит
     * ровно столько же, сколько весь текст. Одного достаточно, чтобы выйти из
     * запутанного состояния поля; второй означает, что дело не в опечатке, и
     * повторять уже нечего.
     */
    const MAX_RESTARTS = 1;
    let restarts = 0;

    /*
     * Слежение за темпом.
     *
     * Складываем запланированные паузы и сравниваем с фактическим временем.
     * Расхождение в разы означает, что нас душат снаружи — троттлинг, нехватка
     * процессора, тяжёлая страница. Само по себе это не ошибка набора, но
     * молчать о нём нельзя: именно так девятиминутный набор выглядел в логах
     * обычной работой.
     */
    let plannedMs = 0;
    let stalled = false;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const prev = i > 0 ? chars[i - 1] : null;

      const elapsed = Date.now() - started;
      if (elapsed > cfg.maxTotalMs) {
        return { ok: false, aborted: true, reason: 'набор не уложился в отведённое время',
          ms: elapsed, typos, typedChars: i, swaps, stalled: true, editor: target };
      }
      if (!stalled && i >= 40 && elapsed > plannedMs * 3 + 8000) {
        stalled = true;
        TA.util.warn(`набор идёт втрое медленнее плана: ${Math.round(elapsed / 1000)} с `
          + `на ${i} симв. при плане ${Math.round(plannedMs / 1000)} с`);
      }

      /*
       * Проверка контекста каждые пятнадцать символов.
       *
       * Обработчик отвечает одним из трёх: true — всё в порядке; false —
       * продолжать нельзя; элемент — поле сменилось, работать теперь с ним.
       * Чаще проверять расточительно, реже — успеваем напечатать половину
       * в пустоту.
       */
      /*
       * Фокус проверяется чаще, чем контекст, и восстанавливается молча.
       *
       * Набор в поле, потерявшее фокус, неверен при любой причине потери, но
       * до 02.08 это нигде не проверялось: фокус ставился только при подмене
       * поля. Между подменами React может снять его сам — узел остаётся тем
       * же, `isConnected` истинно, проверка контекста отвечает «всё в
       * порядке», а символы летят мимо.
       *
       * Отдельная неприятность в том, куда они летят. У Threads есть
       * клавиатурная навигация по ленте, и события с расфокусированного поля
       * всплывают до документа. Это единственная известная мне причина, по
       * которой набор мог увести агента на **чужой** пост, а такое в журнале
       * встречалось: `/@old_user/... → /@new_user/...` при отсоединённой
       * карточке и нулевом числе диалогов.
       *
       * Доказательством этой связи я не располагаю — поэтому здесь не
       * лечение гипотезы, а безусловно правильное поведение: печатать можно
       * только туда, где стоит курсор.
       */
      if (i > 0 && i % 5 === 0 && target.isConnected && document.activeElement !== target) {
        target.focus();
        placeCaretAtEnd(target);
        refocused++;
      }

      if (cfg.onProgress && i > 0 && i % 15 === 0) {
        const verdict = cfg.onProgress(i, chars.length);

        if (verdict === false) {
          return { ok: false, aborted: true, ms: Date.now() - started, typos, typedChars: i, swaps };
        }

        if (verdict && verdict !== true && verdict !== target) {
          if (++swaps > MAX_SWAPS) {
            return { ok: false, aborted: true, reason: 'поле менялось слишком часто',
              ms: Date.now() - started, typos, typedChars: i, swaps };
          }

          target = verdict;
          target.focus();
          placeCaretAtEnd(target);
          await sleep(uniform(120, 350));

          /*
           * Досинхронизация с новым полем.
           *
           * Перерисовка часто сохраняет уже набранное, иногда теряет часть,
           * изредка очищает всё. Позиция берётся от фактического содержимого,
           * а не от счётчика: только так продолжение не даст ни дубля, ни
           * пропуска.
           */
          const full = chars.join('');
          const got = readRaw(target);
          if (full.startsWith(got)) {
            i = got.length - 1;
            typo = null;             // прежняя опечатка осталась в старом поле
          } else {
            await clear(target);
            i = -1;
            typo = null;
          }
          continue;
        }
      }

      // Иногда человек задумывается посреди фразы.
      if (chance(cfg.thinkChance) && i > 3 && i < chars.length - 3) {
        const think = uniform(...cfg.thinkMs);
        plannedMs += think;
        await sleep(think);
      }

      const step = delayFor(ch, prev, cfg, base);
      plannedMs += step;
      await sleep(step);

      // Промах по клавише: печатаем соседний символ, ошибку заметим позже.
      if (!typo && corrections < MAX_CORRECTIONS
        && chance(cfg.typoChance) && /\p{L}/u.test(ch) && i > 2 && i < chars.length - 1) {
        const wrong = neighborOf(ch);
        if (wrong) {
          await insertChar(target, wrong);
          typo = { from: i, typed: 1, notice: randInt(...cfg.typoNoticeAfter) };
          typos++;
          continue;
        }
      }

      await insertChar(target, ch);

      if (typo) {
        typo.typed++;
        if (--typo.notice <= 0) {
          await sleep(uniform(...cfg.typoFixPauseMs));
          i = await correct(target, chars, typo, cfg);
          typo = null;
          corrections++;

          if (i < 0) {
            // Поле очищено, набор пойдёт с нуля. Второй раз этого не будет:
            // повторный перенабор стоит столько же, сколько весь текст, и
            // означает, что причина не в опечатке.
            if (++restarts > MAX_RESTARTS) {
              return { ok: false, aborted: true, reason: 'поле не удалось привести в порядок',
                ms: Date.now() - started, typos, typedChars: 0, swaps, editor: target };
            }
            // Потраченное засчитываем как плановое: перенабор — наше решение,
            // а слежение должно ловить внешнее торможение, а не его.
            plannedMs = Date.now() - started;
            corrections = MAX_CORRECTIONS;   // дальше без промахов
          }

          await sleep(uniform(120, 380));
        }
      }
    }

    // Опечатка осталась незамеченной до конца текста — исправляем перед отправкой.
    if (typo) {
      await sleep(uniform(...cfg.typoFixPauseMs));
      const from = await correct(target, chars, typo, cfg);
      for (let k = from + 1; k < chars.length; k++) {
        await sleep(delayFor(chars[k], chars[k - 1] ?? null, cfg, base));
        await insertChar(target, chars[k]);
      }
    }

    // Поле возвращается вместе с результатом: оно могло смениться по дороге,
    // и дальше работать нужно именно с ним.
    return {
      ok: true, ms: Date.now() - started, typos, swaps, restarts, stalled,
      refocused, editor: target,
    };
  }

  /**
   * Исправить опечатку и пересинхронизироваться с полем.
   *
   * Стереть N символов и продолжить с заранее посчитанной позиции — наивно.
   * В Lexical удаление не всегда снимает ровно один символ: редактор работает
   * узлами, и один бэкспейс способен снести слово целиком. Код при этом
   * считал, что стёр ровно столько, сколько собирался, и допечатывал с
   * рассчитанного места — а всё, что редактор захватил сверх плана, исчезало
   * навсегда. Так «проверка ввода» превращалось в «проверкаа».
   *
   * Поэтому здесь не доверяем счётчику, а спрашиваем поле. После стирания
   * ищем, какой длины общий префикс у содержимого и у цели: это и есть
   * настоящая точка, с которой нужно продолжать.
   *
   * @returns {Promise<number>} индекс последнего верного символа; цикл
   *          продолжится со следующего
   */
  async function correct(el, chars, typo, cfg) {
    void cfg;
    const target = chars.join('');

    /*
     * Единственное безопасное условие для продолжения — содержимое поля
     * является чистым началом нужного текста.
     *
     * Считать позиции по длине нельзя: readValue нормализует пробелы и
     * переносы, счёт разъезжается, и допечатка ложится поверх уже набранного.
     * Так появлялись дубли вида «так же бы было, с было». Проверка на префикс
     * от таких расхождений не зависит вовсе.
     */
    const prefixLen = () => {
      const got = readRaw(el);
      return target.startsWith(got) ? got.length : -1;
    };

    // Стираем, пока в поле не останется чистое начало текста до точки ошибки.
    const budget = typo.typed + 6;
    for (let k = 0; k < budget; k++) {
      const n = prefixLen();
      if (n >= 0 && n <= typo.from) return n - 1;
      // Не подтвердилось — дальше стирать бессмысленно и опасно: продолжая
      // вслепую, мы снесём набранное до пустого.
      if (!(await backspaceConfirmed(el))) break;
      await sleep(uniform(45, 130));
    }

    /*
     * Не сошлось за отведённые попытки — начисто.
     *
     * Случай редкий, зато исход однозначен: пустое поле нельзя продублировать.
     * Лишние секунды набора дешевле опубликованной каши.
     */
    await clear(el);
    return -1;
  }

  /**
   * Стереть символ и дождаться, пока редактор это применит.
   *
   * Читать поле сразу после бэкспейса нельзя. Lexical применяет удаление не
   * синхронно с событием, а своим циклом, и на загруженной странице ответ
   * приходит заметно позже. Код, читавший поле немедленно, видел прежний
   * текст, считал удаление несостоявшимся и стирал дальше — так набранное
   * сносилось до пустого, после чего весь текст печатался заново. Именно это
   * пользователь и увидел на живом посте: три-четыре полных стирания подряд.
   *
   * Отличать «удаление не применилось» от «применилось, но я не дождался»
   * можно только по факту изменения содержимого.
   *
   * @returns {Promise<boolean>} применилось ли удаление
   */
  async function backspaceConfirmed(el) {
    const before = readRaw(el);
    if (!before) return false;

    await backspace(el);
    for (let k = 0; k < 12; k++) {
      await sleep(uniform(22, 45));
      if (readRaw(el) !== before) return true;
    }
    return false;
  }

  function neighborOf(ch) {
    const rows = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    const lower = ch.toLowerCase();
    for (const row of rows) {
      const idx = row.indexOf(lower);
      if (idx < 0) continue;
      const opts = [row[idx - 1], row[idx + 1]].filter(Boolean);
      if (!opts.length) continue;
      const rep = pick(opts);
      return ch === ch.toUpperCase() && ch !== lower ? rep.toUpperCase() : rep;
    }
    return null;
  }

  function placeCaretAtEnd(el) {
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.selectionStart = el.selectionEnd = el.value.length;
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* поле могло исчезнуть */ }
  }

  /** Пауза «перечитал перед отправкой». Растёт с длиной текста. */
  async function reviewPause(text, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const base = uniform(...cfg.reviewMs);
    const perChar = String(text || '').length * uniform(4, 11);
    await sleep(clamp(base + perChar, 700, 9000));
  }

  /** Прочитать текущее содержимое поля — для проверки, что набор дошёл. */
  function readValue(el) {
    return readRaw(el).trim();
  }

  /**
   * То же, но без обрезки краёв.
   *
   * Для сравнения с целью обрезка недопустима: поле «проверяем » с хвостовым
   * пробелом после trim даёт длину на единицу меньше, коррекция возобновляет
   * набор с того же пробела и печатает его повторно. Получается двойной
   * пробел — расхождение мелкое, но текст уже не тот, который проверяли
   * фильтры безопасности.
   */
  function readRaw(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return (el.innerText || el.textContent || '')
      .replace(/[​﻿]/g, '')
      .replace(/ /g, ' ')
      .replace(/\n+$/, '');
  }

  /** Полностью очистить поле. */
  async function clear(el) {
    el.focus();
    try {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } catch { /* дальше вручную */ }
    if (readValue(el)) {
      const n = readValue(el).length;
      for (let i = 0; i < n + 5 && readValue(el); i++) {
        await backspace(el);
        await sleep(uniform(12, 40));
      }
    }
  }

  TA.typing = {
    type, reviewPause, readValue, readRaw, clear,
    insertChar, backspace, meanCharMs, DEFAULTS,
  };
})();

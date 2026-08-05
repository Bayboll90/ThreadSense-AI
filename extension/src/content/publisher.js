/**
 * Публикация собственного поста.
 *
 * Отдельный модуль, а не ветка в `composer.js`, по существенной причине: ответ
 * и пост различаются не только кнопкой. У ответа есть цель — карточка, к
 * которой всё привязано: по ней проверяется контекст, в ней ищется поле,
 * по ней же понятно, что публикация удалась. У поста цели нет вовсе. Проверять
 * приходится по другим признакам, и попытка втиснуть это в общий код дала бы
 * функцию с двумя несовместимыми режимами.
 *
 * Что здесь важно и чего нет в ответах:
 *
 *  - **Черновики Threads.** Композер помнит незаконченный текст. Если открыть
 *    его и увидеть чужой черновик, дописывать в него нельзя — опубликуется
 *    смесь. Поле чистится до набора всегда.
 *  - **Проверка публикации.** У ответа есть ветка, в которой он должен
 *    появиться. У поста — только собственный профиль, и проверять приходится
 *    там же, где публиковали: композер обязан закрыться, а текст обязан
 *    пропасть из поля.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.publisher) return;

  const { log, warn, sleep, waitFor } = TA.util;
  const { uniform, chance } = TA.rng;

  const HOME = 'https://www.threads.com/';

  /** Коды отказа, понятные фону. Совпадают по смыслу с общими кодами пропуска. */
  const FAIL = {
    NOT_HOME: 'not_home',
    NO_ENTRY: 'no_compose_entry',
    NO_EDITOR: 'no_editor',
    TYPE_MISMATCH: 'type_mismatch',
    NO_SUBMIT: 'no_submit',
    NOT_CONFIRMED: 'not_confirmed',
    BLOCKED: 'blocked',
  };

  const fail = (error, code) => ({ ok: false, error, code });

  /**
   * Открыть композер.
   *
   * Возвращает поле ввода. Никаких предположений о том, откроется модалка или
   * поле развернётся прямо в ленте: и то и другое встречается, а дальше код
   * работает с полем, а не с окном.
   */
  async function openComposer() {
    const before = TA.composer.baseline();

    const entry = TA.sel.findComposeEntry();
    if (!entry.el) return { el: null, code: FAIL.NO_ENTRY };

    log(`композер: открываем через ${entry.how}`);
    await TA.mouse.click(entry.el, { scroll: true });

    /*
     * Ждём именно появившееся поле, а не любое.
     *
     * На странице уже могут быть поля ввода — поиск, например. Базовый снимок
     * до клика отсекает их: интересует то, чего раньше не было.
     */
    const el = await waitFor(() => {
      const fresh = TA.composer.newEditors(before);
      return fresh[0] || null;
    }, { timeout: 9000, interval: 200 });

    if (!el) return { el: null, code: FAIL.NO_EDITOR };
    return { el, code: null };
  }

  /**
   * Дождаться подтверждения публикации.
   *
   * Признак — исчезновение композера вместе с текстом. Слабее, чем поиск
   * ответа в ветке, но для поста другого нет: собственная лента обновляется с
   * задержкой, и требовать появления поста там значило бы ложно браковать
   * успешные публикации.
   *
   * Отдельно проверяется, что текст не остался в поле: композер, закрывшийся
   * с сохранением черновика, выглядит так же, как успешный.
   */
  async function waitPublished(editor, text, { timeout = 15000 } = {}) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const alert = TA.guard.scan();
      if (alert) return { ok: false, alert };

      const gone = !editor.isConnected || !TA.util.isVisible(editor);
      if (gone) {
        // Композер мог закрыться, а модалка — остаться с вопросом о черновике.
        const dlg = TA.sel.findDialog();
        if (!dlg) return { ok: true, how: 'композер закрылся' };
      }

      const now = TA.typing.readValue(editor);
      if (editor.isConnected && !now && text) {
        return { ok: true, how: 'поле опустело' };
      }

      await sleep(400);
    }

    return { ok: false, timeout: true };
  }

  /**
   * Добавить в форму ещё одно сообщение ветки.
   *
   * Возвращает новое поле. Threads собирает многочастную ветку прямо в форме и
   * публикует её одной кнопкой — это и надёжнее, чем публиковать первую часть,
   * искать её в профиле и отвечать самому себе, и ближе к тому, как это делает
   * человек: он тоже пишет всю ветку сразу.
   */
  async function addPart(known) {
    const btn = TA.sel.findAddToThread();
    if (!btn) return null;

    await TA.mouse.click(btn, { scroll: false });

    // Ждём именно новое поле: в форме их уже несколько, и «нашлось поле» само
    // по себе ничего не значит.
    return waitFor(() => {
      const all = TA.composer.visibleEditors();
      return all.find((e) => !known.includes(e)) || null;
    }, { timeout: 6000, interval: 200 });
  }

  /**
   * Прикрепить картинку к посту.
   *
   * Два пути, и оба нужны.
   *
   * **Поле выбора файла.** У формы Threads есть скрытый `input[type=file]` —
   * его использует кнопка «прикрепить». Подставить туда файл через
   * `DataTransfer` и сообщить об изменении — самый прямой способ: это ровно то,
   * что происходит, когда человек выбирает картинку в диалоге, и дальше
   * страница ведёт себя обычным образом.
   *
   * **Вставка из буфера.** Если поля не нашлось (Threads меняет разметку чаще,
   * чем хотелось бы), картинка отправляется в редактор событием вставки —
   * так же, как если бы её вставили из буфера обмена. Lexical это понимает.
   *
   * Неудача не срывает публикацию: пост без картинки — это пост, а брошенная
   * форма — потерянный слот. Тот же принцип, что у темы Threads.
   *
   * @returns {Promise<{ok: boolean, how?: string, why?: string}>}
   */
  async function attachImage(dataUrl, editor) {
    if (!dataUrl) return { ok: false, why: 'картинки нет' };

    let file;
    try {
      file = await dataUrlToFile(dataUrl, `card-${Date.now()}.jpg`);
    } catch (e) {
      return { ok: false, why: `не собрался файл: ${e.message}` };
    }

    const before = countAttachments();

    /* 1. Скрытое поле выбора файла. */
    const input = findFileInput();
    if (input) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));

        const ok = await waitFor(() => countAttachments() > before, { timeout: 8000, interval: 250 });
        if (ok) return { ok: true, how: 'через поле выбора файла' };
      } catch { /* пробуем второй путь */ }
    }

    /* 2. Вставка в редактор. */
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = editor?.isConnected ? editor : TA.composer.visibleEditors()[0];
      if (!target) return { ok: false, why: 'некуда вставлять' };

      target.focus();
      target.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));

      const ok = await waitFor(() => countAttachments() > before, { timeout: 8000, interval: 250 });
      if (ok) return { ok: true, how: 'вставкой в редактор' };
    } catch (e) {
      return { ok: false, why: `вставка не прошла: ${e.message}` };
    }

    return { ok: false, why: 'превью не появилось' };
  }

  /** Сколько картинок уже висит в форме: по ним видно, приложилась ли наша. */
  function countAttachments() {
    const dlg = TA.sel.findDialog() || document;
    return dlg.querySelectorAll('img[src^="blob:"], img[src^="data:"], video[src^="blob:"]').length;
  }

  /** Скрытое поле выбора файла внутри открытой формы. */
  function findFileInput() {
    const dlg = TA.sel.findDialog() || document;
    const inputs = [...dlg.querySelectorAll('input[type="file"]')];
    return inputs.find((i) => !i.disabled && /image|\*/.test(i.accept || '*')) || inputs[0] || null;
  }

  /** `data:` в объект File — без сети и без обращения к диску. */
  async function dataUrlToFile(dataUrl, name) {
    const [head, b64] = String(dataUrl).split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  /**
   * Поставить посту тему.
   *
   * Тема в Threads — не хэштег. Это отдельное поле рядом с именем автора
   * (`example_user > Topic`) с автодополнением; выбранная тема становится
   * ссылкой на ленту, которую можно листать. Для аккаунта, которого ещё никто
   * не читает, это вторая поверхность раздачи после ленты подписок — и до
   * 01.08 агент ею не пользовался просто потому, что публикатор печатал только
   * текст поста.
   *
   * **Ничего не ломает при неудаче.** Тема — приятная добавка, а не часть
   * публикации: не нашли поле, не открылось автодополнение, не совпало ни
   * одного варианта — публикуем без темы и пишем об этом в журнал. Обратный
   * порядок (бросить готовый пост из-за темы) означал бы менять сделанную
   * работу на украшение.
   *
   * **Берём только предложенное.** Тема, набранная руками и не существующая в
   * Threads, открывает пустую ленту: пользы ноль, а выглядит как выдумка.
   * Поэтому текст набирается, а дальше выбирается вариант из подсказки — с
   * предпочтением точному совпадению.
   *
   * @returns {Promise<{ok: boolean, topic?: string, why?: string}>}
   */
  async function setTopic(wanted) {
    const want = String(wanted || '').trim();
    if (!want) return { ok: false, why: 'тема не задана' };

    const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

    const dlg = TA.sel.findDialog();
    const found = TA.sel.findTopicInput(dlg);
    if (!found.el) return { ok: false, why: 'поле темы не найдено' };

    log(`тема: поле найдено (${found.how}), пробуем «${want}»`);

    await TA.mouse.click(found.el, { scroll: false, settle: false });
    await sleep(uniform(200, 600));

    try {
      await TA.typing.type(found.el, want, {
        wpm: 150, thinkChance: 0, typoChance: 0,
        preTypeMs: [80, 220], reviewMs: [0, 0],
      });
    } catch (e) {
      return { ok: false, why: `набор темы: ${e.message}` };
    }

    // Автодополнению нужно время на запрос; список появляется не мгновенно.
    const options = await waitFor(() => {
      const list = TA.sel.topicOptions(dlg || document, want);
      return list.length ? list : null;
    }, { timeout: 5000, interval: 250 });

    if (!options) {
      /*
       * Вариантов нет — но текст в поле остался, и Threads принимает его при
       * отправке: первые два боевых поста вышли с темой именно так, хотя код
       * счёл попытку неудачной.
       *
       * Поэтому здесь не отказ, а признание с оговоркой: тема, скорее всего,
       * встанет, но подтвердить выбором из списка мы её не смогли. Отличать
       * это от подтверждённого выбора важно — по журналу видно, работает
       * распознавание подсказок или нет.
       */
      const left = TA.typing.readValue(found.el) || found.el.value || '';
      if (norm(left).startsWith(norm(want))) {
        return { ok: true, topic: want, exact: false, unconfirmed: true };
      }
      return { ok: false, why: 'автодополнение не предложило вариантов, текст в поле не удержался' };
    }

    const exact = options.find((o) => norm(TA.util.textOf(o)) === norm(want));
    const pick = exact || options[0];
    const picked = TA.util.textOf(pick).trim();

    await TA.mouse.click(pick, { scroll: false });
    await sleep(uniform(300, 800));

    return { ok: true, topic: picked, exact: !!exact };
  }

  /**
   * Опубликовать пост или многочастную ветку.
   *
   * @param {object} opts { text, parts, exact, typing, topic }
   *   `parts` — массив сообщений ветки; `text` — то же самое для одной части.
   *   `exact` — по флагу на часть: в ней важен каждый знак (команда установки).
   *   `topic` — тема Threads; необязательна, неудача её не срывает публикацию.
   */
  async function publish(opts) {
    const parts = (opts.parts && opts.parts.length ? opts.parts : [opts.text])
      .map((t) => String(t || '').trim())
      .filter(Boolean);

    const { typing = {} } = opts;

    /*
     * Часть, где важен каждый знак, набирается без промахов по клавише.
     *
     * Чинить опечатку после набора можно, но незачем: промах в команде — это
     * не живость, а неработающая команда. Поле темы так набирают с самого
     * начала (`typoChance: 0`), а сообщение с командой почему-то нет.
     */
    const exactAt = (i) => !!(opts.exact && opts.exact[i]);
    const typingFor = (i) => (exactAt(i) ? { ...typing, typoChance: 0 } : typing);
    const text = parts[0];
    if (!parts.length) return fail('пустой текст', FAIL.TYPE_MISMATCH);

    // Пост пишется с главной. На странице чужой ветки композер тоже есть, но
    // там он создаёт ответ, а не запись в профиль.
    if (!/^https:\/\/(www\.)?threads\.(com|net)\/?($|\?)/.test(location.href)) {
      return fail('не на главной странице', FAIL.NOT_HOME);
    }

    const alertBefore = TA.guard.scan();
    if (alertBefore) return { ok: false, error: `сторож: ${alertBefore.kind}`, alert: alertBefore };

    /* 1. Открыть композер. */
    const opened = await openComposer();
    if (!opened.el) {
      await TA.composer.closeDialogIfAny();
      return fail('композер не открылся', opened.code);
    }

    let editor = opened.el;
    await sleep(uniform(400, 1100));

    /* 2. Прибрать чужой черновик. */
    if (TA.typing.readValue(editor)) {
      log('в композере остался черновик, чистим');
      await TA.typing.clear(editor);
      await sleep(uniform(200, 600));
    }

    /* 3. Фокус приходит от клика, а не от .focus(). */
    await TA.mouse.click(editor, { scroll: false, settle: false });
    await sleep(uniform(200, 700));

    /* 4. Набор с переподхватом поля при перерисовке. */
    let live = editor;
    let typed;
    try {
      typed = await TA.typing.type(editor, text, {
        ...typingFor(0),
        onProgress: () => {
          if (TA.guard.scan()) return false;
          if (live.isConnected && TA.util.isVisible(live)) return true;

          // Поле пересобрали — ищем замену там же, где работали.
          const dlg = TA.sel.findDialog();
          const fresh = (dlg ? TA.composer.visibleEditors(dlg) : TA.composer.visibleEditors())[0];
          if (fresh) { live = fresh; return fresh; }
          return false;
        },
      });
    } catch (e) {
      await TA.composer.cleanupComposer(live);
      return fail(`сбой набора: ${e.message}`, FAIL.TYPE_MISMATCH);
    }

    if (typed.editor) live = typed.editor;

    if (!typed.ok) {
      await TA.composer.cleanupComposer(live);
      return fail(typed.reason || 'набор прерван', FAIL.TYPE_MISMATCH);
    }

    /* 5. Текст обязан совпасть: публикуем ровно то, что прошло фильтры. */
    const check = await TA.composer.verifyTyped(live, text, { exact: exactAt(0) });
    if (!check.ok) {
      warn('текст поста не совпал:', check.level, check.got);
      await TA.composer.cleanupComposer(live);
      return fail(`текст не попал в поле (${check.level})`, FAIL.TYPE_MISMATCH);
    }

    /*
     * 5б. Тема.
     *
     * Ставится после того, как основной текст набран и сверен: если что-то
     * пойдёт не так с полем темы, у нас уже есть готовый пост, который можно
     * опубликовать как есть. Обратный порядок означал бы риск потерять работу
     * ради украшения.
     *
     * Для многочастной ветки тема ставится один раз — она у ветки общая.
     */
    /*
     * 5в. Картинка.
     *
     * После текста и до остальных частей ветки: картинка принадлежит первому
     * сообщению — именно оно показывается в ленте. Неудача пишется в журнал и
     * ничего не отменяет.
     */
    let imageSet = null;
    if (opts.image) {
      try {
        imageSet = await attachImage(opts.image, live);
        if (imageSet.ok) log(`картинка прикреплена ${imageSet.how}`);
        else warn(`картинка не прикрепилась: ${imageSet.why}`);
      } catch (e) {
        warn(`картинка не прикрепилась: ${e.message}`);
        imageSet = { ok: false, why: e.message };
      }
    }

    let topicSet = null;
    if (opts.topic) {
      try {
        topicSet = await setTopic(opts.topic);
        if (topicSet.ok) log(`тема поставлена: «${topicSet.topic}»`);
        else warn(`тема не поставлена: ${topicSet.why}`);
      } catch (e) {
        warn(`тема не поставлена: ${e.message}`);
        topicSet = { ok: false, why: e.message };
      }
    }

    /*
     * 5а. Остальные части ветки.
     *
     * Каждая добавляется той же кнопкой и набирается так же посимвольно.
     * Между частями пауза заметно больше межсимвольной: человек, дописав
     * мысль, задумывается над следующей, а не продолжает в том же ритме.
     *
     * Неудача на части N не отменяет уже набранного: публикуем то, что вышло.
     * Ветка из двух сообщений вместо четырёх — это неполный результат, а
     * брошенная форма — потерянный целиком.
     */
    const written = [live];
    for (let i = 1; i < parts.length; i++) {
      await sleep(uniform(1200, 3200));

      const next = await addPart(TA.composer.visibleEditors());
      if (!next) { warn(`часть ${i + 1}: не удалось добавить поле, публикуем что есть`); break; }

      await TA.mouse.click(next, { scroll: false, settle: false });
      await sleep(uniform(200, 600));

      let partTyped;
      try {
        partTyped = await TA.typing.type(next, parts[i], {
          ...typingFor(i),
          onProgress: () => (TA.guard.scan() ? false : true),
        });
      } catch (e) {
        warn(`часть ${i + 1}: сбой набора (${e.message}), публикуем что есть`);
        break;
      }

      const el = partTyped.editor || next;
      const okPart = partTyped.ok
        && (await TA.composer.verifyTyped(el, parts[i], { exact: exactAt(i) })).ok;
      if (!okPart) {
        warn(`часть ${i + 1}: текст не совпал, убираем её и публикуем что есть`);
        await TA.typing.clear(el);
        break;
      }
      written.push(el);
    }

    if (written.length > 1) log(`ветка собрана: ${written.length} сообщ.`);

    /* 6. Перечитать перед отправкой. */
    await TA.typing.reviewPause(parts.join(' '), typing);

    const alertMid = TA.guard.scan();
    if (alertMid) {
      await TA.composer.cleanupComposer(live);
      return { ok: false, error: `сторож: ${alertMid.kind}`, alert: alertMid };
    }

    /* 7. Отправка. */
    const submit = TA.buttons.findSubmit(live) || wrap(TA.sel.findPostButton());
    if (!submit?.el) {
      await TA.composer.cleanupComposer(live);
      return fail('кнопка публикации не найдена', FAIL.NO_SUBMIT);
    }

    await TA.mouse.click(submit.el, { scroll: false });

    /* 8. Подтверждение. */
    const res = await waitPublished(live, text);
    if (res.alert) {
      return { ok: false, error: `сторож: ${res.alert.kind}`, alert: res.alert };
    }
    if (!res.ok) {
      await TA.composer.cleanupComposer(live);
      return fail('публикация не подтвердилась', FAIL.NOT_CONFIRMED);
    }

    log(`опубликовано (${res.how}), сообщений ${written.length}, `
      + `набор ${Math.round(typed.ms / 1000)} с`);

    // Иногда человек после публикации сразу листает ленту.
    if (chance(0.5)) {
      await sleep(uniform(800, 2400));
      try {
        await TA.scroll.by(uniform(300, 900));
      } catch { /* прокрутка не должна валить состоявшуюся публикацию */ }
    }

    return {
      ok: true,
      typedMs: typed.ms,
      typos: typed.typos,
      how: res.how,
      /* Что вышло с темой — отдельно от успеха публикации: пост мог выйти
         прекрасно и без неё, и в журнале это должно быть видно раздельно. */
      topic: topicSet?.ok ? topicSet.topic : null,
      topicWhy: topicSet && !topicSet.ok ? topicSet.why : null,
      image: !!imageSet?.ok,
      imageWhy: imageSet && !imageSet.ok ? imageSet.why : null,
      /* Тема набрана, но не выбрана из подсказки: скорее всего встанет, а
         подтвердить нечем. Различать это важно — по журналу видно, работает
         распознавание списка подсказок или мы каждый раз идём запасным путём. */
      topicUnconfirmed: !!topicSet?.unconfirmed,
      // Сколько частей реально ушло: при сбое на середине их меньше задуманного,
      // и фон должен запомнить опубликованное, а не запланированное.
      parts: written.length,
    };
  }

  const wrap = (el) => (el ? { el, score: 0, why: 'запасной поиск' } : null);

  TA.publisher = { publish, openComposer, addPart, setTopic, attachImage, waitPublished, HOME, FAIL };
})();

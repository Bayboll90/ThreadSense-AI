/**
 * Публикация ответа.
 *
 * Самая ответственная часть: здесь агент впервые что-то меняет на платформе,
 * и здесь же он рискует нарваться на ограничение. Поэтому шагов больше, чем
 * кажется необходимым, и каждый проверяется.
 *
 * Три идеи определяют устройство этого модуля.
 *
 * Первая — печатать только в то поле, которое появилось после нашего клика.
 * До клика запоминается множество уже открытых редакторов; дальше работа идёт
 * исключительно с новым. Без этого агент способен дописать текст в композер,
 * открытый пользователем, и опубликовать его от чужого имени в чужой ветке.
 *
 * Вторая — ждать событий, а не времени. MutationObserver реагирует на реальное
 * изменение разметки, тогда как опрос по таймеру либо тратит секунды впустую,
 * либо просыпается слишком поздно.
 *
 * Третья — у клика по «Ответить» пять разных исходов, и четыре из них не
 * «ошибка», а состояния, из которых нужно уметь выйти. Threads может увести на
 * страницу ветки, открыть диалог без поля, проигнорировать клик или показать
 * предупреждение. Каждый случай разбирается отдельно, иначе агент оставляет за
 * собой открытые окна и недописанные черновики.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.composer) return;
  const { sleep, isVisible, waitFor, textOf, log, warn } = TA.util;
  const { uniform, chance } = TA.rng;
  const SKIP = {
    NO_REPLY_BUTTON: 'no_reply_button',
    NO_EDITOR: 'no_editor',
    TYPE_MISMATCH: 'type_mismatch',
    SUBMIT_FAILED: 'submit_failed',
    CONTEXT_LOST: 'context_lost',
  };

  /* ------------------------------------------------------------------ *
   * Отслеживание редакторов
   * ------------------------------------------------------------------ */

  /** Все видимые поля ввода на странице. */
  function visibleEditors() {
    const out = new Set();
    for (const s of TA.sel.EDITOR_STRATEGIES) {
      try {
        for (const el of s.run() || []) if (isVisible(el)) out.add(el);
      } catch { /* следующая стратегия */ }
    }
    return [...out];
  }

  /** Снимок «что было открыто до нашего клика». */
  function baseline() {
    return new Set(visibleEditors());
  }

  /** Поля, появившиеся после снимка. */
  function newEditors(before) {
    return visibleEditors().filter((el) => !before.has(el));
  }

  /* ------------------------------------------------------------------ *
   * Ожидание через наблюдателя
   * ------------------------------------------------------------------ */

  /**
   * Дождаться результата клика по «Ответить».
   *
   * Наблюдатель следит за появлением узлов и сменой атрибутов, определяющих
   * модальность и редактируемость. Проверка запускается по факту изменения, а
   * не по таймеру — так реакция приходит в момент отрисовки поля, а не через
   * фиксированный интервал после.
   *
   * @returns {Promise<{status: string, editor?: Element, alert?: object}>}
   */
  function waitReplyOutcome(before, { timeout = 9000, urlAtStart = location.href } = {}) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let timer = null;
      let poll = null;

      const finish = (result) => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve(result);
      };

      const check = () => {
        if (done) return;

        const alert = TA.guard.scan();
        if (alert) return finish({ status: 'platform_restricted', alert });

        const fresh = newEditors(before);
        if (fresh.length) {
          const editor = TA.buttons.pickEditor(fresh);
          if (editor) return finish({ status: 'editor_opened', editor });
        }

        // Threads увёл на страницу ветки, поля при этом нет.
        // Это единственный ранний вывод: адрес сменился, ждать больше нечего.
        if (!samePage(location.href, urlAtStart) && !TA.sel.findDialog()) {
          return finish({ status: 'url_changed_no_editor' });
        }
      };

      /*
       * Отсутствие поля — вывод по таймауту, а не по короткой паузе.
       *
       * Раньше «диалог без поля ввода» объявлялся уже через две с половиной
       * секунды после появления модалки. Threads монтирует редактор дольше:
       * сначала открывается окно, и лишь потом внутри поднимается Lexical.
       * Ранний вердикт обрывал совершенно нормальное открытие и отправлял
       * агента чистить композер, которым он так и не воспользовался.
       *
       * Различие между двумя исходами имеет смысл только в конце ожидания:
       * есть модалка — значит клик сработал, но поле не появилось; нет
       * модалки — значит клик прошёл впустую.
       */
      const onTimeout = () => {
        const dialog = TA.sel.findDialog();
        finish(dialog
          ? { status: 'dialog_opened_no_editor', dialog }
          : { status: 'click_no_effect' });
      };

      observer = new MutationObserver(debounce(check, 60));
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['role', 'aria-modal', 'contenteditable', 'aria-label', 'style', 'class'],
      });

      // Страховка: часть изменений приходит без мутаций (например, стили).
      poll = setInterval(check, 250);
      timer = setTimeout(onTimeout, timeout);

      check();
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  /**
   * Та же это страница или другая.
   *
   * Сравнение шло по `location.href` целиком, и любая правка хвоста адреса
   * читалась как уход со страницы: набор прерывался, пост бросался, оплаченная
   * генерация пропадала. За четыре дня журнала на этот отказ пришлось от 27 до
   * 33 процентов **всех выбранных целей** — то есть примерно каждая третья.
   *
   * Threads правит хвост сам и по множеству поводов: метки показа `?xmt=`,
   * якорь на карточку, служебные параметры при открытии формы ответа. Ни один
   * из них не означает, что мы больше не там, где начинали.
   *
   * Страницу определяют домен и путь. Всё, что после знака вопроса, — это про
   * то, как её показали, а не про то, какая она.
   *
   * Осторожность сохранена в другую сторону: неразбираемый адрес считается
   * другой страницей. Лучше бросить пост, чем дописать его в чужую форму.
   */
  function samePage(a, b) {
    if (a === b) return true;
    try {
      const x = new URL(a);
      const y = new URL(b);
      if (x.origin !== y.origin) return false;
      if (x.pathname.replace(/\/$/, '') !== y.pathname.replace(/\/$/, '')) return false;
      /*
       * Единственный параметр, который всё-таки называет страницу, — поисковый
       * запрос: `/search?q=ии` и `/search?q=нейросети` это разные ленты, а не
       * одна и та же по-разному помеченная. Остальной хвост игнорируем.
       */
      return x.searchParams.get('q') === y.searchParams.get('q');
    } catch {
      return false;
    }
  }

  /** Адрес для журнала: путь и хвост, без домена — он всегда один и тот же. */
  function shortUrl(u) {
    try {
      const x = new URL(u);
      return (x.pathname + x.search + x.hash).slice(0, 90) || '/';
    } catch {
      return String(u || '').slice(0, 90);
    }
  }

  /* ------------------------------------------------------------------ *
   * Восстановление после каждого исхода
   * ------------------------------------------------------------------ */

  /** Threads увёл на страницу ветки — возвращаемся назад. */
  async function recoverFromNavigation(urlAtStart) {
    log('увело на другую страницу, возвращаемся');

    const back = TA.sel.findByLabel(document, ['назад', 'back', 'закрыть', 'close']);
    if (back) {
      await TA.mouse.click(back);
      await sleep(uniform(500, 1200));
      if (samePage(location.href, urlAtStart)) return true;
    }

    try { history.back(); } catch { /* нет истории */ }
    const returned = await waitFor(() => samePage(location.href, urlAtStart), { timeout: 5000 });
    return !!returned;
  }

  /** Открылся диалог без поля ввода — закрываем аккуратно. */
  async function recoverFromEmptyDialog() {
    log('диалог без поля ввода, закрываем');
    await closeDialogIfAny();
    await sleep(uniform(300, 800));
    return !TA.sel.findDialog();
  }

  /** Клик не дал эффекта — пробуем нативный вызов как второй заход. */
  async function retryNativeClick(btn, before, urlAtStart) {
    log('клик не сработал, пробуем нативный');
    try { btn.click(); } catch { return null; }
    return waitReplyOutcome(before, { timeout: 5000, urlAtStart });
  }

  /* ------------------------------------------------------------------ *
   * Очистка композера
   * ------------------------------------------------------------------ */

  const DISCARD_LABELS = [
    'удалить', 'не сохранять', 'сбросить', 'отменить', 'выйти без сохранения',
    'discard', 'delete', 'don\'t save', 'do not save', 'leave',
    'descartar', 'descartar borrador', 'verwerfen', 'annuler',
  ];

  const CANCEL_LABELS = [
    'отмена', 'отменить', 'закрыть', 'назад',
    'cancel', 'close', 'back', 'dismiss',
    'cancelar', 'abbrechen', 'annuler', 'chiudi',
  ];

  /**
   * Закрыть композер и убрать за собой.
   *
   * Каскад из пяти шагов, от мягкого к грубому. Оставленное поле с текстом —
   * не косметическая мелочь: следующий ответ уйдёт в него вместе со старым
   * содержимым, и получится склейка двух комментариев.
   */
  async function cleanupComposer(editor) {
    const steps = [];

    // 1. Вычистить содержимое поля.
    if (editor?.isConnected) {
      try {
        await TA.typing.clear(editor);
        steps.push('очищено поле');
      } catch { /* поле могло исчезнуть */ }
    }

    // 2. Кнопка отмены композера.
    const dialog = TA.sel.findDialog();
    if (dialog) {
      const cancel = TA.sel.findByLabel(dialog, CANCEL_LABELS)
        || TA.sel.findByText(dialog, CANCEL_LABELS, { exact: true });
      if (cancel) {
        await TA.mouse.click(cancel);
        await sleep(uniform(300, 800));
        steps.push('нажата отмена');
      }
    }

    // 3. Escape — и на элемент, и на документ: обработчик может висеть где угодно.
    if (TA.sel.findDialog()) {
      for (const target of [editor, document]) {
        if (!target) continue;
        for (const type of ['keydown', 'keyup']) {
          try {
            target.dispatchEvent(new KeyboardEvent(type, {
              bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27,
            }));
          } catch { /* элемент мог исчезнуть */ }
        }
      }
      await sleep(uniform(250, 600));
      steps.push('escape');
    }

    // 4. Подтверждение сброса черновика, если Threads спросил.
    const confirmDlg = TA.sel.findDialog();
    if (confirmDlg) {
      const discard = TA.sel.findByText(confirmDlg, DISCARD_LABELS, { exact: false })
        || TA.sel.findByLabel(confirmDlg, DISCARD_LABELS);
      if (discard) {
        await TA.mouse.click(discard);
        await sleep(uniform(250, 700));
        steps.push('черновик сброшен');
      }
    }

    // 5. Проверка результата.
    const stillOpen = visibleEditors().some((e) => TA.typing.readValue(e));
    if (stillOpen) {
      warn('композер не закрылся полностью');
      steps.push('осталось открытое поле');
    }

    return { steps, clean: !stillOpen };
  }

  /** Закрыть чужие открытые редакторы перед началом работы. */
  async function cleanupStaleEditors() {
    const open = visibleEditors().filter((e) => TA.typing.readValue(e));
    if (!open.length) return false;
    log(`перед ответом закрываем ${open.length} открытых полей`);
    await cleanupComposer(open[0]);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Верификация набранного
   * ------------------------------------------------------------------ */

  /**
   * Убедиться, что текст действительно оказался в поле.
   *
   * Три уровня, от строгого к спасительному. Lexical иногда съедает часть
   * ввода при быстрой печати или перерисовке, и опубликованный огрызок хуже
   * пропущенного поста.
   */
  async function verifyTyped(editor, expected, { exact = false } = {}) {
    const want = TA.guard.normalizeForMatch(expected);

    // Уровень 1: строгое совпадение, с коротким ожиданием на дорисовку.
    for (let i = 0; i < 7; i++) {
      const got = TA.guard.normalizeForMatch(TA.typing.readValue(editor));
      if (got === want) return { ok: true, level: 'строгое' };
      await sleep(80);
    }

    /*
     * Уровень 2: мягкое сравнение — допускаем мелкие расхождения.
     *
     * Но не там, где важен каждый знак. Живой случай 04.08: в команде
     * установки `github.com` вышло `github.coom`, и ссылка перестала
     * существовать. Сообщение длиной под сотню знаков при одной лишней букве
     * даёт совпадение 98% — мягкая сверка пропустила его не задумываясь.
     *
     * Для такого текста «почти совпало» означает «не работает»: читатель
     * копирует команду целиком. Поэтому при `exact` второй уровень
     * пропускается, и любое расхождение идёт на полную замену — она умеет
     * поставить текст ровно.
     */
    const got = TA.guard.normalizeForMatch(TA.typing.readValue(editor));
    const sim = similarity(got, want);
    if (!exact && sim >= 0.92) return { ok: true, level: `мягкое (${Math.round(sim * 100)}%)` };

    /*
     * Уровень 3: одна безопасная полная замена.
     *
     * Срабатывает при любом расхождении, а не только на почти пустом поле.
     * Lexical при быстром наборе иногда теряет несколько символов — особенно
     * когда посреди слова идёт исправление опечатки бэкспейсами. Поле при
     * этом далеко не пустое, и прежнее условие «меньше трети ожидаемого» его
     * не ловило: агент честно браковал пост, хотя вставить текст одним
     * действием было тривиально.
     *
     * Мириться с расхождением нельзя: фильтры безопасности проверяли ровно
     * тот текст, который мы собирались написать, и опубликовать вместо него
     * искажённый — значит опубликовать непроверенное.
     */
    log(`в поле ${got.length} из ${want.length} символов (совпадение ${Math.round(sim * 100)}%), заменяем целиком`);

    await TA.typing.clear(editor);
    await sleep(uniform(150, 350));
    editor.focus();

    let inserted = false;
    try { inserted = document.execCommand('insertText', false, expected); } catch { inserted = false; }

    if (!inserted) {
      // Резервный путь: событие ввода вручную. Lexical его понимает.
      try {
        editor.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, composed: true,
          inputType: 'insertText', data: expected,
        }));
        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data: expected,
        }));
      } catch { /* проверим результат ниже */ }
    }

    // Замене нужно чуть больше времени: редактор перестраивает узлы целиком.
    for (let i = 0; i < 8; i++) {
      await sleep(120);
      const after = TA.guard.normalizeForMatch(TA.typing.readValue(editor));
      if (after === want) return { ok: true, level: 'полная замена' };
      if (!exact && similarity(after, want) >= 0.92) {
        return { ok: true, level: `замена, мягкое совпадение (${Math.round(similarity(after, want) * 100)}%)` };
      }
    }

    const after = TA.guard.normalizeForMatch(TA.typing.readValue(editor));
    return {
      ok: false,
      level: `замена не помогла, было ${Math.round(sim * 100)}%, стало ${Math.round(similarity(after, want) * 100)}%`,
      got: after.slice(0, 80),
    };
  }

  /**
   * Найти на странице поле с нашим же набранным текстом.
   *
   * Это самый сильный якорь из всех, что у нас были, и появился он последним —
   * после того как три предыдущих не выдержали боя. Хвост адреса, живое поле и
   * присоединённость карточки все оказались свойствами **разметки**, а Threads
   * перестраивает разметку как хочет: за 02.08 на отказ `navigated` пришлось
   * двадцать случаев из тридцати семи выбранных целей, и в каждой улике стояло
   * одно и то же — «полей 1, карточка отсоединена, диалогов 0, фокус на поле
   * ввода». То есть поле на странице было, курсор стоял в нём, а агент бросал
   * пост, потому что не мог доказать, что поле — его.
   *
   * Доказательство даёт содержимое. Мы печатаем посимвольно, и в нашем поле
   * лежит начало нашего же текста — строка, которой на странице взяться больше
   * неоткуда. Совпадение по ней означает «это наше поле» вернее любого
   * родства узлов, и оно же **запрещает** дописать текст в чужую форму: там
   * нашего текста нет.
   *
   * Порог намеренно высокий, а короткое начало не рассматривается вовсе:
   * первые несколько символов могут случайно совпасть с чужим черновиком.
   */
  const ANCHOR_MIN_CHARS = 15;
  const ANCHOR_MIN_SIM = 0.6;

  function editorWithOurText(typedSoFar) {
    const want = TA.guard.normalizeForMatch(String(typedSoFar || ''));
    if (want.length < ANCHOR_MIN_CHARS) return null;

    let best = null;
    let bestSim = 0;
    for (const e of visibleEditors()) {
      const got = TA.guard.normalizeForMatch(TA.typing.readValue(e));
      if (got.length < ANCHOR_MIN_CHARS) continue;
      /* Набранное — префикс задуманного, поэтому сравниваем с общим началом:
         поле может опережать наш счётчик или отставать от него. */
      const n = Math.min(got.length, want.length);
      const sim = similarity(got.slice(0, n), want.slice(0, n));
      if (sim > bestSim) { bestSim = sim; best = e; }
    }

    return bestSim >= ANCHOR_MIN_SIM ? { editor: best, sim: bestSim } : { editor: null, sim: bestSim };
  }

  /**
   * Разобрать, что случилось с контекстом набора.
   *
   * Раньше три разные ситуации сваливались в одну: «страница сменилась».
   * Между ними принципиальная разница.
   *
   * Перерисовка — обычное дело для React: узлы заменяются, наш элемент
   * отваливается, но эквивалентное поле существует рядом и содержит наш же
   * текст. Это восстановимо, и бросать здесь пост означает терять его на
   * ровном месте.
   *
   * Уход на другую страницу означает, что цели больше нет — продолжать
   * нельзя, иначе комментарий уйдёт не туда.
   *
   * Предупреждение платформы важнее всего остального: там нужно немедленно
   * остановиться, а не искать новое поле.
   *
   * @param {string} typedSoFar  что к этому моменту должно лежать в поле —
   *                             единственный якорь, переживающий перерисовку
   * @returns {{state: 'ok'|'rerendered'|'navigated'|'closed'|'blocked',
   *            editor?: Element, alert?: object}}
   */
  function contextState(editor, urlAtStart, card = null, typedSoFar = '') {
    const alert = TA.guard.scan();
    if (alert) return { state: 'blocked', alert };

    /*
     * Живое поле важнее адреса, и это выяснилось дорого.
     *
     * Раньше первым стоял адрес, и любое его изменение обрывало набор. За
     * четыре дня журнала на отказ `navigated` пришлось от 27 до 33 процентов
     * **всех выбранных целей** — каждая третья, причём после того, как модель
     * уже отработала и текст прошёл фильтры.
     *
     * Улика, добавленная в вердикт, показала настоящую причину с первого же
     * случая:
     *
     *   /@sample_author/post/ExampleOld01 → /@sample_author/post/ExampleNew01
     *
     * Второй адрес — вторая часть той же ветки того же автора; обе страницы
     * показывают один и тот же корень. Threads переписывает адрес на часть,
     * попавшую в фокус, а многочастные ветки в этой нише пишет каждый второй.
     * Никакого ухода со страницы при этом не происходит: диалог открыт, поле
     * то же самое, текст на месте.
     *
     * Отсюда порядок. Настоящий переход уничтожает узел поля — значит живое
     * присоединённое поле само по себе доказывает, что контекст цел, и никакой
     * адрес этого не опровергает. Это тот же принцип, что уже трижды спасал
     * набор: спрашивать объект, а не свою модель о нём.
     *
     * Предупреждение платформы проверяется раньше и остаётся выше всего.
     */
    if (editor?.isConnected && isVisible(editor)) return { state: 'ok', editor };

    if (!samePage(location.href, urlAtStart)) {
      /*
       * Здесь поля уже нет, и сменился адрес. Это ещё не значит, что мы ушли
       * со страницы.
       *
       * Первая правка опиралась на живое поле и не помогла: за час после
       * выката отказ повторился пять раз, и улика показала почему. Threads
       * перерисовывает страницу многочастной ветки целиком — вместе с полем, —
       * и одновременно переписывает адрес на ту часть, что оказалась в фокусе.
       * Поле умирает, адрес меняется, а страница всё та же:
       *
     *   /@sample_author/post/ExampleOld02 → /@sample_author/post/ExampleNew02
       *
       * Значит нужен якорь, который переживает перерисовку и не переживает
       * настоящий переход. Такой якорь есть — **карточка, к которой мы
       * привязались в начале**. При переходе React размонтирует страницу, и
       * карточка отваливается от документа; при перерисовке ветки она остаётся.
       *
       * Замена поля при этом ищется, как и прежде, строго внутри своей
       * карточки или открытого диалога: даже ошибившись с диагнозом, мы не
       * можем дописать текст в чужую форму.
       */
      const alive = card?.isConnected && isVisible(card);
      const dialog = TA.sel.findDialog();

      /*
       * Прежде чем объявлять уход, спрашиваем содержимое полей. Наш текст на
       * странице означает, что страница наша, каким бы ни стал адрес.
       */
      const anchored = editorWithOurText(typedSoFar);
      if (anchored?.editor) return { state: 'rerendered', editor: anchored.editor, byText: true };

      if (!alive && !dialog) {
        /*
         * Три гипотезы подряд не подтвердились: ни хвост адреса, ни живое
         * поле, ни присоединённость карточки не объяснили этот отказ — он
         * повторился на каждой правке. Значит гадать дальше нельзя, надо
         * смотреть на страницу в момент вердикта.
         *
         * Снимок дешёвый и отвечает ровно на те вопросы, которых не хватало:
         * сколько на странице полей ввода (если ноль — страница действительно
         * сменилась; если есть — мы всё ещё в форме, но потеряли свою),
         * жива ли карточка как узел вне документа (значит её размонтировали, а
         * не мы ошиблись ссылкой) и сколько карточек на странице сейчас.
         */
        /*
         * Где стоял курсор — главный оставшийся вопрос.
         *
         * Первая улика показала переход на пост **чужого** автора при
         * отсоединённой карточке. Единственный известный механизм, который так
         * умеет, — клавиатурная навигация Threads: события с поля, потерявшего
         * фокус, всплывают до документа и листают ленту. Если это так, в
         * момент вердикта активным элементом окажется не поле.
         */
        const ae = document.activeElement;
        const focus = !ae || ae === document.body
          ? 'фокуса нет'
          : `фокус на ${ae.tagName.toLowerCase()}`
            + (ae.getAttribute?.('contenteditable') ? ' (поле ввода)' : '');

        const probe = [
          `полей ${visibleEditors().length}`,
          `карточек ${document.querySelectorAll('[data-pressable-container="true"]').length}`,
          card ? (card.isConnected ? 'карточка в документе, но скрыта' : 'карточка отсоединена') : 'карточки не было',
          `диалогов ${document.querySelectorAll('[role="dialog"]').length}`,
          focus,
          /* Насколько близко подошло лучшее поле: если отказ повторится, по
             этому числу видно, наш ли текст на странице вообще есть. */
          `совпадение с набранным ${Math.round((anchored?.sim || 0) * 100)}%`,
        ].join(', ');

        return { state: 'navigated', from: urlAtStart, to: location.href, probe };
      }

      const swap = visibleEditors().filter((e) => {
        if (dialog?.contains(e)) return true;
        return alive && card.contains(e);
      })[0];

      if (swap) return { state: 'rerendered', editor: swap };

      /* Карточка жива, но поля в ней нет — форма закрылась, а не уехала. */
      return alive
        ? { state: 'closed' }
        : { state: 'navigated', from: urlAtStart, to: location.href };
    }

    // Наш элемент отвалился. Ищем замену строго в том же контексте: чужое
    // поле в другом месте страницы брать нельзя ни при каких обстоятельствах.
    const dialog = TA.sel.findDialog();
    const candidates = visibleEditors().filter((e) => {
      if (dialog) return dialog.contains(e);
      if (card?.isConnected) return card.contains(e);
      return false;
    });

    const replacement = TA.buttons.pickEditor(candidates, { card });
    if (replacement) return { state: 'rerendered', editor: replacement };

    /*
     * Тот же якорь и здесь. Адрес не менялся, но карточка могла отвалиться:
     * Threads выбрасывает из разметки всё, что ушло за пределы экрана, а
     * страница во время набора скроллится сама. Без этой проверки набор
     * обрывался как «форма закрылась», хотя форма стояла на месте.
     */
    const anchored = editorWithOurText(typedSoFar);
    if (anchored?.editor) return { state: 'rerendered', editor: anchored.editor, byText: true };

    return { state: 'closed' };
  }

  /** Совместимость: короткий ответ там, где детали не нужны. */
  function contextAlive(editor, urlAtStart) {
    return contextState(editor, urlAtStart).state === 'ok';
  }

  /** Доля совпадающих символьных триграмм. */
  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const tri = (s) => {
      const set = new Set();
      for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
      return set;
    };
    const A = tri(a);
    const B = tri(b);
    if (!A.size || !B.size) return a.includes(b) || b.includes(a) ? 1 : 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / Math.max(A.size, B.size);
  }

  /* ------------------------------------------------------------------ *
   * Главный сценарий
   * ------------------------------------------------------------------ */

  /**
   * Ответить в открытой ветке.
   *
   * @param {object} opts
   *   text          — что написать
   *   replyTo       — индекс ответа в ветке или null (тогда отвечаем посту)
   *   typing        — переопределения таймингов набора
   * @returns {Promise<{ok, verified, error?, code?, elapsedMs}>}
   */
  async function reply(opts) {
    const started = Date.now();
    const urlAtStart = location.href;
    const { text, replyTo = null, typing = {} } = opts;
    let lostReason = null;

    if (!text || !text.trim()) return fail('пустой текст');

    const pre = TA.guard.scan();
    if (pre) return { ok: false, error: `сторож: ${pre.kind}`, alert: pre };

    // Чужие открытые поля мешают отличить наше от постороннего.
    await cleanupStaleEditors();

    /* 1. Карточка, под которой отвечаем. */
    const card = replyTo != null ? TA.thread.replyCardAt(replyTo) : TA.thread.rootCard();
    if (!card) return fail('не найдена карточка для ответа', SKIP.NO_EDITOR);

    /* 2. Кнопка «Ответить». Панель действий может быть скрыта до наведения. */
    await TA.buttons.primeActions(card);
    const found = TA.buttons.findReply(card) || wrap(TA.sel.replyButton(card));
    if (!found?.el) return fail('не найдена кнопка «Ответить»', SKIP.NO_REPLY_BUTTON);
    log(`кнопка ответа найдена: ${found.why?.join(', ') || 'запасной путь'} (${Math.round(found.score || 0)})`);

    await TA.mouse.ensureInView(found.el);
    await sleep(uniform(400, 1500));  // секунда на решение

    /* 3. Клик и разбор исхода. */
    const before = baseline();
    await TA.mouse.click(found.el, { scroll: false });

    let outcome = await waitReplyOutcome(before, { urlAtStart });

    if (outcome.status === 'click_no_effect') {
      const second = await retryNativeClick(found.el, before, urlAtStart);
      if (second) outcome = second;
    }

    switch (outcome.status) {
      case 'platform_restricted':
        return { ok: false, error: `сторож: ${outcome.alert.kind}`, alert: outcome.alert };

      case 'url_changed_no_editor':
        await recoverFromNavigation(urlAtStart);
        return fail('Threads увёл на другую страницу без поля ввода', SKIP.NO_EDITOR);

      case 'dialog_opened_no_editor':
        await recoverFromEmptyDialog();
        return fail('открылся диалог без поля ввода', SKIP.NO_EDITOR);

      case 'click_no_effect':
        return fail('клик по «Ответить» не дал эффекта', SKIP.NO_EDITOR);

      case 'editor_opened':
        break;

      default:
        return fail(`неизвестный исход: ${outcome.status}`, SKIP.NO_EDITOR);
    }

    const editor = outcome.editor;

    /* 4. Фокус приходит от клика, а не от .focus(). */
    await sleep(uniform(250, 900));
    await TA.mouse.click(editor, { scroll: false, settle: false });
    await sleep(uniform(180, 600));

    if (TA.typing.readValue(editor)) await TA.typing.clear(editor);

    /*
     * 5. Набор с адаптацией к перерисовке.
     *
     * Обработчик хода отвечает за то, чтобы набор пережил замену узлов:
     * при перерисовке он возвращает новое поле, и печать продолжается в нём
     * с фактически достигнутой позиции. Остановка происходит только там, где
     * продолжать действительно нельзя — уход на другую страницу, закрытая
     * форма, предупреждение платформы.
     */
    let live = editor;
    let typed;

    try {
      typed = await TA.typing.type(editor, text, {
        ...typing,
        onProgress: (done) => {
          const st = contextState(live, urlAtStart, card, text.slice(0, done));
          switch (st.state) {
            case 'ok':
              return true;
            case 'rerendered':
              log(st.byText
                ? 'поле опознано по набранному тексту, продолжаем в нём'
                : 'поле перерисовано, переподхватываем и продолжаем');
              live = st.editor;
              return st.editor;
            default:
              /*
               * Причина записывается вместе с уликой. Голое слово «navigated»
               * не отвечает на единственный полезный вопрос — куда именно нас
               * увело, — а без ответа на него отказ, съедающий треть целей,
               * так и остаётся необъяснимым.
               */
              lostReason = st.from && st.to
                ? `${st.state}: ${shortUrl(st.from)} → ${shortUrl(st.to)}`
                  + (st.probe ? ` [${st.probe}]` : '')
                : st.state;
              return false;
          }
        },
      });
    } catch (e) {
      await cleanupComposer(live);
      return fail(`сбой набора: ${e.message}`, SKIP.TYPE_MISMATCH);
    }

    if (typed.editor) live = typed.editor;

    if (!typed.ok) {
      await cleanupComposer(live);

      /*
       * Прерванный набор бывает двух родов, и повторять можно только один.
       *
       * Потеря контекста дешева: страница перестроилась, попытка займёт
       * столько же, сколько первая. А вот упёршийся в потолок времени набор
       * повторять нельзя — вторая попытка встанет в тот же потолок, и пост
       * съест десять минут вместо трёх.
       */
      const outOfTime = typed.stalled || /время|порядок/.test(typed.reason || '');
      return fail(
        typed.reason || `набор прерван: ${lostReason || 'контекст потерян'}`,
        outOfTime ? SKIP.TYPE_TIMEOUT : SKIP.CONTEXT_LOST,
      );
    }

    if (typed.stalled) {
      warn(`набор шёл медленнее плана: ${Math.round(typed.ms / 1000)} с`);
    }

    const after = contextState(live, urlAtStart, card, text);
    if (after.state === 'blocked') {
      return { ok: false, error: `сторож: ${after.alert.kind}`, alert: after.alert };
    }
    if (after.state === 'rerendered') live = after.editor;
    else if (after.state !== 'ok') {
      await cleanupComposer(live);
      return fail(`после набора: ${after.state}`, SKIP.CONTEXT_LOST);
    }

    log(`набрано за ${Math.round(typed.ms / 1000)} с, промахов ${typed.typos}`
      + `${typed.swaps ? `, поле менялось ${typed.swaps} раз` : ''}`);

    /* 6. Верификация в три уровня. */
    const check = await verifyTyped(live, text);
    if (!check.ok) {
      warn('текст не совпал:', check.level, check.got);
      await cleanupComposer(live);
      return fail(`текст не попал в поле (${check.level})`, SKIP.TYPE_MISMATCH);
    }
    log(`текст подтверждён: ${check.level}`);

    /* 7. Перечитать перед отправкой. */
    await TA.typing.reviewPause(text, typing);

    if (chance(0.08) && live.isConnected) {
      await TA.typing.backspace(live);
      await sleep(uniform(200, 700));
      await TA.typing.insertChar(live, text.slice(-1));
      await sleep(uniform(300, 900));
    }

    /*
     * 8. Отправка.
     *
     * Перед самым кликом контекст проверяется ещё раз: пауза «перечитал»
     * длится секунды, и за это время страница успевает перерисоваться.
     * Кнопка ищется уже от актуального поля — иначе можно попасть в подвал
     * формы, которой больше нет.
     */
    const beforeSend = contextState(live, urlAtStart, card, text);
    if (beforeSend.state === 'blocked') {
      return { ok: false, error: `сторож: ${beforeSend.alert.kind}`, alert: beforeSend.alert };
    }
    if (beforeSend.state === 'rerendered') {
      live = beforeSend.editor;
      // После перерисовки текст мог не пережить замену узлов.
      const recheck = await verifyTyped(live, text);
      if (!recheck.ok) {
        await cleanupComposer(live);
        return fail(`перед отправкой текст потерялся (${recheck.level})`, SKIP.TYPE_MISMATCH);
      }
    } else if (beforeSend.state !== 'ok') {
      await cleanupComposer(live);
      return fail(`перед отправкой: ${beforeSend.state}`, SKIP.CONTEXT_LOST);
    }

    const submit = TA.buttons.findSubmit(live) || wrap(TA.sel.findPostButton());
    if (!submit?.el) {
      await cleanupComposer(live);
      return fail('не найдена кнопка «Опубликовать»', SKIP.SUBMIT_FAILED);
    }
    log(`кнопка отправки: ${submit.why?.join(', ') || 'запасной путь'} (${Math.round(submit.score || 0)})`);

    const sent = await TA.mouse.click(submit.el);
    if (!sent) {
      await cleanupComposer(live);
      return fail('клик по «Опубликовать» не прошёл', SKIP.SUBMIT_FAILED);
    }

    /* 9. Дождаться закрытия формы. */
    await waitFor(() => !live.isConnected || !isVisible(live) || !TA.typing.readValue(live),
      { timeout: 9000 });
    await sleep(uniform(900, 2600));

    /*
     * 10. Убедиться, что ответ появился.
     *
     * Времени даём с запасом. Отрицательный ответ здесь идёт в счётчик
     * теневого ограничения, а три подряд останавливают агента до ручного
     * разбора — цена ложной тревоги несопоставима с ценой лишних секунд
     * ожидания. Живой случай уже был: комментарий опубликовался, но появился
     * в ветке позже отведённых десяти секунд.
     */
    const verified = await TA.guard.verifyAfterSend(text, { timeout: opts.verifyMs ?? 25000 });
    if (verified.alert) {
      return { ok: true, verified: false, alert: verified.alert, elapsedMs: Date.now() - started };
    }
    if (verified.verified) {
      log(`ответ подтверждён за ${Math.round((verified.ms || 0) / 1000)} с`
        + `${verified.nudged ? ' (после подталкивания страницы)' : ''}`);
    }

    await closeDialogIfAny();
    await sleep(uniform(1200, 4000));
    if (chance(0.3)) await TA.scroll.by(uniform(-200, 260));

    return {
      ok: true,
      verified: verified.verified,
      /* «Не нашли» и «не смогли посмотреть» — разные вещи, и фон обязан их
         различать: второе не должно идти в счёт теневого ограничения. */
      inconclusive: !!verified.inconclusive,
      elapsedMs: Date.now() - started,
    };
  }

  const fail = (error, code) => ({ ok: false, error, code });
  const wrap = (el) => (el ? { el, score: 0, why: ['запасной селектор'] } : null);

  /**
   * Коды, при которых имеет смысл попробовать тот же пост ещё раз.
   *
   * Разница с окончательными отказами в том, что здесь пост никуда не делся
   * и мы ничего не опубликовали — помешала страница, а не содержание.
   * Повторная попытка стоит полминуты, а брошенная цель стоит целого цикла
   * поиска: скан, батч оценки релевантности, разбор ветки, генерация.
   */
  const RETRYABLE = new Set([SKIP.CONTEXT_LOST, SKIP.NO_EDITOR, SKIP.TYPE_MISMATCH]);

  /**
   * Ответить с повторными попытками при восстановимых сбоях.
   *
   * Стопроцентной надёжности здесь не бывает и быть не может: пост могут
   * удалить, платформа может показать ограничение, нас может увести на другую
   * страницу. Но перерисовка разметки и не открывшаяся с первого раза форма —
   * причины временные, и сдаваться на них не нужно.
   */
  async function replyWithRetry(opts) {
    const attempts = Math.max(1, opts.attempts ?? 3);
    const startedAt = location.href;
    let last = null;

    for (let n = 1; n <= attempts; n++) {
      const r = await reply(opts);

      if (r.ok) {
        if (n > 1) log(`ответ прошёл с ${n}-й попытки`);
        return { ...r, attempt: n };
      }

      last = r;

      // Предупреждение платформы и уход со страницы повторять нельзя.
      if (r.alert || !RETRYABLE.has(r.code)) break;
      if (n === attempts) break;

      warn(`попытка ${n} не удалась (${r.error}), пробуем снова`);

      // Даём странице устояться и убираем за собой перед новым заходом.
      await cleanupStaleEditors();
      await sleep(uniform(2000, 5000));

      /*
       * Повторять можно только там, где начинали.
       *
       * Карточка для повтора ищется по адресу текущей страницы, а если нас и
       * правда увело, то этот адрес — чужой пост. Тогда вторая попытка честно
       * найдёт «корневую карточку», нажмёт «Ответить» и опубликует наш текст
       * под чужой веткой, которую никто не выбирал и не оценивал. Цена ошибки
       * несопоставима с ценой пропущенной цели, поэтому здесь сначала
       * возвращаемся, и только вернувшись — пробуем снова.
       */
      if (!samePage(location.href, startedAt)) {
        const back = await recoverFromNavigation(startedAt);
        if (!back) {
          warn('после сбоя мы на другой странице и вернуться не вышло — повтор отменён');
          break;
        }
        await sleep(uniform(800, 2000));
      }

      // Пост мог уехать из виду, пока страница перестраивалась.
      const card = opts.replyTo != null ? TA.thread.replyCardAt(opts.replyTo) : TA.thread.rootCard();
      if (!card) {
        warn('карточка пропала со страницы, повтор невозможен');
        break;
      }
    }

    return { ...last, attempts };
  }

  /** Закрыть модалку, если она осталась открытой. */
  async function closeDialogIfAny() {
    if (!TA.sel.findDialog()) return;
    await cleanupComposer(null);
  }

  /** Лайкнуть корневой пост открытой ветки. */
  async function likeRoot() {
    const card = TA.thread.rootCard();
    if (!card) return false;
    await TA.buttons.primeActions(card);
    return TA.reading.likeCard(card);
  }

  TA.composer = {
    reply, replyWithRetry, cleanupComposer, cleanupStaleEditors, closeDialogIfAny, likeRoot,
    verifyTyped, waitReplyOutcome, visibleEditors, baseline, newEditors,
    similarity, contextAlive, contextState, textOf, RETRYABLE,
  };
})();

/**
 * Сторож.
 *
 * Следит за признаками того, что платформа заметила автоматизацию, и
 * останавливает агента раньше, чем он наберёт достаточно флагов для настоящих
 * санкций. Продолжать работу после первого «Action Blocked» — самый быстрый
 * способ превратить временное ограничение в постоянное.
 *
 * Три источника сигналов: текст в DOM (диалоги и баннеры), состояние сессии
 * (не разлогинило ли) и косвенные признаки вроде капчи. Наблюдение идёт через
 * MutationObserver, потому что предупреждения появляются модально и живут
 * несколько секунд.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.guard) return;
  const { textOf, warn } = TA.util;

  /* ------------------------- Сигнатуры сообщений --------------------------- */

  /**
   * Сигнатуры предупреждений на пяти языках.
   *
   * Список избыточен намеренно. Threads показывает предупреждение на языке
   * интерфейса, а он не обязан совпадать ни с языком постов, ни с настройками
   * расширения: аккаунт мог быть заведён с другой локалью, интерфейс мог
   * переключиться после смены региона. Непойманное предупреждение означает,
   * что агент продолжит работать под ограничением и превратит временную
   * блокировку в постоянную — это худший исход из возможных, и перестраховка
   * тут дешевле точности.
   */
  const PATTERNS = {
    action_blocked: [
      // Русский
      /действи[ея]\s+заблокирован/i,
      /мы ограничили некоторые действия/i,
      /ограничили.*как часто/i,
      /вы не можете выполнить это действие/i,
      /не можете использовать.*функц/i,
      /попробуйте (позже|снова|ещё раз позже)/i,
      /подожд(ите|ём).*попроб/i,
      /слишком много попыток/i,
      /временно (заблокирован|огранич)/i,
      /превышен лимит/i,
      /не удалось\s+(опубликовать|ответить|отправить)/i,
      /ограничен\w*\s+из-за/i,
      /автоматизир\w*\s+повед/i,
      /нарушает.*правил/i,
      // Английский
      /action blocked/i,
      /we restrict certain activity/i,
      /we limit how often/i,
      /you can'?t use this feature/i,
      /restricted function/i,
      /try again later/i,
      /please wait.*try again/i,
      /too many requests/i,
      /temporarily (blocked|restricted|unavailable)/i,
      /rate limit/i,
      /feedback required/i,
      /couldn'?t\s+(post|reply|comment|send)/i,
      /to protect (our|the) community/i,
      /against (our )?community guidelines/i,
      /activity that is against/i,
      /automated behaviou?r/i,
      // Испанский
      /acci[oó]n bloqueada/i,
      /int[eé]ntalo de nuevo m[aá]s tarde/i,
      /limitamos.*frecuencia/i,
      /temporalmente bloquead/i,
      // Португальский
      /a[cç][aã]o bloqueada/i,
      /tente novamente mais tarde/i,
      /temporariamente bloquead/i,
      // Украинский
      /ді[юї]\s+заблоковано/i,
      /спробуйте пізніше/i,
      /тимчасово заблоков/i,
    ],

    challenge: [
      /подтвердите,? что это вы/i,
      /подтвердите свою личность/i,
      /требуется проверка/i,
      /введите код/i,
      /подозрительн\w*\s+активн/i,
      /необычн\w*\s+активн/i,
      /аккаунт (временно )?(приостановлен|отключен|заблокирован навсегда)/i,
      /мы заметили.*вход/i,

      /confirm (it'?s|its) you/i,
      /*
       * Формулировка 04.08.2026 дословно. Перечень фраз догоняет язык всегда
       * с опозданием, поэтому главный якорь теперь адрес страницы (см. `scan`),
       * а эти строки остались вторым слоем — на случай, когда проверку
       * показывают поверх обычной ленты, не меняя адреса.
       */
      /confirm (you'?re|you are|that you'?re) (human|a human)/i,
      /подтвердите,? что вы (человек|не робот)/i,
      /we'?ve (suspended|disabled|restricted) your account/i,
      /your account (has been|was) (suspended|disabled)/i,
      /you submitted an appeal/i,
      /вы (отправили|подали) апелляц/i,
      /ваш аккаунт (приостановлен|отключ[её]н|заблокирован)/i,
      /verify your (identity|account|email|phone)/i,
      /security check/i,
      /enter the (confirmation |security )?code/i,
      /suspicious activity/i,
      /unusual (activity|login|sign[- ]?in)/i,
      /account (has been )?(suspended|disabled|restricted)/i,
      /we detected.*login/i,

      /actividad sospechosa/i,
      /verifica tu identidad/i,
      /atividade suspeita/i,
      /verifique sua identidade/i,
      /підозріл\w*\s+активн/i,
    ],

    captcha: [
      /captcha/i,
      /recaptcha/i,
      /hcaptcha/i,
      /я не робот/i,
      /i'?m not a robot/i,
      /подтвердите,? что вы не робот/i,
      /no soy un robot/i,
      /n[aã]o sou um rob[ôo]/i,
    ],

    logged_out: [
      /войти в threads/i,
      /^войти$/i,
      /log ?in to threads/i,
      /создать аккаунт/i,
      /sign up for threads/i,
    ],
  };

  /* --------------------- Где сторожу смотреть нельзя ----------------------- */

  /**
   * Области, куда пишем мы сами и пользователи.
   *
   * Форма ответа в Threads — тоже `role="dialog"`, и внутри неё лежат поле
   * ввода с уже набранным текстом и карточка поста, на который отвечаем. То
   * есть зона наблюдения и источник сигнала делят один контейнер.
   *
   * Живой случай 30.07.2026: агент печатал «какие сигналы у вас в revers proxy
   * сейчас реально решают: rate limit, fi…», сторож прочитал это в своём же
   * поле, совпал с `/rate limit/i` и остановил работу на сутки. Ограничения со
   * стороны платформы не было вовсе.
   *
   * Список сигнатур при этом трогать нельзя — он избыточен намеренно, и это
   * правильно. Чинить надо не «что искать», а «где искать»: у аккаунта про ИИ
   * и разработку слова про лимиты и блокировки встречаются в каждом втором
   * обсуждении, и никакая точность формулировок тут не спасёт.
   */
  const USER_CONTENT = [
    '[contenteditable]',
    '[data-lexical-editor]',
    'textarea',
    'input',
    'div[data-pressable-container="true"]',
  ].join(', ');

  /**
   * Текст элемента без пользовательского содержимого.
   *
   * Быстрый путь — когда пользовательских областей внутри нет: читаем как
   * прежде, через `innerText`, со всей его правдой о видимости. Медленный путь
   * включается только там, где внутри действительно есть поле ввода или
   * карточка поста: тогда обходим детей и вырезаем такие поддеревья целиком.
   */
  function noticeText(root) {
    if (!root || root.nodeType !== 1) return '';
    if (root.matches?.(USER_CONTENT)) return '';
    if (!root.querySelector?.(USER_CONTENT)) return textOf(root);

    let out = '';
    for (const node of root.childNodes) {
      if (node.nodeType === 3) out += ` ${node.nodeValue}`;
      else if (node.nodeType === 1) out += ` ${noticeText(node)}`;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  /** Проверить строку по всем сигнатурам. */
  function classify(text) {
    const t = String(text || '').slice(0, 3000);
    if (!t) return null;
    for (const [kind, list] of Object.entries(PATTERNS)) {
      // Разлогин определяем отдельно: одно слово «Войти» есть и в обычном меню.
      if (kind === 'logged_out') continue;
      if (list.some((re) => re.test(t))) return { kind, detail: excerpt(t, list) };
    }
    return null;
  }

  function excerpt(text, patterns) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const i = Math.max(0, m.index - 60);
        return text.slice(i, i + 220).replace(/\s+/g, ' ').trim();
      }
    }
    return text.slice(0, 160);
  }

  /* ----------------------------- Проверки --------------------------------- */

  /**
   * Где Threads показывает предупреждения. Тосты добавлены отдельно: короткая
   * плашка внизу экрана живёт несколько секунд и в role="dialog" не попадает.
   */
  const NOTICE_SELECTORS = [
    '[role="dialog"]', '[role="alertdialog"]', '[role="alert"]',
    '[role="status"]', '[aria-live="polite"]', '[aria-live="assertive"]',
    '[data-testid*="toast" i]', '[data-visualcompletion="ignore-dynamic"]',
  ].join(', ');

  /** Разовая проверка всей страницы. Возвращает сигнал или null. */
  function scan() {
    /*
     * 0. Адрес страницы. Проверяется раньше любого текста.
     *
     * Threads уводит заблокированный аккаунт на отдельную страницу, и это
     * решение платформы, а не надпись в баннере: `/accounts/suspended`,
     * `/challenge`, `/checkpoint`. Никакая перестановка слов в интерфейсе на
     * адрес не влияет, тогда как перечень фраз 04.08.2026 разошёлся с
     * действительностью ровно на одно слово — `confirm you're human` против
     * заготовленного `confirm it's you` — и агент сорок минут считал, что
     * просто «проверяет сессию».
     */
    if (TA.sel.pageKind() === 'blocked') {
      const said = textOf(document.body).replace(/\s+/g, ' ').trim().slice(0, 200);
      return {
        kind: 'challenge',
        detail: `страница ${location.pathname}${said ? ` · ${said}` : ''}`,
      };
    }

    // 1. Все места, где может всплыть предупреждение. Ограничиваем обход:
    // на тяжёлой странице узлов бывает много, а проверка идёт часто.
    const notices = document.querySelectorAll(NOTICE_SELECTORS);
    let checked = 0;
    for (const el of notices) {
      if (++checked > 40) break;
      const hit = classify(noticeText(el));
      if (hit) return hit;
    }

    // 3. Капча в iframe.
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[title*="captcha" i]')) {
      return { kind: 'captcha', detail: 'обнаружен фрейм капчи' };
    }

    // 4. Страница-заглушка целиком: текста мало и он про блокировку.
    // Если на странице есть лента или открытая форма — это не заглушка, и
    // проверять нечего: текста там заведомо много, а разбор всего документа
    // ради этого стоит дороже самой проверки.
    if (!document.querySelector(USER_CONTENT)) {
      const bodyText = textOf(document.body).slice(0, 1200);
      if (bodyText.length < 1200) {
        const hit = classify(bodyText);
        if (hit) return hit;
      }
    }

    // 5. Разлогин. Проверяется последним: он дороже остальных проверок
    // и не должен перебивать более конкретные сигналы.
    const s = loginState();
    if (!s.loggedIn && s.confidence === 'high') {
      return {
        kind: 'logged_out',
        detail: `сессия Threads не активна (${Object.entries(s.signals)
          .filter(([, v]) => v).map(([k]) => k).join(', ') || 'нет личных разделов'})`,
      };
    }

    return null;
  }

  /**
   * Состояние сессии.
   *
   * Проверять «есть ли посты на странице» бесполезно: Threads показывает
   * публичную ленту и гостям, и она ничем не отличается от рабочей — те же
   * карточки, те же кнопки. Отличаются только личные разделы: вкладка
   * активности и кнопка создания поста есть лишь у вошедшего, а приглашение
   * войти и зарегистрироваться — только у гостя.
   *
   * Цена ошибки высокая: на гостевой ленте агент отбирал бы посты, тратил
   * токены на генерацию, а на публикации получал форму входа. Верификация
   * не находила бы ответ в ветке и через три попытки объявляла теневой бан.
   *
   * @returns {{loggedIn: boolean, confidence: 'high'|'low', signals: object}}
   */
  function loginState() {
    // Личные разделы навигации. Гостю их не показывают.
    const activity = document.querySelector('a[href^="/activity"]');
    const saved = document.querySelector('a[href^="/saved"], a[href^="/liked"]');

    // Ссылка на собственный профиль с аватаром в навигации, а не в карточке поста.
    const navProfile = [...document.querySelectorAll('a[href^="/@"]')].find((a) => {
      const href = a.getAttribute('href') || '';
      if (!/^\/@[A-Za-z0-9._]+\/?$/.test(href)) return false;
      if (a.closest('[data-pressable-container]')) return false;
      return !!a.querySelector('img');
    });

    // Кнопка создания поста есть и у гостя: по ней его зовут войти.
    // Как признак сессии она не годится, но в диагностике полезна.
    const compose = TA.sel.findByLabel(document, ['создать', 'create', 'написать', 'new thread']);

    const loginCta = TA.sel.findByText(document, ['войти', 'log in', 'login', 'вход'], { exact: true });
    const signupCta = TA.sel.findByText(
      document,
      ['создать аккаунт', 'sign up', 'зарегистрироваться', 'continue with instagram'],
      { exact: false },
    );

    const onLoginPage = /^\/(login|accounts\/login)/.test(location.pathname)
      || !!document.querySelector('input[name="username"], input[autocomplete="username"]');

    const signals = {
      activity: !!activity,
      saved: !!saved,
      navProfile: navProfile ? navProfile.getAttribute('href') : false,
      compose: !!compose,
      loginCta: !!loginCta,
      signupCta: !!signupCta,
      onLoginPage,
    };

    if (onLoginPage) return { loggedIn: false, confidence: 'high', signals };

    // Два независимых положительных признака — иначе один редизайн навигации
    // остановил бы агента навсегда.
    if (activity || saved || navProfile) return { loggedIn: true, confidence: 'high', signals };

    if (signupCta || loginCta) return { loggedIn: false, confidence: 'high', signals };

    // Личных разделов не видно. Возможно, страница ещё не дорисовалась, но
    // считать сессию активной нельзя: на гостевой ленте агент отберёт посты,
    // потратит токены и упрётся в форму входа при публикации.
    return { loggedIn: false, confidence: 'low', signals };
  }

  function isLoggedIn() {
    return loginState().loggedIn;
  }

  function isLoggedOut() {
    const s = loginState();
    return !s.loggedIn && s.confidence === 'high';
  }

  /** Проверить конкретный узел (для наблюдателя). */
  function checkNode(node) {
    if (!node || node.nodeType !== 1) return null;
    const role = node.getAttribute?.('role');
    if (role && ['dialog', 'alertdialog', 'alert', 'status'].includes(role)) {
      return classify(noticeText(node));
    }
    if (node.querySelector?.('[role="dialog"], [role="alert"], [role="alertdialog"]')) {
      for (const el of node.querySelectorAll('[role="dialog"], [role="alert"], [role="alertdialog"]')) {
        const hit = classify(noticeText(el));
        if (hit) return hit;
      }
    }
    return null;
  }

  /* ---------------------------- Наблюдение -------------------------------- */

  let observer = null;
  let sweepTimer = null;
  let lastAlertKey = '';
  let lastAlertAt = 0;
  let onAlert = null;

  function raise(alert) {
    if (!alert) return;
    const key = `${alert.kind}|${(alert.detail || '').slice(0, 60)}`;
    const now = Date.now();
    // Одно и то же предупреждение может мелькнуть несколько раз подряд.
    if (key === lastAlertKey && now - lastAlertAt < 30000) return;
    lastAlertKey = key;
    lastAlertAt = now;

    warn('сигнал сторожа:', alert.kind, alert.detail);
    if (onAlert) onAlert(alert);
  }

  function start(handler) {
    onAlert = handler;
    stop();

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          const hit = checkNode(node);
          if (hit) { raise(hit); return; }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Периодическая полная проверка — на случай, если предупреждение
    // отрисовалось до подписки или без добавления узлов.
    sweepTimer = setInterval(() => {
      const hit = scan();
      if (hit) raise(hit);
    }, 15000);
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  /**
   * Проверка после отправки ответа: не всплыло ли предупреждение
   * и появился ли комментарий в ветке.
   */
  /**
   * Дождаться появления своего ответа в ветке.
   *
   * Отрицательный ответ здесь дорог: он засчитывается в счётчик теневого
   * ограничения, а три подряд останавливают агента до ручного разбора. Поэтому
   * терпения должно хватать на медленную публикацию.
   *
   * Живой случай: комментарий ушёл и появился в ветке, но позже отведённых
   * десяти секунд. Агент записал «не подтвердился», хотя всё сработало.
   *
   * Два приёма против этого. Первое — ждать заметно дольше: лишние секунды
   * ожидания ничего не стоят, а ложная тревога стоит остановки. Второе —
   * подтолкнуть страницу: Threads дорисовывает ответы лениво, и наш может
   * просто не быть смонтирован, пока до него не долистали.
   */
  async function verifyAfterSend(expectedText, { timeout = 25000, nudgeAfter = 7000 } = {}) {
    const { sleep, textOf: t } = TA.util;
    const needle = normalizeForMatch(expectedText).slice(0, 40);
    const started = Date.now();
    const deadline = started + timeout;
    let nudged = false;

    const found = () => {
      const { cards } = TA.sel.findPostCards();
      for (const c of cards) {
        if (normalizeForMatch(t(c)).includes(needle)) return true;
      }
      return false;
    };

    /**
     * Все ли ответы ветки вообще показаны на странице.
     *
     * Без этого «не нашли» и «не смогли посмотреть» сливаются в один вывод, а
     * это разные утверждения. Боевой случай 02.08, 15:23: ответ ушёл под пост
     * с 82 комментариями, Threads показал десяток из них, нашего среди них не
     * было — и агент записал себе неподтверждённую отправку, то есть шаг к
     * остановке по теневому ограничению. Ответ при этом лежал на месте,
     * проверено вкладкой ответов профиля.
     *
     * Признак точный: если корень заявляет ответов больше, чем карточек на
     * странице, выборка неполна и отсутствие нашего текста ничего не значит.
     */
    const partialThread = () => {
      try {
        const shown = TA.sel.findPostCards().cards.length;
        const claimed = TA.thread?.parse?.(location.href)?.root?.replies ?? 0;
        return claimed > 0 && claimed + 1 > shown;
      } catch {
        return false;
      }
    };

    while (Date.now() < deadline) {
      const alert = scan();
      if (alert) return { verified: false, alert };

      if (found()) return { verified: true, ms: Date.now() - started };

      // Разовый толчок: пролистать вниз, чтобы страница дорисовала ответы.
      if (!nudged && Date.now() - started > nudgeAfter) {
        nudged = true;
        try {
          window.scrollBy({ top: 700, behavior: 'smooth' });
          await sleep(900);
          if (found()) return { verified: true, ms: Date.now() - started, nudged: true };
          window.scrollBy({ top: -400, behavior: 'smooth' });
        } catch { /* прокрутка не критична */ }
      }

      await sleep(700);
    }

    return {
      verified: false,
      alert: null,
      ms: Date.now() - started,
      inconclusive: partialThread(),
    };
  }

  function normalizeForMatch(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .trim();
  }

  TA.guard = {
    scan, start, stop, classify, verifyAfterSend,
    loginState, isLoggedIn, isLoggedOut, normalizeForMatch,
  };
})();

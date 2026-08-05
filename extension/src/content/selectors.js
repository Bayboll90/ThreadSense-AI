/**
 * Селекторы Threads.
 *
 * Единственный файл, который придётся править после редизайна Threads. Всё
 * остальное обращается к DOM только через него.
 *
 * Классы в Threads обфусцированы и меняются при каждой сборке, поэтому здесь
 * их нет вообще. Опора идёт на то, что переживает редизайн: атрибуты доступности
 * (role, aria-label), семантические теги (time[datetime]), форму ссылок
 * (/@author/post/shortcode) и служебные атрибуты React Native Web
 * (data-pressable-container) и Lexical (data-lexical-editor).
 *
 * Каждый элемент описан не одним селектором, а списком стратегий, которые
 * пробуются по порядку. Инспектор (inspector.js) прогоняет их все на живой
 * странице и показывает, какая сработала и что сломалось.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.sel) return;
  const { isVisible, textOf, closestBy } = TA.util;

  /* ------------------------------------------------------------------ *
   * Подписи кнопок на разных языках интерфейса.
   * Threads наследует локали Instagram; список покрывает ru/en/uk и вариации.
   * ------------------------------------------------------------------ */
  const LABELS = {
    like: ['нравится', 'лайк', 'like', 'подобається', 'unlike', 'убрать лайк'],

    /**
     * Подписи, означающие «пост уже лайкнут».
     *
     * Живой Threads после лайка меняет подпись на «Не нравится» — это
     * предложение снять отметку, а не признак её отсутствия. Такой формулировки
     * в списке не было, поэтому агент считал каждый свой лайк неудавшимся:
     * счётчик не рос, а при следующем проходе он кликал повторно и снимал
     * только что поставленную отметку.
     */
    liked: [
      'не нравится', 'убрать отметку', 'снять отметку', 'убрать "нравится"',
      'вам нравится', 'unlike', 'you liked', 'liked',
    ],
    reply: ['ответить', 'ответ', 'reply', 'comment', 'комментировать', 'відповісти'],
    repost: ['репост', 'repost', 'поделиться публикацией'],
    share: ['поделиться', 'share', 'поділитися'],
    more: ['ещё', 'еще', 'more', 'options', 'параметры'],
    post: ['опубликовать', 'отправить', 'post', 'publish', 'опублікувати'],
    close: ['закрыть', 'close', 'закрити', 'отмена', 'cancel'],
    translate: ['перевести', 'see translation', 'посмотреть перевод'],

    /**
     * Подписи кнопки «написать свой пост».
     *
     * Их две разновидности, и обе нужны. В боковой навигации это отдельная
     * кнопка «Создать», а вверху ленты — заглушка-строка с приглашением, у
     * которой подписи может не быть вовсе: там опознание идёт по тексту.
     */
    compose: ['создать', 'create', 'новый пост', 'new thread', 'створити'],

    /** «Дополнить ветку» — добавляет ещё одно сообщение в ту же форму. */
    addToThread: ['дополнить ветку', 'add to thread', 'добавить в ветку', 'доповнити гілку'],
    composePlaceholder: [
      'что нового', "what's new", 'начните ветку', 'start a thread',
      'напишите что-нибудь', 'що нового',
    ],

    /**
     * Поле темы — то, что в интерфейсе стоит рядом с именем автора:
     * `example_user > Topic`.
     *
     * Отдельная сущность Threads, не хэштег: тема выбирается из
     * автодополнения, живёт ссылкой `serp_type=tags&tag_id=…` и открывает
     * ленту, которую можно листать. Для аккаунта без подписчиков это вторая
     * поверхность раздачи после ленты подписок, и до 01.08 агент ею не
     * пользовался вовсе — просто потому, что публикатор печатал только текст.
     */
    topic: [
      'добавить тему', 'add a topic', 'add topic', 'тема', 'topic',
      'выбрать тему', 'додати тему',
    ],
  };

  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

  /** Совпадает ли aria-label элемента с одной из подписей. */
  function labelMatches(el, keys) {
    const label = norm(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
    if (!label) return false;
    return keys.some((k) => label.includes(norm(k)));
  }

  /** Найти интерактивный элемент по подписи внутри корня. */
  function findByLabel(root, keys, { visibleOnly = true } = {}) {
    const scope = root || document;
    const nodes = scope.querySelectorAll(
      '[aria-label], [title], svg[aria-label], [role="button"], button',
    );
    for (const n of nodes) {
      if (!labelMatches(n, keys)) continue;
      // Для svg берём ближайшего кликабельного предка: клик по самому svg
      // в React Native Web часто не доходит до обработчика.
      const target = n.tagName?.toLowerCase() === 'svg'
        ? closestBy(n, (e) => e.getAttribute?.('role') === 'button' || e.tagName === 'BUTTON' || e.hasAttribute?.('tabindex'), 6) || n.parentElement
        : n;
      if (!visibleOnly || isVisible(target)) return target;
    }
    return null;
  }

  /** Найти кликабельный элемент по его тексту. */
  function findByText(root, keys, { exact = false, visibleOnly = true } = {}) {
    const scope = root || document;
    const nodes = scope.querySelectorAll('[role="button"], button, a, div[tabindex]');
    for (const n of nodes) {
      const t = norm(textOf(n));
      if (!t || t.length > 40) continue;
      const hit = keys.some((k) => (exact ? t === norm(k) : t.includes(norm(k))));
      if (!hit) continue;
      if (!visibleOnly || isVisible(n)) return n;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Карточки постов в ленте
   * ------------------------------------------------------------------ */

  /**
   * Стратегии поиска контейнеров постов, от самой надёжной к самой грубой.
   * Каждая возвращает массив элементов.
   */
  const POST_STRATEGIES = [
    {
      name: 'data-pressable-container',
      // Собственный атрибут React Native Web, которым Threads помечает
      // кликабельные карточки. Держится дольше всего.
      run: () => [...document.querySelectorAll('div[data-pressable-container="true"]')],
    },
    {
      name: 'permalink-ancestor',
      // От ссылки на пост поднимаемся к её карточке. Работает всегда, пока
      // ссылки имеют вид /@author/post/shortcode.
      run: () => {
        const seen = new Set();
        const out = [];
        for (const a of document.querySelectorAll('a[href*="/post/"]')) {
          const card = closestBy(a, isPostCard, 14);
          if (card && !seen.has(card)) { seen.add(card); out.push(card); }
        }
        return out;
      },
    },
    {
      name: 'article-role',
      run: () => [...document.querySelectorAll('[role="article"], article')],
    },
    {
      name: 'time-ancestor',
      // Совсем грубо: от отметки времени вверх до достаточно крупного блока.
      run: () => {
        const seen = new Set();
        const out = [];
        for (const t of document.querySelectorAll('time[datetime]')) {
          const card = closestBy(t, (e) => e.getBoundingClientRect().height > 60, 12);
          if (card && !seen.has(card)) { seen.add(card); out.push(card); }
        }
        return out;
      },
    },
  ];

  /**
   * Похож ли элемент на карточку поста.
   *
   * Одной ссылки на пост мало: на странице ветки заголовок «Ветка» и хлебные
   * крошки тоже содержат такую ссылку. Отличие карточки в том, что у неё есть
   * отметка времени либо собственный содержательный текст. Без этой проверки
   * корнем ветки становился заголовок страницы: пять символов текста, ноль
   * лайков, ноль ответов.
   */
  function isPostCard(el) {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.height < 40) return false;
    if (r.height > window.innerHeight * 4) return false;
    if (!el.querySelector('a[href*="/post/"]')) return false;

    if (el.querySelector('time')) return true;
    return textOf(el).length >= 25;
  }

  /** Все карточки постов на странице. Возвращает { cards, strategy }. */
  function findPostCards() {
    for (const s of POST_STRATEGIES) {
      let cards;
      try { cards = s.run(); } catch { continue; }
      const good = (cards || []).filter((c) => isPostCard(c) && isVisible(c));
      if (good.length >= 2) return { cards: dedupeNested(good), strategy: s.name };
    }
    // Последняя попытка — принять и одну карточку: на странице поста она такая.
    for (const s of POST_STRATEGIES) {
      try {
        const good = (s.run() || []).filter((c) => isPostCard(c));
        if (good.length) return { cards: dedupeNested(good), strategy: `${s.name} (одиночная)` };
      } catch { /* следующая стратегия */ }
    }
    return { cards: [], strategy: null };
  }

  /**
   * Убрать вложенные карточки: цитируемый пост внутри репоста порождает
   * дубль, где внешний контейнер содержит внутренний.
   */
  function dedupeNested(list) {
    const out = [];
    for (const el of list) {
      if (list.some((other) => other !== el && other.contains(el))) continue;
      out.push(el);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Части карточки
   * ------------------------------------------------------------------ */

  /** Ссылка-пермалинк поста. */
  function postLink(card) {
    const links = [...card.querySelectorAll('a[href*="/post/"]')];
    // Предпочитаем ссылку, обёрнутую вокруг отметки времени: она всегда ведёт
    // на сам пост, а не на цитируемый.
    const withTime = links.find((a) => a.querySelector('time'));
    return withTime || links[0] || null;
  }

  /** Ссылка на профиль автора. */
  function authorLink(card) {
    const links = [...card.querySelectorAll('a[href^="/@"], a[href*="threads.com/@"], a[href*="threads.net/@"]')];
    // Первая по порядку в DOM — обычно автор поста; дальше идут упоминания.
    return links.find((a) => !a.href.includes('/post/')) || links[0] || null;
  }

  /**
   * Текстовый блок поста.
   *
   * Ищем самый длинный текстовый контейнер, который не является служебным
   * (не хлебные крошки, не имя автора, не панель действий).
   */
  function postTextEl(card) {
    const candidates = [...card.querySelectorAll('div[dir="auto"], span[dir="auto"], div[data-testid*="text"]')];
    let best = null;
    let bestLen = 0;

    for (const el of candidates) {
      // Пропускаем обёртки, внутри которых есть другой кандидат: берём лист.
      if (candidates.some((o) => o !== el && el.contains(o))) continue;
      if (el.closest('a[href^="/@"]')) continue;   // имя автора
      if (el.querySelector('time')) continue;      // строка со временем
      if (isServiceText(textOf(el))) continue;     // «3 ч.», «Перевести», счётчики

      const t = textOf(el);
      if (t.length > bestLen) { bestLen = t.length; best = el; }
    }
    return best;
  }

  /**
   * Служебная строка, а не текст поста.
   *
   * У постов без текста (только медиа) единственным кандидатом остаётся
   * подпись времени, и она уезжала в текст: пост превращался в «4 ч. YCJBAW».
   */
  function isServiceText(t) {
    const s = norm(t);
    if (!s) return true;
    if (s.length > 40) return false;
    if (/^\d+\s*(сек|мин|ч|час|д|дн|нед|мес|г|[smhdwy])\.?( назад)?$/i.test(s)) return true;
    if (/^(перевести|see translation|посмотреть перевод|подписаться|follow|ещё|еще|more)$/i.test(s)) return true;
    if (/^\d[\d\s.,]*\s*(тыс\.?|млн|k|m)?$/i.test(s)) return true;
    return false;
  }

  /** Отметка времени. */
  function timeEl(card) {
    return card.querySelector('time[datetime]') || card.querySelector('time') || null;
  }

  /** Панель действий: лайк, ответ, репост, поделиться. */
  function actionBar(card) {
    const like = findByLabel(card, LABELS.like, { visibleOnly: false });
    if (like) {
      const bar = closestBy(like, (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 80 && r.height > 0 && r.height < 90;
      }, 6);
      if (bar) return bar;
    }
    return null;
  }

  /**
   * Счётчики лайков и ответов.
   *
   * Threads показывает их по-разному: то как aria-label кнопки («12 отметок
   * "Нравится"»), то отдельной строкой под панелью действий, то не показывает
   * вовсе при нуле. Собираем из всех доступных мест.
   */
  /**
   * Счётчики поста.
   *
   * Кроме значений возвращается availability — какие метрики действительно
   * удалось прочитать. Различие принципиальное: Threads показывает счётчик
   * ответов не всегда, и «ноль ответов» от «счётчик скрыт» отличается только
   * этим флагом. Без него фильтр «минимум 5 ответов» выбрасывает половину
   * годной ленты, где счётчика просто нет в разметке.
   */
  function counts(card) {
    const out = { likes: 0, replies: 0, reposts: 0 };
    const availability = { likes: false, replies: false, reposts: false };
    const { parseCount, COUNT_SRC } = TA.util;

    // Число ищется строго ограниченным шаблоном: жадный «\d[\d\s]*» слизывал
    // подряд идущие счётчики из соседних кнопок и склеивал «214 18 18» в одно
    // бессмысленное число.
    const near = (words) => new RegExp(`(${COUNT_SRC})\\s*(?:${words})`, 'i');

    const set = (key, value) => {
      if (out[key] || !Number.isFinite(value)) return;
      out[key] = value;
      availability[key] = true;
    };

    // 1. Самый надёжный источник — подписи доступности у кнопок.
    for (const n of card.querySelectorAll('[aria-label]')) {
      const label = norm(n.getAttribute('aria-label'));
      if (!/\d/.test(label)) continue;
      if (LABELS.like.some((k) => label.includes(norm(k)))) set('likes', parseCount(label));
      else if (LABELS.reply.some((k) => label.includes(norm(k)))) set('replies', parseCount(label));
      else if (LABELS.repost.some((k) => label.includes(norm(k)))) set('reposts', parseCount(label));
    }

    // 2. Итоговая строка вида «18 ответов · 214 отметок «Нравится»».
    if (!out.likes || !out.replies) {
      const tail = textOf(card).split('\n').slice(-4).join(' ').toLowerCase();
      const rep = tail.match(near('ответ|коммент|repl|comment'));
      const lik = tail.match(near('отмет|нравит|лайк|like'));
      if (rep) set('replies', parseCount(rep[1]));
      if (lik) set('likes', parseCount(lik[1]));
    }

    // 3. Числа рядом с иконками в панели действий: первое — лайки, второе — ответы.
    if (!out.likes || !out.replies) {
      const bar = actionBar(card);
      if (bar) {
        const nums = textOf(bar).match(new RegExp(COUNT_SRC, 'gi'))?.filter((x) => /\d/.test(x)) || [];
        if (nums[0]) set('likes', parseCount(nums[0]));
        if (nums[1]) set('replies', parseCount(nums[1]));
      }
    }

    // Свойство неперечисляемое: не мусорит в логах и при сериализации в промпт,
    // но доступно фильтрам, которым нужно отличить ноль от скрытого счётчика.
    Object.defineProperty(out, 'availability', { value: availability, enumerable: false });
    return out;
  }

  /**
   * Кнопка лайка внутри карточки. Возвращает { el, liked }.
   *
   * Подпись со словом «нравится» встречается не только у кнопки: рядом бывает
   * бейдж «Оригинальный автор поставил "Нравится"» размером в дюжину пикселей.
   * Клик по нему ничего не даёт, а агент считает лайк поставленным. Поэтому
   * кандидат обязан быть настоящей кнопкой разумного размера.
   */
  function likeButton(card) {
    const candidates = [...card.querySelectorAll('[aria-label], [title], svg[aria-label], [role="button"], button')];

    for (const n of candidates) {
      if (!labelMatches(n, LABELS.like)) continue;

      const el = n.tagName?.toLowerCase() === 'svg'
        ? closestBy(n, (e) => e.getAttribute?.('role') === 'button' || e.tagName === 'BUTTON' || e.hasAttribute?.('tabindex'), 6) || n.parentElement
        : n;
      if (!el || !isVisible(el)) continue;

      // Бейджи и подписи кнопками не являются.
      const isButton = el.getAttribute?.('role') === 'button'
        || el.tagName === 'BUTTON'
        || el.hasAttribute?.('tabindex');
      if (!isButton) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;

      const label = norm(el.getAttribute?.('aria-label') || '')
        || norm(el.querySelector?.('svg[aria-label]')?.getAttribute('aria-label') || '');

      /*
       * Заливка иконки как признак лайка не годится: на живом Threads путь
       * имеет fill="currentColor" в обоих состояниях, и проверка по ней
       * объявляла бы лайкнутым вообще всё. Решает только подпись.
       */
      const liked = LABELS.liked.some((k) => label.includes(norm(k)));

      return { el, liked, label };
    }
    return null;
  }

  /** Кнопка ответа. */
  function replyButton(card) {
    return findByLabel(card, LABELS.reply) || findByText(card, LABELS.reply, { exact: true });
  }

  /**
   * Пометки рекламы и рекомендаций.
   *
   * Границы слова заданы просмотром, а не \b: в JavaScript \b опирается на
   * ASCII, поэтому «\bреклама\b» не совпадает никогда и вся проверка молча
   * вырождалась в ложь.
   */
  function isAd(card) {
    const t = norm(textOf(card).slice(0, 200));
    return /(?<![\p{L}\p{N}_])(реклама|рекламный пост|sponsored|спонсировано|партнерский материал|promoted)(?![\p{L}\p{N}_])/u
      .test(t);
  }

  /* ------------------------------------------------------------------ *
   * Композер ответа
   * ------------------------------------------------------------------ */

  const EDITOR_STRATEGIES = [
    {
      name: 'lexical-editor',
      // Threads использует Lexical; этот атрибут ставится на корень редактора.
      run: () => [...document.querySelectorAll('div[contenteditable="true"][data-lexical-editor="true"]')],
    },
    {
      name: 'textbox-role',
      run: () => [...document.querySelectorAll('div[contenteditable="true"][role="textbox"]')],
    },
    {
      name: 'contenteditable',
      run: () => [...document.querySelectorAll('div[contenteditable="true"], p[contenteditable="true"]')],
    },
    {
      name: 'textarea',
      run: () => [...document.querySelectorAll('textarea')],
    },
  ];

  /** Активное поле ввода ответа. */
  function findEditor() {
    for (const s of EDITOR_STRATEGIES) {
      let els;
      try { els = s.run(); } catch { continue; }
      const good = (els || []).filter(isVisible);
      if (good.length) {
        // Если открыт диалог, поле внутри него приоритетнее.
        const dlg = document.querySelector('[role="dialog"]');
        const inDialog = dlg && good.find((e) => dlg.contains(e));
        return { el: inDialog || good[good.length - 1], strategy: s.name };
      }
    }
    return { el: null, strategy: null };
  }

  /** Кнопка публикации ответа. */
  function findPostButton(scope) {
    const root = scope || document.querySelector('[role="dialog"]') || document;
    return findByText(root, LABELS.post, { exact: true })
      || findByLabel(root, LABELS.post)
      || findByText(root, LABELS.post, { exact: false });
  }

  /**
   * Кнопка «написать свой пост».
   *
   * Три пути, потому что Threads показывает разное на разных страницах и
   * ширинах. Заглушка вверху ленты — самая надёжная точка входа: она есть
   * всегда, когда лента вообще отрисована. Кнопка в боковой навигации
   * пропадает на узком экране. Прямая ссылка `/intent/post` работает даже
   * тогда, когда не нашлось ни того, ни другого.
   *
   * Порядок именно такой: заглушка ведёт себя как обычный композер, а кнопка
   * в навигации иногда открывает меню выбора типа записи, и это лишний шаг.
   */
  function findComposeEntry() {
    // 1. Заглушка вверху ленты — ищем по тексту приглашения.
    const byPlaceholder = findByText(document, LABELS.composePlaceholder, { exact: false });
    if (byPlaceholder) {
      const clickable = closestBy(byPlaceholder, (n) => (
        n.getAttribute?.('role') === 'button'
        || n.tagName === 'BUTTON'
        || n.getAttribute?.('data-pressable-container') === 'true'
      )) || byPlaceholder;
      return { el: clickable, how: 'заглушка ленты' };
    }

    // 2. Кнопка в навигации.
    const byLabel = findByLabel(document, LABELS.compose);
    if (byLabel) return { el: byLabel, how: 'кнопка навигации' };

    return { el: null, how: null };
  }

  /**
   * Кнопка «Дополнить ветку» в форме публикации.
   *
   * Threads умеет собирать многочастную ветку прямо в форме: каждое нажатие
   * добавляет ещё одно поле, а публикуется всё разом одной кнопкой. Это и
   * надёжнее, и ближе к человеку, чем публиковать первую часть, искать её у
   * себя в профиле и отвечать самому себе.
   *
   * Тонкость, на которой я споткнулся при разведке: подпись повторяется на
   * трёх вложенных элементах — обёртке, самой кнопке и `span` с текстом. Клик
   * по обёртке не срабатывает вовсе. Поэтому берём самый глубокий элемент с
   * точным текстом и поднимаемся от него к ближайшему кликабельному предку.
   */
  function findAddToThread(scope) {
    const root = scope || findDialog() || document;
    const want = LABELS.addToThread.map(norm);

    const hits = [...root.querySelectorAll('*')]
      .filter(isVisible)
      .filter((el) => want.includes(norm(el.innerText)));

    if (!hits.length) return null;

    const leaf = hits[hits.length - 1];
    return leaf.closest('[role="button"], button, div[tabindex]') || leaf;
  }

  /**
   * Поле темы в композере.
   *
   * Опознаётся каскадом, потому что ни одного устойчивого признака у него нет,
   * а ошибиться дороже, чем не найти: печатать в чужое поле нельзя, а обойтись
   * без темы можно всегда.
   *
   * Порядок стратегий — от самого надёжного к самому общему:
   *
   * 1. Подпись или подсказка со словом «тема» — единственный прямой признак.
   * 2. Комбобокс внутри композера: у автодополнения такая роль по стандарту.
   * 3. Однострочный `input` рядом с именем автора. Основное поле поста —
   *    `contenteditable`, так что обычный `input` в композере может быть либо
   *    темой, либо поиском; поиска в композере нет.
   *
   * Последняя стратегия сознательно не пытается угадать по позиции: «элемент
   * справа от автора» ломается от любой перевёрстки, а цена ошибки — тема,
   * набранная в текст поста.
   */
  function findTopicInput(scope) {
    const root = scope || findDialog() || document;

    const byLabel = findByLabel(root, LABELS.topic);
    if (byLabel) {
      const inner = byLabel.matches('input, [contenteditable="true"]')
        ? byLabel
        : byLabel.querySelector('input, [contenteditable="true"]');
      if (inner && isVisible(inner)) return { el: inner, how: 'подпись «тема»' };
    }

    const byPlaceholder = [...root.querySelectorAll('input[placeholder], [aria-placeholder]')]
      .filter(isVisible)
      .find((el) => {
        const p = norm(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
        return LABELS.topic.some((k) => p.includes(norm(k)));
      });
    if (byPlaceholder) return { el: byPlaceholder, how: 'подсказка в поле' };

    const combo = [...root.querySelectorAll('[role="combobox"]')].filter(isVisible)[0];
    if (combo) {
      const inner = combo.matches('input, [contenteditable="true"]')
        ? combo
        : combo.querySelector('input, [contenteditable="true"]');
      if (inner && isVisible(inner)) return { el: inner, how: 'combobox' };
    }

    /*
     * Основное поле поста — `contenteditable`, а не `input`, поэтому обычное
     * однострочное поле внутри композера темой и является. Текстовые области
     * и поля поиска исключены явно.
     */
    const plain = [...root.querySelectorAll('input')]
      .filter(isVisible)
      .filter((el) => {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (!['text', 'search', ''].includes(t)) return false;
        return !closestBy(el, (p) => p.matches?.('[role="search"]'));
      })[0];
    if (plain) return { el: plain, how: 'однострочное поле в композере' };

    return { el: null, how: null };
  }

  /**
   * Варианты, которые предложило автодополнение темы.
   *
   * Выбирать надо именно из них: тема, набранная руками и не существующая в
   * Threads, открывает пустую ленту, и смысла в ней нет никакого.
   *
   * Ролей `option` и `listbox` в живом Threads не оказалось: боевой прогон
   * 01.08 дважды вернул «автодополнение не предложило вариантов», хотя поле
   * нашлось и текст набрался. Поэтому кроме ролей ищем по строению — узлы,
   * появившиеся рядом с полем и содержащие набранное. Ищем **не по всему
   * документу**, а внутри диалога: подходящий по тексту узел найдётся и в
   * ленте под формой, а кликать по нему нельзя.
   *
   * @param {Element} scope   диалог композера
   * @param {string}  typed   что набрали в поле
   */
  function topicOptions(scope, typed = '') {
    const root = scope || findDialog() || document;

    const byRole = [...root.querySelectorAll('[role="option"]')].filter(isVisible);
    if (byRole.length) return byRole;

    const box = [...root.querySelectorAll('[role="listbox"], [role="menu"]')].filter(isVisible)[0];
    if (box) {
      const kids = [...box.children].filter(isVisible);
      if (kids.length) return kids;
    }

    /*
     * Запасной путь по строению. Берём самые глубокие элементы, чей текст
     * начинается с набранного: у списка подсказок каждый вариант — отдельная
     * строка, а родительские обёртки содержат их все сразу и потому длиннее.
     */
    const want = norm(typed);
    if (!want) return [];

    const hits = [...root.querySelectorAll('div, span, li, a')]
      .filter(isVisible)
      .filter((el) => {
        const t = norm(el.innerText);
        if (!t || t.length > want.length + 40) return false;
        if (!t.startsWith(want)) return false;
        // Само поле ввода и его обёртки вариантами не являются.
        return !el.querySelector('input, [contenteditable="true"]');
      });

    // Оставляем листья: у вложенных пар родитель и потомок дают один вариант.
    return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
  }

  /** Открытый модальный диалог. */
  function findDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
    return dialogs[dialogs.length - 1] || null;
  }

  /** Кнопка закрытия диалога. */
  function findCloseButton(scope) {
    return findByLabel(scope || document, LABELS.close);
  }

  /* ------------------------------------------------------------------ *
   * Определение страницы
   * ------------------------------------------------------------------ */

  /**
   * Образцы путей по убыванию точности.
   *
   * Дословная копия `ROUTES` из `common/pages.js`: сюда модуль не
   * импортируется — это классический скрипт. Расхождение между копиями ловит
   * проверка «страница и фон одинаково понимают, где агент» на стенде.
   *
   * Порядок значим: `/@user/post/x` подходит и под пост, и под профиль, и
   * выигрывать обязан пост.
   */
  const ROUTES = [
    [/^\/(accounts\/(suspended|disabled|inactive)|challenge|checkpoint)/, 'blocked'],
    [/\/post\//, 'post'],
    [/^\/search/, 'search'],
    [/^\/@[^/]+\/replies/, 'profile_replies'],
    [/^\/@[^/]+\/?$/, 'profile'],
    [/^\/activity/, 'activity'],
    [/^\/(for-you|following)/, 'feed'],
  ];

  /**
   * Какая это страница.
   *
   * Путь можно передать — так проверяется таблица образцов, не бегая по
   * настоящим адресам. По умолчанию берётся живой `location`: страница знает о
   * себе точнее, чем фон, у которого адрес приходит сообщением и успевает
   * устареть.
   */
  function pageKind(path = location.pathname) {
    const p = String(path || '').split(/[?#]/)[0];
    if (p === '/' || p === '') return 'feed';
    for (const [re, kind] of ROUTES) if (re.test(p)) return kind;
    return 'other';
  }

  /** Мой ли это профиль. */
  function isOwnProfile(handle) {
    const m = location.pathname.match(/^\/@([^/]+)/);
    return !!m && norm(m[1]) === norm(String(handle || '').replace(/^@/, ''));
  }

  TA.sel = {
    LABELS,
    norm, labelMatches, findByLabel, findByText,
    POST_STRATEGIES, EDITOR_STRATEGIES,
    findPostCards, isPostCard, dedupeNested, isServiceText,
    postLink, authorLink, postTextEl, timeEl, actionBar, counts,
    likeButton, replyButton, isAd,
    findEditor, findPostButton, findDialog, findCloseButton, findComposeEntry, findAddToThread,
    findTopicInput, topicOptions,
    pageKind, isOwnProfile,
  };
})();

/**
 * Отличить пост от ответа внутри ветки.
 *
 * В разметке Threads это одинаковые карточки: тот же контейнер, та же панель
 * действий, та же ссылка вида /@author/post/shortcode. Разница только в
 * положении и в мелких визуальных признаках.
 *
 * Цена ошибки высокая и неочевидная. Ответив на чужой ответ, агент вступает в
 * чужой разговор с репликой, написанной по корневому посту, — она не в тему.
 * Хуже того, на странице ветки такие карточки идут подряд, и один неверный
 * выбор превращается в серию.
 *
 * Надёжного одного признака нет, поэтому детекторов три, и они независимы.
 * Каждый ловит свой случай и ошибается по-своему; согласие двух из трёх
 * надёжнее любого поодиночке.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.nested) return;
  const { textOf, closestBy, shortcodeFromHref } = TA.util;

  /**
   * Детектор 1: положение в группе карточек.
   *
   * Ветка рисуется как группа соседних контейнеров с общим родителем. Первый
   * в группе — корневой пост, остальные — ответы. Работает на странице поста,
   * где группа явная.
   */
  function byGroupPosition(card) {
    const parent = closestBy(card, (e) => {
      const kids = e.querySelectorAll(':scope > * [data-pressable-container="true"], :scope > [data-pressable-container="true"]');
      return kids.length >= 2 && kids.length <= 12;
    }, 4);
    if (!parent) return { nested: false, confidence: 0 };

    const group = [...parent.querySelectorAll('[data-pressable-container="true"]')]
      .filter((c) => !group_isNestedContainer(c, parent));
    const idx = group.indexOf(card);

    if (idx < 0 || group.length < 2) return { nested: false, confidence: 0 };
    return {
      nested: idx > 0,
      confidence: idx > 0 ? 0.7 : 0.5,
      detail: `карточка ${idx + 1} из ${group.length}`,
    };
  }

  function group_isNestedContainer(el, parent) {
    // Контейнер внутри другого контейнера — это цитата, а не элемент группы.
    let n = el.parentElement;
    while (n && n !== parent) {
      if (n.getAttribute?.('data-pressable-container') === 'true') return true;
      n = n.parentElement;
    }
    return false;
  }

  /**
   * Детектор 2: нить ветки.
   *
   * Threads рисует вертикальную линию, связывающую пост с ответами, через
   * собственные css-переменные. У корневого поста нить уходит вниз, у ответа
   * приходит сверху. Признак хрупкий — переменные могут переименовать, — но
   * когда он есть, он однозначен.
   */
  function byThreadLine(card) {
    const hasLine = (el) => !!el?.querySelector?.('[style*="--x-top"], [style*="--x-bottom"], [style*="--thread-line"]');

    const prev = card.previousElementSibling;
    const prevHasLine = hasLine(prev);
    const selfHasLine = hasLine(card);

    if (!prevHasLine && !selfHasLine) return { nested: false, confidence: 0 };

    // У предыдущей карточки нить есть, у текущей нет, и зазор маленький —
    // текущая замыкает ветку, то есть является ответом.
    if (prevHasLine && !selfHasLine && prev) {
      const gap = card.getBoundingClientRect().top - prev.getBoundingClientRect().bottom;
      if (gap > -8 && gap < 260) {
        return { nested: true, confidence: 0.6, detail: `нить сверху, зазор ${Math.round(gap)}px` };
      }
    }
    return { nested: false, confidence: 0.3 };
  }

  /**
   * Детектор 3: бейдж автора оригинала.
   *
   * Под ответами Threads показывает отметку вида «Оригинальный автор поставил
   * отметку "Нравится"». Её наличие означает, что перед нами именно ответ.
   */
  function byAuthorBadge(card) {
    const markers = [
      '[aria-label*="Оригинальный автор" i]',
      '[aria-label*="Original author" i]',
      '[aria-label*="автор поста" i]',
    ];
    for (const sel of markers) {
      if (card.querySelector(sel)) {
        return { nested: true, confidence: 0.8, detail: 'бейдж автора оригинала' };
      }
    }

    const t = textOf(card).toLowerCase();
    if (/оригинальн\w+ автор|original author (liked|replied)/.test(t)) {
      return { nested: true, confidence: 0.7, detail: 'упоминание автора оригинала' };
    }
    return { nested: false, confidence: 0 };
  }

  /**
   * Детектор 4: адрес страницы.
   *
   * Самый надёжный, когда применим. На странице поста корневой — тот, чей
   * шорткод совпадает с адресом; всё остальное заведомо ответы.
   */
  function byUrl(card) {
    const want = shortcodeFromHref(location.href);
    if (!want || TA.sel.pageKind() !== 'post') return { nested: false, confidence: 0 };

    const href = TA.sel.postLink(card)?.getAttribute('href') || '';
    const own = shortcodeFromHref(href);
    if (!own) return { nested: false, confidence: 0 };

    return own === want
      ? { nested: false, confidence: 0.95, detail: 'шорткод совпал с адресом' }
      : { nested: true, confidence: 0.95, detail: 'другой шорткод на странице поста' };
  }

  /**
   * Свод по всем детекторам.
   *
   * Адрес страницы, когда он применим, решает сам: он однозначен. В ленте
   * его нет, и там нужно согласие остальных — одного слабого признака мало,
   * чтобы выбросить годный пост.
   *
   * @returns {{nested: boolean, confidence: number, votes: object[]}}
   */
  function isNestedReply(card) {
    if (!card) return { nested: false, confidence: 0, votes: [] };

    const votes = [
      { name: 'url', ...byUrl(card) },
      { name: 'badge', ...byAuthorBadge(card) },
      { name: 'group', ...byGroupPosition(card) },
      { name: 'line', ...byThreadLine(card) },
    ];

    const url = votes[0];
    if (url.confidence >= 0.9) {
      return { nested: url.nested, confidence: url.confidence, votes, decidedBy: 'url' };
    }

    const positive = votes.filter((v) => v.nested && v.confidence >= 0.5);
    const weight = positive.reduce((s, v) => s + v.confidence, 0);

    return {
      nested: weight >= 1.1,          // один сильный плюс один средний
      confidence: Math.min(1, weight / 2),
      votes,
      decidedBy: positive.map((v) => v.name).join('+') || 'нет признаков',
    };
  }

  TA.nested = { isNestedReply, byUrl, byAuthorBadge, byGroupPosition, byThreadLine };
})();

/**
 * Разбор открытой ветки: корневой пост плюс ответы.
 *
 * Именно эти данные определяют качество комментария. Отвечать «в пустоту»,
 * не видя, что уже сказали другие, — верный способ повторить чужую мысль
 * или написать что-то невпопад. Поэтому ответы собираются с текстами,
 * авторами и лайками: по ним первый проход ИИ решает, кому отвечать и чего
 * в разговоре не хватает.
 *
 * Корневым считается пост, чей шорткод совпадает с адресом страницы. Если
 * определить не удалось — берётся первая карточка сверху: на странице поста
 * Threads всегда рисует его первым.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.thread) return;
  const { sleep, isVisible, textOf, shortcodeFromHref, log, warn } = TA.util;
  const { uniform, chance } = TA.rng;

  /**
   * Открыть ветку и разобрать её.
   *
   * Переход делается кликом по карточке, а не сменой location: клик порождает
   * обычную SPA-навигацию с полным набором событий, тогда как присвоение
   * location перезагружает приложение целиком — это и медленнее, и заметнее.
   *
   * @param {string} url  адрес поста
   * @returns {Promise<{ok: boolean, thread?: object, error?: string}>}
   */
  async function openAndParse(url) {
    const shortcode = shortcodeFromHref(url);
    const already = shortcode ? location.href.includes(shortcode) : false;

    if (!already) {
      const sc = shortcode || ' ';
      const arrived = (timeout) => TA.util.waitFor(
        () => location.href.includes(sc) || TA.sel.pageKind() === 'post',
        { timeout, interval: 250 },
      );

      /*
       * Три попытки, от самой человечной к самой грубой.
       *
       * Отправленный клик и состоявшийся переход — разные вещи: mouse.click
       * сообщает лишь о том, что события ушли в DOM. Раньше первой же удачной
       * отправки хватало, чтобы счесть переход выполненным, и запасные пути
       * не задействовались вовсе — при неудаче агент просто бросал ветку.
       */
      const card = TA.feed.findCardByUrl(url);
      let ok = false;

      // 1. Клик по тексту поста: имя автора уведёт в профиль, панель
      // действий поставит лайк — поэтому именно текст.
      if (card) {
        const textEl = TA.sel.postTextEl(card) || card;
        await TA.mouse.ensureInView(textEl);
        await sleep(uniform(300, 1100));
        await TA.mouse.click(textEl, { scroll: false });
        ok = !!(await arrived(3500));
      }

      // 2. Клик по самой ссылке-пермалинку.
      if (!ok && card) {
        const link = TA.sel.postLink(card);
        if (link) {
          await TA.mouse.click(link);
          ok = !!(await arrived(5000));
        }
      }

      // 3. Прямой переход. Перезагружает приложение целиком, поэтому идёт
      // последним: конвейер после такого подхватится следующим тиком из
      // сохранённого состояния.
      if (!ok) {
        location.href = url;
        ok = !!(await arrived(9000));
      }

      if (!ok) return { ok: false, error: 'не удалось открыть ветку' };
    }

    // Ждём не появления карточек, а появления разбираемого корня.
    //
    // Threads рисует страницу поста в несколько заходов: сначала каркас с
    // заголовком «Ветка», и только потом сам пост с ответами. Ожидание по
    // «есть хотя бы одна карточка» срабатывало на каркасе, и корнем ветки
    // становился заголовок: пять символов текста и нули в счётчиках.
    const ready = await TA.util.waitFor(() => {
      const t = parse(url);
      return t?.root?.text && t.root.text.length >= 20 ? t : null;
    }, { timeout: 14000, interval: 400 });

    await sleep(uniform(500, 1600));

    const thread = ready ? parse(url) : null;
    if (!thread?.root?.text) return { ok: false, error: 'ветка не разобралась' };

    // «Читаем» перед тем, как отвечать.
    await TA.reading.readThread(thread.root.text, thread.replies.map((r) => r.text));

    // Подгружаем ответы, если их обрезали кнопкой «Показать ещё».
    if (thread.replies.length < 3) {
      const more = TA.sel.findByText(document, ['показать ещё', 'ещё ответы', 'view more replies', 'show more']);
      if (more && chance(0.7)) {
        await TA.mouse.click(more);
        await sleep(uniform(900, 2400));
        const again = parse(url);
        if (again?.replies?.length > thread.replies.length) return { ok: true, thread: again };
      }
    }

    return { ok: true, thread };
  }

  /** Разобрать содержимое открытой страницы поста. */
  function parse(url) {
    const { cards } = TA.sel.findPostCards();
    const visible = cards.filter(isVisible);
    if (!visible.length) return null;

    const wantSc = shortcodeFromHref(url || location.href);

    let rootIdx = 0;
    if (wantSc) {
      // Ссылку на пост содержат и заголовок страницы, и сама карточка.
      // Берём ту, где больше текста: это и есть пост.
      let best = -1;
      let bestLen = -1;
      visible.forEach((c, i) => {
        const href = TA.sel.postLink(c)?.getAttribute('href') || '';
        if (!href.includes(wantSc)) return;
        const len = textOf(c).length;
        if (len > bestLen) { bestLen = len; best = i; }
      });
      if (best >= 0) rootIdx = best;
    }

    const rootCard = visible[rootIdx];
    const root = TA.feed.parseCard(rootCard);
    if (!root) return null;

    // Ответы — всё, что ниже корня в DOM.
    const replies = [];
    for (let i = rootIdx + 1; i < visible.length; i++) {
      let r;
      try { r = TA.feed.parseCard(visible[i]); } catch { continue; }
      if (!r || !r.text || r.text.length < 3) continue;
      // Ссылка на тот же пост — это не ответ, а дубль корня.
      if (r.shortcode && r.shortcode === root.shortcode) continue;
      replies.push({
        authorHandle: r.authorHandle,
        authorName: r.authorName,
        text: r.text,
        likes: r.likes,
        ageMinutes: r.ageMinutes,
        url: r.url,
        shortcode: r.shortcode,
      });
      if (replies.length >= 14) break;
    }

    log(`ветка: корень @${root.authorHandle}, ответов ${replies.length}`);
    return { root, replies, parsedAt: Date.now() };
  }

  /**
   * Найти в открытой ветке карточку конкретного ответа по индексу.
   * Нужно, чтобы нажать «Ответить» именно под ним, а не под корневым постом.
   */
  function replyCardAt(index) {
    const { cards } = TA.sel.findPostCards();
    const visible = cards.filter(isVisible);
    const wantSc = shortcodeFromHref(location.href);

    let rootIdx = 0;
    if (wantSc) {
      const idx = visible.findIndex((c) => (TA.sel.postLink(c)?.getAttribute('href') || '').includes(wantSc));
      if (idx >= 0) rootIdx = idx;
    }

    // Индекс ответа отсчитывается от корня; пропускаем дубли корня.
    let seen = -1;
    for (let i = rootIdx + 1; i < visible.length; i++) {
      const link = TA.sel.postLink(visible[i])?.getAttribute('href') || '';
      if (wantSc && link.includes(wantSc)) continue;
      seen++;
      if (seen === index) return visible[i];
    }
    warn(`ответ №${index} не найден в DOM`);
    return null;
  }

  /** Корневая карточка открытой ветки. */
  function rootCard() {
    const { cards } = TA.sel.findPostCards();
    const visible = cards.filter(isVisible);
    const wantSc = shortcodeFromHref(location.href);
    if (wantSc) {
      const found = visible.find((c) => (TA.sel.postLink(c)?.getAttribute('href') || '').includes(wantSc));
      if (found) return found;
    }
    return visible[0] || null;
  }

  /** Есть ли в ветке ответ от указанного автора. */
  function hasReplyFrom(handle) {
    const h = String(handle || '').replace(/^@/, '').toLowerCase();
    if (!h) return false;
    const parsed = parse(location.href);
    if (!parsed) return false;
    return parsed.replies.some(
      (r) => String(r.authorHandle || '').replace(/^@/, '').toLowerCase() === h,
    );
  }

  TA.thread = { openAndParse, parse, replyCardAt, rootCard, hasReplyFrom, textOf };
})();

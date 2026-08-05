/**
 * Сбор собственных текстов с профиля — сырьё для обучения стилю.
 *
 * Берутся обе вкладки: посты и ответы. Ответы важнее — именно их манера
 * воспроизводится, когда агент комментирует чужие ветки. Посты человек часто
 * пишет более собранно, ответы — как говорит.
 *
 * Сам обход двух страниц ведёт фоновый скрипт, а этот модуль умеет собирать
 * тексты только с уже открытой страницы. Так сделано вынужденно: переход между
 * вкладками профиля перезагружает документ, вместе с ним умирает content script,
 * и ответ на sendMessage никогда не доходит до вызывающего. Раньше именно это
 * и происходило — кнопка «Обучить стиль» молча висела до таймаута.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.profile) return;
  const { sleep, textOf, log } = TA.util;
  const { uniform } = TA.rng;

  /**
   * Собрать тексты с текущей страницы профиля.
   *
   * @param {string} handle без собаки
   * @returns {Promise<{ok, samples, error?}>}
   */
  async function collectCurrentPage(handle) {
    const h = String(handle || '').replace(/^@/, '').trim();
    if (!h) return { ok: false, error: 'не задан хэндл' };

    if (!new RegExp(`^/@${h}(/|$)`, 'i').test(location.pathname)) {
      return { ok: false, error: `открыта не та страница: ${location.pathname}` };
    }

    const samples = await harvest(h, location.pathname);
    return { ok: true, samples };
  }

  /** Собрать тексты со страницы, на которой мы уже находимся. */
  async function harvest(handle, what) {
    await TA.util.waitFor(() => TA.sel.findPostCards().cards.length > 0, { timeout: 10000 });
    await sleep(uniform(600, 1600));

    const out = [];
    const seen = new Set();
    const target = String(handle).toLowerCase();

    for (let scroll = 0; scroll < 14; scroll++) {
      const { cards } = TA.sel.findPostCards();

      for (const card of cards) {
        let p;
        try { p = TA.feed.parseCard(card); } catch { continue; }
        if (!p?.text) continue;

        // На вкладке ответов видны и чужие посты, к которым отвечали.
        const author = String(p.authorHandle || '').toLowerCase();
        if (author && author !== target) continue;

        const t = p.text.trim();
        if (t.length < 15 || t.length > 900) continue;
        const key = t.slice(0, 120);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }

      if (out.length >= 90) break;

      const before = out.length;
      await TA.scroll.screenDown(uniform(0.85, 1.1));
      await sleep(uniform(700, 1800));

      // Дошли до конца профиля.
      if (scroll > 2 && out.length === before) {
        await sleep(1200);
        const { cards: after } = TA.sel.findPostCards();
        if (after.length === cards.length) break;
      }
    }

    log(`${what}: ${out.length}`);
    return out;
  }

  /** Слить и обеззубить дубли из нескольких страниц. Вызывается фоном. */
  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const t of list) {
      const key = t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 100);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  /**
   * Определить свой хэндл по интерфейсу — подсказка для мастера настройки.
   *
   * Опора идёт на навигацию: ссылка на собственный профиль лежит в том же
   * блоке, что и вкладка активности, а вкладка активности есть только у
   * вошедшего. Прежний вариант считал частоту ссылок вида /@name по всей
   * странице и на гостевой ленте уверенно возвращал случайного автора.
   */
  function detectOwnHandle() {
    const handleOf = (a) => TA.util.handleFromHref(a?.getAttribute('href'));

    // 1. Навигационный блок рядом с вкладкой активности.
    const activity = document.querySelector('a[href^="/activity"]');
    if (activity) {
      const nav = TA.util.closestBy(
        activity,
        (e) => e !== activity && e.querySelector('a[href^="/@"]'),
        8,
      );
      const own = handleOf(nav?.querySelector('a[href^="/@"]'));
      if (own) return own;
    }

    // 2. Ссылка на профиль с собственным аватаром в шапке или боковом меню.
    for (const a of document.querySelectorAll('a[href^="/@"]')) {
      if (!/^\/@[A-Za-z0-9._]+\/?$/.test(a.getAttribute('href') || '')) continue;
      const img = a.querySelector('img[alt]');
      if (!img) continue;
      if (a.closest('[data-pressable-container]')) continue; // это автор поста в ленте
      const own = handleOf(a);
      if (own) return own;
    }

    // 3. Мы уже на своей странице профиля.
    const onProfile = location.pathname.match(/^\/@([A-Za-z0-9._]+)/);
    if (onProfile && TA.guard.isLoggedIn()) {
      const editing = TA.sel.findByText(document, ['редактировать профиль', 'edit profile'], { exact: false });
      if (editing) return onProfile[1];
    }

    return null;
  }

  TA.profile = { collectCurrentPage, harvest, dedupe, detectOwnHandle, textOf };
})();

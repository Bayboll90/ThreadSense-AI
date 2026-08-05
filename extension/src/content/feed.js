/**
 * Разбор ленты: превращение карточек DOM в объекты постов.
 *
 * Задача — собрать по каждому посту достаточно данных для скоринга: текст,
 * автора, возраст, счётчики. Всё, что не удалось прочитать, остаётся null;
 * скоринг рассчитан на неполные данные и не должен падать из-за отсутствующего
 * счётчика лайков.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.feed) return;
  const { textOf, absUrl, handleFromHref, shortcodeFromHref, ageMinutesFrom, hash, isVisible, sleep, log } = TA.util;
  const { uniform } = TA.rng;

  /** Разобрать одну карточку. */
  function parseCard(card) {
    const link = TA.sel.postLink(card);
    const url = absUrl(link?.getAttribute('href'));
    if (!url) return null;

    const shortcode = shortcodeFromHref(url);
    const authorEl = TA.sel.authorLink(card);
    const authorHandle = handleFromHref(authorEl?.getAttribute('href')) || handleFromHref(url);

    const textEl = TA.sel.postTextEl(card);
    let text = stripServiceLines(textOf(textEl), authorHandle);

    // Если текстовый блок не нашёлся, вытаскиваем текст карточки, отрезая
    // служебные хвосты: имя автора, время, подписи кнопок.
    if (!text || text.length < 12) {
      text = cleanCardText(textOf(card), authorHandle);
    }

    const c = TA.sel.counts(card);
    const timeEl = TA.sel.timeEl(card);
    const nested = TA.nested?.isNestedReply(card);

    return {
      id: shortcode ? `sc_${shortcode}` : hash(`${authorHandle}|${text.slice(0, 200)}`),
      url,
      shortcode,
      authorHandle,
      authorName: textOf(authorEl) || null,
      text,
      likes: c.likes,
      replies: c.replies,
      reposts: c.reposts,
      // Какие счётчики реально прочитаны: «ноль» и «скрыто» — разные вещи,
      // и фильтры по метрикам обязаны их различать.
      availability: c.availability || { likes: false, replies: false, reposts: false },
      ageMinutes: ageMinutesFrom(timeEl || card),
      isAd: TA.sel.isAd(card),
      isNestedReply: !!nested?.nested,
      nestedBy: nested?.decidedBy,
      mediaAlt: mediaAlt(card),
      hasMedia: !!card.querySelector('img[alt]:not([alt=""]), video'),
    };
  }

  /** Описание вложения — иногда в нём вся суть поста. */
  function mediaAlt(card) {
    const img = [...card.querySelectorAll('img[alt]')]
      .map((i) => i.getAttribute('alt'))
      .filter((a) => a && a.length > 12 && !/^(фото профиля|profile picture|аватар)/i.test(a));
    return img[0] || null;
  }

  /**
   * Срезать служебные строки по краям текста поста.
   *
   * Текстовый блок Threads нередко включает соседние подписи — чаще всего
   * «Перевести» в конце. В промпт это уходить не должно: модель начинает
   * считать их частью реплики собеседника.
   */
  function stripServiceLines(raw, authorHandle) {
    const lines = String(raw || '').split('\n');

    const isJunk = (l) => {
      const t = l.trim();
      if (!t) return true;
      if (TA.sel.isServiceText(t)) return true;
      if (authorHandle && t.toLowerCase() === authorHandle.toLowerCase()) return true;
      return false;
    };

    while (lines.length && isJunk(lines[lines.length - 1])) lines.pop();
    while (lines.length && isJunk(lines[0])) lines.shift();

    return lines.join('\n').trim();
  }

  /** Срезать с текста карточки служебные строки. */
  function cleanCardText(raw, authorHandle) {
    const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const drop = new Set([
      ...TA.sel.LABELS.like, ...TA.sel.LABELS.reply,
      ...TA.sel.LABELS.repost, ...TA.sel.LABELS.share,
      ...TA.sel.LABELS.more, ...TA.sel.LABELS.translate,
      'подписаться', 'follow', 'подписки', 'подписан',
    ].map((s) => s.toLowerCase()));

    return lines
      .filter((l) => {
        const t = l.toLowerCase();
        if (drop.has(t)) return false;
        if (authorHandle && t === authorHandle.toLowerCase()) return false;
        // «2 ч», «3 ч. назад», «14 мин» — подпись времени в любой форме.
        if (TA.sel.isServiceText(l)) return false;
        if (t.length <= 2) return false;
        return true;
      })
      .join('\n')
      .trim();
  }

  /**
   * Собрать посты с текущей страницы, подгружая ленту прокруткой.
   *
   * @param {object} opts { limit, scrolls }
   * @returns {Promise<{posts: Array, strategy: string, scanned: number}>}
   */
  async function scan(opts = {}) {
    const { limit = 60, scrolls = 5 } = opts;
    const byId = new Map();
    let strategy = null;

    const harvest = () => {
      const found = TA.sel.findPostCards();
      strategy = strategy || found.strategy;
      for (const card of found.cards) {
        if (!isVisible(card)) continue;
        let post;
        try { post = parseCard(card); } catch { continue; }
        if (!post || !post.text || post.text.length < 10) continue;
        if (!byId.has(post.id)) byId.set(post.id, post);
      }
    };

    harvest();

    for (let i = 0; i < scrolls && byId.size < limit; i++) {
      const before = byId.size;
      await TA.scroll.screenDown(uniform(0.75, 1.1));

      // Пауза «просматриваю» — заодно даёт ленте догрузиться.
      await sleep(uniform(700, 2400));
      harvest();

      // Лента кончилась или не грузится дальше — не крутим впустую.
      if (byId.size === before && i > 1) {
        await sleep(uniform(900, 2000));
        harvest();
        if (byId.size === before) break;
      }
    }

    const posts = [...byId.values()].slice(0, limit);
    log(`скан: ${posts.length} постов, стратегия «${strategy}»`);
    return { posts, strategy, scanned: byId.size };
  }

  /** Найти на странице карточку по URL поста — нужно, чтобы кликнуть по ней. */
  function findCardByUrl(url) {
    const sc = shortcodeFromHref(url);
    const { cards } = TA.sel.findPostCards();
    for (const card of cards) {
      const link = TA.sel.postLink(card);
      const href = link?.getAttribute('href') || '';
      if (sc && href.includes(sc)) return card;
      if (!sc && absUrl(href) === url) return card;
    }
    return null;
  }

  TA.feed = { scan, parseCard, findCardByUrl, cleanCardText, stripServiceLines };
})();

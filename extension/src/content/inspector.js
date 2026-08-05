/**
 * Инспектор селекторов.
 *
 * Threads меняет разметку без предупреждения, и однажды агент просто перестанет
 * находить кнопку «Ответить». Без диагностики это выглядит как «расширение
 * сломалось» без единой подсказки, что именно чинить.
 *
 * Инспектор прогоняет каждую стратегию поиска на живой странице и показывает,
 * какая сработала, сколько элементов нашла и что именно не нашлось. Этого
 * достаточно, чтобы за пару минут поправить selectors.js — единственный файл,
 * который вообще знает о разметке.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.inspector) return;
  const { textOf, isVisible } = TA.util;

  const OK = 'ok';
  const WARN = 'warn';
  const FAIL = 'fail';

  function run() {
    const report = {
      url: location.href,
      pageKind: TA.sel.pageKind(),
      at: new Date().toISOString(),
      checks: [],
      sample: null,
    };

    const add = (name, status, detail, extra) =>
      report.checks.push({ name, status, detail, ...extra });

    /* --- Карточки постов --- */

    const strategies = [];
    for (const s of TA.sel.POST_STRATEGIES) {
      let n = 0;
      let err = null;
      try {
        n = (s.run() || []).filter((c) => TA.sel.isPostCard(c) && isVisible(c)).length;
      } catch (e) { err = e.message; }
      strategies.push({ name: s.name, found: n, error: err });
    }
    const found = TA.sel.findPostCards();

    add(
      'Карточки постов',
      found.cards.length ? OK : FAIL,
      found.cards.length
        ? `найдено ${found.cards.length} через «${found.strategy}»`
        : 'ни одна стратегия не сработала',
      { strategies },
    );

    /* --- Разбор одной карточки --- */

    const card = found.cards[0];
    if (card) {
      const link = TA.sel.postLink(card);
      const author = TA.sel.authorLink(card);
      const textEl = TA.sel.postTextEl(card);
      const time = TA.sel.timeEl(card);
      const counts = TA.sel.counts(card);
      const like = TA.sel.likeButton(card);
      const replyBtn = TA.sel.replyButton(card);

      add('Ссылка на пост', link ? OK : FAIL,
        link ? link.getAttribute('href') : 'a[href*="/post/"] не найден');

      add('Автор', author ? OK : WARN,
        author ? (author.getAttribute('href') || '') : 'a[href^="/@"] не найден');

      add('Текст поста', textEl && textOf(textEl).length > 10 ? OK : WARN,
        textEl ? `${textOf(textEl).length} символов` : 'текстовый блок не найден');

      add('Отметка времени', time ? OK : WARN,
        time ? (time.getAttribute('datetime') || textOf(time)) : 'time не найден');

      add('Счётчики', counts.likes || counts.replies ? OK : WARN,
        `лайков ${counts.likes}, ответов ${counts.replies}, репостов ${counts.reposts}`);

      add('Кнопка лайка', like ? OK : FAIL,
        like ? `найдена, состояние: ${like.liked ? 'уже лайкнут' : 'не лайкнут'}` : 'не найдена');

      add('Кнопка «Ответить»', replyBtn ? OK : FAIL,
        replyBtn ? `aria-label: ${replyBtn.getAttribute('aria-label') || textOf(replyBtn)}` : 'не найдена');

      let parsed = null;
      try { parsed = TA.feed.parseCard(card); } catch (e) { parsed = { error: e.message }; }
      report.sample = parsed;
    } else {
      add('Разбор карточки', FAIL, 'нет ни одной карточки для проверки');
    }

    /* --- Композер --- */

    const editorStrategies = [];
    for (const s of TA.sel.EDITOR_STRATEGIES) {
      let n = 0;
      try { n = (s.run() || []).filter(isVisible).length; } catch { n = -1; }
      editorStrategies.push({ name: s.name, found: n });
    }
    const editor = TA.sel.findEditor();
    add(
      'Поле ввода',
      editor.el ? OK : WARN,
      editor.el
        ? `найдено через «${editor.strategy}»`
        : 'не найдено — это нормально, если форма ответа сейчас закрыта',
      { strategies: editorStrategies },
    );

    const postBtn = TA.sel.findPostButton();
    add('Кнопка «Опубликовать»', postBtn ? OK : WARN,
      postBtn ? textOf(postBtn) : 'не найдена — нормально при закрытой форме');

    /* --- Ветка --- */

    if (TA.sel.pageKind() === 'post') {
      const th = TA.thread.parse(location.href);
      add('Разбор ветки', th?.root?.text ? OK : FAIL,
        th?.root?.text
          ? `корень @${th.root.authorHandle}, ответов ${th.replies.length}`
          : 'не удалось разобрать');
    } else {
      add('Разбор ветки', WARN, 'открой любой пост, чтобы проверить этот блок');
    }

    /* --- Сторож и сессия --- */

    const alert = TA.guard.scan();
    add('Сторож', alert ? FAIL : OK,
      alert ? `сигнал: ${alert.kind} — ${alert.detail}` : 'предупреждений нет');

    const own = TA.profile.detectOwnHandle();
    add('Мой профиль', own ? OK : WARN,
      own ? `@${own}` : 'не удалось определить — укажи хэндл вручную');

    add('Язык интерфейса', OK, document.documentElement.lang || 'не указан');

    /* --- Новые подсистемы --- */

    const session = TA.guard.loginState();
    add('Сессия Threads', session.loggedIn ? OK : FAIL,
      session.loggedIn
        ? `подтверждена (${Object.entries(session.signals).filter(([, v]) => v).map(([k]) => k).join(', ')})`
        : `не подтверждена, уверенность ${session.confidence}`);

    add('Право действовать', TA.lock.isHeld() ? OK : WARN,
      TA.lock.isHeld()
        ? `у этой вкладки (${TA.lock.holderId})`
        : TA.lock.denyReason() || 'ещё не запрашивалось');

    const ka = TA.keepalive.state();
    add('Защита от троттлинга', ka.audio ? OK : WARN,
      ka.audio
        ? 'звуковой keepalive активен'
        : ka.waitingForGesture
          ? 'ждём первого клика: автовоспроизведение заблокировано браузером'
          : `выключен (${ka.audioState})`);

    if (card) {
      const scoredReply = TA.buttons.findReply(card);
      add('Кнопка ответа: скоринг', scoredReply ? OK : FAIL,
        scoredReply
          ? `${Math.round(scoredReply.score)} баллов — ${scoredReply.why.join(', ')}`
          : 'ни один кандидат не набрал баллов');

      const nested = TA.nested.isNestedReply(card);
      add('Вложенный ответ', nested.nested ? WARN : OK,
        nested.nested
          ? `определён как ответ в ветке (${nested.decidedBy})`
          : `распознан как самостоятельный пост (${nested.decidedBy})`);

      const c = TA.sel.counts(card);
      const avail = c.availability || {};
      add('Доступность метрик', OK,
        Object.entries(avail).map(([k, v]) => `${k}: ${v ? 'прочитана' : 'скрыта'}`).join(', '));
    }

    /* --- Итог --- */

    const fails = report.checks.filter((c) => c.status === FAIL).length;
    const warns = report.checks.filter((c) => c.status === WARN).length;
    report.summary = fails
      ? `${fails} критичных проблем, ${warns} предупреждений`
      : warns
        ? `всё основное работает, ${warns} предупреждений`
        : 'все проверки пройдены';
    report.healthy = fails === 0;

    return report;
  }

  /** Подсветить найденные карточки — визуальная проверка на месте. */
  function highlight(on = true) {
    document.querySelectorAll('.__ta-hl').forEach((el) => {
      el.classList.remove('__ta-hl');
      el.style.outline = '';
    });
    if (!on) return 0;

    const { cards } = TA.sel.findPostCards();
    for (const c of cards) {
      c.classList.add('__ta-hl');
      c.style.outline = '2px dashed #7c5cff';
      c.style.outlineOffset = '-2px';
    }
    return cards.length;
  }

  TA.inspector = { run, highlight, OK, WARN, FAIL };
})();

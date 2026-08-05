/**
 * Поведение «чтения» ленты.
 *
 * Аккаунт, у которого на каждое действие приходится ровно один просмотр,
 * выглядит как бот вне зависимости от того, насколько человечен сам клик.
 * Настоящее соотношение — десятки просмотров, единицы лайков и один
 * комментарий; примерно это здесь и воспроизводится.
 *
 * Время задержки на посте пропорционально объёму текста: мгновенный лайк
 * под длинным постом физически невозможен, и это одна из немногих метрик,
 * которую платформа может проверить точно.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.reading) return;
  const { sleep, textOf, isVisible, inViewport } = TA.util;
  const { uniform, chance, clamp, pick } = TA.rng;

  /**
   * Что на этой странице уже читали.
   *
   * Память обязана быть общей для всех пролистываний одной страницы, а не
   * заводиться заново на каждое. Пока набор жил внутри `browseFeed`, «новой»
   * считалась любая карточка, новая **в пределах одного вызова**, — а в ветке
   * поста их всегда две-три. Значит `fresh` не падал до нуля никогда,
   * `exhausted` не выставлялся, счётчик холостых пролистываний обнулялся
   * каждый раз, и возврат в ленту (`orchestrator`, шаг 6) был недостижим в
   * принципе.
   *
   * 04.08 агент так простоял семнадцать минут в одной ветке, листая её вверх
   * и вниз: 27 повторов строки «часовой лимит 2» подряд и 167 просмотров при
   * `emptyBrowses` равном нулю.
   *
   * Ключ — путь страницы: Threads это SPA, скрипт переживает смену маршрута,
   * и память о прежней странице к новой отношения не имеет.
   */
  let seenPath = null;
  let seenOnPage = new Set();

  function pageSeen() {
    const path = location.pathname + location.search;
    if (path !== seenPath) {
      seenPath = path;
      seenOnPage = new Set();
    }
    /*
     * Потолок нужен только ленте: скрипт живёт, пока открыта вкладка, а лента
     * бесконечна, и за сутки на одном маршруте набор рос бы без края. Сброс
     * ей ничем не вредит — на бесконечной странице новые карточки есть
     * всегда, и признак исчерпания от этого не меняется. У страницы поста до
     * двух тысяч карточек дело не дойдёт никогда.
     */
    if (seenOnPage.size > 2000) seenOnPage = new Set();
    return seenOnPage;
  }

  /** Сколько миллисекунд «читать» текст такой длины. */
  function readingTime(text) {
    const chars = String(text || '').length;
    // Порядка 900 знаков в минуту при беглом чтении с экрана, с широким разбросом.
    const base = (chars / 900) * 60000;
    return clamp(base * uniform(0.65, 1.7) + uniform(600, 2600), 900, 40000);
  }

  /**
   * Сколько задержаться на посте.
   *
   * Раньше время считалось по объёму текста для каждого поста подряд. Это и
   * медленно, и неправдоподобно: человек не вчитывается в каждый пост ленты.
   * Он скользит — полторы-две секунды на карточку, взгляд цепляется за первую
   * строку, — и лишь изредка останавливается и читает целиком.
   *
   * Отсюда две модели вместо одной. Скольжение занимает секунды и покрывает
   * большинство карточек; вчитывание считается по объёму, как раньше, и
   * достаётся примерно каждой четвёртой. Средняя скорость обхода вырастает
   * втрое, а картина поведения становится ближе к настоящей, а не дальше.
   *
   * Длинный пост цепляет чаще короткого — на него и смотрят дольше.
   */
  function dwellOn(text) {
    const chars = String(text || '').length;
    const engaging = clamp(0.18 + chars / 2600, 0.18, 0.5);

    if (chance(engaging)) return readingTime(text) * uniform(0.4, 0.85);
    return uniform(650, 2100);
  }

  /**
   * Пролистать ленту, «читая» попадающиеся посты и, возможно, лайкнув.
   *
   * @param {object} opts { scrolls, maxLikes, onPost }
   * @returns {Promise<{viewed: number, liked: number}>}
   */
  async function browseFeed(opts = {}) {
    const { scrolls = 5, maxLikes = 0, onPost = null } = opts;
    let viewed = 0;
    let liked = 0;
    let fresh = 0;                 // сколько карточек оказалось новыми
    const touched = new Set();
    const seenIds = pageSeen();    // общий на всю страницу, а не на один вызов
    const startY = window.scrollY;

    await TA.scroll.browse(scrolls, async () => {
      const { cards } = TA.sel.findPostCards();
      const visible = cards.filter((c) => inViewport(c, -60) && isVisible(c));
      if (!visible.length) return;

      // Из видимых берём один-два поста и задерживаемся на них.
      const howMany = chance(0.4) ? 2 : 1;
      for (let i = 0; i < howMany && i < visible.length; i++) {
        const card = pick(visible);
        if (!card || touched.has(card)) continue;
        touched.add(card);
        viewed++;

        // Отличаем новые посты от тех же самых, которые просто снова попали
        // в кадр: на конечной странице второе означает, что читать нечего.
        try {
          const id = TA.sel.postLink(card)?.getAttribute('href') || '';
          if (id && !seenIds.has(id)) { seenIds.add(id); fresh++; }
        } catch { /* ссылка не разобралась — не считаем */ }

        const text = textOf(TA.sel.postTextEl(card) || card);

        // Навести курсор — так делает любой, кто действительно читает.
        if (chance(0.4)) await TA.mouse.hover(card);
        await sleep(dwellOn(text));

        if (onPost) {
          try { await onPost(card, text); } catch { /* не роняем обход */ }
        }

        // Лайк ставим не первому попавшемуся, а тому, на чём задержались.
        if (liked < maxLikes && chance(0.45)) {
          const ok = await likeCard(card);
          if (ok) {
            liked++;
            await sleep(uniform(700, 2600));
          }
        }
      }

      if (chance(0.2)) await TA.mouse.drift();
    });

    /*
     * Страница кончилась, если читать на ней больше нечего.
     *
     * Одного счётчика просмотров для этого мало: упёршись в низ конечной
     * страницы, агент продолжает «просматривать» те же карточки, счётчик
     * исправно растёт, и застревание выглядит как обычная работа.
     *
     * Но и «скролл не сдвинулся» недостаточно, и это стоило семнадцати минут
     * топтания в одной ветке 04.08: страница поста длиннее экрана, агент
     * честно ходил по ней вверх и вниз, `moved` было истинно всегда — и
     * признак исчерпания не выставлялся, сколько бы раз он ни перечитывал
     * одно и то же.
     *
     * Решающее — ни одной новой карточки за проход. Движению ленты это не
     * мешает: бесконечная лента всегда подаёт новые, и там `fresh` больше
     * нуля по определению.
     */
    const moved = Math.abs(window.scrollY - startY) > 60;
    const exhausted = fresh === 0 || (!moved && fresh <= 1);

    return { viewed, liked, fresh, exhausted };
  }

  /**
   * Поставить лайк карточке, если он ещё не стоит.
   *
   * Повторный клик по уже лайкнутому посту снимает отметку, поэтому проверка
   * состояния до и после — не формальность. Именно на ней агент и спотыкался:
   * не узнавая своё же «Не нравится», он считал лайк неудавшимся и при
   * следующем проходе снимал только что поставленный.
   */
  async function likeCard(card) {
    const btn = TA.sel.likeButton(card);
    if (!btn) return false;
    if (btn.liked) return false;   // уже лайкнут: второй клик снял бы отметку

    // Часть кнопок Threads отрисовывает только по наведению.
    await TA.buttons.primeActions(card);

    // Перед лайком человек секунду смотрит на пост.
    await sleep(uniform(400, 1800));
    const ok = await TA.mouse.click(btn.el);
    if (!ok) return false;

    await sleep(uniform(400, 1100));

    const after = TA.sel.likeButton(card);
    if (!after) return true;        // кнопка исчезла — считаем, что сработало

    if (!after.liked) {
      TA.util.warn(`лайк не подтвердился: подпись «${after.label}»`);
      return false;
    }
    return true;
  }

  /**
   * Задержаться на открытой ветке перед тем, как отвечать.
   * Читаем корневой пост и ответы, иногда прокручиваем вниз и обратно.
   */
  async function readThread(rootText, replyTexts = []) {
    const total = String(rootText || '').length
      + replyTexts.reduce((s, t) => s + String(t || '').length, 0);

    const budget = readingTime(String(rootText || '')) + readingTime('x'.repeat(total * 0.4));
    const chunks = clamp(Math.round(budget / 2500), 2, 6);

    for (let i = 0; i < chunks; i++) {
      await sleep(budget / chunks * uniform(0.6, 1.4));
      if (i < chunks - 1 && chance(0.65)) {
        await TA.scroll.by(window.innerHeight * uniform(0.2, 0.5));
      }
      if (chance(0.18)) await TA.mouse.drift();
    }

    // Часто перед ответом возвращаются к началу поста.
    if (chance(0.5)) {
      await TA.scroll.by(-window.innerHeight * uniform(0.3, 0.8));
      await sleep(uniform(600, 2200));
    }
  }

  TA.reading = { readingTime, browseFeed, likeCard, readThread };
})();

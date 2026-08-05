/**
 * Прокрутка страницы.
 *
 * window.scrollTo мгновенно телепортирует страницу — ни одного промежуточного
 * события scroll, ни одного wheel. Настоящая прокрутка колесом порождает серию
 * дискретных рывков с затуханием, а прокрутка с тачпада — плавную кривую с
 * инерцией. Здесь воспроизводится колесо: серия шагов с ease-out и микропаузами
 * между «щелчками».
 *
 * Отдельно моделируется то, что человек не листает ленту равномерно: он
 * останавливается на интересном, иногда возвращается назад, иногда проскакивает
 * скучное быстро.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.scroll) return;
  const { sleep } = TA.util;
  const { uniform, gauss, chance, clamp, randInt } = TA.rng;

  /** Событие колеса, чтобы страница видела причину прокрутки. */
  function fireWheel(deltaY) {
    const el = document.elementFromPoint(
      window.innerWidth / 2,
      window.innerHeight / 2,
    ) || document.body;
    try {
      el.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, composed: true,
        deltaY, deltaMode: 0,
        clientX: window.innerWidth / 2, clientY: window.innerHeight / 2,
      }));
    } catch { /* не критично */ }
  }

  /**
   * Прокрутить на заданное число пикселей плавно.
   * @param {number} distance положительное значение — вниз
   */
  async function by(distance, { speed = 1 } = {}) {
    const dist = Math.round(distance);
    if (Math.abs(dist) < 4) return;

    const dir = Math.sign(dist);
    const total = Math.abs(dist);

    // Один «щелчок» колеса — примерно 100 пикселей, но с разбросом.
    const steps = clamp(Math.round(total / uniform(70, 130)), 2, 40);
    let done = 0;

    // Щелчки считаются заранее: пачкой их проиграет фон, поодиночке — мы сами.
    const clicks = [];
    for (let i = 1; i <= steps; i++) {
      // Ease-out: колесо крутят быстро, потом придерживают у цели.
      const t = i / steps;
      const eased = 1 - (1 - t) ** 2;
      const target = Math.round(total * eased);
      const delta = (target - done) * dir;
      done = target;

      if (Math.abs(delta) < 1) continue;

      // Пауза между щелчками колеса, около 40-90 мс с разбросом,
      // изредка — человек замирает посреди прокрутки.
      const gap = clamp(gauss(62, 22), 16, 210) / speed + (chance(0.07) ? uniform(150, 700) : 0);
      clicks.push({ delta, gap });
    }

    /*
     * Доверенное колесо не только сообщает о прокрутке — оно её выполняет.
     *
     * Поэтому `window.scrollBy` здесь не нужен: браузер сдвинет страницу сам,
     * ровно как от живого колеса, и добавка прокрутила бы вдвое. Крутим в
     * точке, где сейчас курсор, а не в центре экрана: колесо действует там,
     * где указатель, и на странице с несколькими прокручиваемыми областями
     * это разные вещи.
     */
    if (TA.input?.available()) {
      const at = TA.mouse?.getCursor?.() || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const ok = await TA.input.play(clicks.map((c) => ({
        op: 'wheel',
        x: Math.round(at.x),
        y: Math.round(at.y),
        dy: c.delta,
        waitMs: Math.round(c.gap),
      })));
      if (ok) {
        /*
         * Пауза на саму прокрутку.
         *
         * Своё `scrollBy` двигало страницу синхронно: вернулись из функции —
         * значит уже прокрутили. Доверенное колесо только отдаёт событие
         * браузеру, а сдвиг и дорисовка происходят после. Без этой паузы
         * следующий шаг — обычно прицеливание в элемент — считал бы
         * координаты по ещё не уехавшей странице и промахивался.
         */
        await sleep(uniform(120, 260));
        return;
      }
    }

    for (const c of clicks) {
      fireWheel(c.delta);
      window.scrollBy(0, c.delta);
      await sleep(c.gap);
    }
  }

  /** Прокрутить примерно на один экран вниз. */
  async function screenDown(factor = 1) {
    await by(window.innerHeight * uniform(0.55, 0.95) * factor);
  }

  /**
   * Пролистать ленту как человек: несколько экранов с остановками,
   * иногда с возвратом назад.
   *
   * @param {number} screens сколько примерно экранов пролистать
   * @param {function} [onStop] вызывается на каждой остановке
   */
  async function browse(screens, onStop) {
    for (let i = 0; i < screens; i++) {
      await screenDown(uniform(0.6, 1.15));

      /*
       * Остановка «почитать».
       *
       * Здесь была двойная плата за одно и то же: пауза на экран плюс пауза на
       * каждый прочитанный пост внутри обработчика. Внимание к посту считается
       * там, где пост и разбирается, а здесь остаётся только перевод взгляда
       * между экранами — он короткий.
       *
       * Длинные отвлечения оставлены: без них ритм получается ровным, а
       * ровность заметнее любой скорости.
       */
      const dwell = chance(0.2)
        ? uniform(1400, 4200)   // задержался на экране
        : uniform(320, 1200);   // пролистнул
      await sleep(dwell);

      if (onStop) {
        try { await onStop(i); } catch { /* обработчик не должен ронять прокрутку */ }
      }

      // Иногда человек возвращается назад — что-то мелькнуло.
      if (chance(0.12)) {
        await by(-window.innerHeight * uniform(0.25, 0.6));
        await sleep(uniform(800, 3000));
        if (chance(0.6)) await by(window.innerHeight * uniform(0.2, 0.5));
      }

      // Изредка отвлёкся надолго.
      if (chance(0.05)) await sleep(uniform(4000, 14000));
    }
  }

  /** Дождаться подгрузки новых постов после прокрутки вниз. */
  async function waitForMore(prevCount, getCount, { timeout = 6000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(300);
      if (getCount() > prevCount) return true;
    }
    return false;
  }

  /** Прокрутить наверх, как это делают — быстро, но не мгновенно. */
  async function toTop() {
    const y = window.scrollY;
    if (y < 50) return;
    await by(-y, { speed: 2.2 });
  }

  /** Случайное «дёрганье» страницы без цели. */
  async function fidget() {
    const d = randInt(60, 240) * (chance(0.5) ? 1 : -1);
    await by(d, { speed: 1.6 });
    await sleep(uniform(200, 900));
  }

  TA.scroll = { by, screenDown, browse, waitForMore, toTop, fidget };
})();

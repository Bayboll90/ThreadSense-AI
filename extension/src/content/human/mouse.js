/**
 * Человеческий курсор и клики.
 *
 * Программный el.click() не порождает ни одного движения мыши. Поведенческие
 * детекторы смотрят именно на это: перед настоящим кликом всегда есть трек
 * mousemove, приближающийся к цели с замедлением, микродрожание руки и
 * ненулевая пауза между mousedown и mouseup.
 *
 * Траектория строится кубической кривой Безье со случайно смещёнными опорными
 * точками — прямая линия к цели так же неестественна, как и её отсутствие.
 * Скорость вдоль траектории задаётся ease-in-out, что воспроизводит закон
 * Фиттса: разгон, крейсер, торможение у цели.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.mouse) return;
  const { sleep, isVisible } = TA.util;
  const { uniform, randInt, gauss, chance, clamp } = TA.rng;

  /** Последняя известная позиция курсора. Стартуем из случайной точки экрана. */
  let cursor = {
    x: Math.round(window.innerWidth * uniform(0.3, 0.7)),
    y: Math.round(window.innerHeight * uniform(0.3, 0.7)),
  };

  const getCursor = () => ({ ...cursor });

  /** Точка на кубической кривой Безье. */
  function bezier(t, p0, p1, p2, p3) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  }

  /** Плавность: медленный старт, быстрая середина, торможение у цели. */
  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }

  function fire(type, x, y, extra = {}) {
    const el = document.elementFromPoint(
      clamp(x, 0, window.innerWidth - 1),
      clamp(y, 0, window.innerHeight - 1),
    );
    if (!el) return null;
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: Math.round(x),
      clientY: Math.round(y),
      screenX: Math.round(x + window.screenX),
      screenY: Math.round(y + window.screenY),
      button: 0,
      buttons: type === 'mousedown' ? 1 : 0,
      ...extra,
    });
    el.dispatchEvent(ev);
    return el;
  }

  function firePointer(type, x, y, extra = {}) {
    const el = document.elementFromPoint(
      clamp(x, 0, window.innerWidth - 1),
      clamp(y, 0, window.innerHeight - 1),
    );
    if (!el) return null;
    try {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: Math.round(x),
        clientY: Math.round(y),
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        ...extra,
      }));
    } catch { /* старые движки не знают PointerEvent — не критично */ }
    return el;
  }

  /**
   * Провести курсор к точке по кривой Безье.
   * Число шагов зависит от дистанции: короткие перемещения не требуют
   * тридцати промежуточных событий.
   */
  async function moveTo(x, y, { speed = 1, pressed = false } = {}) {
    const from = { ...cursor };
    const to = { x, y };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);

    if (dist < 3) {
      cursor = to;
      return;
    }

    // Опорные точки смещаем перпендикулярно направлению — получается лёгкая
    // дуга, как при движении кистью, а не по линейке.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const perp = { x: -dy / dist, y: dx / dist };
    const bow = uniform(-0.22, 0.22) * dist;

    const c1 = {
      x: from.x + dx * uniform(0.15, 0.4) + perp.x * bow * uniform(0.4, 1),
      y: from.y + dy * uniform(0.15, 0.4) + perp.y * bow * uniform(0.4, 1),
    };
    const c2 = {
      x: from.x + dx * uniform(0.6, 0.85) + perp.x * bow * uniform(0.2, 0.7),
      y: from.y + dy * uniform(0.6, 0.85) + perp.y * bow * uniform(0.2, 0.7),
    };

    const steps = clamp(Math.round(dist / uniform(9, 20)), 6, 42);
    const totalMs = clamp(dist * uniform(0.9, 2.1) / speed, 90, 1400);

    /*
     * Трек считается целиком заранее — и при доверенном пути уезжает в фон
     * одной пачкой.
     *
     * Отправлять по точке на сообщение нельзя: сорок обменов с service worker
     * посреди движения растягивают его непредсказуемо, и ровно те интервалы,
     * ради правдоподобности которых всё считается, оказываются шумом канала,
     * а не моделью руки.
     */
    const track = [];
    for (let i = 1; i <= steps; i++) {
      const t = easeInOut(i / steps);
      const p = bezier(t, from, c1, c2, to);
      // Микродрожание: около полутора пикселей, как у настоящей руки.
      const jx = gauss(0, 0.7);
      const jy = gauss(0, 0.7);
      const at = { x: p.x + jx, y: p.y + jy };

      // Изредка курсор запинается — человек отвлёкся на полсекунды.
      const stumble = chance(0.04) ? uniform(60, 220) : 0;
      track.push({ ...at, waitMs: stumble + (totalMs / steps) * uniform(0.6, 1.5) });
    }

    if (TA.input?.available()) {
      const ok = await TA.input.play(track.map((p) => ({
        op: 'move',
        x: Math.round(p.x),
        y: Math.round(p.y),
        pressed,
        waitMs: Math.round(p.waitMs),
      })));
      if (ok) {
        cursor = to;
        return;
      }
      // Отказ — доигрываем прежним путём, чтобы движение не оборвалось на
      // середине: страница уже ждёт курсор у цели.
    }

    for (const p of track) {
      cursor = { x: p.x, y: p.y };
      firePointer('pointermove', cursor.x, cursor.y);
      fire('mousemove', cursor.x, cursor.y);
      await sleep(p.waitMs);
    }

    cursor = to;
  }

  /** Случайная точка внутри элемента, ближе к центру. */
  function pointIn(el, { padding = 0.22 } = {}) {
    const r = el.getBoundingClientRect();
    // Гауссово распределение вокруг центра: человек целится в середину,
    // но не попадает в неё ровно.
    const gx = clamp(0.5 + gauss(0, 0.16), padding, 1 - padding);
    const gy = clamp(0.5 + gauss(0, 0.16), padding, 1 - padding);
    return { x: r.left + r.width * gx, y: r.top + r.height * gy };
  }

  /** Прокрутить элемент в комфортную зону экрана, если он вне её. */
  async function ensureInView(el) {
    const r = el.getBoundingClientRect();
    const top = window.innerHeight * 0.18;
    const bottom = window.innerHeight * 0.78;
    if (r.top >= top && r.bottom <= bottom) return;

    const targetY = window.innerHeight * 0.42;
    const delta = r.top + r.height / 2 - targetY;
    await TA.scroll.by(delta);
    await sleep(uniform(180, 500));
  }

  /**
   * Человеческий клик: подвести курсор, зависнуть, нажать, отпустить.
   * @returns {Promise<boolean>} дошёл ли клик до цели
   */
  async function click(el, { scroll = true, settle = true } = {}) {
    if (!el || !isVisible(el)) return false;

    if (scroll) await ensureInView(el);
    if (!isVisible(el)) return false;

    const p = pointIn(el);
    await moveTo(p.x, p.y);

    // Пауза перед нажатием: глаз должен подтвердить, что курсор на цели.
    await sleep(uniform(70, 320));

    // Иногда курсор чуть уезжает и возвращается — характерная коррекция.
    if (chance(0.18)) {
      await moveTo(p.x + gauss(0, 6), p.y + gauss(0, 6), { speed: 1.8 });
      await sleep(uniform(40, 140));
    }

    // Длительность удержания клавиши у людей — около 60-140 мс.
    const holdMs = Math.round(clamp(gauss(95, 30), 45, 220));

    /*
     * Доверенный клик.
     *
     * Ради него всё и затевалось: у события, рождённого браузером, стоит
     * `isTrusted: true`, и обработчику на странице нечем отличить его от
     * настоящего нажатия. Наведение (`mouseover`, `pointerover`) браузер
     * порождает сам при движении курсора — досылать их руками не нужно, а
     * лишние синтетические события рядом с доверенными выглядели бы страннее,
     * чем их отсутствие.
     */
    if (TA.input?.available()) {
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      const ok = await TA.input.play([
        { op: 'move', x, y, waitMs: uniform(20, 90) },
        { op: 'down', x, y, waitMs: holdMs },
        { op: 'up', x, y },
      ]);
      if (ok) {
        if (settle) await sleep(uniform(120, 420));
        return true;
      }
    }

    firePointer('pointerover', p.x, p.y);
    fire('mouseover', p.x, p.y);
    fire('mouseenter', p.x, p.y);
    await sleep(uniform(20, 90));

    firePointer('pointerdown', p.x, p.y);
    fire('mousedown', p.x, p.y);

    await sleep(holdMs);

    firePointer('pointerup', p.x, p.y);
    fire('mouseup', p.x, p.y);
    const hit = fire('click', p.x, p.y, { detail: 1 });

    // Подстраховка: если синтетический click не дошёл до нужного обработчика
    // (React иногда слушает только на своём корне), дублируем нативным вызовом.
    if (hit && !el.contains(hit) && hit !== el) {
      try { el.click(); } catch { /* элемент мог исчезнуть */ }
    }

    if (settle) await sleep(uniform(120, 420));
    return true;
  }

  /** Просто навести курсор — используется при «чтении» ленты. */
  async function hover(el) {
    if (!el || !isVisible(el)) return false;
    const p = pointIn(el, { padding: 0.3 });
    await moveTo(p.x, p.y);
    firePointer('pointerover', p.x, p.y);
    fire('mouseover', p.x, p.y);
    return true;
  }

  /** Бесцельное движение курсора: человек не держит мышь неподвижно. */
  async function drift() {
    const x = clamp(cursor.x + gauss(0, 140), 30, window.innerWidth - 30);
    const y = clamp(cursor.y + gauss(0, 110), 30, window.innerHeight - 30);
    await moveTo(x, y, { speed: uniform(0.6, 1.2) });
  }

  TA.mouse = { click, hover, moveTo, drift, pointIn, ensureInView, getCursor, randInt };
})();

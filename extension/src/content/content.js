/**
 * Главный цикл агента.
 *
 * Content script — исполнитель. Он тикает, спрашивает у фонового скрипта, что
 * делать, выполняет одну команду и отчитывается. Решения не принимает вообще:
 * вся логика, лимиты и математика живут в service worker.
 *
 * Цикл живёт здесь, а не в фоне, по двум причинам. Техническая: в Manifest V3
 * service worker выгружается через тридцать секунд простоя, и таймер в нём не
 * переживёт даже одной паузы между действиями. Смысловая: агент не должен
 * ничего делать, когда вкладки Threads нет — а именно это и означает
 * «content script не запущен».
 *
 * Важное свойство: одновременно выполняется ровно одна команда. Пока идёт
 * набор текста, новые тики игнорируются — иначе агент начнёт кликать поверх
 * собственной открытой формы.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.started) return;
  TA.started = true;

  const { sleep, log, warn } = TA.util;
  const { uniform } = TA.rng;
  const MSG = TA.MSG;

  let tickSec = 20;
  let busy = false;
  let stopped = false;
  let pendingReport = null;
  let lastCmd = null;
  let singleTab = true;

  /* Сколько «проверяю сессию…» считается отрисовкой, а не событием. */
  const SILENT_SESSION_MS = 4 * 60000;
  /* Как часто повторять жалобу, пока состояние держится. */
  const NO_SESSION_CRY_EVERY_MS = 15 * 60000;
  let noSessionSince = 0;
  let lastNoSessionCry = 0;

  /* ------------------------------ Связь с фоном --------------------------- */

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      // Расширение перезагрузили или обновили — тихо выходим из цикла.
      if (/Extension context invalidated|receiving end does not exist/i.test(e.message || '')) {
        stopped = true;
        TA.overlay?.destroy();
        return null;
      }
      warn('сбой связи с фоном:', e.message);
      return null;
    }
  }

  function alertGuard(alert) {
    send({ type: MSG.GUARD_ALERT, alert });
  }

  /* --------------------------------- Тик ---------------------------------- */

  /**
   * Скрытая вкладка — не всегда фоновая.
   *
   * Здесь стоял безусловный выход по `document.hidden`, и стоял по делу:
   * фоновой вкладке Chrome душит таймеры, а рваный набор выглядит не
   * человечнее, а страннее. Но у флага видимости две разные причины, и
   * лечения у них противоположные.
   *
   * Человек ушёл в соседнюю вкладку — работать нельзя: клики полетят поверх
   * чужой страницы.
   *
   * Рабочий стол не отрисовывается — отключённая RDP-сессия на сервере,
   * свёрнутое окно — и вкладка помечается скрытой, оставаясь единственной и
   * активной. Не работать в этом случае значит не работать никогда: сервер
   * для того и заведён, чтобы к нему никто не был подключён.
   *
   * Различить их изнутри страницы нечем: `document.hidden` одинаков в обоих.
   * Зато это видит фон — только он знает, активна ли вкладка в своём окне.
   * Ответ приходит вместе с пульсом, отдельного запроса не делаем.
   */
  async function tick() {
    if (stopped || busy) return;

    // Пульс сторожевому таймеру уходит раньше любых отказов. Он означает
    // «скрипт жив», а не «агент работает», и до этой правки отправлялся уже
    // после всех проверок — поэтому сознательное молчание было неотличимо от
    // зависания. Живой журнал с сервера: вкладка молчала из-за скрытости, а
    // сторож перезагружал исправную страницу каждые восемь минут по кругу.
    const pulse = await send({ type: MSG.HEARTBEAT, url: location.href, phase: lastCmd?.cmd || 'idle' });

    if (document.hidden && pulse?.front === false) {
      TA.overlay?.set({
        status: 'пауза',
        why: 'открыта другая вкладка',
        next: 0,
        enabled: false,
      });
      return;
    }

    // Без подтверждённой сессии не работаем. Threads показывает гостям такую
    // же ленту, поэтому по наличию постов это не отличить, а цена ошибки
    // высокая: агент отберёт посты, потратит токены на генерацию, упрётся в
    // форму входа при публикации и запишет это себе как теневой бан.
    //
    // Молчание при сомнении — безопасный отказ: ничего не сломается, если
    // агент подождёт лишний тик, и сломается многое, если он поедет вслепую.
    const session = TA.guard.loginState();
    if (!session.loggedIn) {
      TA.overlay?.set({
        status: 'нет входа',
        why: session.confidence === 'high' ? 'войди в Threads в этой вкладке' : 'проверяю сессию…',
        next: 0,
        enabled: false,
      });

      /*
       * Уверенный разлогин уезжает фону сразу, сомнительный — по времени.
       *
       * Осторожность здесь была правильной ровно наполовину: дёргать остановку
       * на промежуточной отрисовке действительно не нужно. Но «сомневаюсь»
       * молчало не тик и не два, а бесконечно — и 04.08.2026 это стоило сорока
       * минут тишины при заблокированном аккаунте. Страница проверки не
       * показывает ни личных разделов, ни приглашения войти, поэтому
       * уверенность остаётся низкой навсегда, и порог по ней не наступает
       * никогда.
       *
       * Сомнение, которое длится минуты, — уже не промежуточное состояние.
       * Оно обязано звучать: пауза по разлогину самоснимается через две
       * минуты, так что ложная тревога стоит дёшево, а молчание — дорого.
       */
      const now = Date.now();
      if (session.confidence === 'high') {
        alertGuard({ kind: 'logged_out', detail: 'сессия Threads не активна' });
      } else {
        if (!noSessionSince) noSessionSince = now;
        const held = now - noSessionSince;
        if (held >= SILENT_SESSION_MS && now - lastNoSessionCry >= NO_SESSION_CRY_EVERY_MS) {
          lastNoSessionCry = now;
          alertGuard({
            kind: 'logged_out',
            detail: `вход не подтверждается ${Math.round(held / 60000)} мин на ${location.pathname}`,
          });
        }
      }
      return;
    }
    noSessionSince = 0;

    // Право действовать принадлежит одной вкладке. Остальные тикают вхолостую:
    // без этого две открытые вкладки Threads дают двух агентов, и реальная
    // нагрузка на аккаунт удваивается при тех же цифрах в счётчиках.
    if (singleTab) {
      const lease = await TA.lock.acquire();
      if (!lease.ok) {
        TA.overlay?.set({
          status: 'ждёт очереди',
          why: lease.reason,
          next: 0,
          enabled: false,
        });
        return;
      }
    }

    busy = true;
    try {
      const report = pendingReport;
      pendingReport = null;

      /*
       * Вид страницы уходит вместе с адресом, а не выводится из него в фоне.
       *
       * Фон об адресе знает с чужих слов: `sender.tab.url` обновляется не в
       * тот же миг, что `location`, а в SPA маршрут меняется и вовсе без
       * навигации. Страница знает о себе точно — пусть она и отвечает.
       */
      const cmd = await send({
        type: MSG.TICK, report, url: location.href, kind: TA.sel.pageKind(),
      });
      if (!cmd || !cmd.ok) return;

      TA.overlay?.set({ enabled: !!cmd.live });
      applyRuntimeFlags(cmd);
      lastCmd = cmd;
      await execute(cmd);
    } catch (e) {
      warn('ошибка тика:', e);
      pendingReport = { step: 'error', at: lastCmd?.cmd || 'tick', error: e?.message || String(e) };
    } finally {
      busy = false;
    }
  }

  /* ----------------------------- Исполнение ------------------------------- */

  async function execute(cmd) {
    switch (cmd.cmd) {
      case MSG.CMD_IDLE:
        return onIdle(cmd);

      case MSG.CMD_GOTO:
        return onGoto(cmd);

      case MSG.CMD_SCAN:
        return onScan(cmd);

      case MSG.CMD_BROWSE:
        return onBrowse(cmd);

      case MSG.CMD_OPEN_THREAD:
        return onOpenThread(cmd);

      case MSG.CMD_REPLY:
        return onReply(cmd);

      case MSG.CMD_POST:
        return onPost(cmd);

      case MSG.CMD_RECHECK:
        return onRecheck(cmd);

      case MSG.CMD_RELOAD:
        return onReload(cmd);

      default: {
        /*
         * Неизвестная команда — это поломка, а не мелочь.
         *
         * Раньше здесь стояла запись в консоль страницы и всё. Фон при этом не
         * получал ничего: ни отчёта, ни ошибки. Со стороны журнала выглядело
         * так, будто команду выдали и она бесследно растворилась, — а искать
         * причину приходилось в самом действии, которого не было.
         *
         * Реальный случай: `CMD_POST` добавили в общий список сообщений, но не
         * в его копию для content-скриптов. Значение оказалось `undefined`,
         * ветка не совпала ни с чем, и публикация тихо не происходила.
         */
        warn('неизвестная команда:', cmd.cmd);
        pendingReport = {
          step: 'error',
          at: cmd.cmd || 'unknown',
          error: `content script не знает команду «${cmd.cmd}»`,
        };
        setTimeout(tick, uniform(2000, 4000));
      }
    }
  }

  /**
   * Ступень восстановления: перезагрузка страницы.
   *
   * Конвейер персистится, поэтому после перезагрузки агент поднимется и
   * продолжит с того же места. Здесь важно только отдать право действовать:
   * иначе новая копия скрипта упрётся в аренду, которую держит уходящая.
   */
  async function onReload(cmd) {
    TA.overlay?.set({ status: 'перезагрузка', why: cmd.why || '', next: 0 });
    await TA.lock.release();
    await sleep(uniform(400, 1200));
    location.reload();
  }

  /**
   * Настройки, влияющие на поведение самого тикера, приходят вместе с командой.
   * Отдельного запроса не делаем: тик и так ходит в фон каждые несколько секунд.
   */
  function applyRuntimeFlags(cmd) {
    if (typeof cmd.singleTab === 'boolean') singleTab = cmd.singleTab;

    if (typeof cmd.keepaliveAudio === 'boolean') {
      if (cmd.keepaliveAudio && cmd.live) TA.keepalive.start();
      else TA.keepalive.stop();
    }
  }

  function onIdle(cmd) {
    TA.overlay?.set({
      status: 'ждём',
      why: cmd.why || '',
      next: Date.now() + (cmd.waitMs || 0),
    });
  }

  async function onGoto(cmd) {
    TA.overlay?.set({ status: 'переход', why: cmd.why || '', next: 0 });

    // Пауза перед навигацией: человек не переключает разделы мгновенно.
    await sleep(uniform(600, 2400));

    // history.pushState заставляет SPA перерисоваться без полной перезагрузки —
    // это и быстрее, и ближе к тому, что происходит при клике по навигации.
    try {
      const before = location.href;
      history.pushState({}, '', cmd.url);
      window.dispatchEvent(new PopStateEvent('popstate'));
      const moved = await TA.util.waitFor(() => location.href !== before, { timeout: 1500 });
      if (!moved || !document.querySelector('a[href*="/post/"]')) {
        location.href = cmd.url;
      }
    } catch {
      location.href = cmd.url;
    }

    await sleep(uniform(1200, 3000));
    pendingReport = { step: 'goto', url: location.href };
  }

  async function onScan(cmd) {
    TA.overlay?.set({ status: 'смотрим ленту', why: cmd.why || '', next: 0 });

    const { posts, strategy } = await TA.feed.scan({
      limit: cmd.limit || 60,
      scrolls: cmd.scrolls || 5,
    });

    log(`отдаём ${posts.length} постов (${strategy})`);
    pendingReport = { step: 'scan', posts, strategy };

    // Отчёт нужен фону сразу, а не через полный интервал тика: пока мы
    // ждём, лента успевает уехать и выбранная цель окажется вне экрана.
    setTimeout(tick, uniform(800, 2500));
  }

  async function onBrowse(cmd) {
    TA.overlay?.set({ status: 'читаем', why: cmd.why || '', next: 0 });

    const r = await TA.reading.browseFeed({
      scrolls: cmd.scrolls || 5,
      maxLikes: cmd.maxLikes || 0,
    });

    pendingReport = {
      step: 'browse',
      viewed: r.viewed,
      liked: r.liked > 0,
      likes: r.liked,
      fresh: r.fresh,
      exhausted: r.exhausted,   // страница кончилась: скролл не сдвинулся, новых постов нет
    };
  }

  async function onOpenThread(cmd) {
    TA.overlay?.set({ status: 'открываем ветку', why: cmd.why || '', next: 0 });

    const r = await TA.thread.openAndParse(cmd.url);
    if (!r.ok) {
      pendingReport = { step: 'error', at: 'open', error: r.error };
      setTimeout(tick, 1500);
      return;
    }

    pendingReport = { step: 'open', thread: r.thread, postId: cmd.postId };
    setTimeout(tick, uniform(600, 1800));
  }

  async function onReply(cmd) {
    TA.overlay?.set({ status: 'пишем ответ', why: cmd.why || '', next: 0 });

    // Ручная публикация из очереди может прийти, когда мы не на странице поста.
    if (cmd.manual && cmd.url && !location.href.includes(TA.util.shortcodeFromHref(cmd.url) || ' ')) {
      const opened = await TA.thread.openAndParse(cmd.url);
      if (!opened.ok) return { ok: false, error: opened.error };
    }

    // С повторами: перерисовка страницы и не открывшаяся с первого раза форма —
    // причины временные, и бросать из-за них выбранную цель незачем. Цикл поиска
    // новой стоит на порядок дороже, чем повторная попытка.
    const r = await TA.composer.replyWithRetry({
      text: cmd.text,
      replyTo: cmd.replyTo,
      typing: cmd.typing || {},
      attempts: cmd.attempts ?? 3,
    });

    if (r.alert) alertGuard(r.alert);

    if (cmd.manual) return r; // ручной режим отвечает напрямую вызывающему

    pendingReport = {
      step: 'reply',
      ok: r.ok,
      verified: r.verified,
      inconclusive: r.inconclusive,
      error: r.error,
      postId: cmd.postId,
      elapsedMs: r.elapsedMs,
    };
    setTimeout(tick, uniform(1500, 4000));
    return r;
  }

  /**
   * Опубликовать собственный пост.
   *
   * Отличие от ответа в том, где это можно делать: композер на странице чужой
   * ветки создаёт ответ, а не запись в профиль, поэтому пост пишется только с
   * главной. Возвращать туда — забота фона: он один видит всю картину и уже
   * делает это для просмотров и лайков. Здесь только отказ с внятным кодом,
   * иначе получится две независимые навигации, спорящие друг с другом.
   */
  async function onPost(cmd) {
    TA.overlay?.set({ status: 'пишем пост', why: cmd.why || '', next: 0 });

    const r = await TA.publisher.publish({
      text: cmd.text,
      parts: cmd.parts,
      // Части, где важен каждый знак: набираются без промахов и сверяются строго.
      exact: cmd.exact || [],
      topic: cmd.topic,
      image: cmd.image || null,
      typing: cmd.typing || {},
    });

    if (r.alert) alertGuard(r.alert);

    if (cmd.manual) return r;

    pendingReport = {
      step: 'post',
      ok: r.ok,
      error: r.error,
      code: r.code,
      kind: cmd.kind,
      newsId: cmd.newsId,
      slot: cmd.slot,
      // Тема отдельно от успеха: пост мог выйти прекрасно и без неё, и фон
      // должен видеть это раздельно, а не гадать по отсутствию поля.
      topic: r.topic || null,
      topicWhy: r.topicWhy || null,
      topicUnconfirmed: !!r.topicUnconfirmed,
      // Картинка тоже отдельно: пост без неё — полноценный пост, но фон должен
      // видеть, прикрепилась ли она, иначе поломку прикрепления не заметить.
      image: !!r.image,
      imageWhy: r.imageWhy || null,
      // Текст возвращается фону: он нужен для защиты от самоповтора, а фон
      // после перезапуска service worker своей копии уже не помнит.
      // Возвращаем все части: фон помнит опубликованное для защиты от
      // самоповтора, а при сбое на середине частей уходит меньше задуманного.
      text: r.ok ? cmd.text : null,
      parts: r.ok ? (cmd.parts || [cmd.text]).slice(0, r.parts || 1) : null,
    };
    setTimeout(tick, uniform(2500, 6000));
    return r;
  }

  /**
   * Жив ли наш прежний ответ в ветке.
   *
   * Открываем ветку и ищем свой текст среди ответов. Отсутствие само по себе
   * ничего не доказывает — автор мог удалить комментарий, — поэтому здесь
   * только факт, а выводы делает фон по серии проверок.
   *
   * Ветка могла исчезнуть целиком: пост удалили, автор закрылся. Это не то же
   * самое, что «наш ответ сняли», и в отчёт идёт отдельным признаком.
   */
  async function onRecheck(cmd) {
    TA.overlay?.set({ status: 'проверяем прежний ответ', why: cmd.why || '', next: 0 });

    let alive = null;
    let threadGone = false;
    let seen = 0;
    let declared = 0;

    try {
      const opened = await TA.thread.openAndParse(cmd.url);
      if (!opened.ok) {
        threadGone = true;
      } else {
        const needle = TA.guard.normalizeForMatch(cmd.needle || '');
        const { cards } = TA.sel.findPostCards();
        const found = cards.some((c) => TA.guard.normalizeForMatch(TA.util.textOf(c)).includes(needle));

        /*
         * Не нашли — ещё не значит «пропал».
         *
         * Threads показывает под постом не все ответы: у ветки с полусотней
         * реплик на странице их десяток, остальные прячутся за «показать
         * ещё». Нашего свежего ответа среди показанных может не быть просто
         * потому, что он не набрал лайков и стоит ниже.
         *
         * Поэтому отсутствие считается пропажей только тогда, когда мы видели
         * ветку целиком: показанных ответов не меньше, чем счётчик у корня.
         * Иначе честный ответ — «не знаем», и серия не двигается.
         */
        const root = opened.thread?.root;
        seen = opened.thread?.replies?.length || 0;
        // Непрочитанный счётчик — тоже «не знаем»: ноль в нём означает
        // «скрыто», а не «ответов нет, значит наш удалён».
        declared = root?.availability?.replies ? (Number(root.replies) || 0) : null;
        alive = found ? true : (declared != null && seen >= declared ? false : null);
      }
    } catch (e) {
      warn('перепроверка не удалась:', e.message);
      threadGone = true;
    }

    pendingReport = {
      step: 'recheck',
      url: cmd.url,
      author: cmd.author || null,
      // Пропавшая ветка не считается пропавшим ответом: причина другая.
      alive: threadGone ? true : alive,
      threadGone,
      seen,
      declared,
    };
    setTimeout(tick, uniform(2000, 5000));
    return { ok: true, alive, threadGone };
  }

  /* ------------------------- Сообщения от расширения ---------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case MSG.CMD_INSPECT:
          sendResponse({ ok: true, report: TA.inspector.run() });
          break;

        case 'ta_ping':
          // Пульс для фона: он ждёт, пока скрипт поднимется после навигации.
          sendResponse({ ok: true, url: location.href, kind: TA.sel.pageKind() });
          break;

        case MSG.CMD_COLLECT_STYLE: {
          // Собираем только с текущей страницы: по вкладкам профиля нас водит фон.
          TA.overlay?.set({ status: 'собираем стиль', why: location.pathname, next: 0 });
          const r = await TA.profile.collectCurrentPage(msg.handle);
          TA.overlay?.set({ status: r.ok ? 'страница собрана' : 'не вышло', why: '', next: 0 });
          sendResponse(r);
          break;
        }

        case MSG.CMD_REPLY: {
          if (busy) { sendResponse({ ok: false, error: 'агент занят другим действием' }); break; }
          busy = true;
          try {
            const r = await onReply({ ...msg, manual: true });
            sendResponse(r || { ok: false, error: 'нет результата' });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          } finally {
            busy = false;
          }
          break;
        }

        case MSG.CMD_STATUS:
          TA.overlay?.set(msg.patch || {});
          sendResponse({ ok: true });
          break;

        case 'ta_highlight':
          sendResponse({ ok: true, count: TA.inspector.highlight(msg.on) });
          break;

        case 'ta_detect_handle':
          sendResponse({ ok: true, handle: TA.profile.detectOwnHandle() });
          break;

        default:
          sendResponse({ ok: false, error: 'неизвестная команда' });
      }
    })().catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  });

  /* -------------------------------- Запуск -------------------------------- */

  async function boot() {
    const hello = await send({ type: MSG.CONTENT_READY, url: location.href });
    if (hello?.tickSec) tickSec = hello.tickSec;

    // Плашка на странице — только если её прямо попросили. Прежнее «показывать,
    // пока не запретили» и оставило агенту опознавательный знак в DOM сайта.
    TA.overlay.configure(hello?.overlay);
    if (hello?.overlay === 'page') TA.overlay.show(false);

    TA.guard.start((alert) => {
      alertGuard(alert);
      TA.overlay?.set({ status: 'стоп', why: `сторож: ${alert.kind}`, next: 0 });
    });

    // Первый тик через случайную паузу: одновременный старт во всех вкладках
    // после перезагрузки браузера — сам по себе паттерн.
    setTimeout(tick, uniform(3000, 9000));
    setInterval(tick, tickSec * 1000);

    log('агент запущен, тик каждые', tickSec, 'с');
  }

  // Threads — SPA: смена маршрута не перезапускает скрипт, но конвейер
  // должен знать, что страница сменилась.
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== lastPath) {
      lastPath = now;
      log('маршрут сменился:', now);
    }
  }, 1500);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

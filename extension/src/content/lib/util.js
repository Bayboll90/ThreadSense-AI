/**
 * База content script.
 *
 * Content-скрипты в Manifest V3 не поддерживают ES-модули: файлы из массива
 * `js` манифеста выполняются последовательно в общей изолированной области.
 * Поэтому вместо import/export здесь общее пространство имён `window.__TA`,
 * куда каждый файл дописывает свой раздел.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.util) return;

  /**
   * Типы сообщений. Дублируют src/common/messages.js — модуль оттуда
   * недоступен в классическом content-скрипте. Источник правды там;
   * при правке протокола менять оба места.
   */
  TA.MSG = {
    TICK: 'tick',
    REPORT: 'report',
    GUARD_ALERT: 'guard_alert',
    CONTENT_READY: 'content_ready',

    CMD_IDLE: 'cmd_idle',
    CMD_SCAN: 'cmd_scan',
    CMD_GOTO: 'cmd_goto',
    CMD_BROWSE: 'cmd_browse',
    CMD_OPEN_THREAD: 'cmd_open',
    CMD_REPLY: 'cmd_reply',
    CMD_POST: 'cmd_post',
    CMD_RECHECK: 'cmd_recheck',
    CMD_LIKE: 'cmd_like',
    CMD_COLLECT_STYLE: 'cmd_style',
    CMD_INSPECT: 'cmd_inspect',
    CMD_STATUS: 'cmd_status',
    CMD_RELOAD: 'cmd_reload',

    LEASE: 'lease',
    HEARTBEAT: 'heartbeat',
    INPUT: 'input',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  /** Ждать выполнения условия с опросом. Возвращает результат или null по таймауту. */
  async function waitFor(fn, { timeout = 8000, interval = 120 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const v = fn();
        if (v) return v;
      } catch { /* элемент ещё не готов */ }
      await sleep(interval);
    }
    return null;
  }

  /** Видим ли элемент физически: есть размер, не скрыт, не за пределами. */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    return true;
  }

  /** Находится ли элемент в пределах экрана хотя бы частично. */
  function inViewport(el, margin = 0) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > -margin && r.top < window.innerHeight + margin;
  }

  /** Текст элемента без служебного мусора. */
  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Разбор счётчика Threads.
   * Форматы: «12», «1,2 тыс.», «1.2K», «3,4 млн», «5 400».
   *
   * Берётся только первое число строки и только вплотную стоящий к нему
   * суффикс. Раньше пробел трактовался как разделитель разрядов слишком
   * вольно, и строка «214 18 18 ответов» превращалась в одно число из
   * склеенных цифр. Поэтому группировка пробелами признаётся лишь в строгом
   * виде «1 234», где после каждого пробела ровно три цифры.
   */
  function parseCount(raw) {
    if (raw == null) return 0;
    const s = String(raw).toLowerCase().replace(/\u00A0/g, ' ').trim();
    if (!s) return 0;

    // «5 400», «1 234 567» — но не «214 18 18».
    const grouped = s.match(/^\d{1,3}(?: \d{3})+(?![\d.,])/);
    if (grouped) return Number(grouped[0].replace(/\D/g, ''));

    const m = s.match(/^\D*?(\d+(?:[.,]\d+)?)[ ]?(тыс|тис|k|к|млн|m|м|b|млрд)?/i);
    if (!m) return 0;

    const num = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(num)) return 0;

    const suffix = (m[2] || '').toLowerCase();
    if (['тыс', 'тис', 'k', 'к'].includes(suffix)) return Math.round(num * 1000);
    if (['млн', 'm', 'м'].includes(suffix)) return Math.round(num * 1e6);
    if (['b', 'млрд'].includes(suffix)) return Math.round(num * 1e9);

    return Math.round(num);
  }

  /** Шаблон одного счётчика: не захватывает соседние числа. */
  const COUNT_SRC = '(?:\\d{1,3}(?: \\d{3})+|\\d+(?:[.,]\\d+)?)[ ]?(?:тыс\\.?|тис\\.?|млн|млрд|[kкmм])?';

  /** Возраст поста в минутах по атрибуту datetime либо по подписи «2 ч». */
  function ageMinutesFrom(el) {
    if (!el) return null;

    const time = el.matches?.('time') ? el : el.querySelector?.('time[datetime], time[title]');
    const iso = time?.getAttribute?.('datetime');
    if (iso) {
      const t = Date.parse(iso);
      if (isFinite(t)) return Math.max(0, (Date.now() - t) / 60000);
    }

    const label = textOf(time) || '';
    return parseRelativeAge(label);
  }

  /**
   * «5 м», «2 ч», «3 д», «2 часа», «5m», «2h», «сейчас».
   *
   * Единица вытаскивается как целое слово и разбирается по префиксу. Прежний
   * вариант опирался на \b («ч\b», «м\b»), а в JavaScript \b определяется по
   * ASCII: после кириллической буквы границы слова не возникает, и подписи
   * вида «2 ч» не разбирались вовсе. Заметно это было только там, где у
   * элемента time нет атрибута datetime.
   */
  function parseRelativeAge(label) {
    const s = String(label || '').toLowerCase().replace(/\u00A0/g, ' ').trim();
    if (!s) return null;
    if (/сейчас|только что|now|just now/.test(s)) return 0;

    const m = s.match(/(\d+)\s*([a-zа-яё]+)/i);
    if (!m) return null;

    const n = Number(m[1]);
    const u = m[2];
    if (!isFinite(n)) return null;

    // Порядок важен: «мес» должен проверяться раньше «м», иначе месяцы
    // превратятся в минуты.
    if (/^(г|год|лет|y)/.test(u)) return n * 525600;
    if (/^(мес|mo)/.test(u)) return n * 43200;
    if (/^(нед|w)/.test(u)) return n * 10080;
    if (/^(д|дн|сут|d)/.test(u)) return n * 1440;
    if (/^(ч|час|h)/.test(u)) return n * 60;
    if (/^(мин|м|m)/.test(u)) return n;
    if (/^(сек|с|s)/.test(u)) return n / 60;
    return null;
  }

  /** Ближайший предок, удовлетворяющий предикату. */
  function closestBy(el, predicate, maxUp = 12) {
    let node = el;
    for (let i = 0; node && i < maxUp; i++) {
      if (predicate(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** Абсолютный URL из href. */
  function absUrl(href) {
    if (!href) return null;
    try { return new URL(href, location.origin).toString(); } catch { return null; }
  }

  /** Хэндл автора из ссылки вида /@name или /@name/post/xxx. */
  function handleFromHref(href) {
    if (!href) return null;
    const m = String(href).match(/\/@([A-Za-z0-9._]+)/);
    return m ? m[1] : null;
  }

  /** Шорткод поста из ссылки. */
  function shortcodeFromHref(href) {
    if (!href) return null;
    const m = String(href).match(/\/post\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  /** Быстрый строковый хеш. Должен совпадать с common/text.js. */
  function hash(s) {
    let h = 0x811c9dc5;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** Логирование в консоль страницы с общим префиксом. */
  function log(...args) {
    if (TA.debug) console.log('%c[ThreadSense AI]', 'color:#7c5cff;font-weight:600', ...args);
  }
  function warn(...args) {
    console.warn('%c[ThreadSense AI]', 'color:#f5a524;font-weight:600', ...args);
  }

  TA.util = {
    sleep, waitFor, isVisible, inViewport, textOf, parseCount, COUNT_SRC,
    ageMinutesFrom, parseRelativeAge, closestBy, absUrl,
    handleFromHref, shortcodeFromHref, hash, log, warn,
  };
  TA.debug = false;
})();

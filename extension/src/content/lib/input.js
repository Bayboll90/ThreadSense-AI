/**
 * Клиент доверенного ввода.
 *
 * Страница знает геометрию и намерение — куда вести курсор, какой символ
 * набрать, сколько ждать между ними. Породить настоящее событие она не может:
 * `dispatchEvent` из content script всегда даёт `isTrusted: false`. Поэтому
 * намерение уезжает в фон, а он проигрывает его через отладчик браузера.
 *
 * Правило простое: **сначала пробуем доверенный путь, при отказе работаем
 * прежним**. Отказ — это не поломка: отладчик может быть занят DevTools,
 * запрещён политикой или выключен настройкой. Агент в этом случае теряет в
 * скрытности, но не в работоспособности, и это правильный размен: молчащий
 * агент бесполезен, а заметный — хотя бы работает.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.input) return;

  /**
   * Пока `null` — не знаем, есть ли доверенный ввод. Ответ приходит в
   * `CONTENT_READY` при запуске и уточняется первым же отказом.
   */
  let enabled = null;
  let lastError = '';

  function configure(flag) {
    enabled = !!flag;
  }

  function available() {
    return enabled === true;
  }

  /**
   * Проиграть последовательность операций.
   *
   * @param {Array<object>} ops операции вида {op, x, y, waitMs, ...}
   * @returns {Promise<boolean>} удалось ли доверенным путём
   */
  async function play(ops) {
    if (enabled === false || !ops?.length) return false;

    try {
      const r = await chrome.runtime.sendMessage({ type: TA.MSG.INPUT, ops });
      if (r?.ok) return true;

      /*
       * Отказ выключает доверенный путь до перезагрузки страницы.
       *
       * Повторять запрос на каждый символ бессмысленно: причины отказа —
       * отсутствие разрешения, занятый отладчик, выключенная настройка — за
       * время одного набора не меняются, зато лишний обмен сообщениями между
       * символами растягивает интервалы и портит ровно ту правдоподобность,
       * ради которой всё и затевалось.
       */
      enabled = false;
      lastError = r?.error || 'отказ без причины';
      TA.util?.warn?.('доверенный ввод недоступен:', lastError);
      return false;
    } catch (e) {
      enabled = false;
      lastError = e?.message || String(e);
      return false;
    }
  }

  /** Виртуальный код клавиши по символу — Windows-раскладка, как в CDP. */
  function vkFor(ch) {
    if (ch === ' ') return 32;
    if (ch === '\n') return 13;
    const up = ch.toUpperCase();
    if (up >= 'A' && up <= 'Z') return up.charCodeAt(0);
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0);
    return 0;
  }

  TA.input = { configure, available, play, vkFor, error: () => lastError };
})();

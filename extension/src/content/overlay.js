/**
 * Плашка агента на странице Threads.
 *
 * Нужна не для красоты: когда агент работает в фоне твоей же вкладки, важно
 * одним взглядом понимать, что он делает прямо сейчас и когда пошевелится
 * дальше. Без этого поведение выглядит как случайные подёргивания страницы.
 *
 * Плашку можно свернуть и выключить в настройках.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.overlay) return;

  let root = null;
  let collapsed = false;
  let hidden = false;

  /**
   * Показывать ли плашку на самой странице.
   *
   * По умолчанию — нет, и это главное изменение после 04.08.2026. Узел с
   * текстом «ThreadSense AI» лежал прямо в `document.documentElement` сайта,
   * а стили `.__ta-overlay` приезжали в `document.styleSheets` из манифеста.
   * И то, и другое страница читает одной строкой, то есть агент носил
   * опознавательный знак на себе всё время работы.
   *
   * Состояние никуда не делось: его показывает отдельное окно расширения,
   * которое в DOM сайта не попадает, но попадает в снимок экрана сервера.
   */
  let onPage = false;

  const state = { status: 'ожидание', why: '', next: 0, day: '', enabled: false };

  /** Стили держим при себе, а не в общей таблице страницы. */
  const CSS = `
    .__ta-overlay{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:230px;
      font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#e7e7ea;background:#1b1b1f;
      border:1px solid #34343a;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden}
    .__ta-head{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#232329}
    .__ta-title{flex:1;font-weight:600}
    .__ta-dot{width:7px;height:7px;border-radius:50%;background:#3ecf6b}
    .__ta-off .__ta-dot{background:#8a8a92}
    .__ta-btn{border:0;background:transparent;color:#9a9aa2;cursor:pointer;font-size:13px;padding:0 3px}
    .__ta-body{padding:7px 9px 9px}
    .__ta-collapsed .__ta-body{display:none}
    .__ta-row{margin-top:2px}
    .__ta-status{font-weight:600}
    .__ta-why,.__ta-next,.__ta-day{color:#9a9aa2}`;

  function configure(mode) {
    onPage = mode === 'page' || mode === true;
    if (!onPage) destroy();
  }

  function ensure() {
    if (root?.isConnected) return root;

    root = document.createElement('div');
    root.className = '__ta-overlay';
    root.innerHTML = `
      <div class="__ta-head">
        <span class="__ta-dot"></span>
        <span class="__ta-title">ThreadSense AI</span>
        <button class="__ta-btn" data-act="collapse" title="Свернуть">–</button>
        <button class="__ta-btn" data-act="hide" title="Скрыть до перезагрузки">×</button>
      </div>
      <div class="__ta-body">
        <div class="__ta-row __ta-status">—</div>
        <div class="__ta-row __ta-why"></div>
        <div class="__ta-row __ta-next"></div>
        <div class="__ta-row __ta-day"></div>
      </div>`;

    root.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (act === 'collapse') {
        collapsed = !collapsed;
        root.classList.toggle('__ta-collapsed', collapsed);
      } else if (act === 'hide') {
        hidden = true;
        root.remove();
      }
    });

    // Стиль кладём внутрь плашки, а не в общую таблицу страницы: правило
    // `.__ta-overlay` в `document.styleSheets` видно любому скрипту сайта.
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    document.documentElement.appendChild(root);
    return root;
  }

  function render() {
    if (hidden || !onPage) return;
    const el = ensure();

    el.classList.toggle('__ta-off', !state.enabled);
    el.querySelector('.__ta-status').textContent = state.status;
    el.querySelector('.__ta-why').textContent = state.why || '';

    const nextEl = el.querySelector('.__ta-next');
    if (state.next > Date.now()) {
      const sec = Math.round((state.next - Date.now()) / 1000);
      nextEl.textContent = sec > 90 ? `дальше через ${Math.round(sec / 60)} мин` : `дальше через ${sec} с`;
    } else {
      nextEl.textContent = '';
    }

    el.querySelector('.__ta-day').textContent = state.day || '';
  }

  function set(patch) {
    Object.assign(state, patch);
    render();
  }

  function show(enabled) {
    hidden = false;
    state.enabled = enabled;
    render();
  }

  function destroy() {
    hidden = true;
    root?.remove();
    root = null;
  }

  // Обратный отсчёт обновляем сами — сообщения от фонового скрипта редкие.
  setInterval(() => { if (!hidden && root?.isConnected) render(); }, 1000);

  TA.overlay = { set, show, destroy, render, configure };
})();

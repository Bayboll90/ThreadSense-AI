/**
 * Протокол обмена между service worker, content script и страницами UI.
 * Один источник правды на все три контекста.
 */

export const MSG = {
  /* content -> bg */
  TICK: 'tick',                   // тикер спрашивает: что делать дальше?
  REPORT: 'report',               // отчёт о выполненном шаге
  GUARD_ALERT: 'guard_alert',     // обнаружена блокировка/челлендж/капча
  CONTENT_READY: 'content_ready',
  LEASE: 'lease',                 // аренда права действовать: одна вкладка на всех
  HEARTBEAT: 'heartbeat',         // пульс для сторожевого таймера
  INPUT: 'input',                 // проиграть ввод от имени браузера (CDP)

  /* bg -> content (команды) */
  CMD_IDLE: 'cmd_idle',           // ничего не делать
  CMD_SCAN: 'cmd_scan',           // собрать посты с текущей страницы
  CMD_GOTO: 'cmd_goto',           // перейти на URL внутри SPA
  CMD_BROWSE: 'cmd_browse',       // холостое поведение: скролл, чтение, лайки
  CMD_OPEN_THREAD: 'cmd_open',    // открыть ветку и распарсить
  CMD_REPLY: 'cmd_reply',         // ввести и отправить ответ
  CMD_POST: 'cmd_post',           // опубликовать собственный пост в профиль
  CMD_RECHECK: 'cmd_recheck',     // жив ли наш прежний ответ в ветке
  CMD_LIKE: 'cmd_like',           // лайкнуть пост
  CMD_COLLECT_STYLE: 'cmd_style', // собрать свои посты с профиля
  CMD_INSPECT: 'cmd_inspect',     // диагностика селекторов
  CMD_STATUS: 'cmd_status',       // обновить плашку на странице
  CMD_RELOAD: 'cmd_reload',       // перезагрузить страницу: ступень восстановления

  /* ui -> bg */
  UI_GET_STATUS: 'ui_status',
  UI_TOGGLE: 'ui_toggle',
  UI_TEST_KEY: 'ui_test_key',
  UI_TRAIN_STYLE: 'ui_train_style',
  UI_QUEUE_ACTION: 'ui_queue_action',   // approve | reject | edit | regen
  UI_RESET_STATE: 'ui_reset_state',
  UI_SET_PRESET: 'ui_set_preset',  // выбрать режим работы целиком
  UI_POST_NOW: 'ui_post_now',     // опубликовать свой пост, не дожидаясь слота
  UI_RUN_INSPECTOR: 'ui_inspector',
  UI_PREVIEW_HUMANIZE: 'ui_preview_humanize',
  UI_DRY_RUN: 'ui_dry_run',             // прогон без публикации
  UI_CLEAR_HALT: 'ui_clear_halt',

  /* bg -> ui (пуш) */
  PUSH_STATUS: 'push_status',
};

/** Причины остановки. */
export const HALT = {
  ACTION_BLOCKED: 'action_blocked',
  CHALLENGE: 'challenge',
  LOGGED_OUT: 'logged_out',
  SHADOW_BAN: 'shadow_ban',
  BUDGET: 'budget',
  MANUAL: 'manual',
  NO_KEY: 'no_key',
  RATE_LIMIT: 'rate_limit',
};

export const HALT_LABEL = {
  [HALT.ACTION_BLOCKED]: 'Threads ограничил действия',
  [HALT.CHALLENGE]: 'Требуется проверка аккаунта',
  [HALT.LOGGED_OUT]: 'Нет входа в Threads',
  [HALT.SHADOW_BAN]: 'Комментарии не публикуются',
  [HALT.BUDGET]: 'Исчерпан дневной бюджет AI',
  [HALT.MANUAL]: 'Остановлено вручную',
  [HALT.NO_KEY]: 'Не задан ключ API',
  [HALT.RATE_LIMIT]: 'Слишком частые запросы',
};

/** Обёртка sendMessage, которая не падает при спящем получателе. */
export async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return null;
  }
}

export async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

/**
 * Доверенный ввод: события рождаются в браузере, а не в странице.
 *
 * Зачем это существует. Всё, что content script умеет сам, — это
 * `el.dispatchEvent(new MouseEvent(...))`, и у такого события стоит
 * `isTrusted: false`. Флаг доступен любому обработчику на странице одной
 * строкой, различает настоящий ввод и подделку без единой эвристики и не
 * зависит ни от траектории курсора, ни от распределения пауз между символами.
 * То есть весь труд по кривым Безье и логнормальным интервалам в `human/`
 * перечёркивался одним булевым полем на клике «Опубликовать».
 *
 * Изнутри страницы это неустранимо по устройству веба — доверенное событие
 * может создать только сам браузер. Значит, просить надо браузер: протокол
 * отладчика (CDP) умеет `Input.dispatchMouseEvent` и `Input.dispatchKeyEvent`,
 * которые входят в тот же конвейер ввода, что нажатие живой мыши. События из
 * них приходят на страницу с `isTrusted: true`, проходят через хит-тест и
 * фокус браузера, и отличить их от руки человека изнутри страницы нечем.
 *
 * Цена — жёлтая плашка «Chrome is being debugged by ThreadSense AI» в окне
 * браузера. Она часть интерфейса самого Chrome: странице не видна, в DOM не
 * попадает, скриптам не доступна. На боевом сервере её никто не смотрит.
 *
 * Чего здесь намеренно нет — постоянных `attach` и `detach` вокруг каждого
 * действия. Плашка отладчика занимает место сверху и уменьшает высоту
 * видимой области: подключаясь и отключаясь на каждый клик, мы двигали бы
 * страницу под курсором ровно в тот момент, когда целимся. Подключение
 * делается один раз и живёт, пока жива вкладка.
 */

const PROTOCOL = '1.3';

/** Вкладка, к которой сейчас подключён отладчик. */
let attachedTab = null;
/** Незавершённое подключение — чтобы два параллельных вызова не спорили. */
let attaching = null;
/**
 * Отладчик недоступен насовсем: нет разрешения, занят DevTools, запрещён
 * политикой. Дальше не пробуем и работаем прежним путём.
 */
let disabledReason = '';

/** Есть ли вообще у расширения отладчик. */
export function debuggerAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.debugger && !disabledReason;
}

export function debuggerState() {
  return { attachedTab, disabledReason };
}

/**
 * Отпустить вкладку.
 *
 * Вызывается при закрытии вкладки и при выключении агента: держать чужой
 * браузер под отладчиком, ничего не делая, незачем.
 */
export async function detachInput(tabId = attachedTab) {
  if (!tabId || !chrome.debugger) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch { /* уже отвалился сам — это не ошибка */ }
  if (attachedTab === tabId) attachedTab = null;
}

/**
 * Подключиться к вкладке, если ещё не подключены.
 *
 * @returns {Promise<boolean>} готов ли доверенный ввод
 */
export async function ensureInput(tabId) {
  if (!debuggerAvailable() || !tabId) return false;
  if (attachedTab === tabId) return true;

  if (attaching) {
    try { await attaching; } catch { /* разберёмся ниже по attachedTab */ }
    if (attachedTab === tabId) return true;
  }

  // К другой вкладке отладчик мог остаться с прошлой жизни — отпускаем.
  if (attachedTab && attachedTab !== tabId) await detachInput(attachedTab);

  attaching = (async () => {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
    attachedTab = tabId;
  })();

  try {
    await attaching;
    return true;
  } catch (e) {
    const msg = e?.message || String(e);

    // «Уже подключён» — не беда: это мы же и подключились раньше.
    if (/already attached/i.test(msg)) {
      attachedTab = tabId;
      return true;
    }

    /*
     * Остальные отказы означают, что доверенного ввода на этой машине не
     * будет: разрешение не выдано, вкладку держит DevTools, отладка запрещена
     * политикой домена. Помечаем это один раз и больше не дёргаем браузер на
     * каждый клик — иначе к каждому действию добавится отвергнутый запрос.
     */
    disabledReason = msg;
    return false;
  } finally {
    attaching = null;
  }
}

/* --------------------------- Отправка событий ---------------------------- */

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));

/**
 * Одна операция ввода.
 *
 * Словарь намеренно узкий: страница просит «нажми здесь», «проведи туда»,
 * «набери этот символ», а как это выразить в протоколе — забота фона.
 */
async function one(tabId, op) {
  switch (op.op) {
    case 'move':
      return send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: op.x,
        y: op.y,
        button: op.pressed ? 'left' : 'none',
        buttons: op.pressed ? 1 : 0,
        pointerType: 'mouse',
      });

    case 'down':
      return send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: op.x,
        y: op.y,
        button: 'left',
        buttons: 1,
        clickCount: op.clickCount || 1,
        pointerType: 'mouse',
      });

    case 'up':
      return send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: op.x,
        y: op.y,
        button: 'left',
        buttons: 0,
        clickCount: op.clickCount || 1,
        pointerType: 'mouse',
      });

    case 'wheel':
      return send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: op.x,
        y: op.y,
        deltaX: op.dx || 0,
        deltaY: op.dy || 0,
        button: 'none',
        buttons: 0,
        pointerType: 'mouse',
      });

    /*
     * Печатаемый символ.
     *
     * `text` в `keyDown` — это и есть ввод: Chrome сам породит `beforeinput` и
     * `input` в фокусированном редакторе, включая Lexical, на котором сделан
     * композер Threads. Обходной путь через `execCommand('insertText')`
     * при этом больше не нужен.
     */
    case 'key': {
      const base = {
        key: op.key,
        code: op.code || undefined,
        windowsVirtualKeyCode: op.vk || 0,
        nativeVirtualKeyCode: op.vk || 0,
        modifiers: op.modifiers || 0,
      };
      await send(tabId, 'Input.dispatchKeyEvent', {
        ...base, type: 'keyDown', text: op.text, unmodifiedText: op.text,
      });
      return send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }

    /* Служебная клавиша без текста: Backspace, Enter, стрелки. */
    case 'press': {
      const base = {
        key: op.key,
        code: op.code || undefined,
        windowsVirtualKeyCode: op.vk || 0,
        nativeVirtualKeyCode: op.vk || 0,
        modifiers: op.modifiers || 0,
      };
      await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
      return send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }

    case 'wait':
      return undefined;

    default:
      throw new Error(`неизвестная операция ввода: ${op.op}`);
  }
}

/**
 * Проиграть последовательность операций.
 *
 * Пачкой, а не по одной команде на сообщение: трек курсора состоит из
 * десятков точек с паузами в единицы миллисекунд, и обмен сообщениями на
 * каждую точку сам стал бы источником рваного тайминга. Паузы отсчитываются
 * здесь же, в фоне, где их никто не душит.
 *
 * @param {number} tabId
 * @param {Array<object>} ops
 * @returns {Promise<{ok: boolean, done: number, error?: string}>}
 */
export async function playInput(tabId, ops) {
  if (!Array.isArray(ops) || !ops.length) return { ok: true, done: 0 };
  if (!(await ensureInput(tabId))) return { ok: false, done: 0, error: disabledReason || 'отладчик недоступен' };

  let done = 0;
  for (const op of ops) {
    try {
      await one(tabId, op);
      done += 1;
      if (op.waitMs) await sleep(op.waitMs);
    } catch (e) {
      const msg = e?.message || String(e);

      /*
       * Вкладку могли перезагрузить или закрыть посреди набора. Подключение
       * при этом умирает, и следующая попытка должна начинаться с него, а не
       * лететь в пустоту.
       */
      if (/not attached|No tab with given id|detached/i.test(msg)) {
        if (attachedTab === tabId) attachedTab = null;
      }
      return { ok: false, done, error: msg };
    }
  }
  return { ok: true, done };
}

/* ------------------------------- Живучесть -------------------------------- */

/*
 * Отладчик отваливается сам: вкладку закрыли, открыли DevTools, страница
 * упала. Забыть об этом здесь важнее, чем обработать: иначе `ensureInput`
 * считает, что подключён, и каждая операция уходит в никуда.
 *
 * Ручное закрытие плашки владельцем (`canceled_by_user`) — не сбой, а
 * решение: доверенный ввод выключается до перезапуска, агент продолжает
 * прежним путём.
 */
if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source?.tabId === attachedTab) attachedTab = null;
    if (reason === 'canceled_by_user') disabledReason = 'отладчик отключён вручную';
  });
}

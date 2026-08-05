/**
 * Точка входа фонового скрипта.
 *
 * Здесь только маршрутизация сообщений и обслуживание. Вся логика — в
 * orchestrator.js и соседних модулях. В Manifest V3 этот файл может быть
 * выгружен в любой момент между сообщениями, поэтому в модульной области
 * не хранится ничего, кроме кешей, которые не жалко потерять.
 */

import { MSG, HALT } from '../common/messages.js';
import { PAGE_LABEL, pageKindOf } from '../common/pages.js';
import {
  getSettings, setSettings, replaceSettings, importSettings, getState, updateState,
  resetState, pushLog, getLog, clearLog, todayKey, daysSince,
} from '../common/storage.js';
import { decide, handleGuardAlert } from './orchestrator.js';
import { testKey, listModels } from './openai.js';
// Только статические импорты: dynamic import() запрещён в ServiceWorkerGlobalScope.
import { trainStyle, generateComment } from './generator.js';
import { previewHumanize } from './humanizer.js';
import { estimateDailyActions } from './scheduler.js';
import { renderToolCard } from './cardimage.js';
import { collectTools, pickTool, toolMaterial } from './tools.js';
import {
  warmupLimit, rolloverDay, clearHalt, canComment, recordComment, resyncDayLimit, refreshHalt,
  warmupDay, restartWarmup,
} from './limiter.js';
import { listQueue, updateItem, removeItem, pruneQueue, pendingCount, getItem } from './queue.js';
import { recordAngle } from './safety.js';
import { setBadge, notify } from './notify.js';
import { handleLease, onTabClosed, leaseInfo, clearLease } from './lease.js';
import {
  startWatchdog, heartbeat, forgetTab, checkPulse, pulseInfo, WATCHDOG_ALARM,
} from './watchdog.js';
import { complete as registryComplete, registryStats } from './registry.js';
import { recoveryInfo } from './recovery.js';
import { survivalStats } from './survival.js';
import { PRESETS, applyPreset } from '../common/defaults.js';
import { POST_KINDS } from './postplan.js';

/* --------------------------- Жизненный цикл ------------------------------ */

/**
 * Последняя команда, отданная странице. Только для показа: кеш, который не
 * жалко потерять при выгрузке service worker.
 */
let lastCommand = null;

/**
 * Окно состояния.
 *
 * Открывается один раз и живёт рядом с окном Threads. Смысл — вернуть то,
 * что давала плашка на странице, не оставляя следов в DOM сайта: на сервере
 * без RDP единственный способ увидеть, чем занят агент, — снимок экрана.
 */
async function ensureStatusWindow(settings) {
  if (settings.ui?.overlay !== 'window') return;

  const url = chrome.runtime.getURL('src/ui/status.html');
  try {
    const open = await chrome.tabs.query({ url });
    if (open.length) return;

    await chrome.windows.create({
      url,
      type: 'popup',
      // С запасом: плашка отладчика съедает верхнюю полосу, а рамка окна —
      // ещё десяток пикселей. На снимке 04.08 в 320×240 счётчики уехали под
      // скролл, то есть окно, заведённое ради чтения со снимка, читалось не всё.
      width: 380,
      height: 330,
      top: 40,
      left: 40,
      // Не отбираем фокус у Threads: агент работает в активной вкладке, и
      // перехват фокуса посреди набора стоил бы прерванного комментария.
      focused: false,
    });
  } catch (e) {
    console.warn('[ThreadSense AI] окно состояния не открылось:', e?.message || e);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await getSettings();   // материализуем дефолты
  await updateState((s) => rolloverDay(settings, s, Date.now()));
  await chrome.alarms.create('housekeeping', { periodInMinutes: 5 });
  await startWatchdog();
  await injectIntoOpenTabs();

  if (details.reason === 'install') {
    await pushLog({ level: 'info', event: 'install', msg: 'Расширение установлено' });
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html#wizard') });
  }
  await ensureStatusWindow(settings);
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('housekeeping', { periodInMinutes: 5 });
  await startWatchdog();
  await injectIntoOpenTabs();
  await ensureStatusWindow(await getSettings());
  await refreshBadge();
});

/**
 * Дозалить content-скрипты во вкладки, открытые до установки или обновления.
 *
 * Декларативные content_scripts применяются только к новым загрузкам страниц.
 * Без этого шага после установки расширения агент молчит на уже открытой
 * вкладке Threads, и единственная подсказка — «перезагрузи страницу», которую
 * пользователь взять неоткуда.
 */
async function injectIntoOpenTabs() {
  try {
    const spec = chrome.runtime.getManifest().content_scripts[0];
    const tabs = await chrome.tabs.query({ url: spec.matches });
    let injected = 0;

    for (const tab of tabs) {
      /*
       * Живость проверяем разговором, а не флагом в окне.
       *
       * Раньше здесь спрашивалось `window.__TA?.started`. Флаг ставит сам
       * скрипт, но переживает его смерть: после обновления расширения старый
       * контекст инвалидируется, а объект в окне остаётся, и дозаливка решала,
       * что скрипт работает. В журнале при этом честно писалось «дозалиты»,
       * хотя не заливалось ничего. Так агент и простоял после перехода на 5.6:
       * вкладка открыта, скрипт мёртв, никто этого не заметил.
       *
       * Мёртвый контекст на сообщение не ответит — это и есть проверка.
       */
      const alive = await chrome.tabs.sendMessage(tab.id, { type: 'ta_ping' })
        .then((r) => !!r?.ok)
        .catch(() => false);

      if (alive) continue;

      // Флаг от прежнего экземпляра снимаем: иначе свежий скрипт увидит
      // `started` и выйдет на первой строке, не начав работу.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { if (window.__TA) window.__TA.started = false; },
      }).catch(() => {});

      // Своей таблицы стилей у расширения на странице больше нет: правило
      // `.__ta-overlay` в `document.styleSheets` было видно сайту, и плашка
      // теперь носит стили внутри себя. Условие оставлено на случай, если
      // манифест снова обзаведётся CSS.
      if (spec.css?.length) {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: spec.css });
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: spec.js });
      injected++;
    }
    // Пишем то, что произошло на самом деле: «дозалиты: 1» при пропущенной
    // вкладке выглядело подтверждением работы, которой не было.
    if (injected) {
      await pushLog({ level: 'info', event: 'inject', msg: `Скрипты дозалиты во вкладки: ${injected} из ${tabs.length}` });
    }
  } catch (e) {
    console.warn('[ThreadSense AI] дозаливка не удалась:', e.message);
  }
}

/* ------------------------------------------------------------------ *
 * Навигация: куда шли и куда попали
 *
 * Команда перехода — это намерение, а не результат. Между ними успевает
 * случиться многое: Threads подменяет маршрут, клик уходит в пустоту, SPA
 * перерисовывается и оставляет агента там же, где он был. Прежде расхождение
 * не замечал никто: фон выдавал «иди в ленту», страница оставалась в ветке, и
 * на следующем тике фон выдавал то же самое — бесконечно и молча.
 *
 * Поэтому намерение записывается, а на следующем тике сверяется с тем, что
 * страница о себе сообщила.
 * ------------------------------------------------------------------ */

/** Сколько ждать прибытия, прежде чем считать переход несостоявшимся. */
const ARRIVAL_GRACE_MS = 30000;

async function rememberDestination(cmd) {
  if (cmd?.cmd === MSG.CMD_GOTO) {
    const want = cmd.kind || pageKindOf(cmd.url || '');
    await updateState((s) => {
      s.navWant = { kind: want, url: cmd.url || null, at: Date.now() };
      return s;
    });
    return;
  }

  /*
   * Любое другое действие отменяет прежнее намерение: мозг явно перешёл к
   * чему-то ещё, и спрашивать с него старый переход больше не за что.
   * Ожидание — не действие: пока агент стоит в паузе, намерение в силе, иначе
   * ни один незавершённый переход не был бы замечен.
   */
  if (cmd?.cmd && cmd.cmd !== MSG.CMD_IDLE) {
    const st = await getState();
    if (st.navWant) await updateState((s) => { s.navWant = null; return s; });
  }
}

async function checkArrival(kind) {
  if (!kind) return;
  const st = await getState();
  const want = st.navWant;
  if (!want) return;

  // Дошли — намерение исполнено, помнить больше нечего.
  if (kind === want.kind) {
    await updateState((s) => { s.navWant = null; return s; });
    return;
  }

  // Ещё в пути: переход занимает секунды, а тик приходит чаще.
  if (Date.now() - (want.at || 0) < ARRIVAL_GRACE_MS) return;

  const settings = await getSettings();
  await pushLog({
    level: 'warn',
    event: 'nav',
    msg: `Не дошли: собирались в «${PAGE_LABEL[want.kind] || want.kind}», `
      + `остались в «${PAGE_LABEL[kind] || kind}»`,
    detail: want.url || '',
  }, settings.ui.logSize);

  await updateState((s) => { s.navWant = null; return s; });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    await checkPulse();
    return;
  }
  if (alarm.name !== 'housekeeping') return;

  const settings = await getSettings(true);
  await updateState((s) => {
    rolloverDay(settings, s, Date.now());
    refreshHalt(s, Date.now());
    return s;
  });
  await pruneQueue();
  await refreshBadge();
  await ensureWorkingTab(settings);
});

/**
 * Держать открытой вкладку, в которой агент вообще может работать.
 *
 * Это главный пробел ночного режима. Агент действует только из вкладки
 * Threads: там живёт content script, там открывается композер, оттуда
 * читается лента. Если вкладку закрыли, она упала вместе с процессом рендера
 * или Chrome её выгрузил, работа прекращается — молча. Утром это выглядит как
 * «агент ничего не сделал», и причину по журналу не найти, потому что журнал
 * тоже пуст.
 *
 * Поэтому раз в пять минут проверяем, есть ли рабочая вкладка, и если её нет —
 * открываем в фоне. Действие заметное, поэтому оно попадает в журнал: человек
 * должен понимать, откуда взялась вкладка.
 *
 * Порог в две проверки подряд намеренный. Одиночная пропажа бывает штатной:
 * пользователь на секунду закрыл вкладку, перезагружает страницу, переходит по
 * ссылке. Открывать новую вкладку под руками у человека — навязчиво.
 */
let noTabChecks = 0;

async function ensureWorkingTab(settings) {
  if (!settings.enabled || settings.safety?.reopenTab === false) {
    noTabChecks = 0;
    return;
  }
  // Остановленный агент вкладку не требует: он всё равно ничего не делает.
  const state = await getState(true);
  if (state.halt) { noTabChecks = 0; return; }

  const tabs = await chrome.tabs.query({ url: ['*://*.threads.com/*', '*://*.threads.net/*'] });
  if (tabs.length) { noTabChecks = 0; return; }

  if (++noTabChecks < 2) return;
  noTabChecks = 0;

  try {
    await chrome.tabs.create({ url: 'https://www.threads.com/', active: false });
    await pushLog({
      level: 'warn',
      event: 'recovery',
      msg: 'Вкладка Threads пропала — открыли новую',
      detail: 'без неё агент не может ни читать ленту, ни публиковать',
    });
  } catch (e) {
    await pushLog({
      level: 'error',
      event: 'recovery',
      msg: `Не удалось открыть вкладку Threads: ${e.message}`,
    });
  }
}

// Вкладку закрыли — освобождаем право действовать сразу, не дожидаясь
// истечения аренды: следующая вкладка подхватит работу без паузы.
chrome.tabs.onRemoved.addListener((tabId) => {
  onTabClosed(tabId);
  forgetTab(tabId);
});

async function refreshBadge() {
  const settings = await getSettings();
  const state = await getState(true);

  if (state.halt) return setBadge('!', '#e5484d');
  if (!settings.enabled) return setBadge('');

  const n = await pendingCount();
  if (n > 0) return setBadge(String(n), '#f5a524');
  return setBadge('on', '#30a46c');
}

/* ------------------------------ Маршрутизация ---------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch(async (e) => {
      console.error('[ThreadSense AI]', e);
      const s = await getSettings();
      await pushLog({ level: 'error', event: 'bg', msg: e?.message || String(e) }, s.ui.logSize);
      sendResponse({ ok: false, error: e?.message || String(e) });
    });
  return true; // ответ асинхронный
});

async function handle(msg, sender) {
  switch (msg?.type) {
    /* --------------------------- content script --------------------------- */

    case MSG.CONTENT_READY: {
      const settings = await getSettings();

      /*
       * Окно состояния открываем и отсюда.
       *
       * `onStartup` для этого недостаточно: после выката Chrome закрывается
       * принудительно, и событие старта service worker может не застать —
       * 04.08 окно так и не появилось, хотя настройка стояла. Вкладка Threads,
       * доложившая о готовности, — надёжный признак того, что браузер поднялся
       * и рабочий стол есть. Повторный вызов безвреден: окно ищется по адресу
       * и второй раз не создаётся.
       */
      ensureStatusWindow(settings);

      return {
        ok: true,
        tickSec: settings.timing.tickSec,
        overlay: settings.ui.overlay,
      };
    }

    case MSG.LEASE:
      return handleLease(msg, sender);

    case MSG.HEARTBEAT:
      heartbeat(sender?.tab?.id, { url: msg.url, phase: msg.phase });
      // `front` отвечает на вопрос, который изнутри страницы не задать:
      // скрытая вкладка — это человек ушёл в соседнюю или окно просто не
      // отрисовывается. Активная вкладка своего окна означает второе.
      return { ok: true, front: sender?.tab?.active !== false };

    case MSG.TICK: {
      const kind = msg.kind || null;
      await checkArrival(kind);

      const cmd = await decide(msg.report || null, {
        url: msg.url || sender?.tab?.url || '',
        // Вид страницы приходит со страницы. Если сообщение пришло от старого
        // content-скрипта, поля не будет — оркестратор выведет его из адреса.
        kind,
        tabId: sender?.tab?.id,
      });
      await rememberDestination(cmd);
      await refreshBadge();

      // Плашке на странице нужно знать, жив ли агент: индикатор должен гаснуть,
      // когда работа остановлена, а не только когда команда пришла «ждать».
      const st = await getState();
      const settings = await getSettings();
      const live = settings.enabled && !st.halt && st.breaker !== 'open';

      lastCommand = {
        cmd: cmd.cmd,
        why: cmd.why || '',
        next: cmd.waitMs ? Date.now() + cmd.waitMs : 0,
        at: Date.now(),
        live,
      };

      return {
        ok: true,
        ...cmd,
        live,
        // Флаги, влияющие на поведение самого тикера. Отдельного запроса не
        // делаем: тик и так ходит в фон каждые несколько секунд.
        singleTab: settings.safety.singleTab,
        keepaliveAudio: settings.safety.keepaliveAudio,
      };
    }

    case MSG.GUARD_ALERT: {
      await handleGuardAlert(msg.alert || {}, await getSettings());
      await refreshBadge();
      return { ok: true };
    }

    /* -------------------------------- UI --------------------------------- */

    case MSG.UI_GET_STATUS:
      return buildStatus();

    case MSG.UI_TOGGLE: {
      if (msg.enabled) {
        const current = await getSettings(true);
        const hasTopic = !!String(current.niche?.description || '').trim()
          || !!current.niche?.includeKeywords?.length
          || !!current.niche?.searchQueries?.length;
        const missing = [];
        if (!current.ai?.apiKey) missing.push('ключ API');
        if (!current.ai?.connectionVerified) missing.push('проверка AI');
        if (!String(current.handle || '').trim()) missing.push('хэндл Threads');
        if (!hasTopic) missing.push('описание темы');
        if (missing.length) return { ...(await buildStatus()), ok: false, error: `Завершите настройку: ${missing.join(', ')}` };
      }
      const s = await setSettings({ enabled: !!msg.enabled });
      let warmedAgain = false;

      if (msg.enabled) {
        await updateState((st) => {
          if (!st.firstRunDate) st.firstRunDate = todayKey();

          /*
           * Возвращение после долгого простоя — это начало, а не продолжение.
           *
           * Агент, которого выключили на сутки и больше, обычно выключили не
           * просто так: ограничение, разбирательство, пауза по решению
           * владельца. Продолжать с той же дневной нормы, на которой
           * остановились, — худшее, что можно сделать после такого перерыва.
           *
           * Второе условие — про режим: «Осторожный», включённый на аккаунте,
           * у которого прогрев давно позади, иначе стартовал бы сразу с полной
           * нормы, то есть означал бы ровно обратное тому, зачем его выбирают.
           */
          const idleTooLong = st.disabledAt && Date.now() - st.disabledAt > 12 * 3600000;
          const warmedPast = warmupDay(st) > (s.limits.warmupDays || 0);

          if (idleTooLong || (!st.restartDate && warmedPast && s.preset === 'careful')) {
            restartWarmup(st);
            resyncDayLimit(s, st);
            warmedAgain = true;
          }

          st.disabledAt = null;
          st.nextSessionAt = 0; // разрешаем стартовать сразу
          return st;
        });
      } else {
        await updateState((st) => {
          st.session = { ...st.session, active: false };
          st.pipeline = null;
          // Когда выключили — чтобы при возвращении знать, был ли это перерыв
          // на минуту или простой длиной в сутки.
          st.disabledAt = Date.now();
          return st;
        });
        // Право действовать освобождаем сразу: иначе вкладка держит его ещё
        // минуту после выключения и мешает другой начать работу.
        clearLease();
      }
      await pushLog({
        level: 'info',
        event: 'toggle',
        msg: msg.enabled
          ? (warmedAgain ? 'Агент включён — прогрев начат заново' : 'Агент включён')
          : 'Агент выключен',
      }, s.ui.logSize);
      await refreshBadge();
      return buildStatus();
    }

    case MSG.UI_CLEAR_HALT: {
      /*
       * Снятие санкции — это начало прогрева, а не возвращение к прежнему темпу.
       *
       * Ограничение платформы обнуляет всё, что аккаунт нажил до него: смотрят
       * на поведение после снятия. Вернуться назавтра к шести комментариям в
       * день — самый быстрый способ получить второе ограничение, которое уже
       * не обжалуешь.
       */
      const restarted = [HALT.CHALLENGE, HALT.ACTION_BLOCKED, HALT.SHADOW_BAN];
      const before = (await getState()).halt?.reason;

      await updateState((s) => {
        clearHalt(s);
        if (restarted.includes(before)) {
          restartWarmup(s);
          s.dayLimit = 0;   // сегодняшний день пересчитается со сменой суток
        }
        return s;
      });

      await pushLog({
        level: 'info',
        event: 'halt',
        msg: restarted.includes(before)
          ? 'Остановка снята вручную — прогрев начат заново'
          : 'Остановка снята вручную',
      });
      await refreshBadge();
      return buildStatus();
    }

    case MSG.UI_TEST_KEY: {
      const settings = await getSettings(true);
      let cfg = msg.ai ? { ...settings.ai, ...msg.ai } : settings.ai;
      const available = await listModels(cfg);
      const models = available.ok ? available.models : [];
      const configured = cfg.modelScore || cfg.modelWrite;
      if (models.length && !models.includes(configured)) {
        const model = models.find((id) => !/(embedding|moderation|whisper|transcri|tts|audio|image|realtime)/i.test(id)) || models[0];
        cfg = { ...cfg, modelScore: model, modelWrite: model, modelStyle: model };
      }
      const r = await testKey(cfg);
      return { ...r, models: models.length ? models : null };
    }

    case MSG.UI_TRAIN_STYLE: {
      const settings = await getSettings(true);
      const samples = Array.isArray(msg.samples) ? msg.samples : [];
      // Наличие ответов меняет задачу разбора, а не только объём выборки.
      const r = await trainStyle(samples, settings, { hasReplies: msg.hasReplies !== false });
      if (!r.ok) return r;

      await updateState((s) => { s.daySpend = (s.daySpend || 0) + (r.cost || 0); return s; });

      if (msg.apply !== false) {
        await setSettings({
          style: {
            ...settings.style,
            profileText: r.profile.profileText,
            examples: r.profile.examples,
            fillers: r.profile.fillers.length ? r.profile.fillers : settings.style.fillers,
            emojis: r.profile.emojis.length ? r.profile.emojis : settings.style.emojis,
            targetLen: r.profile.targetLen,
            maxLen: r.profile.maxLen,
          },
        });
      }
      await pushLog({
        level: 'success',
        event: 'style',
        msg: `Стиль обучен на ${r.meta.samples} текстах`,
        detail: r.profile.profileText.slice(0, 200),
      }, settings.ui.logSize);
      return r;
    }

    case MSG.UI_PREVIEW_HUMANIZE: {
      const settings = await getSettings(true);
      const merged = msg.overrides
        ? { ...settings, humanize: { ...settings.humanize, ...msg.overrides.humanize }, style: { ...settings.style, ...msg.overrides.style } }
        : settings;
      return { ok: true, variants: previewHumanize(msg.text || '', merged, msg.n || 4) };
    }

    case MSG.UI_QUEUE_ACTION:
      return queueAction(msg);

    case MSG.UI_RESET_STATE: {
      await resetState();
      await clearLog();
      await pushLog({ level: 'info', event: 'reset', msg: 'Счётчики и журнал сброшены' });
      await refreshBadge();
      return buildStatus();
    }

    /*
     * Опубликовать свой пост, не дожидаясь слота.
     *
     * Только поднимаем флаг: команду всё равно выдаёт обычный цикл тиков, и
     * только когда вкладка окажется на главной. Публиковать напрямую отсюда
     * нельзя — фон страницы не видит и композер открыть не может.
     */
    case MSG.UI_POST_NOW: {
      const settings = await getSettings();
      if (!settings.posting?.enabled) {
        return { ok: false, error: 'автопостинг выключен в настройках' };
      }
      // Можно попросить конкретный формат: и для проверки, и когда человек
      // сам знает, что сейчас уместнее — разбор или короткое наблюдение.
      const kind = msg.kind && POST_KINDS[msg.kind] ? msg.kind : null;
      await updateState((s) => { s.forcePost = true; s.forceKind = kind; return s; });

      await pushLog({
        level: 'info',
        event: 'post',
        msg: `Запрошена публикация вне расписания${kind ? `: ${POST_KINDS[kind].label}` : ''}`,
      });
      return { ok: true, queued: true, kind, draftsOnly: !!settings.posting.draftsOnly };
    }

    /*
     * Выбор режима работы.
     *
     * Применяется здесь, а не в интерфейсе, потому что интерфейсов два —
     * всплывающее окно и страница настроек, — и держать применение пресета в
     * каждом значило бы иметь две расходящиеся версии одного решения.
     */
    case MSG.UI_SET_PRESET: {
      const settings = await getSettings(true);
      if (!PRESETS[msg.preset]) return { ok: false, error: `нет такого режима: ${msg.preset}` };

      const next = applyPreset(settings, msg.preset);
      await replaceSettings(next);

      // Дневной лимит разыгран из прежнего режима и до полуночи остался бы
      // прежним. Смена режима — ровно тот случай, когда его надо переиграть.
      await updateState((st) => {
        /*
         * Прогрев режима начинается заново.
         *
         * Иначе «Осторожный», включённый на аккаунте, который работает третью
         * неделю, стартует сразу с полной нормы: прогрев считался от первого
         * запуска, а он давно позади. Человек, выбирающий осторожный режим,
         * просит обратного — начать медленно.
         */
        if (settings.limits?.warmupDays !== next.limits?.warmupDays
          || settings.preset !== msg.preset) {
          restartWarmup(st);
        }
        return resyncDayLimit(next, st);
      });

      await pushLog({
        level: 'info',
        event: 'preset',
        msg: `Режим: ${PRESETS[msg.preset].label}`,
        detail: PRESETS[msg.preset].hint,
      });
      return buildStatus();
    }

    case MSG.UI_DRY_RUN:
      return dryRun(msg);

    case 'ui_get_log':
      return { ok: true, log: await getLog() };

    case 'ui_clear_log':
      await clearLog();
      return { ok: true };

    case 'ui_get_settings':
      return { ok: true, settings: await getSettings(true) };

    /*
     * Правка настроек.
     *
     * Дневной лимит переигрывается сразу, а не со сменой суток. Иначе правка
     * лимита выглядит проигнорированной: цифра внизу остаётся прежней до
     * полуночи, и человек жмёт ещё раз, думая, что не сохранилось.
     */
    case 'ui_save_settings': {
      const s = await setSettings(msg.patch || {});
      await updateState((st) => resyncDayLimit(s, st));
      await refreshBadge();
      return { ok: true, settings: s };
    }

    case 'ui_replace_settings': {
      const s = await replaceSettings(msg.settings || {});
      await updateState((st) => resyncDayLimit(s, st));
      await refreshBadge();
      return { ok: true, settings: s };
    }

    case 'ui_import_settings': {
      const s = await importSettings(msg.settings || {});
      await updateState((st) => resyncDayLimit(s, st));
      await refreshBadge();
      return { ok: true, settings: s };
    }

    case 'ui_get_queue':
      return { ok: true, items: await listQueue({ includeDone: !!msg.includeDone }) };

    case 'ui_estimate': {
      const settings = msg.settings || (await getSettings(true));
      return { ok: true, estimate: estimateDailyActions(settings) };
    }

    case 'ui_run_inspector': {
      const tab = await activeThreadsTab();
      if (!tab) return { ok: false, error: 'Открой вкладку с threads.com' };
      const r = await chrome.tabs.sendMessage(tab.id, { type: MSG.CMD_INSPECT });
      return r || { ok: false, error: 'Content script не ответил. Перезагрузи страницу Threads.' };
    }

    case 'ui_collect_style':
      return collectStyleSamples();

    /*
     * Карточка к посту — по запросу интерфейса.
     *
     * Нужна в двух местах сразу: человеку в настройках, чтобы посмотреть, что
     * именно уедет в ленту, и стенду, чтобы замерить время отрисовки на той
     * машине, где агент работает. Своими руками рисовать её в UI нельзя:
     * получилась бы вторая реализация, которая разойдётся с боевой.
     */
    case 'ui_render_card': {
      const settings = await getSettings(true);
      let material = msg.material;

      if (!material) {
        const pool = await collectTools(settings);
        const card = pickTool({ toldTools: [] }, pool, { minScore: settings.tools?.minScore ?? 0.3 });
        if (!card) return { ok: false, error: 'Не нашлось ни одного инструмента для примера' };
        material = await toolMaterial(card);
        if (!material) return { ok: false, error: 'У кандидата не определился способ установки' };
      }

      const out = await renderToolCard(material, {
        site: settings.funnel?.site,
        handle: settings.handle,
      });
      return { ok: true, ...out, material };
    }

    default:
      return { ok: false, error: `неизвестное сообщение: ${msg?.type}` };
  }
}

/* ------------------------------- Статус ---------------------------------- */

async function buildStatus() {
  const settings = await getSettings(true);

  // Разыграть суточный лимит, если новые сутки ещё не открывались. Без этого
  // сразу после установки popup честно показывает «дневной лимит 0 исчерпан»:
  // rolloverDay раньше вызывался только на тике, а тика без вкладки не бывает.
  const state = await updateState((s) => {
    rolloverDay(settings, s, Date.now());
    return s;
  });

  const queued = await pendingCount();
  const gate = canComment(settings, state);
  const topicReady = !!String(settings.niche?.description || '').trim()
    || !!settings.niche?.includeKeywords?.length
    || !!settings.niche?.searchQueries?.length;
  const aiVerified = !!settings.ai.apiKey && settings.ai.connectionVerified === true;
  const setupReady = aiVerified && !!String(settings.handle || '').trim() && topicReady;

  return {
    ok: true,
    enabled: settings.enabled,
    autopilot: settings.autopilot,
    hasKey: !!settings.ai.apiKey,
    aiVerified,
    setupReady,
    onboarded: settings.onboarded,
    preset: settings.preset,
    handle: settings.handle,
    topicReady,

    day: state.day,
    dayCount: state.dayCount || 0,
    dayLimit: state.dayLimit || 0,
    dayLikes: state.dayLikes || 0,
    dayViews: state.dayViews || 0,
    daySpend: Math.round((state.daySpend || 0) * 10000) / 10000,
    budget: settings.ai.dailyBudgetUsd,

    warmupDay: warmupDay(state),
    warmupDays: settings.limits.warmupDays,
    warmupLimit: warmupLimit(settings, state),

    session: state.session,
    nextActionAt: state.nextActionAt,
    nextSessionAt: state.nextSessionAt,
    pipeline: state.pipeline ? { phase: state.pipeline.phase, target: state.pipeline.target } : null,

    breaker: state.breaker,
    breakerUntil: state.breakerUntil,
    halt: state.halt,
    blocked: gate.ok ? null : gate.reason,

    queued,
    totals: state.totals,
    history: state.history,
    estimate: estimateDailyActions(settings),

    /* Собственные посты: на главном экране это половина работы агента. */
    dayPosts: state.dayPosts || 0,
    postingEnabled: settings.posting?.enabled === true,
    postLimit: settings.posting?.enabled ? (settings.posting.perDay || 0) : 0,

    /*
     * Последняя команда странице.
     *
     * Раньше это показывала плашка в углу Threads, и не раз оказывалось, что
     * диагноз даёт именно она, а не журнал: «ждём · остановка: undefined ·
     * дальше через 5 мин» вывело на опечатку в перечне, о которой журнал
     * молчал. Плашку со страницы убрали, а знание оставлять было нельзя —
     * теперь оно приходит сюда и попадает в окно состояния.
     *
     * Держится в памяти фона, а не в хранилище: команда меняется каждые
     * двадцать секунд, а состояние весит полмегабайта, и писать его ради
     * строчки статуса — дорого. Переживать выгрузку service worker ей незачем:
     * первый же тик после пробуждения заполнит заново.
     */
    lastCommand,
    /* Новые подсистемы: видны в статусе, чтобы не гадать по журналу. */
    lease: leaseInfo(),
    pulse: pulseInfo(),
    registry: registryStats(state),
    recovery: recoveryInfo(state),
    survival: survivalStats(state),
  };
}

/* ---------------------------- Действия очереди --------------------------- */

async function queueAction(msg) {
  const settings = await getSettings(true);
  const item = await getItem(msg.id);
  if (!item) return { ok: false, error: 'черновик не найден' };

  if (msg.action === 'reject') {
    await removeItem(msg.id);
    await pushLog({ level: 'info', event: 'queue', msg: 'Черновик отклонён' }, settings.ui.logSize);
    await refreshBadge();
    return { ok: true };
  }

  if (msg.action === 'edit') {
    await updateItem(msg.id, { draft: { ...item.draft, text: String(msg.text || '').trim(), edited: true } });
    return { ok: true };
  }

  if (msg.action === 'approve') {
    const tab = await activeThreadsTab();
    if (!tab) return { ok: false, error: 'Открой вкладку с threads.com — публикация идёт через неё' };

    const text = String(msg.text || item.draft.text).trim();
    if (!text) return { ok: false, error: 'пустой текст' };

    const res = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.CMD_REPLY,
      url: item.post.url,
      text,
      replyTo: item.draft.replyTo,
      replyToHandle: item.draft.replyToHandle,
      postId: item.post.id,
      typing: settings.typing,
      manual: true,
    });

    if (!res?.ok) {
      await pushLog({
        level: 'error', event: 'queue', msg: `Публикация не удалась: ${res?.error || 'нет ответа'}`,
      }, settings.ui.logSize);
      return { ok: false, error: res?.error || 'content script не ответил' };
    }

    await updateState((s) => {
      recordComment(s, { author: item.post.authorHandle, postId: item.post.id, text });
      recordAngle(s, item.draft.angle);
      return s;
    });
    await updateItem(msg.id, { status: 'sent', sentAt: Date.now(), draft: { ...item.draft, text } });
    await pushLog({
      level: 'success',
      event: 'comment',
      msg: `Опубликовано вручную у @${item.post.authorHandle}`,
      detail: text,
      url: item.post.url,
    }, settings.ui.logSize);
    await refreshBadge();
    return { ok: true, verified: res.verified };
  }

  return { ok: false, error: `неизвестное действие: ${msg.action}` };
}

/* ------------------------------- Сбор стиля ------------------------------ */

/**
 * Обойти обе вкладки профиля и собрать свои тексты.
 *
 * Обход ведётся отсюда, а не из content script, по простой причине: переход
 * между страницами профиля перезагружает документ, вместе с ним умирает
 * content script, и ответ на sendMessage не доходит до вызывающего никогда.
 * Фоновый скрипт переживает навигацию, поэтому водит вкладку он.
 */
async function collectStyleSamples() {
  const settings = await getSettings();
  const handle = (settings.handle || '').replace(/^@/, '').trim();
  if (!handle) return { ok: false, error: 'Не задан хэндл на вкладке «Ниша»' };

  const tab = await activeThreadsTab();
  if (!tab) return { ok: false, error: 'Открой вкладку с threads.com и залогинься' };

  const pages = [
    { path: `/@${handle}`, what: 'посты' },
    { path: `/@${handle}/replies`, what: 'ответы' },
  ];

  const collected = [];
  const perPage = {};

  for (const { path, what } of pages) {
    try {
      await navigateAndWait(tab.id, `https://www.threads.com${path}`);
      const r = await chrome.tabs.sendMessage(tab.id, {
        type: MSG.CMD_COLLECT_STYLE,
        handle,
      });
      const got = r?.ok ? r.samples : [];
      perPage[what] = got.length;
      collected.push(...got);
    } catch (e) {
      perPage[what] = `ошибка: ${e.message}`;
    }
  }

  // Ответы идут первыми: именно их манеру агент и воспроизводит.
  const ordered = [...collected].reverse();
  const samples = dedupeSamples(ordered);

  if (!samples.length) {
    return {
      ok: false,
      error: 'Не удалось собрать тексты. Проверь, что ты залогинен и хэндл указан верно.',
      perPage,
    };
  }
  return { ok: true, samples, perPage };
}

/** Перевести вкладку на URL и дождаться, пока content script снова отзовётся. */
async function navigateAndWait(tabId, url, { timeout = 25000 } = {}) {
  await chrome.tabs.update(tabId, { url });

  const deadline = Date.now() + timeout;
  await new Promise((resolve, reject) => {
    const onUpdated = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('страница не загрузилась'));
    }, timeout);
  });

  // Событие complete приходит раньше, чем content script успевает подняться.
  while (Date.now() < deadline) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'ta_ping' });
      if (pong?.ok) return;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('content script не отозвался после перехода');
}

function dedupeSamples(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const key = String(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 100);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/* ------------------------------ Пробный прогон --------------------------- */

/**
 * Сгенерировать комментарий к произвольному тексту, ничего не публикуя.
 * Нужно, чтобы крутить промпты и стиль без расхода лимитов аккаунта.
 */
async function dryRun(msg) {
  const settings = await getSettings(true);
  const state = await getState(true);

  const thread = {
    root: {
      id: 'dryrun',
      url: 'https://www.threads.com/',
      authorHandle: msg.author || 'someone',
      text: String(msg.text || '').trim(),
      likes: Number(msg.likes) || 12,
      replies: (msg.replies || []).length,
      ageMinutes: 25,
    },
    replies: (msg.replies || []).map((r, i) => ({
      authorHandle: r.author || `user${i}`,
      text: String(r.text || ''),
      likes: Number(r.likes) || 0,
      ageMinutes: 10,
    })),
  };

  if (!thread.root.text) return { ok: false, error: 'нужен текст поста' };

  const r = await generateComment(thread, settings, state);
  await updateState((s) => { s.daySpend = (s.daySpend || 0) + (r.cost || 0); return s; });
  return { ok: true, result: r };
}

/* -------------------------------- Утилиты -------------------------------- */

async function activeThreadsTab() {
  const pattern = ['https://www.threads.com/*', 'https://threads.com/*',
    'https://www.threads.net/*', 'https://threads.net/*'];
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /threads\.(com|net)/.test(active.url || '')) return active;
  const all = await chrome.tabs.query({ url: pattern });
  return all[0] || null;
}

export { HALT, notify };

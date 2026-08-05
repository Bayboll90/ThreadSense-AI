/**
 * Сторожевой таймер: оживление зависшей вкладки.
 *
 * Content script может замолчать по причинам, которые изнутри не поймать:
 * Threads переписал полстраницы под ногами, вкладка ушла в глубокий сон,
 * сломался промис в середине цикла. Снаружи это выглядит одинаково — агент
 * включён, а heartbeat не обновляется.
 *
 * Здесь этот случай и обрабатывается. Content script отмечается на каждом
 * тике, service worker проверяет отметку по будильнику. Если пульса нет
 * дольше порога — вкладка перезагружается: скрипт поднимется заново и
 * подхватит конвейер из сохранённого состояния.
 *
 * Перезагрузка не бесплатна, поэтому у неё есть свой кулдаун: лучше подождать
 * лишних несколько минут, чем устроить цикл перезагрузок на сломанной странице.
 */

import { pushLog, getSettings } from '../common/storage.js';

const ALARM = 'watchdog';

/** Тишина дольше этого считается зависанием. */
const SILENCE_LIMIT_MS = 8 * 60000;

/** Не перезагружать одну и ту же вкладку чаще. */
const RELOAD_COOLDOWN_MS = 5 * 60000;

/** @type {Map<number, {at: number, url: string, phase: string}>} */
const beats = new Map();

/** @type {Map<number, number>} */
const lastReload = new Map();

/** Отметка от content script. Приходит на каждом тике. */
export function heartbeat(tabId, info = {}) {
  if (tabId == null) return;
  beats.set(tabId, { at: Date.now(), url: info.url || '', phase: info.phase || '' });
}

export function forgetTab(tabId) {
  beats.delete(tabId);
  lastReload.delete(tabId);
}

export async function startWatchdog() {
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

export async function stopWatchdog() {
  await chrome.alarms.clear(ALARM);
}

/**
 * Проверка пульса. Вызывается по будильнику.
 * Возвращает список перезагруженных вкладок — для журнала и тестов.
 */
export async function checkPulse() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.safety.watchdogEnabled) return [];

  const now = Date.now();
  const revived = [];

  /*
   * Сначала берём на учёт вкладки, от которых пульса не было вовсе.
   *
   * `beats` живёт в памяти service worker и обнуляется вместе с ним — а он в
   * Manifest V3 выгружается постоянно. Пока вкладка жива, первый же её тик
   * заводит запись заново, и потери незаметны. Но если скрипт в ней мёртв,
   * тика не будет никогда: сторож обходил пустую карту и не сторожил ничего.
   *
   * Именно так агент простоял полчаса после обновления расширения 31.07 —
   * вкладка открыта, скрипт мёртв, сторож слеп, потому что «не знал» о ней.
   * Отметку ставим текущим временем: если скрипт жив, он перебьёт её своим
   * пульсом задолго до порога тишины.
   */
  try {
    const spec = chrome.runtime.getManifest().content_scripts?.[0];
    if (spec?.matches) {
      for (const tab of await chrome.tabs.query({ url: spec.matches })) {
        if (tab.id != null && !beats.has(tab.id)) {
          beats.set(tab.id, { at: now, url: tab.url || '', phase: 'unseen' });
        }
      }
    }
  } catch { /* вкладки недоступны — сторожить нечего */ }

  for (const [tabId, beat] of [...beats.entries()]) {
    if (now - beat.at < SILENCE_LIMIT_MS) continue;

    // Вкладки может уже не быть — тогда и оживлять нечего.
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { /* закрыта */ }
    if (!tab) { forgetTab(tabId); continue; }

    const since = lastReload.get(tabId) || 0;
    if (now - since < RELOAD_COOLDOWN_MS) continue;

    try {
      await chrome.tabs.reload(tabId);
      lastReload.set(tabId, now);
      beats.set(tabId, { at: now, url: beat.url, phase: 'reloaded' });
      revived.push(tabId);

      await pushLog({
        level: 'warn',
        event: 'watchdog',
        msg: `Вкладка молчала ${Math.round((now - beat.at) / 60000)} мин, перезагружена`,
        detail: beat.url,
      }, settings.ui.logSize);
    } catch (e) {
      await pushLog({
        level: 'error', event: 'watchdog', msg: `Не удалось перезагрузить вкладку: ${e.message}`,
      }, settings.ui.logSize);
    }
  }

  return revived;
}

/** Состояние для статуса и диагностики. */
export function pulseInfo() {
  const now = Date.now();
  return [...beats.entries()].map(([tabId, b]) => ({
    tabId,
    silentSec: Math.round((now - b.at) / 1000),
    url: b.url,
    phase: b.phase,
  }));
}

export const WATCHDOG_ALARM = ALARM;
export { SILENCE_LIMIT_MS };

/**
 * Арендодатель права действовать.
 *
 * Content script живёт в каждой вкладке Threads независимо и не видит соседей.
 * Только service worker знает про все вкладки сразу, поэтому решение «чья
 * очередь» принимается здесь.
 *
 * Аренда короткая и с продлением. Это принципиально: если вкладку закрыли,
 * усыпили или её скрипт завис, никакой уборки не потребуется — право
 * освободится само по истечении срока. Обратная схема, где владелец обязан
 * явно отдать право, ломается ровно в тех случаях, ради которых её заводят.
 *
 * Предпочтение отдаётся активной вкладке: если пользователь смотрит в одну
 * вкладку, а право держит другая, фоновая, то через ttl оно перейдёт к той,
 * что на виду. Так действия агента совпадают с тем, что человек видит.
 */

import { pushLog } from '../common/storage.js';

/** @type {{holderId: string, tabId: number, url: string, until: number}|null} */
let lease = null;

const DEFAULT_TTL_MS = 45000;

/**
 * Обработать запрос аренды.
 *
 * @param {object} msg  { action: 'acquire'|'renew'|'release', holderId, ttlMs }
 * @param {object} sender
 * @returns {Promise<{ok: boolean, reason?: string, holder?: string}>}
 */
export async function handleLease(msg, sender) {
  const now = Date.now();
  const tabId = sender?.tab?.id ?? null;
  const ttl = Math.min(Math.max(Number(msg.ttlMs) || DEFAULT_TTL_MS, 10000), 120000);

  // Протухшая аренда никого не держит.
  if (lease && lease.until <= now) lease = null;

  if (msg.action === 'release') {
    if (lease && lease.holderId === msg.holderId) lease = null;
    return { ok: true };
  }

  // Держатель тот же — просто продлеваем.
  if (lease && lease.holderId === msg.holderId) {
    lease.until = now + ttl;
    lease.url = msg.url || lease.url;
    return { ok: true };
  }

  // Та же вкладка, но другой идентификатор — content script перезагрузился.
  //
  // Так происходит при любой полной навигации: наш собственный переход по
  // ссылке, перезагрузка как ступень восстановления, обычный клик
  // пользователя. Прежний скрипт при этом уже мёртв, отдать право он не успел,
  // и без этой ветки вкладка простаивала бы до истечения аренды — до сорока
  // пяти секунд после каждого перехода. В одной вкладке не может работать два
  // content script одновременно, поэтому новый идентификатор с того же tabId
  // означает смену поколения, а не конкурента.
  if (lease && tabId != null && lease.tabId === tabId) {
    lease = { holderId: msg.holderId, tabId, url: msg.url || '', until: now + ttl };
    return { ok: true, renewedAfterReload: true };
  }

  // Право свободно.
  if (!lease) {
    lease = { holderId: msg.holderId, tabId, url: msg.url || '', until: now + ttl };
    await pushLog({ level: 'info', event: 'lease', msg: 'Право действовать закреплено за вкладкой' });
    return { ok: true };
  }

  // Право занято. Единственный повод отобрать — вкладки владельца больше нет.
  if (lease.tabId != null) {
    const alive = await tabExists(lease.tabId);
    if (!alive) {
      lease = { holderId: msg.holderId, tabId, url: msg.url || '', until: now + ttl };
      await pushLog({ level: 'info', event: 'lease', msg: 'Прежняя вкладка закрыта, право перешло' });
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason: 'агент уже работает в другой вкладке Threads',
    holder: lease.holderId,
  };
}

async function tabExists(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return !!t;
  } catch {
    return false;
  }
}

/** Освободить право при закрытии вкладки — не дожидаясь истечения срока. */
export function onTabClosed(tabId) {
  if (lease && lease.tabId === tabId) lease = null;
}

/** Текущее состояние аренды — для статуса в UI. */
export function leaseInfo() {
  if (!lease || lease.until <= Date.now()) return null;
  return { tabId: lease.tabId, url: lease.url, msLeft: lease.until - Date.now() };
}

/** Сбросить аренду принудительно: используется при выключении агента. */
export function clearLease() {
  lease = null;
}

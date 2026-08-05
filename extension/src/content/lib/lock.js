/**
 * Аренда права действовать: агент работает ровно в одной вкладке.
 *
 * Дыра, которую это закрывает, тихая и дорогая. Content script живёт в каждой
 * вкладке Threads независимо, и все они тикают одновременно. Две открытые
 * вкладки означают два агента: лимиты считаются в общем состоянии, но реальная
 * нагрузка на аккаунт удваивается, а два курсора начинают драться за один
 * композер. Ни один счётчик такого не покажет — со стороны просто «иногда
 * агент ведёт себя странно».
 *
 * Защита двухслойная.
 *
 * Первый слой — атрибут на documentElement. Ловит вторую копию скрипта в той
 * же вкладке: такое случается после дозаливки скриптов в уже открытую страницу.
 *
 * Второй слой — аренда у service worker. Он единственный видит все вкладки
 * сразу, поэтому только он может решить, чья очередь. Аренда с коротким сроком
 * и продлением: если вкладку закрыли или она зависла, право освободится само
 * через ttl, без всякой уборки.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.lock) return;
  const { log, warn } = TA.util;

  const DOM_ATTR = 'data-ta-agent-owner';

  /** Срок аренды и период продления. Продление вдвое чаще срока — с запасом. */
  const LEASE_TTL_MS = 45000;
  const RENEW_EVERY_MS = 18000;

  /** Идентификатор этой вкладки. Живёт до перезагрузки страницы. */
  const holderId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  let renewTimer = null;
  let held = false;
  let lastDenyReason = '';

  /* ----------------------- Первый слой: DOM-атрибут ----------------------- */

  function claimDomLock() {
    const root = document.documentElement;
    if (!root) return false;

    const current = root.getAttribute(DOM_ATTR);
    if (current && current !== holderId) {
      // Владелец мог умереть вместе со старой копией скрипта. Штампуем время
      // рядом с идентификатором, чтобы отличить живого владельца от призрака.
      const stamp = Number(root.getAttribute(`${DOM_ATTR}-at`) || 0);
      if (Date.now() - stamp < LEASE_TTL_MS) return false;
      log('перехватываем протухший DOM-lock у', current);
    }

    root.setAttribute(DOM_ATTR, holderId);
    root.setAttribute(`${DOM_ATTR}-at`, String(Date.now()));
    return true;
  }

  function touchDomLock() {
    const root = document.documentElement;
    if (root?.getAttribute(DOM_ATTR) === holderId) {
      root.setAttribute(`${DOM_ATTR}-at`, String(Date.now()));
    }
  }

  function releaseDomLock() {
    const root = document.documentElement;
    if (root?.getAttribute(DOM_ATTR) === holderId) {
      root.removeAttribute(DOM_ATTR);
      root.removeAttribute(`${DOM_ATTR}-at`);
    }
  }

  /* --------------------- Второй слой: аренда у фона ----------------------- */

  async function ask(action) {
    try {
      return await chrome.runtime.sendMessage({
        type: TA.MSG.LEASE,
        action,
        holderId,
        url: location.href,
        ttlMs: LEASE_TTL_MS,
      });
    } catch {
      // Расширение перезагружают — считаем, что права нет.
      return null;
    }
  }

  /**
   * Попробовать получить или продлить право действовать.
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function acquire() {
    if (!claimDomLock()) {
      held = false;
      lastDenyReason = 'в этой вкладке уже работает другая копия скрипта';
      return { ok: false, reason: lastDenyReason };
    }

    const r = await ask(held ? 'renew' : 'acquire');
    if (!r?.ok) {
      held = false;
      lastDenyReason = r?.reason || 'право занято другой вкладкой';
      return { ok: false, reason: lastDenyReason };
    }

    if (!held) log('право действовать получено');
    held = true;
    lastDenyReason = '';
    touchDomLock();
    startRenew();
    return { ok: true };
  }

  function startRenew() {
    if (renewTimer) return;
    renewTimer = setInterval(async () => {
      if (!held) return;
      touchDomLock();
      const r = await ask('renew');
      if (!r?.ok) {
        // Право отобрали: другая вкладка стала активной либо фон перезапустился.
        held = false;
        lastDenyReason = r?.reason || 'аренда не продлена';
        warn('право действовать потеряно:', lastDenyReason);
      }
    }, RENEW_EVERY_MS);
  }

  async function release() {
    if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    if (held) await ask('release');
    held = false;
    releaseDomLock();
  }

  /** Отдаём право, когда вкладку закрывают: следующая подхватит сразу. */
  window.addEventListener('pagehide', () => {
    releaseDomLock();
    // sendMessage при выгрузке может не успеть — фон всё равно снимет по ttl.
    ask('release');
  });

  const isHeld = () => held;
  const denyReason = () => lastDenyReason;

  TA.lock = { acquire, release, isHeld, denyReason, holderId, LEASE_TTL_MS };
})();

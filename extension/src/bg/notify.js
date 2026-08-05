/**
 * Уведомления Chrome и бейдж на иконке.
 * Уведомления должны быть редкими и по делу, иначе их перестают читать —
 * поэтому дёргаем их только на остановках и на новых черновиках в очереди.
 */

let lastNotifyAt = 0;
const MIN_GAP_MS = 20000;

export function notify(title, message, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastNotifyAt < MIN_GAP_MS) return;
  lastNotifyAt = now;

  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message || '').slice(0, 240),
      priority: 1,
    });
  } catch {
    // Уведомления могут быть отключены пользователем — это не повод падать.
  }
}

/** Бейдж: число черновиков в очереди либо статус агента. */
export async function setBadge(text, color = '#7c5cff') {
  try {
    await chrome.action.setBadgeText({ text: String(text ?? '') });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* иконки может не быть в момент установки */ }
}

/**
 * Очередь черновиков на ручное подтверждение.
 *
 * Это основной режим работы первых недель: агент делает всю работу, но
 * последний клик остаётся за человеком. Заодно очередь — единственный честный
 * способ откалибровать промпты: видно, какие черновики хочется отправить как
 * есть, а какие приходится переписывать.
 */

import { getQueue, updateQueue } from '../common/storage.js';

/** Сколько черновиков держим. Старые протухают: пост ушёл из ленты — ответ уже не к месту. */
const MAX_ITEMS = 60;
const TTL_MS = 12 * 3600000;

export async function enqueue(item) {
  return updateQueue((q) => {
    const items = [...q.items.filter((i) => i.post?.id !== item.post?.id), item];
    return { ...q, items: items.slice(-MAX_ITEMS) };
  });
}

export async function listQueue({ includeDone = false } = {}) {
  const q = await getQueue(true);
  const now = Date.now();
  return q.items
    .filter((i) => includeDone || i.status === 'pending')
    .filter((i) => includeDone || now - i.createdAt < TTL_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getItem(id) {
  const q = await getQueue(true);
  return q.items.find((i) => i.id === id) || null;
}

export async function updateItem(id, patch) {
  return updateQueue((q) => ({
    ...q,
    items: q.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
  }));
}

export async function removeItem(id) {
  return updateQueue((q) => ({ ...q, items: q.items.filter((i) => i.id !== id) }));
}

/** Выбросить протухшие и разобранные записи. */
export async function pruneQueue() {
  const now = Date.now();
  return updateQueue((q) => ({
    ...q,
    items: q.items.filter((i) => {
      if (i.status === 'pending') return now - i.createdAt < TTL_MS;
      return now - i.createdAt < 3600000; // обработанные держим час, для истории в UI
    }),
  }));
}

export async function clearQueue() {
  return updateQueue(() => ({ items: [] }));
}

export async function pendingCount() {
  const items = await listQueue();
  return items.length;
}

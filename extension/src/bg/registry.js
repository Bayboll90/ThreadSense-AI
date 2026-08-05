/**
 * Реестр обработанных постов.
 *
 * Простой список идентификаторов — ненадёжная защита от повторов. Один и тот
 * же пост приходит под разными обличьями: в ленте у него один URL, на странице
 * ветки другой, после редактирования текста меняется хеш, репост даёт третий
 * адрес. Список по одному ключу пропускает такой пост как новый, и агент пишет
 * второй комментарий под тем, где уже отметился. Со стороны это худшее, что он
 * может сделать: выглядит как явный бот.
 *
 * Решение — несколько ключей на запись и слияние по пересечению. Пост
 * описывается набором: шорткод, полная ссылка, хеш автора с началом текста.
 * Совпадение по любому ключу означает тот же пост, и записи сливаются в одну
 * с объединённым набором ключей. Дальше он узнаётся по любому из них.
 *
 * Второе назначение — защита от гонки. Между выбором цели и публикацией
 * проходят десятки секунд: генерация, чтение ветки, набор текста. Всё это
 * время пост должен считаться занятым, иначе следующий проход выберет его
 * снова. Отсюда трёхтактная схема: claim перед работой, complete при успехе,
 * release при сбое. У захвата свой короткий срок — зависшая обработка
 * освобождает пост сама.
 */

import { updateState } from '../common/storage.js';
import { hash, normalize } from '../common/text.js';

/** Сколько записей помним. Дальше вытесняем самые старые. */
const MAX_ENTRIES = 3000;

/** Сколько живёт отметка «прокомментирован». */
const TTL_MS = 72 * 3600000;

/** Сколько живёт захват. Короткий: столько длится обработка одного поста. */
const INFLIGHT_TTL_MS = 8 * 60000;

/* ------------------------------------------------------------------ *
 * Ключи
 * ------------------------------------------------------------------ */

/**
 * Собрать все идентификаторы поста.
 * Чем их больше, тем устойчивее узнавание — но каждый должен быть достаточно
 * специфичным, чтобы не склеить два разных поста.
 */
export function keysOf(post) {
  const keys = [];

  if (post.shortcode) keys.push(`sc:${post.shortcode}`);

  if (post.url) {
    const m = String(post.url).match(/\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/);
    if (m) keys.push(`url:${m[1].toLowerCase()}/${m[2]}`);
  }

  // Хеш от автора и начала текста. Переживает смену URL и правку хвоста,
  // но не склеивает разных авторов с похожими началами.
  const author = String(post.authorHandle || '').replace(/^@/, '').toLowerCase();
  const head = normalize(post.text || '').slice(0, 120);
  if (author && head.length >= 20) keys.push(`ah:${hash(`${author}|${head}`)}`);

  if (post.id && !keys.length) keys.push(`id:${post.id}`);

  return [...new Set(keys)];
}

/* ------------------------------------------------------------------ *
 * Операции
 * ------------------------------------------------------------------ */

/**
 * Найти запись, пересекающуюся с набором ключей.
 * @returns {{index: number, entry: object}|null}
 */
function find(entries, keys) {
  const want = new Set(keys);
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].keys.some((k) => want.has(k))) return { index: i, entry: entries[i] };
  }
  return null;
}

/** Выбросить протухшее. Мутирует массив. */
function prune(entries, now) {
  const alive = entries.filter((e) => {
    if (e.status === 'inflight') return now - e.at < INFLIGHT_TTL_MS;
    return now - e.at < TTL_MS;
  });
  // Вытеснение по возрасту, если записей стало слишком много.
  if (alive.length > MAX_ENTRIES) {
    alive.sort((a, b) => a.at - b.at);
    alive.splice(0, alive.length - MAX_ENTRIES);
  }
  return alive;
}

/**
 * Захватить пост перед обработкой.
 *
 * @returns {Promise<{ok: boolean, reason?: string, keys: string[]}>}
 *          ok=false означает, что пост уже прокомментирован или обрабатывается.
 */
export async function claim(post) {
  const keys = keysOf(post);
  if (!keys.length) return { ok: false, reason: 'нечем опознать пост', keys };

  let verdict = { ok: true, keys };

  await updateState((s) => {
    const now = Date.now();
    const entries = prune(s.registry || [], now);
    const hit = find(entries, keys);

    if (hit) {
      const e = hit.entry;
      if (e.status === 'commented') {
        verdict = { ok: false, reason: 'уже прокомментирован', keys };
        s.registry = entries;
        return s;
      }
      if (e.status === 'inflight' && now - e.at < INFLIGHT_TTL_MS) {
        verdict = { ok: false, reason: 'уже в обработке', keys };
        s.registry = entries;
        return s;
      }
      // Захват протух — перехватываем и доливаем ключи.
      e.keys = [...new Set([...e.keys, ...keys])];
      e.status = 'inflight';
      e.at = now;
      s.registry = entries;
      return s;
    }

    entries.push({ keys, status: 'inflight', at: now, author: post.authorHandle || '' });
    s.registry = entries;
    return s;
  });

  return verdict;
}

/** Пометить пост как прокомментированный. */
export async function complete(post, meta = {}) {
  const keys = keysOf(post);
  await updateState((s) => {
    const now = Date.now();
    const entries = prune(s.registry || [], now);
    const hit = find(entries, keys);

    if (hit) {
      // Слияние: запись могла быть заведена по другому набору ключей.
      hit.entry.keys = [...new Set([...hit.entry.keys, ...keys])];
      hit.entry.status = 'commented';
      hit.entry.at = now;
      if (meta.text) hit.entry.text = String(meta.text).slice(0, 200);
    } else {
      entries.push({
        keys, status: 'commented', at: now,
        author: post.authorHandle || '',
        text: meta.text ? String(meta.text).slice(0, 200) : undefined,
      });
    }
    s.registry = entries;
    return s;
  });
}

/** Отпустить захват: обработка сорвалась, пост можно взять снова. */
export async function release(post) {
  const keys = keysOf(post);
  await updateState((s) => {
    const now = Date.now();
    const entries = prune(s.registry || [], now);
    const hit = find(entries, keys);
    // Отпускаем только собственный захват: завершённую запись трогать нельзя.
    if (hit && hit.entry.status === 'inflight') entries.splice(hit.index, 1);
    s.registry = entries;
    return s;
  });
}

/**
 * Быстрая проверка без захвата — для префильтра.
 * @returns {Promise<'new'|'commented'|'inflight'>}
 */
export async function status(post, state) {
  const keys = keysOf(post);
  const entries = state?.registry || [];
  const hit = find(entries, keys);
  if (!hit) return 'new';

  const now = Date.now();
  if (hit.entry.status === 'inflight') {
    return now - hit.entry.at < INFLIGHT_TTL_MS ? 'inflight' : 'new';
  }
  return now - hit.entry.at < TTL_MS ? 'commented' : 'new';
}

/** Синхронная версия для мест, где состояние уже на руках. */
export function statusSync(post, state) {
  const keys = keysOf(post);
  const hit = find(state?.registry || [], keys);
  if (!hit) return 'new';
  const now = Date.now();
  if (hit.entry.status === 'inflight') {
    return now - hit.entry.at < INFLIGHT_TTL_MS ? 'inflight' : 'new';
  }
  return now - hit.entry.at < TTL_MS ? 'commented' : 'new';
}

/** Статистика для UI. */
export function registryStats(state) {
  const entries = state?.registry || [];
  const now = Date.now();
  return {
    total: entries.length,
    commented: entries.filter((e) => e.status === 'commented' && now - e.at < TTL_MS).length,
    inflight: entries.filter((e) => e.status === 'inflight' && now - e.at < INFLIGHT_TTL_MS).length,
  };
}

export { MAX_ENTRIES, TTL_MS, INFLIGHT_TTL_MS };

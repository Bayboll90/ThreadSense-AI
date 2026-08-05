/**
 * Воронка: как читатель, которому пригодился разбор, находит дорогу дальше.
 *
 * Задача формулируется просто и решается неочевидно. Ссылку в тексте поста
 * ставить нельзя — платформа считает это уводом и показывает такой пост
 * меньшему числу людей. Значит, адрес должен оказаться там, где он ссылкой не
 * является, и при этом попасться на глаза ровно тому, кто уже заинтересовался.
 *
 * Отсюда три места, и у каждого своя роль.
 *
 * **Картинка** (`bg/cardimage.js`) — самое дешёвое касание. Адрес видит любой,
 * кто пролистал ленту, даже не читая текст. Ничего не требует и ничего не
 * стоит; конверсия у такого касания низкая, зато их много.
 *
 * **Подпись в последней части ветки** — для того, кто дочитал. Не «подпишись»,
 * а объяснение, что есть ещё: человек, дочитавший разбор до конца, уже
 * согласился, что ему полезно, и подсказка ему не мешает.
 *
 * **Комментарий под собственным постом** — единственное место, где ссылка
 * уместна полностью: охвату поста она уже не вредит, а тот, кто открыл ветку,
 * увидит её первой. Это же и самый частый приём у живых авторов.
 *
 * Адрес поста в момент публикации нам неизвестен — композер его не отдаёт, —
 * поэтому комментарий оставляется позже, на ближайшем заходе в профиль. Тем
 * самым обходом, который и так делается ради ответов читателям: лишних
 * переходов ноль.
 */

import { normalize } from '../common/text.js';

/** Сколько постов держим в очереди на комментарий. */
const QUEUE_MAX = 10;

/** Дольше суток ждать нет смысла: под остывшим постом комментарий не читают. */
const QUEUE_TTL_MS = 24 * 3.6e6;

/**
 * Выбрать подпись, не повторяя предыдущую.
 *
 * Одна и та же фраза под каждым постом читается как автоподпись, чем она и
 * является. Ротация не делает её живой, но убирает самый заметный признак.
 */
export function pickTail(settings, state, rand = Math.random) {
  const list = (settings?.funnel?.tails || []).filter(Boolean);
  if (!list.length) return null;

  const last = state?.lastTail || '';
  const pool = list.length > 1 ? list.filter((t) => t !== last) : list;
  return pool[Math.floor(rand() * pool.length)] || null;
}

/**
 * Дописать подпись в последнюю часть ветки.
 *
 * Только если она туда помещается. Подпись — добавка, и ради неё нельзя ни
 * сокращать содержание, ни ломать потолок длины: разбор без подписи полезен,
 * подпись без разбора бессмысленна.
 *
 * @returns {{parts: string[], added: boolean}}
 */
export function appendTail(parts, tail, maxLen) {
  const list = [...(parts || [])];
  if (!tail || !list.length) return { parts: list, added: false };

  const i = list.length - 1;
  const joined = `${list[i].replace(/\s+$/, '')}\n\n${tail}`;
  if (joined.length > maxLen) return { parts: list, added: false };

  list[i] = joined;
  return { parts: list, added: true };
}

/* ------------------------------------------------------------------ *
 * Комментарий под своим постом
 * ------------------------------------------------------------------ */

/**
 * Поставить пост в очередь на собственный комментарий.
 *
 * Ключ — начало текста, как и у обучения: адреса у нас нет, а по началу текста
 * пост опознаётся при следующем скане профиля.
 */
export function queueFollowup(state, text, now = Date.now()) {
  const key = normalize(text || '').slice(0, 60);
  if (!key) return state;

  const queue = (state.followupQueue || []).filter((q) => now - q.at < QUEUE_TTL_MS);
  if (!queue.some((q) => q.key === key)) queue.push({ key, at: now });

  state.followupQueue = queue.slice(-QUEUE_MAX);
  return state;
}

/**
 * Найти среди карточек профиля тот пост, который ждёт комментария.
 *
 * Свежие вперёд: под постом, вышедшим час назад, комментарий увидят те, кто
 * читает ленту сейчас, а под вчерашним он останется незамеченным.
 */
export function pickFollowup(cards, state, myHandle, now = Date.now()) {
  const queue = (state?.followupQueue || []).filter((q) => now - q.at < QUEUE_TTL_MS);
  if (!queue.length) return null;

  const me = String(myHandle || '').replace(/^@/, '').toLowerCase();
  const byKey = new Map(queue.map((q) => [q.key, q]));

  const mine = (cards || [])
    .filter((c) => (c.authorHandle || '').replace(/^@/, '').toLowerCase() === me && c.url)
    .sort((a, b) => (a.ageMinutes ?? 0) - (b.ageMinutes ?? 0));

  for (const card of mine) {
    const key = normalize(card.text || '').slice(0, 60);
    if (!key) continue;

    for (const [qk, q] of byKey) {
      if (key === qk || key.startsWith(qk) || qk.startsWith(key)) {
        return { card, entry: q };
      }
    }
  }

  return null;
}

/** Убрать пост из очереди — независимо от того, чем кончилась попытка. */
export function dropFollowup(state, key) {
  state.followupQueue = (state.followupQueue || []).filter((q) => q.key !== key);
  return state;
}

/**
 * Текст комментария со ссылкой.
 *
 * Собирается кодом, а не моделью, и по той же причине, по какой команда
 * установки берётся из данных: ссылка — это факт, а не творчество. Опечатка в
 * адресе стоит всей воронки.
 */
export function followupText(settings, state, rand = Math.random) {
  const f = settings?.funnel || {};
  const link = f.telegram || f.site;
  if (!f.followup?.enabled || !link) return null;

  const list = (f.followup.texts || []).filter((t) => t && t.includes('{link}'));
  if (!list.length) return null;

  const last = state?.lastFollowup || '';
  const pool = list.length > 1 ? list.filter((t) => t !== last) : list;
  const tpl = pool[Math.floor(rand() * pool.length)] || list[0];

  return { text: tpl.replace('{link}', link), template: tpl };
}

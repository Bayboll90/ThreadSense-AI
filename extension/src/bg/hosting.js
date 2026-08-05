/**
 * Кому из ответивших под нашим постом отвечать.
 *
 * Появилось 02.08. Повод — первый за неделю отклик: пост-вопрос собрал два
 * ответа от живых людей, и оба остались без реакции. Разговор, начавшийся
 * ровно так, как мы хотели, умер в тот же час.
 *
 * Для аккаунта с девятнадцатью подписчиками это дороже, чем кажется. Человек,
 * который потрудился ответить, — самый вероятный будущий читатель из всех,
 * кого мы можем встретить, и стоит он одного запроса к модели. Вдобавок
 * Threads поднимает ветки, где идёт разговор, а не только висит пост.
 *
 * Функции чистые: всё, что здесь решается, проверяется тестом без браузера.
 */

import { normalize } from '../common/text.js';

/** Ключ «кому уже отвечали». По посту и автору, а не по тексту реплики. */
export function answerKey(postUrl, author) {
  const sc = String(postUrl || '').split('/post/')[1]?.split(/[/?#]/)[0] || postUrl;
  return `${sc}#${String(author || '').replace(/^@/, '').toLowerCase()}`;
}

/**
 * Пора ли заглянуть в свой профиль за новыми ответами.
 *
 * Отдельный ритм, а не доля в мешке источников: проверка своего профиля не
 * конкурирует с поиском целей, она про другое. И редкий — заглядывать каждые
 * пять минут значит ходить кругами по пустой странице.
 */
export function shouldCheckOwn(settings, state, now = Date.now()) {
  const h = settings.hosting;
  if (!h?.enabled) return { check: false, why: 'ответы своим выключены' };

  if ((state.dayHostReplies || 0) >= (h.maxPerDay ?? 15)) {
    return { check: false, why: `дневной предел ответов своим (${h.maxPerDay}) исчерпан` };
  }

  const passed = now - (state.lastOwnCheckAt || 0);
  const everyMs = (h.everyMin ?? 40) * 60000;
  if (passed < everyMs) {
    return { check: false, why: `до проверки своего профиля ${Math.round((everyMs - passed) / 60000)} мин` };
  }

  return { check: true };
}

/**
 * Выбрать реплику, на которую отвечаем.
 *
 * Правила отбора и почему каждое нужно:
 *
 * - **Не своя.** Собственные части ветки — не собеседники.
 * - **Ещё не отвеченная.** Ключ по посту и автору: человек может поправить
 *   свой текст, и по тексту реплика выглядела бы новой.
 * - **Не короткая.** «Круто», «+», «согласен» — на такое отвечают лайком.
 *   Развёрнутый ответ на «+» выглядит натужно.
 * - **Свежая.** Ответ через сутки после реплики читается не вниманием, а
 *   обходом по списку.
 *
 * Из подходящих берём **первую по порядку в ветке**, а не самую длинную или
 * самую свежую: разговор идёт сверху вниз, и отвечать вразнобой странно.
 *
 * @returns {{index: number, reply: object, others: object[]}|null}
 */
export function pickReplyToAnswer(thread, settings, state, myHandle) {
  const h = settings.hosting || {};
  const me = String(myHandle || '').replace(/^@/, '').toLowerCase();
  const answered = new Set(state.answeredReplies || []);
  const url = thread?.root?.url || thread?.url || '';

  const replies = Array.isArray(thread?.replies) ? thread.replies : [];
  const others = replies.filter((r) => (r.authorHandle || '').toLowerCase() !== me);

  for (let i = 0; i < replies.length; i++) {
    const r = replies[i];
    const author = String(r.authorHandle || '').replace(/^@/, '').toLowerCase();

    if (!author || author === me) continue;
    if (answered.has(answerKey(url, author))) continue;

    const text = String(r.text || '').trim();
    if (text.length < (h.minReplyLen ?? 20)) continue;

    /*
     * Реплика, на которую мы уже отвечали в этой же ветке под другим ключом,
     * сюда не попадёт, а вот ответ, который сам является нашим, — мог бы:
     * разбор ветки не всегда различает вложенность. Проверка по автору
     * закрывает и это.
     */
    return { index: i, reply: { author, text }, others: others.filter((o) => o !== r) };
  }

  return null;
}

/** Запомнить, что этому человеку под этим постом уже ответили. */
export function rememberAnswer(state, postUrl, author) {
  const key = answerKey(postUrl, author);
  const list = state.answeredReplies || [];
  if (!list.includes(key)) {
    /* Двухсот хватает: старые ветки всё равно выпадают из окна по возрасту. */
    state.answeredReplies = [...list, key].slice(-200);
  }
  state.dayHostReplies = (state.dayHostReplies || 0) + 1;
  return state;
}

/**
 * Наши посты, которые стоит обслужить.
 *
 * Приходят с обычного скана профиля: карточки уже разобраны, ничего
 * дополнительно собирать не надо. Отбираем свои, свежие и с ответами.
 *
 * Порядок — от свежих к старым: разговор под вчерашним постом уже остыл, а
 * под часовым только начинается.
 */
export function pickOwnPosts(cards, settings, state, myHandle, now = Date.now()) {
  const h = settings.hosting || {};
  const me = String(myHandle || '').replace(/^@/, '').toLowerCase();
  const maxAge = (h.maxPostAgeHours ?? 48) * 60;

  return (cards || [])
    .filter((c) => (c.authorHandle || '').replace(/^@/, '').toLowerCase() === me)
    .filter((c) => c.url && outsideReplies(c, state) > 0)
    .filter((c) => (c.ageMinutes ?? Infinity) <= maxAge)
    .filter((c) => !alreadyServed(state, c))
    .sort((a, b) => (a.ageMinutes ?? 0) - (b.ageMinutes ?? 0));
}

/**
 * Пост, под которым мы уже всем ответили и с тех пор ничего не изменилось.
 *
 * Заход в профиль обслуживает один пост — самый свежий из тех, где есть чужие
 * ответы. Пока под ним всем отвечено, а он остаётся самым свежим, агент будет
 * открывать его снова и снова, а читатель под соседним постом так и не
 * дождётся ответа. В одном из прогонов после первого же ответа @reader_one
 * шесть заходов подряд закончились «отвечать некому» — при том, что постов с
 * чужими ответами к вечеру стало четыре.
 *
 * Метка снимается сама, без сроков: сравнивается число чужих ответов. Выросло
 * — значит пришёл кто-то новый, и пост снова в очереди. Время здесь не нужно
 * вовсе, а любой таймаут был бы выдумкой.
 */
export function alreadyServed(state, card) {
  const seen = state?.ownServed?.[postKey(card.url)];
  return seen != null && outsideReplies(card, state) <= seen;
}

/** Запомнить, что под этим постом отвечать больше некому. */
export function markOwnServed(state, url, outside) {
  const key = postKey(url);
  if (!key) return state;

  const all = { ...(state.ownServed || {}), [key]: outside };

  /* Полсотни постов — это больше, чем помещается в окно `maxPostAgeHours`;
     старое просто отбрасываем, порядок вставки в объекте это позволяет. */
  const keys = Object.keys(all);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete all[k];

  state.ownServed = all;
  return state;
}

/** Шорткод поста — тот же ключ, что и в `answerKey`. */
function postKey(url) {
  return String(url || '').split('/post/')[1]?.split(/[/?#]/)[0] || String(url || '');
}

/**
 * Сколько под нашим постом **чужих** ответов.
 *
 * У корня многочастной ветки в счётчике ответов лежат наши же продолжения, и
 * без вычитания любой пост из трёх частей выглядит постом с двумя ответами.
 * За 02.08 это дало девятнадцать заходов в свой профиль подряд, каждый из
 * которых сообщал «с ответами 1», открывал ветку, разбирал её и признавался:
 * отвечать некому. Переход, разбор и запись в журнале — всё впустую, и
 * настоящий случай в этом шуме было бы не отличить.
 *
 * Число частей знает `learning`: оно записывается в момент публикации.
 * Сопоставление то же, что и при замере счётчиков, — по началу текста.
 */
export function outsideReplies(card, state) {
  const total = card?.replies || 0;
  if (total <= 0) return 0;

  const key = normalize(card.text || '').slice(0, 60);
  if (!key) return total;

  const rec = (state?.myPosts || []).find((p) => p.key && (p.key === key || key.startsWith(p.key)));
  const ownParts = Math.max(0, (rec?.parts || 1) - 1);

  return Math.max(0, total - ownParts);
}

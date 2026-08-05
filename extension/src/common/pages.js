/**
 * Карта страниц Threads: где агент может находиться и куда ему ходить.
 *
 * Зачем отдельный модуль. Прежде мозг судил о местоположении по подстрокам в
 * адресе: `isHomeFeed` разбирал `pathname` регуляркой, `isFeedPage` добавляла к
 * ней поиск, и каждое новое место требовало новой такой функции. Знание о том,
 * какие вообще бывают страницы, при этом лежало в третьем файле —
 * `selectors.pageKind()`, — и мозгу не показывалось вовсе. Оркестратор,
 * принимающий все решения о переходах, о существовании вкладки уведомлений не
 * знал ничего.
 *
 * Здесь это знание собрано в одном месте и в одном виде: упорядоченный список
 * «образец пути → вид страницы». Порядок значим — путь `/@user/post/x`
 * подходит и под пост, и под профиль, и выигрывать обязан пост.
 *
 * Страница по-прежнему остаётся источником правды о самой себе: `pageKind()` в
 * `selectors.js` смотрит на настоящий `location`, а не на то, что фон считает
 * текущим адресом. Список тот же — совпадение проверяется тестом на стенде.
 */

/** Виды страниц. Значения уезжают в журнал и в состояние, менять их нельзя. */
export const PAGE = {
  FEED: 'feed',
  SEARCH: 'search',
  POST: 'post',
  PROFILE: 'profile',
  PROFILE_REPLIES: 'profile_replies',
  ACTIVITY: 'activity',
  BLOCKED: 'blocked',
  OTHER: 'other',
};

/**
 * Образцы путей по убыванию точности.
 *
 * Тот же список дословно повторён в `selectors.js` — там он нужен классическому
 * скрипту, куда модули не импортируются. Расхождение ловит проверка
 * «страница и фон одинаково понимают, где агент».
 */
export const ROUTES = [
  /*
   * Страницы проверки и блокировки — первыми и по адресу, а не по тексту.
   *
   * 04.08.2026 Threads увёл аккаунт на `/accounts/suspended/` с плашкой
   * «Confirm you're human to use your account». Сторож её не опознал: в его
   * перечне лежало `confirm it's you`, а на экране стояло `confirm you're
   * human`, и разошлись они на одном слове. Пока диагноз собирается из фраз,
   * он всегда отстаёт от того, что платформа напишет завтра.
   *
   * Адрес такой оговорки не допускает: `/accounts/suspended` не бывает
   * случайно, на каком бы языке ни был интерфейс.
   */
  [/^\/(accounts\/(suspended|disabled|inactive)|challenge|checkpoint)/, PAGE.BLOCKED],
  [/\/post\//, PAGE.POST],
  [/^\/search/, PAGE.SEARCH],
  [/^\/@[^/]+\/replies/, PAGE.PROFILE_REPLIES],
  [/^\/@[^/]+\/?$/, PAGE.PROFILE],
  [/^\/activity/, PAGE.ACTIVITY],
  [/^\/(for-you|following)/, PAGE.FEED],
];

/**
 * Какая это страница.
 *
 * Принимает и полный адрес, и один путь: фон рассуждает об адресах, которые
 * ещё только собирается открыть, страница — о своём собственном `location`.
 */
export function pageKindOf(urlOrPath) {
  let path = String(urlOrPath || '');
  if (/^https?:\/\//.test(path)) {
    try { path = new URL(path).pathname; } catch { return PAGE.OTHER; }
  } else {
    path = path.split(/[?#]/)[0];
  }

  if (path === '/' || path === '') return PAGE.FEED;
  for (const [re, kind] of ROUTES) if (re.test(path)) return kind;
  return PAGE.OTHER;
}

/**
 * Страницы с бесконечной подгрузкой.
 *
 * Лента и поиск подсыпают новое, пока листаешь. Профиль, пост и уведомления
 * конечны: пролистывание рано или поздно упирается в конец, и продолжать его
 * значит топтаться. Ради этого различия список и заведён — 04.08 агент
 * семнадцать минут листал одну ветку вверх и вниз.
 */
export const ENDLESS = new Set([PAGE.FEED, PAGE.SEARCH]);

/** Куда идти, чтобы оказаться на странице такого вида. */
export const PAGE_URL = {
  [PAGE.FEED]: 'https://www.threads.com/',
  [PAGE.ACTIVITY]: 'https://www.threads.com/activity',
  [PAGE.SEARCH]: 'https://www.threads.com/search',
};

/** Человеческое название — для журнала и плашки. */
export const PAGE_LABEL = {
  [PAGE.FEED]: 'лента',
  [PAGE.SEARCH]: 'поиск',
  [PAGE.POST]: 'ветка поста',
  [PAGE.PROFILE]: 'профиль',
  [PAGE.PROFILE_REPLIES]: 'ответы профиля',
  [PAGE.ACTIVITY]: 'уведомления',
  [PAGE.BLOCKED]: 'страница блокировки',
  [PAGE.OTHER]: 'неизвестная страница',
};

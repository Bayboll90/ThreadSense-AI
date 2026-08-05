/**
 * Конечный автомат агента.
 *
 * Content script выполняет роль исполнителя: он тикает раз в несколько секунд,
 * отчитывается о том, что сделал, и спрашивает следующую команду. Все решения
 * принимаются здесь.
 *
 * Разделение сделано ради живучести. В Manifest V3 service worker выгружается
 * после тридцати секунд простоя, поэтому держать в нём таймерный цикл нельзя.
 * Content script живёт ровно столько, сколько открыта вкладка Threads, — и это
 * же правильная семантика: агент не должен действовать, когда вкладки нет.
 *
 * Весь прогресс конвейера персистится в state.pipeline, поэтому выгрузка
 * service worker посреди работы ничего не ломает: он просыпается на следующий
 * тик и продолжает с того же шага.
 */

import { MSG, HALT, HALT_LABEL } from '../common/messages.js';
import { PAGE, PAGE_URL, PAGE_LABEL, ENDLESS, pageKindOf } from '../common/pages.js';
import { getSettings, getState, updateState, pushLog, todayKey } from '../common/storage.js';
import {
  rolloverDay, canComment, canSpend, refreshBreaker, refreshHalt,
  recordComment, recordLike, recordViews, recordSpend, recordSkip, markSeen,
  onSuccess, onError, onShadowFail, halt as haltState,
} from './limiter.js';
import {
  shouldStartSession, shouldEndSession, planSession, planBreak,
  planInSessionDelay, pickAction, inActiveWindow, msUntilWindowOpens, wakeLabel,
  effectiveTiming,
} from './scheduler.js';
import { planFresh, inGap, msUntilHour, hhmm, describePlan } from './rhythm.js';
import { prefilter, scorePost, pickTarget, chunk } from './scorer.js';
import { scoreRelevance, generateComment } from './generator.js';
import { recordAngle } from './safety.js';
import { enqueue } from './queue.js';
import { hash } from '../common/text.js';
import { pick, chance, randInt } from '../common/rng.js';
import { notify } from './notify.js';
import { claim, complete, release } from './registry.js';
import {
  addCandidates, takeBest, toTarget, dropFromBacklog, backlogStats,
} from './backlog.js';
import {
  slotDue, expiredSlots, pickKind, markSlotPosted, markSlotMissed, pickTopic, rememberTopic,
  POST_KINDS, guideSlots, moscowNow, lenLimits,
} from './postplan.js';
import {
  recordPublished, pickForRecheck, recordRecheck, shouldHalt as survivalHalt, survivalStats,
  releaseSpentStreak, expireStale, staleCount,
} from './survival.js';
import { collectNews } from './newsfeed.js';
import {
  observe, detectTrends, dedupeTrends, trendsAsMaterial, trendQueries, trendSummary,
  noteQueryResult, healthyQueries, benchedQueries,
} from './trends.js';
import { generatePost } from './poster.js';
import { collectTools, pickTool, rememberTool, toolMaterial } from './tools.js';
import { renderToolCard } from './cardimage.js';
import {
  pickTail, appendTail, queueFollowup, pickFollowup, dropFollowup, followupText,
} from './funnel.js';
import {
  shouldCheckOwn, pickOwnPosts, pickReplyToAnswer, rememberAnswer, outsideReplies,
  markOwnServed,
} from './hosting.js';
import { generateHostReply } from './generator.js';
import { recordPost, measurePosts, formatStats, learningReport } from './learning.js';
import { SKIP, summarize, skipLabel } from '../common/skipcodes.js';
import { onTechnicalFailure, onSuccessfulAction, commandFor, STEP } from './recovery.js';

/** Команда «ничего не делай, спроси через N мс». */
const idle = (waitMs, why) => ({ cmd: MSG.CMD_IDLE, waitMs: Math.max(3000, Math.round(waitMs)), why });

/**
 * Где агент находится прямо сейчас.
 *
 * Вид страницы приходит со страницы: она смотрит на живой `location`, а фон
 * знает адрес с чужих слов и в SPA успевает отстать. Разбор адреса остаётся
 * запасным путём — на случай, когда тик пришёл от content-скрипта прежней
 * версии, ещё не умеющего отвечать на этот вопрос.
 */
const whereIs = (ctx) => ctx?.kind || pageKindOf(ctx?.url || '');

/**
 * Команда «перейди туда, где задуманное вообще возможно».
 *
 * Отдельная функция, а не адрес строкой в каждом месте: раньше все переходы
 * вели на `https://www.threads.com/` дословно, и добавить в обиход ещё одно
 * место — вкладку уведомлений, например — было негде.
 */
const goTo = (kind, why) => ({ cmd: MSG.CMD_GOTO, url: PAGE_URL[kind], kind, why });

/** Конвейер протухает, если застрял: не держим мёртвую цель вечно. */
const PIPELINE_TTL_MS = 12 * 60000;

/**
 * Главная точка входа. Вызывается на каждый TICK от content script.
 *
 * @param {object} report что content script только что сделал (может быть null)
 * @param {object} ctx    { url, tabId }
 * @returns {Promise<object>} команда
 */
export async function decide(report, ctx) {
  const settings = await getSettings();

  // 1. Учесть результат предыдущего шага.
  if (report?.step) {
    const done = await applyReport(report, settings, ctx);
    if (done) return done;
  }

  // 2. Обновить сутки, предохранитель, снять истёкшие остановки.
  let dropped = null;
  let released = false;
  let freshPlan = null;
  const state = await updateState((s) => {
    const wasDay = s.day;
    rolloverDay(settings, s, Date.now());
    // Новые сутки принесли новый распорядок — о нём стоит сказать вслух.
    if (s.day !== wasDay && s.rhythm) freshPlan = { plan: s.rhythm, limit: s.dayLimit };
    refreshBreaker(s);

    /* Остановка без срока может исчезнуть только одним способом — если она
       неисправна. Такое снятие нельзя делать молча: молчание здесь ничем не
       отличается от молчания сломанного агента. */
    const before = s.halt;
    refreshHalt(s, Date.now());
    if (before && !s.halt && !before.until) dropped = before;

    /* Серия пропаж, пережившая свою остановку, считается заново. */
    released = releaseSpentStreak(s, settings);

    if (s.pipeline && Date.now() - (s.pipeline.startedAt || 0) > PIPELINE_TTL_MS) s.pipeline = null;
    return s;
  });

  /*
   * Распорядок дня — в журнал, одной строкой.
   *
   * Без этого «агент молчал с 14 до 16» разбирается гаданием, а разыгранная
   * отлучка неотличима от поломки. Ровно та же болезнь, что стоила
   * четырнадцати часов тишины 04.08: решение принято, но никому не сказано.
   */
  if (freshPlan) {
    await pushLog({
      level: 'info',
      event: 'rhythm',
      msg: `День: ${describePlan(freshPlan.plan)}`,
      detail: `норма комментариев ${freshPlan.limit}`,
    }, settings.ui.logSize);
  }

  if (dropped) {
    await pushLog({
      level: 'warn',
      event: 'guard',
      msg: 'Снята остановка с неизвестной причиной — работаем дальше',
      detail: `причина «${dropped.reason}», ${dropped.detail || 'без пояснения'}, `
        + `поставлена ${new Date(dropped.at || 0).toLocaleString('ru-RU')}`,
    }, settings.ui.logSize);
  }

  if (released) {
    await pushLog({
      level: 'info',
      event: 'survival',
      msg: 'Серия пропаж сброшена: остановка по ней уже кончилась',
      detail: `предел ${settings.safety.vanishedLimit}; считаем заново`,
    }, settings.ui.logSize);
  }

  // 3. Общие рубильники.
  if (!settings.enabled) return idle(30000, 'агент выключен');

  if (!settings.ai.apiKey) {
    return idle(60000, 'не задан ключ AI API');
  }

  if (state.halt) {
    const left = state.halt.until ? state.halt.until - Date.now() : null;
    // Человеческая подпись, а не машинный код: плашку на странице читает
    // человек, и «остановка: shadow_ban» ему говорит не больше, чем
    // «остановка: undefined» говорила до этого.
    const label = HALT_LABEL[state.halt.reason] || state.halt.reason;
    return idle(left ? Math.min(left, 300000) : 300000, `остановка: ${label}`);
  }

  if (state.breaker === 'open') {
    return idle(Math.min(state.breakerUntil - Date.now(), 300000) || 60000, 'предохранитель разомкнут');
  }

  /*
   * Окно активности — сегодняшнее, а не вчерашнее.
   *
   * Границы берутся из разыгранного на сутки распорядка: подъём и отбой у
   * человека плавают, и неподвижная рамка 7:00–01:00 девять дней подряд была
   * одним из самых заметных признаков программы. Розыгрыш происходит при
   * смене суток, здесь он только читается.
   */
  const timing = effectiveTiming(settings, state);

  if (!inActiveWindow(timing)) {
    // Час пробуждения — в причине простоя: длина тика его не показывает, она
    // обрезана десятью минутами и со стороны выглядит как зависание.
    return idle(
      Math.min(msUntilWindowOpens(timing), 600000),
      `вне окна активности, до ${wakeLabel(timing)}`,
    );
  }

  /*
   * Отлучка: обед, дорога, дела.
   *
   * Ровное присутствие все часы окна — та же одинаковость, что и одинаковые
   * сутки, только внутри дня. У людей день разорван, и эти разрывы длиннее
   * любого перерыва между сессиями, поэтому они и заметны со стороны.
   */
  const gap = settings.rhythm?.enabled && planFresh(state.rhythm) ? inGap(state.rhythm) : null;
  if (gap) {
    const endsIn = msUntilHour(gap.to);
    return idle(Math.min(Math.max(endsIn, 60000), 600000), `отлучка до ${hhmm(gap.to)}`);
  }

  /*
   * 3а. Потерянные слоты публикации — вслух.
   *
   * Проверка стоит до управления сессией намеренно: пост пишется только внутри
   * сессии, а окно слота может целиком лечь в перерыв — именно так 03.08
   * пропал разбор инструмента в 16:40. Спрашивать о пропаже там же, где
   * публикуем, значит узнавать о ней с опозданием на весь перерыв, а то и не
   * узнать вовсе, если день кончился раньше следующей сессии.
   *
   * Арифметика дешёвая: расписание считается из даты, в хранилище никто не
   * ходит, пока пропусков нет.
   */
  await reportMissedSlots(settings, state);

  // 4. Управление сессией.
  if (state.session?.active && shouldEndSession(state.session, Date.now())) {
    const breakMs = planBreak(settings);
    await updateState((s) => {
      s.session = { ...s.session, active: false };
      s.nextSessionAt = Date.now() + breakMs;
      s.pipeline = null;
      return s;
    });
    await pushLog({
      level: 'info',
      event: 'session_end',
      msg: `Сессия закрыта. Перерыв ${Math.round(breakMs / 60000)} мин`,
    }, settings.ui.logSize);
    return idle(Math.min(breakMs, 300000), 'перерыв между сессиями');
  }

  if (!state.session?.active) {
    const verdict = shouldStartSession(settings, state, Date.now());
    if (!verdict.start) return idle(Math.min(verdict.retryIn, 300000), verdict.why);

    const session = planSession(settings, Date.now());
    await updateState((s) => { s.session = session; s.pipeline = null; return s; });
    await pushLog({
      level: 'info',
      event: 'session_start',
      msg: session.idle
        ? `Холостая сессия на ${Math.round((session.endsAt - session.startedAt) / 60000)} мин`
        : `Сессия: ${session.plannedActions} действий за ${Math.round((session.endsAt - session.startedAt) / 60000)} мин`,
    }, settings.ui.logSize);
  }

  // 5. Продолжить незаконченный конвейер.
  // Читаем без записи: на каждом тике сохранять неизменённое состояние незачем.
  const fresh = await getState(true);
  if (fresh.pipeline) return continuePipeline(fresh, settings, ctx);

  /*
   * 5а. Собственный пост, если подошёл слот.
   *
   * Проверка стоит здесь намеренно — после конвейера, но до выбора обычного
   * действия. После конвейера, потому что начатый комментарий нельзя бросать
   * на полпути ради поста. До выбора действия, потому что слот привязан ко
   * времени: отложив его до конца сессии, мы либо промахнёмся мимо окна, либо
   * опубликуем всё разом, когда окно почти закрылось.
   */
  const post = await maybePost(settings, fresh, ctx);
  if (post) return post;

  /*
   * 5б. Жив ли прежний ответ.
   *
   * Не чаще раза в час и только для отлежавшихся: проверка стоит перехода на
   * страницу ветки, а свежий ответ и так подтверждён при отправке.
   *
   * Сначала закрываем те, смотреть которые уже поздно. Очередь непроверенных
   * не опустошается никогда — публикуем быстрее, чем проверяем, — и без этого
   * в наблюдении копятся суточные записи, которые выглядят предстоящей
   * работой, хотя проверять их незачем.
   */
  let forRecheck = fresh;
  if (staleCount(fresh, settings)) {
    let stale = 0;
    forRecheck = await updateState((s) => { stale = expireStale(s, settings); return s; });
    await pushLog({
      level: 'info',
      event: 'survival',
      msg: `Просрочено ответов под наблюдением: ${stale}`,
      detail: `старше ${settings.safety.recheckMaxAgeMin} мин — пропажа в таком возрасте ничего не доказывает`,
    }, settings.ui.logSize);
  }

  const check = pickForRecheck(forRecheck, settings);
  if (check) {
    return {
      cmd: MSG.CMD_RECHECK,
      url: check.url,
      needle: check.needle,
      // Автора передаём, чтобы запись в журнале называла ветку по имени, а не
      // вопросительным знаком: по «@?» непонятно, что именно проверялось.
      author: check.author || null,
      handle: (settings.handle || '').replace(/^@/, ''),
      why: 'проверяем, на месте ли прежний ответ',
    };
  }

  /*
   * 5в. Ответить тем, кто написал под нашим постом.
   *
   * Стоит после проверки выживаемости и до выбора обычного действия. После —
   * потому что проверка дешевле и важнее. До — потому что человек, ответивший
   * нам, ждёт сейчас, а не когда закончится очередь на комментарии.
   *
   * Собственный ритм, а не доля в мешке источников: это не конкурент поиску
   * целей, а другая работа.
   */
  const own = shouldCheckOwn(settings, fresh);
  if (own.check) {
    const handle = (settings.handle || '').replace(/^@/, '');
    const profileUrl = `https://www.threads.com/@${handle}`;

    await updateState((s) => {
      s.lastOwnCheckAt = Date.now();
      s.pipeline = { phase: 'need_scan', source: 'own', targetUrl: profileUrl, startedAt: Date.now() };
      return s;
    });

    if (!sameRoute(ctx.url, profileUrl)) {
      return { cmd: MSG.CMD_GOTO, url: profileUrl, why: 'смотрим, кто ответил под нашими постами' };
    }
    return scanCommand(settings, 'own');
  }

  // 6. Если на текущей странице читать больше нечего — вернуться в ленту.
  //
  // Страница поста конечна: докрутив её до низа, агент будет бесконечно
  // скроллить пустоту. Человек в такой ситуации возвращается в ленту, и с
  // точки зрения поведенческих метрик это же и правильно: аккаунт, который
  // резко перестал листать, выглядит не менее странно, чем слишком активный.
  if ((fresh.emptyBrowses || 0) >= 2 && whereIs(ctx) !== PAGE.FEED) {
    await updateState((s) => { s.emptyBrowses = 0; return s; });
    return goTo(PAGE.FEED, `на странице «${PAGE_LABEL[whereIs(ctx)]}» читать нечего, возвращаемся в ленту`);
  }

  // 7. Пауза между действиями внутри сессии.
  if (Date.now() < (fresh.nextActionAt || 0)) {
    return idle(Math.min(fresh.nextActionAt - Date.now(), 120000), 'пауза внутри сессии');
  }

  // 8. Выбрать следующее действие.
  const action = pickAction(settings, fresh.session);

  /*
   * Читать можно только там, где есть что читать.
   *
   * Страница профиля и страница поста конечны: докрутив до низа, агент
   * упирается в конец и продолжает слать команды пролистывания. Счётчик
   * холостых проходов при этом не растёт — карточки на странице есть, просмотры
   * засчитываются, — и застревание получается бесшумным. Со стороны выглядит
   * так, будто агент задумчиво изучает чужой профиль по десять минут.
   *
   * Лента бесконечна, поэтому чтение и лайки идут только на ней.
   */
  if ((action === 'browse' || action === 'like') && !ENDLESS.has(whereIs(ctx))) {
    return goTo(PAGE.FEED, `читать нужно ленту, а не «${PAGE_LABEL[whereIs(ctx)]}»`);
  }

  if (action === 'comment') {
    const gate = canComment(settings, fresh);
    if (!gate.ok) {
      // Лимит выбран — не стоим впустую, дочитываем ленту как человек.
      await pushLog({ level: 'info', event: 'limit', msg: gate.reason }, settings.ui.logSize);
      return browseCommand(settings, 'лимит: ' + gate.reason);
    }
    return startCommentPipeline(settings, ctx);
  }

  if (action === 'like') {
    await updateState((s) => {
      s.session = { ...s.session, likeCount: (s.session.likeCount || 0) + 1 };
      return s;
    });
    await bumpNextAction(settings, 0.35);
    return { cmd: MSG.CMD_BROWSE, intent: 'like', scrolls: randInt(2, 6), maxLikes: 1, why: 'лайк' };
  }

  /*
   * Пролистывание — фон, а не отдельное событие.
   *
   * Человек не делает паузу в семь минут между двумя движениями колеса: он
   * читает ленту непрерывно и лишь изредка на чём-то останавливается.
   * Полная пауза между просмотрами растягивала норму в двенадцать просмотров
   * на полтора часа, и до комментария дело не доходило вовсе.
   */
  await updateState((s) => {
    s.session = { ...s.session, browseCount: (s.session.browseCount || 0) + 1 };
    return s;
  });
  await bumpNextAction(settings, 0.12);
  return browseCommand(settings, 'чтение ленты');
}

/* ------------------------------------------------------------------ *
 * Конвейер комментария
 * ------------------------------------------------------------------ */

async function startCommentPipeline(settings, ctx) {
  const source = pickSource(settings);
  const targetUrl = urlForSource(source, settings, await getState());

  await updateState((s) => {
    s.pipeline = { phase: 'need_scan', source, targetUrl, startedAt: Date.now() };
    return s;
  });

  // Если мы уже на нужной странице, лишняя навигация только мешает: перезагрузка
  // ленты сбрасывает позицию скролла и выглядит неестественно.
  if (targetUrl && !sameRoute(ctx.url, targetUrl)) {
    return { cmd: MSG.CMD_GOTO, url: targetUrl, why: `переход к источнику: ${source}` };
  }
  return scanCommand(settings, source);
}

function continuePipeline(state, settings, ctx) {
  const p = state.pipeline;
  switch (p.phase) {
    case 'need_scan':
      if (p.targetUrl && !sameRoute(ctx.url, p.targetUrl)) {
        return { cmd: MSG.CMD_GOTO, url: p.targetUrl, why: 'переход к источнику' };
      }
      return scanCommand(settings, p.source);

    case 'need_open':
      return {
        cmd: MSG.CMD_OPEN_THREAD,
        url: p.target.url,
        postId: p.target.id,
        readMs: p.readMs,
        why: 'открываем ветку',
      };

    case 'need_reply':
      return {
        cmd: MSG.CMD_REPLY,
        url: p.target.url,
        text: p.draft.text,
        replyTo: p.draft.replyTo,
        replyToHandle: p.draft.replyToHandle,
        postId: p.target.id,
        typing: settings.typing,
        why: 'публикуем ответ',
      };

    default:
      return idle(8000, 'конвейер в неизвестном состоянии');
  }
}

function scanCommand(settings, source) {
  return {
    cmd: MSG.CMD_SCAN,
    source,
    limit: settings.scoring.scanLimit,
    scrolls: randInt(3, 8),
    why: `сканируем: ${source}`,
  };
}

/* ------------------------------------------------------------------ *
 * Собственные посты
 * ------------------------------------------------------------------ */

/** Минуты от полуночи в человеческие часы: слот 1000 → «16:40». */
function clock(minutes) {
  const m = Math.round(minutes);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Назвать слоты, чьё окно закрылось без публикации.
 *
 * Пропущенный слот — не авария: расписание живёт отдельно от сессий, и часть
 * слотов будет теряться в перерывах всегда. Но молчаливая потеря неотличима от
 * поломки автопостинга, а разница принципиальная. Уровень `warn`, чтобы такие
 * записи было видно в журнале отдельно от обычных.
 */
async function reportMissedSlots(settings, state) {
  const p = settings.posting;
  const missed = expiredSlots(p, state);
  if (!missed.length) return;

  const guides = guideSlots(p, moscowNow().key);
  const label = (m) => clock(m.at) + (guides.has(m.slot) ? ' (полезный разбор)' : '');

  await pushLog({
    level: 'warn',
    event: 'post',
    msg: missed.length === 1
      ? `Слот публикации ${label(missed[0])} потерян`
      : `Потеряно слотов публикации: ${missed.length}`,
    detail: missed
      .map((m) => `${label(m)} — окно закрылось в ${clock(m.until)}, публикации не было`)
      .join('\n'),
  }, settings.ui.logSize);

  await updateState((s) => {
    for (const m of missed) markSlotMissed(s, m.slot);
    return s;
  });
}

/**
 * Пора ли публиковать свой пост, и если да — подготовить его.
 *
 * Возвращает команду или null. Вся тяжёлая работа — поход за новостями и
 * генерация — делается только когда слот действительно наступил: проверять
 * расписание дёшево, а собирать материал на каждом тике незачем.
 */
async function maybePost(settings, state, ctx) {
  const p = settings.posting;
  if (!p?.enabled) return null;

  /*
   * Ручной запуск обходит расписание, но не остальные ограничители.
   *
   * Бюджет, лимиты, фильтры текста и защита от самоповтора работают как
   * обычно: смысл флага в том, чтобы не ждать слота, а не в том, чтобы
   * публиковать в обход проверок.
   */
  const forced = !!state.forcePost;
  const due = forced ? { due: true, slot: null, forced: true } : slotDue(p, state);
  if (!due.due) return null;

  // Пост пишется только с главной: композер на странице ветки создаёт ответ.
  if (whereIs(ctx) !== PAGE.FEED) {
    return goTo(PAGE.FEED, 'подошёл слот публикации, возвращаемся на главную');
  }

  if (!canSpend(settings, state)) {
    await pushLog({
      level: 'warn', event: 'post', msg: 'Слот публикации пропущен: бюджет AI исчерпан',
    }, settings.ui.logSize);
    return null;
  }

  /*
   * 1. Материал. Нужен не всем форматам, поэтому неудача сбора не фатальна.
   *
   * Два источника, и порядок между ними содержательный. Тренд — это разговор,
   * который идёт прямо сейчас среди людей, способных нас увидеть. Новость —
   * событие, случившееся где-то ещё; попасть с ней в ленту можно только если
   * её здесь уже обсуждают, а это как раз и проверяет первый источник.
   *
   * Неделя работы на одних новостях дала ноль откликов, поэтому лента идёт
   * первой. Новости остаются запасом: не каждый день в нише что-то кипит, и
   * молчать из-за этого незачем.
   */
  const posted = new Set(state.postedNews || []);

  let trends = [];
  if (settings.trends?.enabled) {
    trends = dedupeTrends(detectTrends(state, settings));
  }
  const trendMaterial = trendsAsMaterial(trends).filter((i) => !posted.has(i.id));

  let news = { items: [], via: 'none' };
  const needNews = !settings.trends?.preferOverNews || !trendMaterial.length;
  if (needNews) {
    try {
      news = await collectNews(settings);
    } catch (e) {
      await pushLog({
        level: 'warn', event: 'post', msg: `Сбор новостей не удался: ${e.message}`,
      }, settings.ui.logSize);
    }
  }

  const fresh = [...trendMaterial, ...news.items.filter((i) => !posted.has(i.id))];
  const material = fresh[0] || null;

  if (material?.trend) {
    await pushLog({
      level: 'info', event: 'post',
      msg: `Повод из ленты: «${material.trend.term}» — рост ×${material.trend.burst.toFixed(1)}`,
      detail: trendSummary(trends),
    }, settings.ui.logSize);
  }

  /*
   * 2. Формат. Ручной запуск может попросить конкретный.
   *
   * Веса из схемы наклоняются фактическим откликом на прошлые посты: агент
   * смотрит, что из его собственных публикаций собрало реакции, и делает
   * таких больше. Пока измеренных постов мало, поправка равна единице и
   * ничего не меняет.
   */
  const stats = formatStats(state, settings);

  /*
   * 2а. Полезный слот.
   *
   * Два слота в сутки закреплены за разбором инструмента — это обещание
   * читателю, а не пожелание, поэтому формат здесь назначается, а не
   * разыгрывается. Всё остальное решает розыгрыш, как и прежде.
   *
   * Если инструмент не нашёлся — сеть недоступна, копилка пуста, обо всём уже
   * писали, — слот не пропадает: пишется обычный пост. Молчать из-за того, что
   * не собралась инструкция, дороже, чем выпустить наблюдение.
   */
  let guide = null;
  if (settings.tools?.enabled && !forced && due.slot != null
      && guideSlots(p, moscowNow().key).has(due.slot)) {
    guide = await prepareGuide(settings, state);
    if (!guide) {
      await pushLog({
        level: 'info', event: 'post',
        msg: 'Полезный слот: инструмент не нашёлся, пишем обычный пост',
      }, settings.ui.logSize);
    }
  }

  const kind = guide ? 'toolguide'
    : (forced && state.forceKind && POST_KINDS[state.forceKind])
      ? state.forceKind
      : pickKind(state, { hasMaterial: !!material, settings, stats });
  const needsMaterial = POST_KINDS[kind]?.needsMaterial;

  /* 3. Текст. */
  const recent = (state.recentPosts || []).slice(-(p.memory ?? 25));
  let gen;
  try {
    gen = guide
      ? await generatePost(kind, guide.material, settings, recent)
      : await generatePost(kind, needsMaterial ? material : null, settings, recent);
  } catch (e) {
    await updateState((s) => { onError(settings, s); return s; });
    await pushLog({ level: 'error', event: 'post', msg: `Генерация поста: ${e.message}` }, settings.ui.logSize);
    return null;
  }

  await updateState((s) => { recordSpend(s, gen.cost); return s; });

  /*
   * Спасённый от перебора пост объявляем вслух.
   *
   * Молча подправленный текст — та же дыра в видимости, что и молча
   * пропущенный: в профиле окажется не совсем то, что написала модель, и
   * понять это по журналу будет нельзя. Если такие записи пойдут подряд,
   * значит потолок формата разошёлся с тем, что формат обещает читателю.
   */
  if (gen.ok && gen.trimmed) {
    await pushLog({
      level: 'info', event: 'post', msg: `Пост подрезан под потолок: ${gen.trimmed}`,
      detail: gen.text,
    }, settings.ui.logSize);
  }

  if (!gen.ok) {
    await pushLog({
      level: 'warn', event: 'post', msg: `Пост забракован: ${gen.reason}`,
      detail: `формат ${POST_KINDS[kind]?.label || kind}`,
    }, settings.ui.logSize);
    // Слот отмечаем отработанным: иначе на каждом тике будет новая попытка
    // генерации, и неудачный слот съест бюджет за час.
    await updateState((s) => {
      if (forced) { s.forcePost = false; s.forceKind = null; }
      else markSlotPosted(s, due.slot, kind);
      return s;
    });
    return null;
  }

  /*
   * 4. Черновик или публикация — решает тот же выключатель, что и у
   * комментариев.
   *
   * Раньше у постов был свой независимый `draftsOnly`, и получалось, что при
   * включённом автопилоте комментарии уходят сами, а посты копятся в очереди.
   * Со стороны это выглядит поломкой: галочка «автопилот» стоит, а половина
   * работы не делается. Одна галочка — одно поведение; отдельный флаг остаётся
   * только как принудительное усиление, но снять автопилот он не может.
   */
  if (!settings.autopilot || p.draftsOnly) {
    await enqueue({
      id: `post_${Date.now()}`,
      kind: 'own_post',
      postKind: kind,
      draft: { text: gen.text, parts: gen.parts || [gen.text], raw: gen.raw },
      material: material ? { title: material.title, url: material.url } : null,
      status: 'pending',
      createdAt: Date.now(),
    });
    await updateState((s) => {
      if (forced) { s.forcePost = false; s.forceKind = null; s.lastPostKind = kind; }
      else markSlotPosted(s, due.slot, kind);
      if (needsMaterial && material) s.postedNews = [...(s.postedNews || []), material.id].slice(-200);
      return s;
    });
    await pushLog({
      level: 'info', event: 'post', msg: `Черновик поста в очереди (${POST_KINDS[kind]?.label})`,
      detail: gen.text,
    }, settings.ui.logSize);
    return null;
  }

  /*
   * Слот закрывается здесь, а не по отчёту о публикации.
   *
   * Отчёт может не прийти вовсе: команда упала, вкладка перезагрузилась, скрипт
   * умер на навигации. Пока слот открыт, каждый следующий тик заново идёт за
   * новостями и заново генерирует текст — и это не теория. Живой прогон выдал
   * три команды публикации за сорок секунд, все про один и тот же релиз
   * Anthropic, каждая оплачена отдельной генерацией.
   *
   * Слот означает «в этот час мы за постом уже сходили», а не «пост
   * опубликован». Потерять слот из-за сбоя дешевле, чем публиковать трижды:
   * следующий наступит через три часа, а три поста подряд про одно и то же
   * останутся в профиле навсегда.
   *
   * Материал помечаем использованным по той же причине — иначе следующий слот
   * возьмёт ту же новость.
   */
  await updateState((s) => {
    // Ручной запуск слота не занимает: расписание не должно сдвигаться от того,
    // что пост попросили вне очереди. Снимаем сам флаг — он и был правом.
    if (forced) {
      s.forcePost = false;
      s.forceKind = null;
      s.lastPostKind = kind;
      s.recentPostKinds = [...(s.recentPostKinds || []), kind].slice(-8);
    } else {
      markSlotPosted(s, due.slot, kind);
    }
    if (needsMaterial && material) {
      s.postedNews = [...(s.postedNews || []), material.id].slice(-200);
    }
    return s;
  });

  /*
   * Подпись воронки — только под полезным разбором.
   *
   * Под наблюдением или вопросом она выглядит рекламной вставкой в чужой
   * разговор; под инструкцией, которую человек дочитал до конца, — уместным
   * «у меня есть ещё». Дописывается кодом, а не моделью: одна и та же строка
   * должна быть предсказуемой и без ссылок.
   */
  if (guide && settings.funnel?.enabled && gen.parts?.length) {
    const tail = pickTail(settings, state);
    const lim = lenLimits(kind, settings);
    const withTail = appendTail(gen.parts, tail, lim.max);
    if (withTail.added) {
      gen.parts = withTail.parts;
      gen.text = withTail.parts[0];
      await updateState((s) => { s.lastTail = tail; return s; });
    }
  }

  await pushLog({
    level: 'info',
    event: 'post_target',
    msg: `Публикуем ${POST_KINDS[kind]?.label || kind}: `
      + ((gen.parts?.length || 1) > 1 ? `ветка из ${gen.parts.length} сообщ.` : `${gen.text.length} симв`)
      + (material && needsMaterial ? ` · повод: ${material.sourceName}` : '')
      + (news.via === 'fallback' ? ' · источник запасной' : ''),
    detail: (gen.parts || [gen.text]).join('\n— — —\n'),
  }, settings.ui.logSize);

  /*
   * Тема выбирается здесь, а не в content script: это решение о содержании, а
   * руки должны получать готовый ответ. Ровно то же разделение, что и у текста.
   */
  const topic = settings.posting?.setTopic === false
    ? null
    : pickTopic(gen.parts?.join(' ') || gen.text, settings, state);

  /*
   * Картинка — только к разбору инструмента, и вот почему.
   *
   * Она делает две вещи: занимает больше места в ленте и несёт на себе адрес.
   * Второе важнее первого: ссылка в тексте уводит читателя с платформы, а
   * надпись на картинке — просто пиксели, и её никто не считает уходом.
   *
   * Но карточка осмысленна лишь там, где есть что на неё вынести: название
   * инструмента, польза, команда установки. Пририсовывать её к наблюдению или
   * вопросу значило бы делать красивую пустоту, поэтому картинка привязана к
   * формату, а не ко всем постам подряд.
   */
  let image = null;
  if (guide && settings.posting?.image?.enabled !== false) {
    try {
      const card = await renderToolCard(guide.material, {
        site: settings.funnel?.site || '',
        handle: settings.handle,
      });
      image = card.dataUrl;
      await pushLog({
        level: 'info', event: 'post',
        msg: `Карточка собрана за ${card.ms} мс, ${Math.round(card.bytes / 1024)} КБ`,
      }, settings.ui.logSize);
    } catch (e) {
      await pushLog({
        level: 'warn', event: 'post', msg: `Карточка не собралась: ${e.message}`,
      }, settings.ui.logSize);
    }
  }

  return {
    cmd: MSG.CMD_POST,
    text: gen.text,
    parts: gen.parts || [gen.text],
    /*
     * Части, где важен каждый знак: команда установки. Их набирают без
     * промахов по клавише и сверяют строго, без «почти совпало».
     *
     * 04.08 в опубликованном разборе вышло `github.coom` вместо `github.com`:
     * гуманизатор командное сообщение щадил, а клавиатурный слой — нет, и
     * мягкая сверка на 98% совпадения не возразила.
     */
    exact: gen.exact || [],
    kind,
    topic,
    image,
    slot: due.slot,
    newsId: needsMaterial && material ? material.id : null,
    typing: settings.typing,
    why: `слот публикации ${due.slot}`,
  };
}

/** Итог публикации собственного поста. */
async function onPosted(report, settings) {
  const kind = report.kind || 'tip';

  // Отметка о самом факте отчёта. Первый живой прогон дал публикацию, которая
  // не появилась в профиле и при этом не оставила в журнале ни успеха, ни
  // неудачи — по записям невозможно было понять, дошёл ли отчёт вообще.
  await pushLog({
    level: 'info',
    event: 'post',
    msg: `Отчёт о публикации: ${report.ok ? 'успех' : 'неудача'}`
      + (report.topic ? ` · тема «${report.topic}»${report.topicUnconfirmed ? ' (не из подсказки)' : ''}` : ''),
    detail: [report.code, report.error, report.topicWhy && `тема: ${report.topicWhy}`]
      .filter(Boolean).join(' · '),
  }, settings.ui.logSize);

  /*
   * Неудача с темой называется вслух, даже когда пост вышел.
   *
   * Молча пропущенная тема неотличима от «мы её и не ставили», а разница
   * существенная: в первом случае сломался поиск поля и чинить надо селекторы,
   * во втором всё работает как задумано. Уровень `warn`, чтобы такие записи
   * было видно в журнале отдельно от обычных.
   */
  if (report.ok && report.topicWhy) {
    await pushLog({
      level: 'warn', event: 'post',
      msg: `Пост опубликован без темы: ${report.topicWhy}`,
    }, settings.ui.logSize);
  }

  if (report.ok) {
    await updateState((s) => {
      // Слот уже закрыт при выдаче команды; здесь только повторная отметка на
      // случай, если состояние успело откатиться. У ручного запуска слота нет.
      if (report.slot != null) markSlotPosted(s, report.slot, kind);
      s.dayPosts = (s.dayPosts || 0) + 1;
      rememberTopic(s, report.topic);
      /* Запись для обучения: формат, тема, длина и время. Отклик допишется
         позже, когда агент зайдёт в свой профиль. */
      recordPost(s, {
        kind,
        topic: report.topic,
        parts: report.parts?.length ? report.parts : null,
        text: report.text,
      });
      // Помним каждую часть отдельно: защита от самоповтора сравнивает
      // сообщения, а склеенная ветка похожа сама на себя и ни на что другое.
      const posted = report.parts?.length ? report.parts : [report.text].filter(Boolean);
      if (posted.length) s.recentPosts = [...(s.recentPosts || []), ...posted].slice(-60);
      if (report.newsId) s.postedNews = [...(s.postedNews || []), report.newsId].slice(-200);

      /*
       * Полезный разбор встаёт в очередь на собственный комментарий со
       * ссылкой. Адреса поста мы сейчас не знаем — композер его не отдаёт, —
       * поэтому комментарий оставим на ближайшем заходе в профиль, тем же
       * обходом, который и так делается ради ответов читателям.
       */
      if (kind === 'toolguide' && settings.funnel?.followup?.enabled) {
        queueFollowup(s, report.text);
      }

      onSuccessfulAction(s);
      return s;
    });

    await pushLog({
      level: 'info',
      event: 'post',
      msg: `Опубликован ${POST_KINDS[kind]?.label || kind}`
        + ((report.parts?.length || 1) > 1 ? ` · ветка из ${report.parts.length} сообщ.` : ''),
      detail: (report.parts || [report.text]).filter(Boolean).join('\n— — —\n'),
    }, settings.ui.logSize);

    await bumpNextAction(settings, 1.2);
    return browseCommand(settings, 'пост опубликован, читаем ленту');
  }

  /*
   * Неудача слот всё равно закрывает.
   *
   * Иначе следующий тик снова сочтёт слот наступившим, снова сходит за
   * новостями и снова сгенерирует текст — и так до конца окна ожидания.
   * Публикация не настолько ценна, чтобы платить за неё десятком генераций.
   */
  await updateState((s) => {
    if (report.slot != null) markSlotPosted(s, report.slot, kind);
    onError(settings, s);
    return s;
  });

  await pushLog({
    level: 'warn', event: 'post',
    msg: `Пост не опубликован: ${report.error || 'без причины'}`,
    detail: report.code || '',
  }, settings.ui.logSize);

  return browseCommand(settings, 'публикация не удалась');
}

/**
 * Итог перепроверки: жив ли прежний ответ.
 *
 * Пропажа одного ответа не считается тревогой намеренно. Автор вправе удалить
 * любой комментарий, ветку могут закрыть, пост могут снять — к нам это может
 * не иметь отношения вовсе. Значение имеет только серия.
 */
async function onRechecked(report, settings) {
  /*
   * Три исхода, а не два.
   *
   * «Не нашли» и «не смогли посмотреть» — разные вещи, и путать их дорого:
   * под постом с полусотней ответов Threads рисует десяток, и нашего среди
   * них может не быть просто потому, что он ниже. Ровно эта подмена уже
   * стоила остановки на сутки в проверке появления ответа; здесь она осталась
   * и привела к остановке 03.08.
   *
   * `null` означает «проверка не состоялась»: серия не растёт и не рвётся.
   */
  const alive = report.alive === true ? true : (report.alive === false ? false : null);

  const st = await updateState((s) => {
    recordRecheck(s, report.url, alive);
    return s;
  });

  const stats = survivalStats(st);

  const msg = {
    true: `Ответ на месте: @${report.author || '?'}`,
    false: `Ответ исчез: @${report.author || '?'} · подряд ${stats.streak}`,
    null: `Не смогли проверить ответ: @${report.author || '?'} · ветка показала не всё`,
  }[String(alive)];

  await pushLog({
    level: alive === false ? 'warn' : 'info',
    event: 'survival',
    msg,
    detail: `проверено ${stats.checked}, живых ${stats.alive}, пропало ${stats.vanished}`,
  }, settings.ui.logSize);

  if (alive === false && survivalHalt(st, settings)) {
    /*
     * Остановка со сроком, а не бессрочная.
     *
     * Здесь стояло `HALT.SHADOW` — ключа с таким именем в перечне нет, поэтому
     * причина уезжала в состояние как `undefined`. Показать её было нечем, а
     * `untilMs` не передавался вовсе, и `until: 0` означает «снимет только
     * рука». 03.08 в 23:41 агент так и встал на четырнадцать часов.
     *
     * Срок берём тот же, что у второй остановки по теневому ограничению
     * (`limiter.onShadowFail`): повод один и тот же, разной должна быть только
     * улика, а не наказание.
     */
    const hours = settings.safety.onShadowFailPauseHours;
    await updateState((s) => haltState(
      s, HALT.SHADOW_BAN, 'ответы исчезают из веток', Date.now() + hours * 3600000,
    ));

    /*
     * Остановка обязана попасть в журнал.
     *
     * Раньше о ней сообщало только уведомление Chrome — на сервере без
     * подключённого рабочего стола его не видит никто. В журнале оставалась
     * рядовая строка «Ответ исчез», и четырнадцать часов простоя выглядели
     * как обычная тишина.
     */
    await pushLog({
      level: 'error',
      event: 'guard',
      msg: `Агент остановлен на ${hours} ч: ответы исчезают из веток`,
      detail: `подряд ${stats.streak} из ${settings.safety.vanishedLimit}; `
        + `проверено ${stats.checked}, живых ${stats.alive}`,
    }, settings.ui.logSize);

    notify(
      'ThreadSense AI остановлен',
      `Подряд ${stats.streak} опубликованных ответа пропали из веток. Проверь аккаунт вручную.`,
    );
    return idle(600000, 'ответы не выживают в ветках');
  }

  return browseCommand(settings, {
    true: 'ответ на месте, читаем дальше',
    false: 'ответ пропал, идём дальше',
    null: 'проверка не состоялась, читаем дальше',
  }[String(alive)]);
}

function browseCommand(settings, why) {
  return {
    cmd: MSG.CMD_BROWSE,
    intent: 'read',
    scrolls: randInt(3, 10),
    maxLikes: chance(settings.limits.likeWithoutCommentChance) ? 1 : 0,
    why,
  };
}

/* ------------------------------------------------------------------ *
 * Обработка отчётов от content script
 * ------------------------------------------------------------------ */

async function applyReport(report, settings, ctx) {
  // Сторож мог сработать, пока content script выполнял шаг. Дорогие шаги —
  // те, что идут в OpenAI, — после этого выполнять нельзя: и токены сгорят,
  // и результат всё равно некуда девать.
  if (report.step === 'scan' || report.step === 'open') {
    const st = await getState(true);
    if (st.halt || st.breaker === 'open') {
      await updateState((s) => { s.pipeline = null; return s; });
      return idle(120000, `остановка: ${st.halt?.reason || 'предохранитель'}`);
    }
  }

  switch (report.step) {
    case 'scan':      return onScanned(report, settings, ctx);
    case 'open':      return onThreadOpened(report, settings, ctx);
    case 'reply':     return onReplied(report, settings, ctx);
    case 'post':      return onPosted(report, settings);
    case 'recheck':   return onRechecked(report, settings);
    case 'browse':    return onBrowsed(report, settings);
    case 'goto':      return null; // навигация сама по себе ничего не меняет
    case 'error':     return onStepError(report, settings, ctx);
    default:          return null;
  }
}

/**
 * Найти инструмент для полезного разбора и собрать по нему материал.
 *
 * Копилка обновляется редко: инструменты не появляются ежеминутно, а каждый
 * поход в сеть — это чужие лимиты и секунды ожидания в момент, когда слот уже
 * наступил. Раз в шесть часов достаточно, чтобы не отстать от новинок.
 *
 * Кандидаты перебираются по очереди: способ установки выясняется запросом к
 * репозиторию и не для всех определяется. Три попытки — и хватит: слот не
 * должен превращаться в перебор сорока карточек.
 */
async function prepareGuide(settings, state) {
  const cfg = settings.tools || {};
  const ttl = (cfg.refreshHours ?? 6) * 3.6e6;
  let pool = state.toolPool || [];

  if (!pool.length || Date.now() - (state.toolPoolAt || 0) > ttl) {
    try {
      const fresh = await collectTools(settings);
      if (fresh.length) {
        pool = fresh;
        await updateState((s) => { s.toolPool = fresh; s.toolPoolAt = Date.now(); return s; });
        await pushLog({
          level: 'info', event: 'post',
          msg: `Копилка инструментов обновлена: ${fresh.length}`,
          detail: fresh.slice(0, 5).map((c) => `${c.repo || c.name} (${c.score.toFixed(2)})`).join(' · '),
        }, settings.ui.logSize);
      }
    } catch (e) {
      await pushLog({
        level: 'warn', event: 'post', msg: `Сбор инструментов не удался: ${e.message}`,
      }, settings.ui.logSize);
    }
  }

  const tried = [];
  for (let n = 0; n < 3; n++) {
    const card = pickTool({ toldTools: [...(state.toldTools || []), ...tried] }, pool,
      { minScore: cfg.minScore ?? 0.3 });
    if (!card) break;
    tried.push(card.id);

    let material = null;
    try { material = await toolMaterial(card); } catch { material = null; }
    if (!material?.install) continue;

    /*
     * Помечаем сразу, а не после публикации.
     *
     * Если пост по этому инструменту забракуется, второй заход за ним же
     * почти наверняка кончится тем же — а вот забыть пометку значит начать
     * следующий полезный слот с той же карточки и упереться в неё насмерть.
     */
    await updateState((s) => { rememberTool(s, card); return s; });

    await pushLog({
      level: 'info', event: 'post',
      msg: `Полезный слот: разбираем ${material.repo || material.title}`,
      detail: `${material.installKind} · ${material.install}`,
    }, settings.ui.logSize);

    return { card, material };
  }

  return null;
}

/**
 * Свой профиль просканирован: ищем, кому ответить.
 *
 * Здесь нет ни префильтра, ни оценки релевантности, ни скоринга — всё это про
 * выбор чужого поста, а свой пост выбирать не из чего: обслуживаем те, под
 * которыми появились ответы.
 */
async function onOwnScanned(posts, settings, state) {
  const handle = (settings.handle || '').replace(/^@/, '');
  const mine = pickOwnPosts(posts, settings, state, handle);

  /*
   * Тот же заход, что и ради ответов читателям, снимает счётчики с наших
   * постов. Отдельного обхода не нужно: карточки уже разобраны, а адрес поста
   * в момент публикации нам всё равно неизвестен — запись опознаётся здесь по
   * началу текста.
   */
  let measured = { matched: 0, updated: 0 };
  if (settings.learning?.enabled) {
    await updateState((s) => { measured = measurePosts(s, posts, settings); return s; });
  }

  await pushLog({
    level: 'info', event: 'own',
    msg: `Свой профиль: ${posts.length} карточек, с чужими ответами ${mine.length}`
      + (measured.updated ? `, замерено ${measured.updated}` : ''),
  }, settings.ui.logSize);

  /*
   * Что агент выучил — вслух.
   *
   * Обучение, которого не видно, неотличимо от его отсутствия: по молчаливо
   * изменившимся весам нельзя понять ни что происходит, ни когда пора
   * вмешаться. Пишем не на каждом заходе, а когда что-то замерили.
   */
  if (measured.updated) {
    await pushLog({
      level: 'info', event: 'learn',
      msg: learningReport(await getState(true), settings),
    }, settings.ui.logSize);
  }

  /*
   * Сначала — собственный комментарий под свежим разбором.
   *
   * Он идёт вперёд ответов читателям по двум причинам. Во-первых, он срочный:
   * комментарий под постом, вышедшим час назад, увидят те, кто читает ленту
   * сейчас, а под вчерашним он останется незамеченным — ответ же читателю
   * ценен и через два часа. Во-вторых, он дешёвый: ни одного запроса к
   * модели, текст собран кодом.
   */
  if (settings.funnel?.enabled) {
    const pending = pickFollowup(posts, state, handle);
    if (pending) {
      const say = followupText(settings, state);
      if (say) {
        await updateState((s) => {
          s.pipeline = {
            phase: 'need_open',
            source: 'own',
            host: true,
            followup: say.text,
            target: {
              id: pending.card.id || hash(pending.card.url),
              url: pending.card.url,
              authorHandle: handle,
              text: (pending.card.text || '').slice(0, 400),
            },
            startedAt: Date.now(),
          };
          /* Из очереди убираем сразу: если публикация сорвётся, второй заход
             под тот же пост выглядел бы навязчивее, чем пропущенная ссылка. */
          dropFollowup(s, pending.entry.key);
          s.lastFollowup = say.template;
          return s;
        });

        return {
          cmd: MSG.CMD_OPEN_THREAD,
          url: pending.card.url,
          handle,
          why: 'ставим ссылку комментарием под своим разбором',
        };
      }
    }
  }

  if (!mine.length) {
    await updateState((s) => { s.pipeline = null; return s; });
    return browseCommand(settings, 'под нашими постами пока не отвечали');
  }

  /* Берём самый свежий: там разговор ещё идёт. */
  const target = mine[0];
  const outside = outsideReplies(target, state);
  await updateState((s) => {
    s.pipeline = {
      phase: 'need_open',
      source: 'own',
      host: true,
      target: {
        id: target.id || hash(target.url),
        url: target.url,
        authorHandle: handle,
        text: (target.text || '').slice(0, 400),
      },
      /* Сколько чужих ответов было видно снаружи: если внутри окажется, что
         отвечать некому, по этому числу пост помечается обслуженным. */
      outside,
      startedAt: Date.now(),
    };
    return s;
  });

  return {
    cmd: MSG.CMD_OPEN_THREAD,
    url: target.url,
    handle,
    why: `под нашим постом ${outsideReplies(target, state)} чужих отв. — идём отвечать`,
  };
}

/** Пришли карточки со страницы. Скорим и выбираем цель. */
async function onScanned(report, settings, ctx) {
  const posts = Array.isArray(report.posts) ? report.posts : [];

  await updateState((s) => { recordViews(s, Math.min(posts.length, 40)); return s; });

  /*
   * Итог скана записывается на счёт той фразы, по которой ходили.
   *
   * Фразу берём из адреса страницы, а не из конвейера: она там уже есть, и
   * лишнее поле в состоянии — лишний способ рассинхронизироваться.
   */
  const usedQuery = queryOf(ctx?.url);
  if (usedQuery) {
    let bench = [];
    await updateState((s) => {
      const before = benchedQueries(s).length;
      noteQueryResult(s, usedQuery, posts.length);
      const after = benchedQueries(s);
      if (after.length > before) bench = after;
      return s;
    });
    if (bench.length) {
      await pushLog({
        level: 'warn', event: 'scan',
        msg: `Фраза «${usedQuery}» третий раз подряд не дала ничего — откладываем на сутки`,
        detail: `сейчас отложено: ${bench.join(', ')}`,
      }, settings.ui.logSize);
    }
  }

  if (!posts.length) {
    await pushLog({
      level: 'warn', event: 'scan',
      msg: usedQuery
        ? `Ничего не нашли по фразе «${usedQuery}»`
        : 'Ничего не нашли на странице',
    }, settings.ui.logSize);
    await updateState((s) => { s.pipeline = null; return s; });
    return browseCommand(settings, 'пустой скан, листаем дальше');
  }

  const state = await getState(true);

  /*
   * Скан своего профиля — совсем другая задача, и до общего конвейера он не
   * доходит: там префильтр первым делом выбросит наши посты как собственные,
   * что для поиска целей верно, а здесь ровно наоборот.
   */
  if (state.pipeline?.source === 'own') {
    return onOwnScanned(posts, settings, state);
  }

  // Локальный префильтр — бесплатно отсеивает основную массу.
  const survived = [];
  const rejected = [];
  /*
   * Отдельная выборка для распознавания тем.
   *
   * Она шире, чем кандидаты в комментарии, и это не небрежность. Пост, который
   * мы уже прокомментировали, автор в кулдауне, пост суточной давности — всё
   * это причины не отвечать, но не причины не знать, что тема обсуждается.
   * Отсеиваем ровно то, что говорит о содержании: не наш язык, не наша тема,
   * реклама, свой же текст, пустышка.
   */
  const offTopic = new Set([
    SKIP.LANGUAGE, SKIP.NO_KEYWORDS, SKIP.STOP_WORD, SKIP.AD, SKIP.BLOCKED_AUTHOR,
    SKIP.OWN_POST, SKIP.NO_TEXT, SKIP.TOO_SHORT, SKIP.NO_URL,
  ]);
  const forTrends = [];

  for (const p of posts) {
    p.id = p.id || hash(`${p.authorHandle}|${(p.text || '').slice(0, 200)}`);
    const v = prefilter(p, settings, state);
    if (v.ok) { survived.push(p); forTrends.push(p); continue; }
    rejected.push(v.code);
    if (!offTopic.has(v.code)) forTrends.push(p);
  }

  await pushLog({
    level: 'info',
    event: 'scan',
    msg: `Собрано ${posts.length}, прошло префильтр ${survived.length}`,
    detail: summarize(rejected),
  }, settings.ui.logSize);

  /*
   * Наблюдения копятся раньше любых отказов ниже по коду.
   *
   * Пустой скан, исчерпанный бюджет, ни одного кандидата — всё это поводы не
   * комментировать, но не поводы забыть увиденное. Прежде выборка выбрасывалась
   * целиком, и знание о том, что происходит в нише, не накапливалось нигде.
   */
  if (settings.trends?.enabled && forTrends.length) {
    let seen = null;
    await updateState((s) => { seen = observe(s, forTrends, settings); return s; });
    if (seen?.updated) {
      // Повторная встреча — единственный способ измерить прирост, а не оценить
      // его по огрублённому возрасту. Об этом стоит знать по журналу.
      await pushLog({
        level: 'info', event: 'scan',
        msg: `Наблюдений ${seen.total}, из них замерен прирост у ${seen.updated}`,
      }, settings.ui.logSize);
    }
  }

  if (!survived.length) {
    await updateState((s) => { s.pipeline = null; return s; });
    return browseCommand(settings, 'ничего подходящего, листаем');
  }

  if (!canSpend(settings, state)) {
    await updateState((s) => haltState(s, HALT.BUDGET, 'дневной бюджет исчерпан'));
    return idle(300000, 'бюджет AI на сегодня исчерпан');
  }

  // Оценка релевантности. Батчим, но не больше двух батчей за раз — иначе один
  // скан ленты обходится дороже, чем сам комментарий.
  const batches = chunk(survived, settings.scoring.batchSize)
    .slice(0, Math.max(1, settings.scoring.maxBatchesPerScan ?? 2));
  const scored = [];
  let cost = 0;

  try {
    for (const batch of batches) {
      const { map, cost: c } = await scoreRelevance(batch, settings);
      cost += c;
      batch.forEach((post, i) => {
        const ai = map.get(i);
        if (ai && !ai.worth) return;
        const rel = ai?.score ?? null;
        // momentum нужен дальше: он попадает в журнал и в карточку цели.
        // Без него в логе оставалось «импульс ?», и по записи было не понять,
        // взял агент разгоняющийся пост или случайный.
        const { score, parts, momentum } = scorePost(post, settings, rel);
        scored.push({ post, score, momentum, relevance: rel ?? parts.relevance, parts, topic: ai?.topic });
      });
    }
  } catch (e) {
    await updateState((s) => { onError(settings, s); s.pipeline = null; return s; });
    await pushLog({ level: 'error', event: 'ai', msg: `Оценка релевантности: ${e.message}` }, settings.ui.logSize);
    return idle(60000, 'ошибка AI API');
  }

  await updateState((s) => { recordSpend(s, cost); return s; });

  /*
   * Всё пригодное уходит в копилку, а цель берётся уже оттуда.
   *
   * Раньше выбиралась одна цель, а прочие кандидаты — прошедшие и префильтр, и
   * оценку релевантности, и порог — помечались виденными и выбрасывались.
   * Лента от этого просеивалась выборочно, а оплаченная токенами оценка
   * пропадала: на десять разобранных постов приходился один использованный.
   */
  const eligible = scored.filter(
    (c) => c.score >= settings.scoring.minScore
      && (c.relevance ?? 1) >= settings.scoring.minRelevance,
  );

  if (eligible.length) {
    let stash = { added: 0, refreshed: 0 };
    await updateState((s) => {
      const r = addCandidates(s, eligible, settings);
      s.backlog = r.backlog;
      stash = { added: r.added, refreshed: r.refreshed };
      return s;
    });

    if (stash.added || stash.refreshed) {
      await pushLog({
        level: 'info',
        event: 'scan',
        msg: `В копилку: новых ${stash.added}, обновлено ${stash.refreshed}`,
      }, settings.ui.logSize);
    }
  }

  let target = pickTarget(scored, settings);

  /*
   * Текущий экран не дал цели — берём лучшее из копилки.
   *
   * Именно здесь сплошной обход и окупается: пост, оценённый двадцать минут
   * назад и проигравший тогда более сильному, дожидается своей очереди вместо
   * того чтобы пропасть. Повторной оплаты за него нет — оценка уже сделана.
   */
  if (!target) {
    let waiting = null;
    await updateState((s) => {
      const r = takeBest(s, settings);
      if (r.item) { s.backlog = r.backlog; waiting = { item: r.item, ready: r.ready, eff: r.effective }; }
      else s.backlog = r.backlog;
      return s;
    });

    if (waiting) {
      target = toTarget(waiting.item);
      await pushLog({
        level: 'info',
        event: 'scan',
        msg: `Из копилки: @${target.post.authorHandle} · ждал ${target.waitedMinutes} мин`,
        detail: `скор ${waiting.eff.toFixed(2)} · готовых в копилке ${waiting.ready}`,
      }, settings.ui.logSize);
    }
  }

  if (!target) {
    /*
     * Отбор режут два независимых порога — скор и релевантность, — и назвать
     * в журнале только первый значит соврать.
     *
     * Живой прогон выдал «ни один не прошёл порог 0.4 (лучший 0.43)»: цифры
     * противоречат друг другу, потому что пост прошёл по скору и отвалился по
     * релевантности. Разница не косметическая: если режет релевантность,
     * опускать порог скора бессмысленно, а именно это напрашивается по такой
     * записи.
     */
    const { minScore, minRelevance } = settings.scoring;
    const relOf = (c) => c.relevance ?? 1;

    const bestScore = scored.length ? Math.max(...scored.map((c) => c.score)) : 0;
    const passedScore = scored.filter((c) => c.score >= minScore);
    const bestRel = passedScore.length ? Math.max(...passedScore.map(relOf)) : 0;

    /*
     * Пустой список и низкие оценки — разные события.
     *
     * Когда модель отсеяла все посты на проверке «стоит ли вообще», в `scored`
     * не остаётся ничего, максимум по пустому массиву даёт ноль, и запись
     * получалась «лучший 0.00 при пороге 0.4». Читается как «кандидаты были, но
     * плохие», хотя кандидатов не было вовсе — а это другая причина и другое
     * лечение.
     */
    let msg;
    if (!scored.length) {
      msg = `Из ${survived.length} прошедших префильтр модель не оставила ни одного: `
        + 'все отсеяны как не стоящие ответа';
    } else if (passedScore.length) {
      msg = `Порог скора ${minScore} прошли ${passedScore.length}, но срезала релевантность: `
        + `лучшая ${bestRel.toFixed(2)} при пороге ${minRelevance}`;
    } else {
      msg = `Ни один из ${scored.length} не прошёл порог скора ${minScore} `
        + `(лучший ${bestScore.toFixed(2)})`;
    }

    await pushLog({ level: 'info', event: 'scan', msg }, settings.ui.logSize);
    await updateState((s) => {
      s.pipeline = null;
      /*
       * Виденными помечаем только отвергнутых.
       *
       * Раньше метились все подряд, включая прошедших отбор. С копилкой это
       * стало прямой поломкой: отметка «виден» означает для неё протухание, и
       * сложенный кандидат выбрасывался на первой же чистке — сплошной обход
       * работал бы ровно наоборот.
       */
      const kept = new Set(eligible.map((c) => c.post.id));
      for (const c of scored.slice(0, 20)) if (!kept.has(c.post.id)) markSeen(s, c.post.id);
      return s;
    });
    return browseCommand(settings, 'порог не пройден');
  }

  // Иногда человек открывает пост и уходит, ничего не написав.
  if (chance(settings.limits.abandonAfterOpenChance)) {
    await updateState((s) => { markSeen(s, target.post.id); recordSkip(s); s.pipeline = null; return s; });
    await pushLog({
      level: 'info', event: 'skip', msg: `Открыли и передумали: @${target.post.authorHandle}`,
    }, settings.ui.logSize);
    return browseCommand(settings, 'передумали отвечать');
  }

  // Захват в реестре. Между этим моментом и публикацией пройдут десятки
  // секунд — чтение ветки, генерация, набор, — и всё это время пост должен
  // считаться занятым, иначе следующий проход выберет его снова.
  const grab = await claim(target.post);
  if (!grab.ok) {
    await updateState((s) => { recordSkip(s); s.pipeline = null; return s; });
    await pushLog({
      level: 'info', event: 'skip', msg: `Пост занят: ${grab.reason}`,
    }, settings.ui.logSize);
    return browseCommand(settings, 'пост уже обработан');
  }

  await updateState((s) => {
    // Взятый в работу пост из копилки убираем сразу: иначе следующий скан
    // достанет его повторно, пока этот заход ещё не завершился.
    s.backlog = dropFromBacklog(s, target.post.id);
    s.pipeline = {
      phase: 'need_open',
      source: s.pipeline?.source,
      target: {
        id: target.post.id,
        url: target.post.url,
        shortcode: target.post.shortcode,
        authorHandle: target.post.authorHandle,
        // Начало текста нужно реестру: по нему пост узнаётся, даже если
        // сменился адрес или его переоткрыли со страницы ветки.
        text: (target.post.text || '').slice(0, 200),
        score: target.score,
        momentum: target.momentum?.label,
        topic: target.topic || '',
      },
      readMs: null,
      startedAt: Date.now(),
    };
    return s;
  });

  const stats = backlogStats(await getState(true), settings);
  await pushLog({
    level: 'info',
    event: 'target',
    msg: `Цель: @${target.post.authorHandle} · скор ${target.score.toFixed(2)}`
      + ` · импульс ${target.momentum?.label || '?'}`
      + (target.fromBacklog ? ' · из копилки' : ` · из ${target.poolSize}`)
      + ` · в копилке ${stats.size} (готовых ${stats.ready})`,
    detail: [target.topic, target.momentum?.reason, (target.post.text || '').slice(0, 120)]
      .filter(Boolean).join(' · '),
  }, settings.ui.logSize);

  return {
    cmd: MSG.CMD_OPEN_THREAD,
    url: target.post.url,
    postId: target.post.id,
    why: 'открываем выбранную ветку',
  };
}

/** Ветка открыта и распарсена. Генерируем комментарий. */
/**
 * Своя ветка открыта: выбираем, кому ответить, и пишем ответ.
 *
 * Один заход — один ответ. Отвечать всем подряд за раз значит выдать серию
 * реплик за минуту под одним постом; человек так не делает, да и разговор от
 * этого не выигрывает. Остальные дождутся следующей проверки профиля.
 */
async function onOwnThreadOpened(thread, settings, state, ctx) {
  const handle = (settings.handle || '').replace(/^@/, '');

  /*
   * Комментарий со ссылкой под своим же постом.
   *
   * Ни одного запроса к модели: текст собран кодом, потому что ссылка — это
   * факт, а не творчество, и опечатка в адресе стоит всей воронки. Отвечаем
   * корню ветки, а не какой-то реплике: это подпись к посту, а не разговор.
   */
  const waiting = state.pipeline?.followup;
  if (waiting) {
    await pushLog({
      level: 'info', event: 'own',
      msg: 'Ставим ссылку комментарием под своим разбором',
      detail: waiting,
    }, settings.ui.logSize);

    await updateState((s) => {
      s.pipeline = { ...s.pipeline, phase: 'need_reply', draft: { text: waiting, replyTo: null } };
      return s;
    });

    return {
      cmd: MSG.CMD_REPLY,
      text: waiting,
      replyTo: null,
      typing: settings.typing,
      why: 'ссылка под своим разбором',
    };
  }

  const pick = pickReplyToAnswer(thread, settings, state, handle);

  if (!pick) {
    /*
     * Помечаем пост обслуженным, иначе следующий заход откроет его же: список
     * идёт от свежих к старым, и самый свежий остаётся самым свежим. Метка
     * снимается сама, как только чужих ответов станет больше.
     */
    await updateState((s) => {
      markOwnServed(s, s.pipeline?.target?.url, s.pipeline?.outside ?? 0);
      s.pipeline = null;
      return s;
    });
    await pushLog({
      level: 'info', event: 'own',
      msg: 'Новых ответов под постом нет — всем уже ответили либо реплики пустые',
      detail: 'пост отложен до следующего чужого ответа, соседние обслужим на следующем заходе',
    }, settings.ui.logSize);
    return browseCommand(settings, 'отвечать некому');
  }

  if (!canSpend(settings, state)) {
    await updateState((s) => { s.pipeline = null; return s; });
    return idle(300000, 'бюджет AI исчерпан');
  }

  let gen;
  try {
    gen = await generateHostReply(thread.root.text, pick.reply, pick.others, settings, state);
  } catch (e) {
    await updateState((s) => { onError(settings, s); s.pipeline = null; return s; });
    await pushLog({ level: 'error', event: 'own', msg: `Ответ читателю: ${e.message}` }, settings.ui.logSize);
    return idle(60000, 'ошибка AI API');
  }

  await updateState((s) => { recordSpend(s, gen.cost); return s; });

  if (!gen.ok) {
    await updateState((s) => { s.pipeline = null; return s; });
    await pushLog({
      level: 'warn', event: 'own', msg: `Ответ читателю забракован: ${gen.reason}`,
    }, settings.ui.logSize);
    return browseCommand(settings, 'ответ не получился');
  }

  await pushLog({
    level: 'info', event: 'own',
    msg: `Отвечаем @${pick.reply.author} под своим постом`,
    detail: `на «${pick.reply.text.slice(0, 90)}» → «${gen.text}»`,
  }, settings.ui.logSize);

  await updateState((s) => {
    s.pipeline = {
      ...s.pipeline,
      phase: 'need_reply',
      draft: { text: gen.text, replyTo: pick.index },
      answerTo: pick.reply.author,
      startedAt: Date.now(),
    };
    return s;
  });

  return {
    cmd: MSG.CMD_REPLY,
    text: gen.text,
    replyTo: pick.index,
    typing: settings.typing,
    why: `отвечаем @${pick.reply.author} под своим постом`,
  };
}

async function onThreadOpened(report, settings, ctx) {
  const thread = report.thread;

  if (!thread?.root?.text) {
    const p = (await getState(true)).pipeline;
    if (p?.target) await release(p.target);
    return escalate(settings, SKIP.NO_EDITOR, 'Не удалось разобрать ветку', ctx);
  }

  const state = await updateState((s) => { recordViews(s, 1); return s; });

  /*
   * Своя ветка обслуживается отдельной веткой кода.
   *
   * Всё, что идёт ниже, устроено вокруг вопроса «стоит ли влезать в чужой
   * разговор»: свой комментарий в ветке — повод уйти, тема проверяется
   * порогом, угол захода выбирается заново. Под собственным постом каждое из
   * этих правил не просто лишнее, а вредное: наш комментарий там обязан быть,
   * тема наша по определению, а угол один — ответить человеку.
   */
  if (state.pipeline?.host) {
    return onOwnThreadOpened(thread, settings, state, ctx);
  }

  // Свой комментарий уже в ветке — уходим.
  const my = (settings.handle || '').replace(/^@/, '').toLowerCase();
  const mine = (thread.replies || []).some(
    (r) => String(r.authorHandle || '').replace(/^@/, '').toLowerCase() === my,
  );
  if (mine) {
    // Пост уже отработан — помечаем завершённым, а не отпускаем: иначе
    // следующий проход выберет его снова и снова упрётся в тот же ответ.
    const p = (await getState(true)).pipeline;
    if (p?.target) await complete(p.target, {});
    await updateState((s) => { s.pipeline = null; recordSkip(s); return s; });
    await pushLog({
      level: 'info', event: 'skip', msg: skipLabel(SKIP.ALREADY_REPLIED),
    }, settings.ui.logSize);
    return browseCommand(settings, 'уже отвечал в этой ветке');
  }

  if (!canSpend(settings, state)) {
    await updateState((s) => haltState(s, HALT.BUDGET, 'дневной бюджет исчерпан'));
    return idle(300000, 'бюджет исчерпан');
  }

  let result;
  try {
    result = await generateComment(thread, settings, state);
  } catch (e) {
    await updateState((s) => { onError(settings, s); s.pipeline = null; return s; });
    await pushLog({ level: 'error', event: 'ai', msg: `Генерация: ${e.message}` }, settings.ui.logSize);
    return idle(45000, 'ошибка генерации');
  }

  await updateState((s) => { recordSpend(s, result.cost); return s; });

  if (!result.ok) {
    // Сбой генерации — проблема текста, а не поста. Отпускаем захват, но
    // помечаем пост виденным: возвращаться к нему в ближайшее время незачем.
    const p = (await getState(true)).pipeline;
    if (p?.target) await complete(p.target, {});
    await updateState((s) => {
      recordSkip(s);
      s.pipeline = null;
      return s;
    });
    await pushLog({
      level: result.offTopic ? 'info' : 'warn',
      event: 'skip',
      msg: result.offTopic
        ? `${skipLabel(SKIP.AI_OFF_TOPIC)}: ${result.reason}`
        : `Пропуск: ${result.reason}`,
      code: result.offTopic ? SKIP.AI_OFF_TOPIC : SKIP.BAD_OUTPUT,
    }, settings.ui.logSize);
    await bumpNextAction(settings, 0.5);
    return browseCommand(settings, result.offTopic ? 'ветка не про нишу' : 'комментарий забракован');
  }

  const targetReply = result.replyTo != null ? thread.replies?.[result.replyTo] : null;

  const draft = {
    text: result.text,
    raw: result.raw,
    angle: result.angle,
    replyTo: result.replyTo,
    replyToHandle: targetReply?.authorHandle || null,
    gap: result.analysis?.gap || '',
    similarity: result.similarity,
    humanized: result.humanized,
    cost: result.cost,
  };

  // Полуавтомат: всё уходит в очередь и ждёт человека.
  if (!settings.autopilot) {
    await enqueue({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      post: {
        id: thread.root.id || state.pipeline?.target?.id,
        url: thread.root.url || state.pipeline?.target?.url,
        authorHandle: thread.root.authorHandle,
        authorName: thread.root.authorName,
        text: thread.root.text,
        likes: thread.root.likes,
        replies: thread.root.replies,
        ageMinutes: thread.root.ageMinutes,
      },
      replies: (thread.replies || []).slice(0, 6),
      draft,
      score: state.pipeline?.target?.score,
      status: 'pending',
    });

    const pipe = (await getState(true)).pipeline;
    if (pipe?.target) await complete(pipe.target, { text: draft.text });

    await updateState((s) => {
      recordAngle(s, result.angle);
      onSuccessfulAction(s);
      s.session = { ...s.session, doneActions: (s.session.doneActions || 0) + 1 };
      s.pipeline = null;
      return s;
    });

    await pushLog({
      level: 'success',
      event: 'queued',
      msg: `В очередь: @${thread.root.authorHandle}`,
      detail: result.text,
    }, settings.ui.logSize);

    if (settings.safety.notify) {
      notify('Новый комментарий в очереди', `@${thread.root.authorHandle}: ${result.text.slice(0, 90)}`);
    }

    await bumpNextAction(settings);
    return browseCommand(settings, 'черновик в очереди');
  }

  // Автопилот: публикуем.
  await updateState((s) => {
    s.pipeline = { ...s.pipeline, phase: 'need_reply', draft, startedAt: Date.now() };
    return s;
  });

  return {
    cmd: MSG.CMD_REPLY,
    url: thread.root.url,
    text: draft.text,
    replyTo: draft.replyTo,
    replyToHandle: draft.replyToHandle,
    postId: thread.root.id,
    typing: settings.typing,
    why: 'публикуем ответ',
  };
}

/** Ответ отправлен. Проверяем, что он реально появился. */
async function onReplied(report, settings, ctx) {
  const state = await getState(true);
  const p = state.pipeline;
  const draft = p?.draft || report.draft || {};

  /*
   * Ответ своему читателю учитывается отдельно от комментариев в чужих ветках.
   *
   * Он не тратит дневной лимит комментариев, не занимает автора кулдауном и не
   * попадает в проверку выживаемости: всё это механизмы против назойливости в
   * чужих обсуждениях, а под собственным постом отвечать хозяину — норма, а не
   * риск. У него свой предел (`hosting.maxPerDay`) и свой счётчик.
   */
  if (p?.host) {
    /* Ссылка под своим разбором — не ответ читателю: собеседника нет, а
       значит нечего запоминать в «кому уже отвечали» и незачем тратить
       дневной предел ответов. */
    const isFollowup = !!p.followup;

    if (!report.ok) {
      await updateState((s) => { s.pipeline = null; return s; });
      await pushLog({
        level: 'warn', event: 'own',
        msg: isFollowup
          ? `Ссылка под своим разбором не поставилась: ${report.error || 'неизвестно'}`
          : `Ответ читателю не отправлен: ${report.error || 'неизвестно'}`,
      }, settings.ui.logSize);
      return browseCommand(settings, 'ответ не ушёл');
    }

    await updateState((s) => {
      if (!isFollowup) rememberAnswer(s, p.target?.url, p.answerTo);
      onSuccessfulAction(s);
      onSuccess(s);
      s.pipeline = null;
      return s;
    });

    await pushLog({
      level: 'success', event: 'own',
      msg: isFollowup
        ? 'Ссылка поставлена комментарием под своим разбором'
        : `Ответили @${p.answerTo} под своим постом`,
      detail: draft.text,
    }, settings.ui.logSize);

    await bumpNextAction(settings);
    return browseCommand(settings, 'ответили читателю');
  }

  if (!report.ok) {
    // Отпускаем захват: пост не тронут, к нему можно вернуться позже.
    if (p?.target) await release(p.target);
    return escalate(settings, report.code || SKIP.SUBMIT_FAILED,
      `Не удалось отправить: ${report.error || 'неизвестно'}`, ctx);
  }

  // Отправка прошла, но комментария в ветке нет — характерный признак
  // теневого ограничения. Несколько подряд означают, что писать бессмысленно
  // и продолжать опасно.
  if (report.verified === false) {
    /*
     * Неподтверждённый комментарий — это «не знаю», а не «не опубликовалось».
     *
     * Раньше пост при этом просто отпускался: захват в реестре истекал, и он
     * возвращался в общий пул. Если комментарий на самом деле ушёл, а проверка
     * его не нашла — перерисовалась ветка, не догрузились ответы, — агент писал
     * туда второй раз.
     *
     * Ошибки здесь несимметричны. Второй комментарий под одним постом виден
     * автору и выглядит именно тем, чем является; потерянный пост не стоит
     * ничего, их вокруг много. Поэтому при неопределённости считаем, что
     * комментарий ушёл: закрываем пост в реестре и засчитываем в дневную норму.
     * Недосчитать норму опаснее, чем пересчитать: недосчёт означает, что
     * реальная активность выше заявленной.
     */
    if (p?.target) await complete(p.target, { text: draft.text });

    /*
     * Теневым ограничением считается только то, что мы **проверили**.
     *
     * Если ветка показала не все ответы — а под постом с восемью десятками
     * комментариев Threads показывает десяток, — нашего текста там могло не
     * оказаться просто потому, что страница его не нарисовала. Записывать это
     * в счёт теневого бана значит вести агента к остановке на сутки по
     * причине, которой не было: три таких подряд гасят его до прихода
     * человека. Поймано в бою 02.08 в 15:23 — ответ лежал на месте.
     *
     * Всё остальное делается как прежде: пост закрывается в реестре и идёт в
     * дневную норму. Здесь мы по-прежнему не знаем исхода, а недосчёт нормы
     * опаснее пересчёта.
     */
    const st = await updateState((s) => {
      if (!report.inconclusive) onShadowFail(settings, s);
      markSeen(s, p?.target?.id || report.postId);
      recordComment(s, {
        author: p?.target?.authorHandle || report.authorHandle,
        postId: p?.target?.id || report.postId,
        text: draft.text,
      });
      s.pipeline = null;
      return s;
    });
    await pushLog({
      level: 'warn',
      event: 'shadow',
      msg: report.inconclusive
        ? 'Проверить появление ответа не вышло: ветка показывает не все ответы'
        : `Комментарий не подтвердился (${st.consecutiveShadowFails} подряд)`,
      detail: report.inconclusive
        ? 'в счёт теневого ограничения не идёт — это «не знаю», а не «не появилось»'
        : undefined,
    }, settings.ui.logSize);

    if (st.halt) {
      notify('ThreadSense AI остановлен', 'Комментарии не появляются в ветке. Проверь аккаунт вручную.');
    }
    await bumpNextAction(settings);
    return browseCommand(settings, 'отправка не подтвердилась');
  }

  if (p?.target) await complete(p.target, { text: draft.text });

  await updateState((s) => {
    recordComment(s, {
      author: p?.target?.authorHandle || report.authorHandle,
      postId: p?.target?.id || report.postId,
      text: draft.text,
    });
    recordAngle(s, draft.angle);

    // Берём ответ под наблюдение: подтверждение при отправке говорит «дошло»,
    // а важнее оказывается «осталось» — исчезновение через час признак более
    // надёжный, чем отсутствие сразу.
    recordPublished(s, {
      url: p?.target?.url,
      postId: p?.target?.id || report.postId,
      text: draft.text,
      author: p?.target?.authorHandle || report.authorHandle,
    });

    onSuccess(s);
    onSuccessfulAction(s);   // успех складывает лестницу восстановления
    s.session = { ...s.session, doneActions: (s.session.doneActions || 0) + 1 };
    s.pipeline = null;
    return s;
  });

  await pushLog({
    level: 'success',
    event: 'comment',
    msg: `Опубликовано у @${p?.target?.authorHandle || '?'}`,
    detail: draft.text,
    url: p?.target?.url,
  }, settings.ui.logSize);

  await bumpNextAction(settings);
  return browseCommand(settings, 'после публикации листаем ленту');
}

async function onBrowsed(report, settings) {
  await updateState((s) => {
    if (report.liked) recordLike(s);
    if (report.viewed) recordViews(s, report.viewed);

    /*
     * Счётчик холостых пролистываний.
     *
     * Считать только «ноль просмотров» недостаточно: упёршись в низ конечной
     * страницы, агент продолжает просматривать одни и те же карточки, счётчик
     * исправно растёт, и застревание выглядит как нормальная работа. Признак
     * исчерпания приходит с той стороны: скролл не сдвинулся и новых постов
     * не прибавилось.
     */
    s.emptyBrowses = (report.viewed && !report.exhausted) ? 0 : (s.emptyBrowses || 0) + 1;
    return s;
  });
  return null;
}

async function onStepError(report, settings, ctx) {
  return escalate(settings, report.code || SKIP.CONTEXT_LOST, report.error || 'ошибка шага', ctx);
}

/**
 * Поднять сбой по лестнице восстановления.
 *
 * Мгновенный стоп на первой неудаче теряет день работы из-за секундной
 * проблемы. Упорное продолжение при системной поломке копит флаги на аккаунте.
 * Лестница разводит эти случаи: пока сбои единичные — просто берём следующий
 * пост, пошли подряд — меняем страницу, не помогло — перезагружаемся, и лишь
 * потом останавливаемся.
 */
async function escalate(settings, code, msg, ctx) {
  void ctx;
  let verdict = null;

  await updateState((s) => {
    onError(settings, s);
    s.pipeline = null;
    verdict = onTechnicalFailure(s, settings, code);
    return s;
  });

  await pushLog({
    level: verdict.step >= STEP.RELOAD_PAGE ? 'error' : 'warn',
    event: 'recovery',
    msg,
    detail: `${skipLabel(code)} · полоса ${verdict.streak} · ${verdict.label}`,
  }, settings.ui.logSize);

  if (verdict.step === STEP.STOP) {
    await updateState((s) => haltState(s, HALT.ACTION_BLOCKED,
      'серия технических сбоев, работа остановлена для разбора',
      Date.now() + 30 * 60000));
    notify('ThreadSense AI остановлен', 'Серия технических сбоев. Проверь страницу и журнал.');
    return idle(300000, 'серия сбоев');
  }

  const cmd = commandFor(verdict.step);
  if (cmd) return cmd;

  await bumpNextAction(settings);
  return browseCommand(settings, 'пропускаем пост после сбоя');
}

/* ------------------------------------------------------------------ *
 * Сигналы от сторожа
 * ------------------------------------------------------------------ */

export async function handleGuardAlert(alert, settings) {
  const s = settings || (await getSettings());
  const now = Date.now();

  // Разлогин — не инцидент безопасности, а обычное «войди в аккаунт».
  // Ставим короткую самоснимающуюся паузу: как только сессия появится,
  // агент продолжит сам, без ручного вмешательства.
  if (alert.kind === 'logged_out') {
    await updateState((st) => {
      haltState(st, HALT.LOGGED_OUT, alert.detail || '', now + 2 * 60000);
      st.pipeline = null;
      st.session = { ...st.session, active: false };
      return st;
    });
    await pushLog({
      level: 'warn', event: 'guard', msg: 'Нет входа в Threads — работа приостановлена',
    }, s.ui.logSize);
    return;
  }

  if (alert.kind === 'challenge' || alert.kind === 'captcha') {
    /*
     * Кричим один раз, стоим сколько нужно.
     *
     * Сигнал приходит с каждой полной проверки сторожа, то есть раз в
     * пятнадцать секунд, пока страница проверки открыта. Записывать это в
     * журнал каждый раз нельзя: кольцо на 400 строк вытрет всю историю до
     * блокировки за полтора часа — ровно те записи, по которым потом
     * разбираются, что к ней привело.
     */
    const already = (await getState()).halt?.reason === HALT.CHALLENGE;

    await updateState((st) => {
      haltState(st, HALT.CHALLENGE, alert.detail || alert.kind, 0);
      st.pipeline = null;
      st.session = { ...st.session, active: false };
      return st;
    });

    if (!already) {
      await pushLog({ level: 'error', event: 'guard', msg: `Требуется вмешательство: ${alert.detail || alert.kind}` }, s.ui.logSize);
      notify('ThreadSense AI остановлен', 'Threads просит проверку аккаунта. Открой вкладку и разберись вручную.');
    }
    return;
  }

  if (alert.kind === 'action_blocked') {
    const until = now + s.safety.onBlockPauseHours * 3600000;
    await updateState((st) => {
      haltState(st, HALT.ACTION_BLOCKED, alert.detail || '', until);
      st.pipeline = null;
      st.session = { ...st.session, active: false };
      return st;
    });
    await pushLog({
      level: 'error',
      event: 'guard',
      msg: `Threads ограничил действия. Пауза ${s.safety.onBlockPauseHours} ч`,
      detail: alert.detail,
    }, s.ui.logSize);
    notify('ThreadSense AI на паузе', `Обнаружено ограничение действий. Пауза ${s.safety.onBlockPauseHours} часов.`);
    return;
  }

  if (alert.kind === 'rate_limit') {
    await updateState((st) => {
      onError(s, st);
      st.pipeline = null;
      return st;
    });
    await pushLog({ level: 'warn', event: 'guard', msg: 'Threads отвечает слишком частыми отказами' }, s.ui.logSize);
  }
}

/* ------------------------------------------------------------------ *
 * Вспомогательное
 * ------------------------------------------------------------------ */

async function bumpNextAction(settings, factor = 1) {
  const delay = planInSessionDelay(settings) * factor;
  await updateState((s) => { s.nextActionAt = Date.now() + delay; return s; });
  return delay;
}

/**
 * Откуда брать посты в этот раз.
 *
 * Веса вынесены в настройки не для гибкости ради гибкости. Домашняя лента у
 * нового аккаунта ещё не настроена, и посты в ней слабо связаны с нишей: живой
 * прогон дал три скана подряд с лучшими скорами 0.24, 0.43 и 0.39. Поиск по
 * своим же фразам такой проблемы не имеет — там посты по теме по построению.
 *
 * При этом совсем отказываться от главной нельзя: Threads строит рекомендации
 * по тому, что читают и отмечают, и чтение своей ленты — единственный способ её
 * выправить. Поэтому не переключение, а перевес.
 */
function pickSource(settings) {
  const src = settings.niche.sources;
  const w = settings.niche.sourceWeights || {};
  const pool = [];

  const add = (name, times) => { for (let i = 0; i < Math.max(0, times); i++) pool.push(name); };

  if (src.home) add('home', w.home ?? 2);
  if (src.search && settings.niche.searchQueries?.length) add('search', w.search ?? 1);
  if (src.tags && settings.niche.tags?.length) add('tags', w.tags ?? 1);
  if (src.authors && settings.niche.authors?.length) add('authors', w.authors ?? 1);

  return pick(pool) || 'home';
}

function urlForSource(source, settings, state = null) {
  const base = 'https://www.threads.com';
  switch (source) {
    case 'search': {
      /*
       * Половина заходов — по разгоревшимся темам, половина — по своим фразам.
       *
       * Только по трендам ходить нельзя: выборка тогда замкнётся сама на себя и
       * уедет в первую же чужую тему, случайно вспыхнувшую в наблюдениях. Только
       * по своим — значит никогда не узнать о том, чего в списке нет, а список
       * писался руками один раз и с тех пор не менялся.
       */
      let q = null;
      if (settings.trends?.enabled && settings.trends?.feedQueries && state) {
        const hot = trendQueries(
          dedupeTrends(detectTrends(state, settings)), settings, settings.trends.maxQueries ?? 6,
        );
        if (hot.length && chance(0.5)) q = pick(hot);
      }
      // Фразы, трижды подряд вернувшие пустую страницу, в розыгрыш не идут.
      q = q || pick(healthyQueries(state, settings.niche.searchQueries));
      return q ? `${base}/search?q=${encodeURIComponent(q)}&serp_type=default` : `${base}/`;
    }
    case 'tags': {
      const t = pick(settings.niche.tags);
      return t ? `${base}/search?q=${encodeURIComponent(t)}&serp_type=tags` : `${base}/`;
    }
    case 'authors': {
      const a = pick(settings.niche.authors);
      return a ? `${base}/@${String(a).replace(/^@/, '')}` : `${base}/`;
    }
    default:
      return `${base}/`;
  }
}

/*
 * `isHomeFeed` и `isFeedPage` жили здесь и разбирали адрес регуляркой каждая
 * по-своему. Обе заменены картой страниц: `whereIs(ctx)` спрашивает у самой
 * страницы, а `PAGE.FEED` и `ENDLESS` из `common/pages.js` отвечают на те же
 * вопросы, но одинаково для всех и с одним местом для правки.
 */

/** Поисковая фраза из адреса. На неленточных страницах её нет — это не ошибка. */
function queryOf(url) {
  try {
    const u = new URL(url);
    if (!/^\/search/.test(u.pathname)) return null;
    return u.searchParams.get('q') || null;
  } catch {
    return null;
  }
}

/** Сравнение маршрутов без учёта хвостов вида ?utm=… */
function sameRoute(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.pathname !== ub.pathname) return false;
    const qa = ua.searchParams.get('q');
    const qb = ub.searchParams.get('q');
    return (qa || '') === (qb || '');
  } catch {
    return false;
  }
}

function topReasons(rejected) {
  const counts = {};
  for (const r of rejected) counts[r.reason] = (counts[r.reason] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([r, n]) => `${r}: ${n}`)
    .join(', ');
}

export { todayKey };

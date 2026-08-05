/**
 * Тесты математики агента.
 *
 * Проверяются не формулы сами по себе, а свойства, ради которых они выбраны:
 * что паузы действительно неравномерны, что выбор цели не вырождается в один
 * и тот же пост, что прогрев растёт монотонно, что гуманизатор ломает текст
 * ровно в тех местах, где обещал, и что фильтр повторов ловит перефразировки.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src');
const load = (p) => import(pathToFileURL(join(EXT, p)).href);

const rng = await load('common/rng.js');
const text = await load('common/text.js');
const defaults = await load('common/defaults.js');
const scorer = await load('bg/scorer.js');
const scheduler = await load('bg/scheduler.js');
const limiter = await load('bg/limiter.js');
const humanizer = await load('bg/humanizer.js');
const safety = await load('bg/safety.js');
const momentum = await load('common/momentum.js');
const skip = await load('common/skipcodes.js');
const registry = await load('bg/registry.js');
const recovery = await load('bg/recovery.js');
const backlog = await load('bg/backlog.js');
const postplan = await load('bg/postplan.js');
const poster = await load('bg/poster.js');
const prompts = await load('bg/prompts.js');
const newsfeed = await load('bg/newsfeed.js');
const survival = await load('bg/survival.js');
const novelty = await load('bg/novelty.js');
const trends = await load('bg/trends.js');
const hosting = await load('bg/hosting.js');
const tools = await load('bg/tools.js');
const funnel = await load('bg/funnel.js');
const cardimage = await load('bg/cardimage.js');
const learning = await load('bg/learning.js');
const PAGES = await load('common/pages.js');

let passed = 0;
let failed = 0;

/**
 * Обвязка обязана дожидаться асинхронных проверок.
 *
 * Прежняя версия вызывала `fn()` без `await`. Синхронные тесты работали, а
 * асинхронный засчитывался пройденным ровно в момент запуска: исключение
 * внутри промиса всплывало уже после того, как в консоль ушло «ok».
 *
 * Обнаружилось на живом дефекте: тест, специально написанный ловить
 * рассинхрон протокола сообщений, показывал «ok» при заведомо сломанном файле.
 * Проверка, которая не может провалиться, хуже отсутствующей — она создаёт
 * уверенность там, где её нет.
 *
 * Ловится и второй случай: `fn` вернул промис, но его забыли дождаться внутри.
 */
const pending = [];

function test(name, fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    return;
  }

  if (result && typeof result.then === 'function') {
    pending.push(result.then(
      () => { passed++; console.log(`  ok    ${name}`); },
      (e) => { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); },
    ));
    return;
  }

  passed++;
  console.log(`  ok    ${name}`);
}

function group(name) {
  console.log(`\n${name}`);
}

const S = structuredClone(defaults.DEFAULTS);
const ST = structuredClone(defaults.DEFAULT_STATE);
ST.firstRunDate = '2026-07-26';

/* ------------------------------------------------------------------ */
group('Распределения');

test('экспоненциальные паузы держатся в границах и разбросаны', () => {
  const samples = Array.from({ length: 20000 }, () => rng.expDelay(180, 60, 600));
  assert.ok(Math.min(...samples) >= 60, 'нижняя граница нарушена');
  assert.ok(Math.max(...samples) <= 600, 'верхняя граница нарушена');

  const mean = samples.reduce((a, b) => a + b) / samples.length;
  // Обрезка сдвигает среднее внутрь интервала — это ожидаемо.
  assert.ok(mean > 120 && mean < 300, `среднее вне разумного: ${mean.toFixed(1)}`);

  // Ключевое свойство: значения не липнут к границам. Если бы стоял clamp,
  // на min и max сидело бы по заметной доле массы.
  const atMin = samples.filter((x) => x < 61).length / samples.length;
  const atMax = samples.filter((x) => x > 599).length / samples.length;
  assert.ok(atMin < 0.01, `слишком много значений на минимуме: ${(atMin * 100).toFixed(1)}%`);
  assert.ok(atMax < 0.01, `слишком много значений на максимуме: ${(atMax * 100).toFixed(1)}%`);
});

test('интервалы набора логнормальны: медиана ниже среднего', () => {
  const samples = Array.from({ length: 20000 }, () => rng.lognormal(150, 0.55)).sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b) / samples.length;
  const median = samples[Math.floor(samples.length / 2)];
  assert.ok(median < mean, 'у логнормального распределения медиана должна быть меньше среднего');
  assert.ok(Math.abs(mean - 150) / 150 < 0.06, `среднее уехало: ${mean.toFixed(1)}`);
  // Правый хвост обязан существовать: это паузы «задумался».
  assert.ok(samples[samples.length - 1] > 400, 'нет длинного хвоста');
});

test('softmax не вырождается в argmax', () => {
  const scores = [0.9, 0.85, 0.8, 0.75, 0.7];
  const counts = new Array(scores.length).fill(0);
  for (let i = 0; i < 20000; i++) counts[rng.softmaxPick(scores, 0.35)]++;

  assert.ok(counts[0] > counts[4], 'лучший должен выбираться чаще худшего');
  assert.ok(counts[0] / 20000 < 0.65, `слишком детерминирован: ${(counts[0] / 200).toFixed(1)}%`);
  assert.ok(counts.every((c) => c > 200), 'какой-то вариант вообще не выбирается');
});

test('softmax при нулевой температуре вырождается в максимум', () => {
  const scores = [0.5, 0.9, 0.7];
  const counts = new Array(3).fill(0);
  for (let i = 0; i < 2000; i++) counts[rng.softmaxPick(scores, 0.001)]++;
  assert.equal(counts[1], 2000, 'при T→0 должен всегда выбираться максимум');
});

test('джиттер держится в заданных пределах', () => {
  for (let i = 0; i < 5000; i++) {
    const v = rng.jitter(100, 0.25);
    assert.ok(v >= 75 && v <= 125, `вышел за пределы: ${v}`);
  }
});

/* ------------------------------------------------------------------ */
group('Скоринг');

test('свежесть монотонно падает и штрафует слишком новое', () => {
  const cfg = S.scoring;
  const at = (m) => scorer.freshness(m, cfg);

  assert.ok(at(30) > at(120), 'свежесть должна падать с возрастом');
  assert.ok(at(120) > at(600), 'свежесть должна падать с возрастом');
  assert.equal(at(cfg.maxAgeHours * 60 + 1), 0, 'за горизонтом должно быть ровно 0');
  assert.ok(at(1) < at(5), 'пост младше minAge должен получать штраф разгона');

  // Внутри зоны чистого затухания за tau минут значение падает ровно в e раз.
  const base = cfg.minAgeMinutes;
  const ratio = at(base + cfg.tauMinutes) / at(base);
  assert.ok(Math.abs(ratio - 1 / Math.E) < 0.01, `спад за tau: ${ratio.toFixed(4)}, ждали ${(1 / Math.E).toFixed(4)}`);
});

test('живость логарифмична: вирусный пост не забивает шкалу', () => {
  const cfg = S.scoring;
  const e10 = scorer.engagement(10, cfg);
  const e100 = scorer.engagement(100, cfg);
  const e1000 = scorer.engagement(1000, cfg);
  assert.ok(e10 < e100 && e100 < e1000);
  // Рост в 10 раз по лайкам даёт далеко не десятикратный рост скора.
  assert.ok(e100 / e10 < 3, 'шкала недостаточно сжата');
  assert.ok(e1000 <= 1, 'значение должно быть нормировано в [0,1]');
});

test('шанс быть замеченным: живой пост с малым числом ответов выигрывает', () => {
  const cfg = S.scoring;
  const good = scorer.opportunity(60, 2, cfg);   // живой, ответов мало
  const buried = scorer.opportunity(60, 80, cfg); // живой, но завален ответами
  const dead = scorer.opportunity(0, 0, cfg);     // мёртвый

  assert.ok(good > buried, 'заваленный ответами пост должен проигрывать');
  assert.ok(good > dead, 'мёртвый пост не должен побеждать');
  assert.equal(dead, 0, 'пост без единого лайка не даёт шанса');
});

test('риск растёт на рекламных признаках', () => {
  const clean = scorer.riskScore({ text: 'разбирал вчера архитектуру агентов на python' }, S.niche);
  const spam = scorer.riskScore({
    text: 'СРОЧНО подпишись на канал https://t.me/x и забери курс https://ya.ru #деньги #заработок #успех #мотивация',
  }, S.niche);
  assert.equal(clean, 0);
  assert.ok(spam > 0.8, `спам недооценён: ${spam}`);
});

test('префильтр отбраковывает по нужным кодам', () => {
  const base = {
    url: 'https://www.threads.com/@bob/post/ABC123',
    shortcode: 'ABC123',
    text: 'разработка на python и нейросети, длинный осмысленный текст поста',
    authorHandle: 'bob',
    ageMinutes: 30,
    likes: 12,
    replies: 3,
    availability: { likes: true, replies: true, reposts: false },
  };
  const filtered = structuredClone(S);
  filtered.niche.includeKeywords = ['python', 'нейросет'];
  filtered.niche.excludeKeywords = ['политик', 'выборы'];
  const code = (post, settings = filtered, state = ST) => scorer.prefilter(post, settings, state).code;

  assert.equal(scorer.prefilter({ ...base }, filtered, ST).ok, true);

  assert.equal(code({ ...base, text: 'ок' }), skip.SKIP.TOO_SHORT);
  assert.equal(code({ ...base, text: 'x'.repeat(4000) }), skip.SKIP.TOO_LONG);
  const ownSettings = structuredClone(S);
  ownSettings.handle = 'owner';
  assert.equal(code({ ...base, authorHandle: 'owner' }, ownSettings), skip.SKIP.OWN_POST);
  assert.equal(code({ ...base, text: `${base.text} выборы и политика` }), skip.SKIP.STOP_WORD);
  assert.equal(code({ ...base, text: 'сегодня погода отличная, гулял в парке целый день и думал о жизни' }), skip.SKIP.NO_KEYWORDS);
  assert.equal(code({ ...base, ageMinutes: 99999 }), skip.SKIP.TOO_OLD);
  assert.equal(code({ ...base, isAd: true }), skip.SKIP.AD);
  assert.equal(code({ ...base, isNestedReply: true }), skip.SKIP.NESTED_REPLY);

  const cooled = { ...ST, authorCooldown: { bob: Date.now() } };
  assert.equal(code(base, filtered, cooled), skip.SKIP.AUTHOR_COOLDOWN);
});

test('префильтр уважает жёсткие фильтры и скрытые метрики', () => {
  const base = {
    url: 'https://www.threads.com/@bob/post/ABC123',
    shortcode: 'ABC123',
    text: 'разработка на python и нейросети, длинный осмысленный текст поста',
    authorHandle: 'bob',
    ageMinutes: 30,
    likes: 2,
    replies: 0,
  };
  const code = (post, settings) => scorer.prefilter(post, settings, ST).code;

  const withMin = structuredClone(S);
  withMin.filters.minLikes = 10;

  // Счётчик прочитан и он ниже порога — отсев честный.
  assert.equal(
    code({ ...base, availability: { likes: true, replies: true } }, withMin),
    skip.SKIP.LOW_LIKES,
  );

  // Счётчик скрыт: ноль ничего не значит, отсеивать нельзя.
  assert.equal(
    scorer.prefilter({ ...base, likes: 0, availability: { likes: false, replies: false } }, withMin, ST).ok,
    true,
    'скрытая метрика не должна работать как ноль',
  );

  const noMedia = structuredClone(S);
  noMedia.filters.skipMedia = true;
  assert.equal(code({ ...base, hasMedia: true, availability: {} }, noMedia), skip.SKIP.HAS_MEDIA);

  const hotOnly = structuredClone(S);
  hotOnly.filters.hotOnly = true;
  assert.equal(
    code({ ...base, likes: 1, replies: 0, ageMinutes: 300, availability: {} }, hotOnly),
    skip.SKIP.COLD,
  );
});

test('реестр узнаёт пост под другим адресом', () => {
  const post = {
    url: 'https://www.threads.com/@bob/post/ABC123',
    shortcode: 'ABC123',
    authorHandle: 'bob',
    text: 'полгода пилила автоматизацию отчётов на python и вот что вышло',
  };
  const sameByHash = {
    url: 'https://www.threads.com/@bob/post/DIFFERENT',
    shortcode: 'DIFFERENT',
    authorHandle: 'bob',
    text: 'полгода пилила автоматизацию отчётов на python и вот что вышло',
  };
  const other = {
    url: 'https://www.threads.com/@alice/post/XYZ',
    shortcode: 'XYZ',
    authorHandle: 'alice',
    text: 'совсем другой текст поста про совершенно другую тему целиком',
  };

  const keys = registry.keysOf(post);
  assert.ok(keys.length >= 2, `ключей должно быть несколько: ${keys.join(', ')}`);

  const state = { registry: [{ keys, status: 'commented', at: Date.now() }] };
  assert.equal(registry.statusSync(post, state), 'commented');
  assert.equal(registry.statusSync(sameByHash, state), 'commented',
    'пост под другим адресом должен узнаваться по хешу автора и текста');
  assert.equal(registry.statusSync(other, state), 'new');

  // Протухший захват освобождает пост.
  const stale = { registry: [{ keys, status: 'inflight', at: Date.now() - 60 * 60000 }] };
  assert.equal(registry.statusSync(post, stale), 'new');

  const fresh = { registry: [{ keys, status: 'inflight', at: Date.now() }] };
  assert.equal(registry.statusSync(post, fresh), 'inflight');
});

test('выбор цели уважает порог и не всегда берёт лучшего', () => {
  // Значения берутся от самого порога, а не забиваются числами: иначе тест
  // ломается при каждой его перенастройке и проверяет константу, а не логику.
  const min = S.scoring.minScore;
  const mk = (score) => ({ post: { id: String(score) }, score, relevance: 0.9 });

  const good = [min + 0.20, min + 0.15, min + 0.10].map((x) => Math.round(x * 100) / 100);
  const bad = [min - 0.05, min - 0.20].map((x) => Math.round(x * 100) / 100);
  const scored = [...good, ...bad].map(mk);

  const picks = new Set();
  for (let i = 0; i < 400; i++) {
    const t = scorer.pickTarget(scored, S);
    assert.ok(t.score >= min, `выбран кандидат ${t.score} ниже порога ${min}`);
    picks.add(t.post.id);
  }
  assert.ok(picks.size >= 2, 'выбор вырожден в один пост');
  for (const b of bad) {
    assert.ok(!picks.has(String(b)), `прошёл кандидат ${b} ниже порога ${min}`);
  }

  assert.equal(scorer.pickTarget([mk(min - 0.3)], S), null,
    'при отсутствии подходящих должен вернуть null');
});

/* ------------------------------------------------------------------ */
group('Импульс');

test('вес действия отражает его стоимость', () => {
  const likeOnly = momentum.computeMomentum({ likes: 12, ageMinutes: 60 });
  const replyOnly = momentum.computeMomentum({ replies: 4, ageMinutes: 60 });
  const repostOnly = momentum.computeMomentum({ reposts: 3, ageMinutes: 60 });

  assert.equal(likeOnly.score, 12);
  assert.equal(replyOnly.score, 12, 'четыре ответа весят как двенадцать лайков');
  assert.equal(repostOnly.score, 12, 'три репоста весят как двенадцать лайков');
});

test('скорость учитывает возраст, но минутный пост не улетает в бесконечность', () => {
  const fast = momentum.computeMomentum({ likes: 40, ageMinutes: 20 });
  const slow = momentum.computeMomentum({ likes: 40, ageMinutes: 720 });
  assert.ok(fast.perHour > slow.perHour * 5, 'свежий пост с теми же лайками должен быть намного быстрее');

  const instant = momentum.computeMomentum({ likes: 2, ageMinutes: 0 });
  assert.ok(instant.perHour < 10, `минутный пост с парой лайков не должен обгонять всех: ${instant.perHour}`);
});

test('горячее, остывшее и обычное различаются', () => {
  const hotEarly = momentum.classifyMomentum({ likes: 9, replies: 3, ageMinutes: 40 });
  assert.equal(hotEarly.label, 'hot', hotEarly.reason);

  const hotBig = momentum.classifyMomentum({ likes: 300, replies: 40, ageMinutes: 60 * 40 });
  assert.equal(hotBig.label, 'hot', 'крупный пост горяч независимо от возраста');

  const dead = momentum.classifyMomentum({ likes: 0, replies: 0, reposts: 0, ageMinutes: 120 });
  assert.equal(dead.label, 'cold', dead.reason);

  const faded = momentum.classifyMomentum({ likes: 4, replies: 0, ageMinutes: 60 * 20 });
  assert.equal(faded.label, 'cold', faded.reason);

  const mid = momentum.classifyMomentum({ likes: 9, replies: 1, ageMinutes: 60 * 5 });
  assert.equal(mid.label, 'neutral', mid.reason);
});

test('вклад импульса нормирован и монотонен', () => {
  const a = momentum.momentumComponent({ likes: 5, ageMinutes: 60 });
  const b = momentum.momentumComponent({ likes: 50, ageMinutes: 60 });
  const c = momentum.momentumComponent({ likes: 5000, ageMinutes: 60 });

  assert.ok(a < b && b < c, 'вклад должен расти со скоростью');
  assert.ok(c <= 1, 'вклад должен быть нормирован');
  assert.ok(b / a < 4, 'лог-шкала должна сжимать разрыв');
});

test('отбор горячих сортирует по скорости', () => {
  const posts = [
    { id: 'slow', likes: 200, ageMinutes: 60 * 30 },
    { id: 'fast', likes: 30, replies: 5, ageMinutes: 30 },
    { id: 'dead', likes: 0, replies: 0, ageMinutes: 300 },
  ];
  const hot = momentum.pickHot(posts);
  assert.ok(hot.length >= 2, 'горячих должно быть хотя бы два');
  assert.equal(hot[0].post.id, 'fast', 'первым идёт самый быстрый, а не самый крупный');
  assert.ok(!hot.some((h) => h.post.id === 'dead'));
});

/* ------------------------------------------------------------------ */
group('Восстановление');

test('единичные сбои не поднимают тревогу', () => {
  const s = structuredClone(S);
  const st = structuredClone(ST);

  for (let i = 0; i < 2; i++) {
    const v = recovery.onTechnicalFailure(st, s, skip.SKIP.NO_REPLY_BUTTON);
    assert.equal(v.step, recovery.STEP.SKIP_POST, 'до порога просто пропускаем пост');
  }
  assert.equal(st.recoveryStep, 0);
});

test('серия технических сбоев поднимает по лестнице', () => {
  const s = structuredClone(S);
  s.safety.technicalStreakLimit = 3;
  const st = structuredClone(ST);

  const steps = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 3; i++) {
      const v = recovery.onTechnicalFailure(st, s, skip.SKIP.SUBMIT_FAILED);
      if (i === 2) steps.push(v.step);
    }
  }

  assert.deepEqual(steps, [
    recovery.STEP.BACK_TO_FEED,
    recovery.STEP.RELOAD_PAGE,
    recovery.STEP.STOP,
  ], 'каждая новая серия поднимает на ступень выше');
});

test('нетехнический сбой не копит полосу', () => {
  const s = structuredClone(S);
  const st = structuredClone(ST);
  for (let i = 0; i < 10; i++) recovery.onTechnicalFailure(st, s, skip.SKIP.DUPLICATE_TEXT);
  assert.equal(st.technicalStreak, 0, 'проблема текста — не проблема страницы');
  assert.equal(st.recoveryStep, 0);
});

test('успех складывает лестницу', () => {
  const s = structuredClone(S);
  const st = structuredClone(ST);
  for (let i = 0; i < 6; i++) recovery.onTechnicalFailure(st, s, skip.SKIP.NO_EDITOR);
  assert.ok(st.recoveryStep > 0);

  recovery.onSuccessfulAction(st);
  assert.equal(st.recoveryStep, 0);
  assert.equal(st.technicalStreak, 0);
});

test('коды пропуска сворачиваются в сводку', () => {
  const codes = [
    skip.SKIP.NO_KEYWORDS, skip.SKIP.NO_KEYWORDS, skip.SKIP.NO_KEYWORDS,
    skip.SKIP.STOP_WORD, skip.SKIP.OWN_POST,
  ];
  const s = skip.summarize(codes);
  assert.match(s, /нет ключевых слов ниши: 3/);
  assert.match(s, /стоп-слово ниши: 1/);
});

test('у каждого кода есть человеческая подпись', () => {
  for (const code of Object.values(skip.SKIP)) {
    assert.ok(skip.SKIP_LABEL[code], `нет подписи для кода ${code}`);
  }
});

/* ------------------------------------------------------------------ */
group('Планировщик');

test('окно активности учитывает переход через полночь', () => {
  const t = { ...S.timing, activeFrom: 22, activeTo: 3, activeWeekdays: [0, 1, 2, 3, 4, 5, 6] };
  const at = (h) => { const d = new Date(2026, 6, 26, h, 30); return scheduler.inActiveWindow(t, d); };
  assert.equal(at(23), true);
  assert.equal(at(1), true);
  assert.equal(at(12), false);
  assert.equal(at(21), false);
});

test('циркадный множитель интерполируется между часами', () => {
  const t = { ...S.timing };
  const d0 = new Date(2026, 6, 26, 7, 0);
  const d30 = new Date(2026, 6, 26, 7, 30);
  const d59 = new Date(2026, 6, 26, 7, 59);

  const a = scheduler.circadianFactor(t, d0);
  const b = scheduler.circadianFactor(t, d30);
  const c = scheduler.circadianFactor(t, d59);

  assert.ok(a < b && b < c, 'нет плавного роста внутри часа');
  assert.ok(scheduler.circadianFactor(t, new Date(2026, 6, 26, 3, 0)) === 0, 'ночью должен быть ноль');
});

/*
 * Вечер обрывался ровно в 23:00, и это выглядело как поломка.
 *
 * Сессия закрывалась в 22:30, планировала следующую через пятьдесят минут — а
 * к 23:20 окно было уже закрыто, и разыгранный перерыв сгорал впустую. Дальше
 * до девяти утра агент молчал, показывая «ждём, вне окна активности».
 *
 * Час ночи вместо одиннадцати вечера закрывает этот разрыв: вечерний перерыв
 * успевает доиграть, а затухающая циркадика оставляет позднее сообщение
 * редким событием, а не ночной сменой.
 */
test('вечернее окно дотягивает до часа ночи', () => {
  const t = { ...S.timing };
  const at = (h, m = 30) => scheduler.inActiveWindow(t, new Date(2026, 6, 28, h, m));
  assert.equal(at(22), true, 'вечер должен быть рабочим');
  assert.equal(at(23), true, 'одиннадцать вечера обрывало сессию на полуслове');
  assert.equal(at(0), true, 'полночь входит в вечернее окно');
  assert.equal(at(1, 30), false, 'после часа ночи агент спит');
  assert.equal(at(3), false, 'глубокая ночь остаётся нерабочей');
  assert.equal(at(8), false, 'до девяти утра окно закрыто');
});

test('полночь затухает, но не обнуляется мгновенно', () => {
  const t = { ...S.timing };
  const f = (h, m) => scheduler.circadianFactor(t, new Date(2026, 6, 28, h, m));

  assert.ok(f(23, 30) > 0.02, 'в половине двенадцатого сессия должна быть ещё возможна');
  assert.ok(f(0, 15) > 0.02, 'сразу после полуночи активность не должна падать в ноль');
  assert.ok(f(0, 15) < f(23, 30), 'ночь обязана быть тише вечера');
  assert.ok(f(2, 0) === 0, 'к двум ночи активности быть не должно');
});

/*
 * Ожидание длиной в восемь часов показывалось как «дальше через 10 мин».
 *
 * Команда простоя режется десятью минутами, чтобы тикер не засыпал намертво,
 * и плашка честно повторяла этот тик. Со стороны человека это неотличимо от
 * зависания: цифра каждые десять минут одна и та же, а движения нет.
 */
test('ожидание вне окна называет час пробуждения', () => {
  const t = { ...S.timing };
  const label = scheduler.wakeLabel(t, new Date(2026, 6, 28, 3, 0));
  assert.match(label, /09:00/, `ожидали время пробуждения, получили «${label}»`);
});

test('миграция схемы продлевает вечер на старых настройках', () => {
  const old = structuredClone(defaults.DEFAULTS);
  old.timing.activeTo = 23;
  old.timing.circadian[0] = 0;

  const m = defaults.migrateSettings(old, 3);
  assert.equal(m.timing.activeTo, 1, 'старое окно 9–23 должно подтянуться до часа ночи');
  assert.ok(m.timing.circadian[0] > 0.02, 'полночь должна перестать быть нулевой');
});

test('миграция не трогает окно, настроенное руками', () => {
  const mine = structuredClone(defaults.DEFAULTS);
  mine.timing.activeFrom = 11;
  mine.timing.activeTo = 20;

  const m = defaults.migrateSettings(mine, 3);
  assert.equal(m.timing.activeTo, 20, 'ручное окно затёрто миграцией');
  assert.equal(m.timing.activeFrom, 11, 'ручное начало окна затёрто миграцией');
});

test('норма просмотров гарантирует комментарий', () => {
  // Прогоняем сессию так же, как это делает оркестратор: счётчики наполняются
  // по мере действий. Раньше выбор был чисто вероятностным, и при десяти
  // просмотрах на комментарий до самого комментария дело почти не доходило.
  const settings = structuredClone(S);
  settings.limits.viewsPerComment = 10;
  settings.limits.likesPerComment = 2;

  const runSession = () => {
    const session = { idle: false, plannedActions: 99, doneActions: 0, browseCount: 0, likeCount: 0 };
    const seq = [];
    for (let step = 0; step < 60; step++) {
      const a = scheduler.pickAction(settings, session);
      seq.push(a);
      if (a === 'comment') break;
      if (a === 'browse') session.browseCount++;
      if (a === 'like') session.likeCount++;
    }
    return seq;
  };

  for (let i = 0; i < 500; i++) {
    const seq = runSession();
    assert.ok(seq.includes('comment'), 'комментарий обязан случиться в пределах сессии');
    // Не позже нормы плюс лайки: иначе счётчик не работает.
    assert.ok(seq.length <= 14, `до комментария ушло ${seq.length} шагов`);
  }

  // Комментарий должен иногда выпадать и раньше срока, иначе интервалы
  // выстроятся в ровную сетку — ровно то, чего мы избегаем.
  const lengths = new Set();
  for (let i = 0; i < 300; i++) lengths.add(runSession().length);
  assert.ok(lengths.size >= 4, `длина пути до комментария почти постоянна: ${[...lengths].join(',')}`);
});

test('холостая сессия и выбранный план не дают комментариев', () => {
  const settings = structuredClone(S);
  const idle = { idle: true, plannedActions: 0, doneActions: 0, browseCount: 99 };
  const done = { idle: false, plannedActions: 2, doneActions: 2, browseCount: 99 };
  for (let i = 0; i < 300; i++) {
    assert.equal(scheduler.pickAction(settings, idle), 'browse');
    assert.equal(scheduler.pickAction(settings, done), 'browse');
  }
});

test('во всех пресетах норма просмотров влезает в сессию', () => {
  // Инвариант, нарушение которого стоило целой ночи: если путь до первого
  // комментария длиннее сессии, агент будет листать ленту и не писать вовсе.
  // Ошибка при этом бесшумная — в журнале просто нет строк.
  for (const name of ['careful', 'normal', 'active']) {
    const s = defaults.applyPreset(structuredClone(S), name);
    const e = scheduler.estimateDailyActions(s);
    assert.ok(
      e.fitPerSession >= 1,
      `пресет «${name}»: до комментария ${e.minutesToFirstComment} мин, `
      + `а сессия ${s.timing.sessionMinMinutes}-${s.timing.sessionMaxMinutes} мин`,
    );
    assert.ok(e.estimatedComments > 0, `пресет «${name}» даёт нулевой прогноз`);
  }
});

test('недостижимая норма честно показывает ноль', () => {
  const broken = structuredClone(S);
  broken.limits.viewsPerComment = 200;
  const e = scheduler.estimateDailyActions(broken);
  assert.equal(e.fitPerSession, 0, 'при недостижимой норме прогноз обязан быть нулевым');
  assert.equal(e.estimatedComments, 0, 'иначе UI показывает бодрую цифру там, где работы не будет');
});

test('холостая сессия не порождает комментариев', () => {
  const session = { idle: true, plannedActions: 0, doneActions: 0 };
  for (let i = 0; i < 500; i++) {
    assert.equal(scheduler.pickAction(S, session), 'browse');
  }
});

test('прогноз дневной активности правдоподобен', () => {
  const careful = defaults.applyPreset(structuredClone(S), 'careful');
  const active = defaults.applyPreset(structuredClone(S), 'active');

  const e1 = scheduler.estimateDailyActions(careful);
  const e2 = scheduler.estimateDailyActions(active);

  assert.ok(e1.estimatedComments > 0, 'осторожный режим не должен давать ноль');
  assert.ok(e2.estimatedComments > e1.estimatedComments, 'активный режим должен быть активнее');
  assert.ok(e1.awakeHours > 0 && e1.awakeHours < 24);
});

/* ------------------------------------------------------------------ */
group('Лимиты и прогрев');

test('прогрев растёт монотонно и упирается в целевой лимит', () => {
  const settings = structuredClone(S);
  settings.limits.perDay = 30;
  settings.limits.warmupDays = 10;
  settings.limits.warmupStartPerDay = 3;

  // Индекс массива = сколько суток прошло с первого запуска: чтобы получить
  // «прошло N дней», дату первого запуска отодвигаем на N дней назад.
  const byDay = [];
  for (let daysPassed = 0; daysPassed <= 14; daysPassed++) {
    const d = new Date();
    d.setDate(d.getDate() - daysPassed);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.push(limiter.warmupLimit(settings, { firstRunDate: iso }));
  }

  for (let i = 1; i < byDay.length; i++) {
    assert.ok(byDay[i] >= byDay[i - 1], `лимит убыл на дне ${i}: ${byDay[i - 1]} → ${byDay[i]}`);
  }
  assert.equal(byDay[0], 3, 'первый день должен стартовать со стартового лимита');
  assert.equal(byDay[10], 30, 'на границе прогрева должен быть целевой лимит');
  assert.equal(byDay[14], 30, 'после прогрева лимит не должен расти дальше');
});

test('дневной лимит каждый раз разный', () => {
  const settings = structuredClone(S);
  settings.limits.perDay = 25;
  settings.limits.warmupDays = 0;
  settings.limits.dailyJitter = 0.25;

  const values = new Set();
  for (let i = 0; i < 300; i++) values.add(limiter.rollDailyLimit(settings, ST));

  assert.ok(values.size >= 5, `лимит почти не гуляет: ${[...values].join(',')}`);
  assert.ok(Math.min(...values) >= 18 && Math.max(...values) <= 32, 'вышел за пределы джиттера');
});

test('часовой лимит режет и отпускает через час', () => {
  const settings = structuredClone(S);
  settings.limits.perHour = 3;
  settings.ai.apiKey = 'sk-test';

  const now = Date.now();
  const state = {
    ...structuredClone(ST),
    dayLimit: 100,
    dayCount: 0,
    hourStamps: [now - 1000, now - 2000, now - 3000],
  };

  const blocked = limiter.canComment(settings, state, now);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /часовой/);

  // Те же метки, но час спустя — ограничение снято.
  const later = limiter.canComment(settings, state, now + 3600001);
  assert.equal(later.ok, true);
});

test('часовой потолок гуляет в заданном коридоре, но не внутри часа', () => {
  /*
   * Решение владельца 02.08: два-три комментария в час вместо восьми. Ровно
   * три каждый час — ритм машины, поэтому потолок разыгрывается. Но внутри
   * одного часа он обязан стоять на месте: иначе агент, получивший отказ
   * «часовой лимит», через минуту получил бы разрешение, и коридор потерял бы
   * смысл.
   */
  const settings = structuredClone(S);
  settings.limits.perHour = 3;
  settings.limits.perHourMin = 2;

  const day = new Date(2026, 7, 2, 12, 0, 0).getTime();
  const seen = new Set();
  for (let h = 0; h < 24 * 14; h++) seen.add(limiter.hourLimit(settings, day + h * 3600000));

  assert.deepEqual([...seen].sort(), [2, 3], `за две недели видели потолки ${[...seen]}`);

  // Внутри часа — одно и то же число при любом числе проверок.
  const inHour = new Set();
  for (let m = 0; m < 60; m++) inHour.add(limiter.hourLimit(settings, day + m * 60000));
  assert.equal(inHour.size, 1, 'потолок менялся посреди часа');

  // Коридор можно выключить, приравняв границы.
  settings.limits.perHourMin = 3;
  assert.equal(limiter.hourLimit(settings, day), 3);
});

test('коридор публикаций: число на день гуляет от шести до одиннадцати', () => {
  /*
   * Тоже решение 02.08: шесть-одиннадцать публикаций за дневное окно вместо
   * тридцати с лишним. Число обязано быть разным день ото дня и одинаковым в
   * пределах одного дня — расписание не должно пересобираться при перезапуске
   * браузера, иначе уже опубликованные слоты начнут означать не то же самое.
   */
  const posting = {
    enabled: true, perDay: 50, perDayMin: 6, perDayMax: 11,
    intervalHours: 0.5, windowFromHour: 7, windowToHour: 24, jitterMin: 25, graceMin: 25,
  };

  const seen = new Set();
  for (let d = 1; d <= 60; d++) seen.add(postplan.dayQuota(posting, `2026-08-${String(d % 28 + 1).padStart(2, '0')}`));

  assert.ok(Math.min(...seen) >= 6 && Math.max(...seen) <= 11, `вышло за коридор: ${[...seen]}`);
  assert.ok(seen.size >= 4, `за два месяца всего ${seen.size} разных значений — это не разброс`);

  // Одна и та же дата — одно и то же число, сколько ни спрашивай.
  const twice = new Set([0, 1, 2].map(() => postplan.dayQuota(posting, '2026-08-02')));
  assert.equal(twice.size, 1, 'число публикаций на день скачет в пределах суток');

  // Слотов ровно столько же, сколько обещает коридор, и все внутри окна.
  const key = '2026-08-02';
  const slots = postplan.daySlots(posting, key);
  assert.equal(slots.length, postplan.dayQuota(posting, key), 'слотов не столько, сколько публикаций');
  assert.ok(slots[0] >= 7 * 60 && slots.at(-1) < 24 * 60, `слоты вне окна: ${slots[0]}..${slots.at(-1)}`);

  // Без коридора работает прежнее расписание с фиксированным шагом.
  const noCorridor = { ...posting, perDayMin: 0, perDayMax: 0, intervalHours: 3 };
  assert.equal(postplan.dayQuota(noCorridor, key), 0);
  assert.ok(postplan.daySlots(noCorridor, key).length > 0);
});

test('смена суток обнуляет счётчики и складывает вчера в историю', () => {
  const settings = structuredClone(S);
  const state = { ...structuredClone(ST), day: '2026-07-25', dayCount: 7, dayLikes: 3, daySpend: 0.12, dayLimit: 10 };
  limiter.rolloverDay(settings, state, Date.now());

  assert.notEqual(state.day, '2026-07-25');
  assert.equal(state.dayCount, 0);
  assert.equal(state.dayLikes, 0);
  assert.equal(state.history['2026-07-25'].comments, 7);
  assert.ok(state.dayLimit >= 0, 'новый лимит должен быть разыгран с учётом выходного дня');
});

test('предохранитель размыкается и удваивает паузу на повторе', () => {
  const settings = structuredClone(S);
  settings.safety.breakerThreshold = 3;
  settings.safety.breakerCooldownMinutes = 10;

  const state = structuredClone(ST);
  const now = Date.now();

  limiter.onError(settings, state, now);
  limiter.onError(settings, state, now);
  assert.equal(state.breaker, 'closed', 'до порога должен оставаться замкнутым');

  limiter.onError(settings, state, now);
  assert.equal(state.breaker, 'open');
  const firstWindow = state.breakerUntil - now;

  // Пауза истекла, пробуем снова.
  limiter.refreshBreaker(state, state.breakerUntil + 1);
  assert.equal(state.breaker, 'half');

  // Неудача в half-состоянии — пауза вдвое длиннее.
  const t2 = state.breakerUntil + 2;
  limiter.onError(settings, state, t2);
  assert.equal(state.breaker, 'open');
  assert.ok(state.breakerUntil - t2 > firstWindow * 1.9, 'пауза должна удвоиться');

  // Удача возвращает в норму.
  limiter.onSuccess(state);
  assert.equal(state.breaker, 'closed');
  assert.equal(state.consecutiveErrors, 0);
});

test('теневой бан останавливает после порога', () => {
  const settings = structuredClone(S);
  settings.safety.shadowFailThreshold = 3;
  const state = structuredClone(ST);

  limiter.onShadowFail(settings, state);
  limiter.onShadowFail(settings, state);
  assert.equal(state.halt, null);

  limiter.onShadowFail(settings, state);
  assert.ok(state.halt, 'должна быть остановка');
  assert.equal(state.halt.reason, 'shadow_ban');
});

/* ------------------------------------------------------------------ */
group('Гуманизация');

test('длинное тире исчезает всегда', () => {
  const s = structuredClone(S);
  for (let i = 0; i < 50; i++) {
    const r = humanizer.humanize('вот это — важная мысль про код', s);
    assert.ok(!r.text.includes('—'), `осталось тире: ${r.text}`);
  }
});

test('штампы вычищаются', () => {
  const s = structuredClone(S);
  const r = humanizer.humanize('Кстати, это работает. Важно отметить что данные решают', s);
  assert.ok(!/Кстати,/i.test(r.text), r.text);
  assert.ok(!/Важно отметить/i.test(r.text), r.text);
});

test('вырезка штампа не оставляет осиротевшей пунктуации', () => {
  const cases = [
    ['Кстати, важно отметить, что результат зависит от данных', /^результат зависит/i],
    ['Работает. Важно отметить, что данные решают', /работает\. данные решают/i],
    ['В целом, подход рабочий', /^подход рабочий/i],
  ];

  for (const [src, want] of cases) {
    const s = structuredClone(S);
    // Отключаем всё, кроме вычистки штампов, чтобы видеть именно её результат.
    Object.assign(s.humanize, {
      typoPerWord: 0, insertFiller: 0, addEmoji: 0, stretchVowel: 0,
      lowercaseStart: 0, dropFinalPeriod: 0, missingSpaceAfterComma: 0, spaceBeforePunct: 0,
    });
    const r = humanizer.humanize(src, s);
    assert.doesNotMatch(r.text, /[.!?]\s*[,;:]/, `осиротевшая пунктуация: «${r.text}»`);
    assert.doesNotMatch(r.text, /^\s*[,;:]/, `запятая в начале: «${r.text}»`);
    assert.match(r.text.toLowerCase(), want, `неожиданный результат: «${r.text}»`);
  }
});

test('подпись «Не нравится» означает лайкнутый пост', async () => {
  // Живой Threads после лайка меняет подпись на «Не нравится» — это
  // предложение снять отметку. Не узнавая её, агент считал свой лайк
  // неудавшимся и при следующем проходе снимал только что поставленный.
  const src = await readFile(join(EXT, 'content/selectors.js'), 'utf8');
  const liked = src.match(/liked:\s*\[([\s\S]*?)\]/)?.[1] || '';

  assert.match(liked, /'не нравится'/, 'подпись живого Threads должна быть в списке');
  assert.match(liked, /'убрать отметку'/);
  assert.match(liked, /'unlike'/);

  // Заливка иконки признаком быть не может: на живом Threads путь имеет
  // fill="currentColor" в обоих состояниях.
  assert.doesNotMatch(src, /svg\[fill\]:not\(\[fill="none"\]\)/,
    'проверка по заливке объявляла бы лайкнутым вообще всё');
});

test('пороги отбора достижимы на реальных скорах', () => {
  // За ночь лучшие кандидаты набирали 0.36, 0.41 и 0.48 при пороге 0.55 —
  // агент отверг их все и опубликовал один комментарий за семь часов.
  const real = [0.36, 0.41, 0.48, 0.57];
  const passing = real.filter((s) => s >= S.scoring.minScore).length;

  assert.ok(passing >= 2,
    `при пороге ${S.scoring.minScore} проходит ${passing} из ${real.length} реальных кандидатов`);
  assert.ok(S.scoring.minScore <= 0.5, 'порог выше 0.5 в бедной ленте недостижим');
});

test('свежесть оставляет вес суточному посту', () => {
  // В ленте нового аккаунта свежих постов мало. Если суточный даёт нулевой
  // вклад, до порога не дотягивает никто.
  const day = scorer.freshness(24 * 60, S.scoring);
  assert.ok(day > 0.015, `суточный пост даёт ${day.toFixed(4)} — слишком мало для бедной ленты`);

  // Предпочтение свежему при этом должно сохраняться.
  const hour = scorer.freshness(60, S.scoring);
  assert.ok(hour > day * 3, 'свежий пост обязан заметно выигрывать у суточного');
});

test('кириллические границы слова заданы без \\b', () => {
  // В JavaScript \b определяется по ASCII: между пробелом и «ч» границы нет,
  // поэтому /\bчто\b/ не совпадает ни с чем. Ловушка стоила трёх багов,
  // держим её под тестом.
  assert.equal(/\bчто\b/.test('а что дальше'), false, 'поведение \\b изменилось — пересмотреть регулярки');
  assert.equal(/(?<![\p{L}])что(?![\p{L}])/u.test('а что дальше'), true);
  assert.equal(/(?<![\p{L}])что(?![\p{L}])/u.test('чтобы'), false);
});

test('опечатки не садятся на первое слово и не идут подряд', () => {
  const s = structuredClone(S);
  s.humanize.typoPerWord = 1;
  s.humanize.typoMaxPerComment = 3;
  s.humanize.insertFiller = 0;
  s.humanize.stretchVowel = 0;
  s.humanize.addEmoji = 0;

  const src = 'словарь метрик определение источник формула владелец версия проверка результат';
  const words = src.split(' ');

  for (let i = 0; i < 150; i++) {
    const r = humanizer.humanize(src, s);
    const got = r.text.split(' ');
    const changed = [];
    for (let k = 0; k < words.length; k++) if (got[k] !== words[k]) changed.push(k);

    assert.ok(!changed.includes(0), `опечатка в первом слове: «${r.text}»`);
    for (let k = 1; k < changed.length; k++) {
      assert.ok(changed[k] - changed[k - 1] >= 3,
        `опечатки слишком близко (${changed.join(',')}): «${r.text}»`);
    }
  }
});

test('опечатки не превышают заданный потолок', () => {
  const s = structuredClone(S);
  s.humanize.typoPerWord = 1;      // максимум давления
  s.humanize.typoMaxPerComment = 2;
  s.humanize.insertFiller = 0;
  s.humanize.stretchVowel = 0;

  for (let i = 0; i < 200; i++) {
    const r = humanizer.humanize('простые надёжные слова которые точно длиннее четырёх символов каждое', s);
    const applied = r.applied.find((a) => a.startsWith('опечаток'));
    if (applied) {
      const n = Number(applied.split(': ')[1]);
      assert.ok(n <= 2, `опечаток больше потолка: ${n}`);
    }
  }
});

test('опечатка не обрубает слово с конца', () => {
  // «трогай» → «трога» читается как обрезанное слово, а не как промах пальца.
  for (let i = 0; i < 800; i++) {
    const t = humanizer.typoWord('трогай', { swap: 0, drop: 1, double: 0, neighbor: 0 });
    if (!t) continue;
    assert.notEqual(t, 'трога', 'пропущена последняя буква');
    assert.equal(t.length, 5, `неожиданная длина: «${t}»`);
    assert.ok(t.endsWith('й'), `последняя буква потеряна: «${t}»`);
  }
});

test('соседняя клавиша берётся из реальной раскладки', () => {
  // «ы» соседствует с «ф» и «в» в среднем ряду ЙЦУКЕН.
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(humanizer.neighborKey('ы'));
  assert.ok(seen.has('ф') || seen.has('в'), `неожиданные соседи: ${[...seen].join(',')}`);
  assert.ok(!seen.has('ы'), 'символ не должен заменяться сам на себя');
});

test('гуманизация не выходит за лимит длины', () => {
  const s = structuredClone(S);
  s.style.maxLen = 60;
  const long = 'очень длинный текст про разработку и нейросети который заведомо длиннее шестидесяти символов подряд';
  for (let i = 0; i < 100; i++) {
    const r = humanizer.humanize(long, s);
    assert.ok(r.text.length <= 60, `длина ${r.text.length}`);
  }
});

test('обрезка не оставляет висящих союзов', () => {
  const src = 'я бы сразу фиксировал словарь метрик и один sql как source of truth, '
            + 'а спорные кейсы добивал тестовыми наборами иначе всё расползётся';

  for (let len = 40; len <= 130; len += 5) {
    const out = humanizer.smartTruncate(src, len);
    assert.ok(out.length <= len, `длина ${out.length} > ${len}`);
    assert.ok(!humanizer.endsDangling(out), `висящее слово при len=${len}: «${out}»`);
    assert.ok(!/[,;:—-]$/.test(out), `висящая пунктуация при len=${len}: «${out}»`);
  }
});

test('обрезка предпочитает границу предложения', () => {
  const src = 'первая мысль закончена полностью тут. а дальше идёт вторая длинная мысль которая не влезет';
  const out = humanizer.smartTruncate(src, 60);
  assert.equal(out, 'первая мысль закончена полностью тут.');
});

test('безопасность бракует оборванную на союзе фразу', () => {
  const s = structuredClone(S);
  const state = structuredClone(ST);
  const v = safety.checkComment('я бы фиксировал словарь метрик сразу, а спорные кейсы добивал тестами иначе', s, state);
  assert.equal(v.ok, false);
  assert.match(v.reason, /служебном слове/);
  assert.equal(v.retry, true, 'такое стоит перегенерировать, а не пропускать пост');
});

test('в паразиты не проходят обороты, требующие продолжения', () => {
  const usable = humanizer.usableFillers([
    'короче', 'в общем', 'типа', 'имхо',
    'а вы тоже', 'я бы', 'это', 'ну и', 'по опыту',
    'очень длинное словосочетание которое точно не паразит',
  ]);
  assert.ok(usable.includes('короче'));
  assert.ok(usable.includes('в общем'));
  assert.ok(usable.includes('по опыту'));
  assert.ok(!usable.includes('а вы тоже'), 'оборот из трёх слов не должен проходить');
  assert.ok(!usable.includes('я бы'), 'оборот, требующий продолжения, не должен проходить');
  assert.ok(!usable.includes('это'));
  assert.ok(!usable.includes('ну и'));
  assert.ok(usable.every((f) => f.length <= 14));
});

test('вставка паразита оставляет фразу целой', () => {
  const s = structuredClone(S);
  s.humanize.insertFiller = 1;
  s.humanize.typoPerWord = 0;
  s.humanize.lowercaseStart = 0;
  s.humanize.addEmoji = 0;
  // Пропуск пробела после запятой — отдельный приём гуманизатора, здесь он
  // только мешает читать результат.
  s.humanize.missingSpaceAfterComma = 0;
  s.humanize.spaceBeforePunct = 0;
  s.style.fillers = ['короче'];

  for (let i = 0; i < 60; i++) {
    const r = humanizer.humanize('я бы начинал с шаблона метрик, потом уже код', s);
    if (!r.applied.some((a) => a.startsWith('слово-паразит'))) continue;
    // Паразит всегда отделён запятой, а не приклеен вплотную к следующему слову.
    assert.match(r.text, /короче,\s/, `плохая склейка: «${r.text}»`);
  }
});

test('время чтения растёт с объёмом текста', () => {
  const short = humanizer.readingTimeMs('короткий пост');
  const long = humanizer.readingTimeMs('x'.repeat(3000));
  assert.ok(long > short * 3, `не масштабируется: ${short} vs ${long}`);
  assert.ok(short >= 2500, 'слишком быстрый ответ на любой пост');
});

/* ------------------------------------------------------------------ */
group('Безопасность');

test('триграммный Жаккар ловит перефразировку', () => {
  const a = 'у меня на проде такое падало из-за таймаута в очереди';
  const b = 'на проде у меня падало такое же из-за таймаута очереди';
  const c = 'вчера гулял в парке и думал о погоде';

  assert.ok(text.jaccard(a, b) > 0.45, `перефразировка не поймана: ${text.jaccard(a, b).toFixed(2)}`);
  assert.ok(text.jaccard(a, c) < 0.2, `ложное срабатывание: ${text.jaccard(a, c).toFixed(2)}`);
  assert.equal(text.jaccard(a, a), 1);
});

test('нормализация снимает регистр, ё и пунктуацию', () => {
  assert.equal(text.normalize('Ещё! Раз, ЁЖИК...'), 'еще раз ежик');
});

test('фильтр комментария ловит всё, что должен', () => {
  const s = structuredClone(S);
  const state = { ...structuredClone(ST), recentTexts: ['у меня на проде такое падало из-за таймаута'] };

  /*
   * Образец удлинён 01.08 вместе с подъёмом `style.minLen` с 25 до 45.
   * Прежний был ровно 43 символа — та самая длина, у которой по замеру на 485
   * живых репликах доля получивших ответ падает с 44% до 34%. Тест держал
   * форму фильтра, а заодно молча закреплял длину, которую мы теперь считаем
   * недостаточной.
   */
  assert.equal(safety.checkComment(
    'у меня похожее было на проде: помог таймаут на стороне клиента и ретрай с бэкоффом',
    s, state,
  ).ok, true);

  assert.match(safety.checkComment('ок', s, state).reason, /короче/);

  /*
   * Запреты обязаны срабатывать раньше длины: короткая реплика со ссылкой
   * должна браковаться за ссылку, иначе журнал уводит разбор не туда.
   * Ровно этот дефект и всплыл при подъёме минимума до 45 символов.
   */
  assert.match(safety.checkComment('вот тут https://example.com', s, state).reason, /ссылка/,
    'короткий текст со ссылкой забракован по длине вместо ссылки');
  assert.match(safety.checkComment('да, @someone прав', s, state).reason, /упоминание/,
    'короткий текст с упоминанием забракован по длине');
  assert.match(safety.checkComment('глянь тут https://example.com классный разбор', s, state).reason, /ссылка/);
  assert.match(safety.checkComment('согласен с @someone тут всё верно сказано', s, state).reason, /упоминание/);
  assert.match(safety.checkComment('интересная тема #нейросети #ии стоит копнуть', s, state).reason, /хэштег/);
  assert.match(safety.checkComment('как ии я не могу дать такой совет тебе', s, state).reason, /стоп-слово/);
  assert.match(safety.checkComment('{"reply": "текст ответа для публикации"}', s, state).reason, /разметк/);
  assert.match(safety.checkComment('на проде у меня падало такое же из-за таймаута', s, state).reason, /похоже/);
  assert.match(safety.checkComment('вот это да 🔥😅💀🤔 просто нет слов совсем', s, state).reason, /эмодзи/);
});

test('выбор угла приглушает недавно использованные', () => {
  const s = structuredClone(S);
  const state = { ...structuredClone(ST), recentAngles: Array(12).fill('agree_add') };

  const counts = {};
  for (let i = 0; i < 4000; i++) {
    const a = safety.pickAngle(s, state);
    counts[a] = (counts[a] || 0) + 1;
  }

  const share = (counts.agree_add || 0) / 4000;
  const baseShare = s.angles.weights.agree_add
    / Object.values(s.angles.weights).reduce((a, b) => a + b, 0);
  assert.ok(share < baseShare * 0.6, `повтор не приглушён: ${(share * 100).toFixed(1)}%`);
  assert.ok(Object.keys(counts).length >= 5, 'слишком мало разных углов');
});

test('угол с нулевым весом не выбирается', () => {
  const s = structuredClone(S);
  s.angles.weights.humor = 0;
  const state = structuredClone(ST);
  for (let i = 0; i < 2000; i++) {
    assert.notEqual(safety.pickAngle(s, state), 'humor');
  }
});

test('подсказка ИИ принимается только для включённого угла', () => {
  const s = structuredClone(S);
  s.angles.weights.humor = 0;
  const state = structuredClone(ST);

  assert.equal(safety.pickAngle(s, state, 'question'), 'question', 'валидная подсказка должна приниматься');
  assert.notEqual(safety.pickAngle(s, state, 'humor'), 'humor', 'выключенный угол не должен проходить');
  assert.ok(safety.pickAngle(s, state, 'ерунда'), 'мусорная подсказка не должна ломать выбор');
});

test('JSON вытаскивается из любой обёртки', () => {
  assert.deepEqual(safety.extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(safety.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(safety.extractJson('Вот результат: {"a":1} готово'), { a: 1 });
  assert.deepEqual(safety.extractJson('[{"id":0}]'), [{ id: 0 }]);
  assert.equal(safety.extractJson('просто текст'), null);
});

test('обёртки вокруг готовой реплики снимаются', () => {
  assert.equal(safety.cleanGenerated('«текст ответа»'), 'текст ответа');
  assert.equal(safety.cleanGenerated('Комментарий: текст ответа'), 'текст ответа');
  assert.equal(safety.cleanGenerated('1) первый вариант\n2) второй вариант'), 'первый вариант');
});

/* ------------------------------------------------------------------ */
group('Настройки');

test('пресет не трогает то, что человек настроил сам', () => {
  // Пресет задаёт режим работы: лимиты, тайминги, пороги, фильтры, автопостинг.
  // Ключ, стиль и хэндл к режиму отношения не имеют и обязаны пережить смену.
  const base = structuredClone(S);
  base.ai.apiKey = 'fixture-not-a-real-key';
  base.style.profileText = 'мой стиль';
  base.handle = 'кто_то';

  const applied = defaults.applyPreset(base, 'active');
  assert.equal(applied.preset, 'active');
  assert.equal(applied.limits.perDay, defaults.PRESETS.active.limits.perDay);
  assert.equal(applied.ai.apiKey, 'fixture-not-a-real-key', 'пресет не должен трогать ключ');
  assert.equal(applied.style.profileText, 'мой стиль', 'пресет не должен трогать стиль');
  assert.equal(applied.handle, 'кто_то', 'пресет не должен трогать хэндл');
  assert.equal(applied.niche.description, base.niche.description, 'пресет не должен трогать нишу');
  assert.equal(applied.enabled, base.enabled, 'пресет не должен запускать агента');
});

test('слияние сохраняет структуру схемы и пользовательские значения', () => {
  const merged = defaults.deepMerge(defaults.DEFAULTS, { limits: { perDay: 77 }, ai: { apiKey: 'k' } });
  assert.equal(merged.limits.perDay, 77);
  assert.equal(merged.ai.apiKey, 'k');
  assert.equal(merged.limits.perHour, defaults.DEFAULTS.limits.perHour, 'недостающие поля должны браться из схемы');
  assert.equal(merged.timing.circadian.length, 24);
});

test('промпт стиля меняет задачу, когда ответов нет', async () => {
  const prompts = await load('bg/prompts.js');

  const withReplies = prompts.styleSystem({ hasReplies: true });
  const postsOnly = prompts.styleSystem({ hasReplies: false });

  assert.notEqual(withReplies, postsOnly, 'промпт обязан различать эти случаи');

  // Без ответов модель должна выводить манеру комментариев, а не копировать посты.
  assert.match(postsOnly, /только собственные посты/i);
  assert.match(postsOnly, /вывести из неё манеру/i);
  assert.doesNotMatch(postsOnly, /Ответы важнее/i);

  assert.match(withReplies, /Ответы важнее/i);

  // Целевой регистр в обоих случаях — комментарий, а не пост.
  for (const p of [withReplies, postsOnly]) {
    assert.match(p, /КОММЕНТАРИЯХ/);
  }

  const u = prompts.styleUser(['раз', 'два'], { hasReplies: false });
  assert.match(u, /все — собственные посты/);
});

test('все веса углов покрывают все объявленные углы', () => {
  for (const key of Object.keys(defaults.ANGLES)) {
    assert.ok(key in defaults.DEFAULTS.angles.weights, `нет веса для угла ${key}`);
  }
});

/* --------------------------- Копилка кандидатов --------------------------- */

const cand = (id, score, over = {}) => ({
  post: {
    id, url: `https://www.threads.com/@a/post/${id}`, authorHandle: 'a',
    text: `пост ${id}`, ageMinutes: 30, likes: 5, replies: 2, reposts: 0, ...over,
  },
  score,
  relevance: 0.7,
  momentum: { label: 'neutral' },
  topic: over.topic || 'нейросети',
});

test('копилка не создаёт дублей и берёт лучшую оценку', () => {
  const S0 = { backlog: [], seenPosts: [] };
  const now = 1_000_000;

  const a = backlog.addCandidates(S0, [cand('p1', 0.5), cand('p2', 0.6)], S, now);
  assert.equal(a.backlog.length, 2);
  assert.equal(a.added, 2);

  // Тот же пост со свежей, более высокой оценкой.
  const b = backlog.addCandidates({ ...S0, backlog: a.backlog }, [cand('p1', 0.8)], S, now + 60000);
  assert.equal(b.backlog.length, 2, 'дубль попал в копилку');
  assert.equal(b.refreshed, 1);

  const p1 = b.backlog.find((i) => i.id === 'p1');
  assert.equal(p1.score, 0.8, 'оценка не обновилась до лучшей');
  assert.equal(p1.queuedAt, now, 'запись омолодила себя и никогда не протухнет');
});

test('ценность записи падает со временем ожидания', () => {
  const now = 1_000_000;
  const item = { id: 'x', score: 0.8, queuedAt: now };

  const fresh = backlog.effectiveScore(item, S, now);
  const waited = backlog.effectiveScore(item, S, now + S.scoring.tauMinutes * 60000);

  assert.equal(fresh.toFixed(3), '0.800');
  // Ровно постоянная затухания — падение в e раз.
  assert.ok(Math.abs(waited - 0.8 / Math.E) < 1e-9, `ожидали ${0.8 / Math.E}, вышло ${waited}`);
  assert.ok(waited < fresh);
});

test('копилка отдаёт лучшего с учётом затухания, а не по исходной оценке', () => {
  const now = 1_000_000;
  const old = { id: 'старый', score: 0.75, queuedAt: now - 8 * 3600000, ageAtQueue: 10 };
  const fresh = { id: 'свежий', score: 0.62, queuedAt: now, ageAtQueue: 10 };

  const r = backlog.takeBest({ backlog: [old, fresh], seenPosts: [] }, S, now);
  assert.equal(r.item.id, 'свежий', 'старая запись вечно обгоняет свежую');
  assert.equal(r.backlog.length, 1, 'выбранная запись осталась в копилке');
});

test('копилка выбрасывает протухшее и уже виденное', () => {
  const now = 1_000_000;
  const maxAge = S.filters.maxAgeHours * 60;

  const items = [
    { id: 'старик', score: 0.9, queuedAt: now, ageAtQueue: maxAge + 10 },
    { id: 'виденный', score: 0.9, queuedAt: now, ageAtQueue: 10 },
    { id: 'годный', score: 0.9, queuedAt: now, ageAtQueue: 10 },
  ];

  const r = backlog.pruneBacklog({ backlog: items, seenPosts: ['виденный'] }, S, now);
  assert.deepEqual(r.backlog.map((i) => i.id), ['годный']);
  assert.equal(r.dropped, 2);
});

test('запись протухает и от собственного ожидания, а не только от возраста поста', () => {
  const now = 1_000_000;
  const maxAgeMs = S.filters.maxAgeHours * 3600000;
  // Пост был свежим на момент постановки, но с тех пор прошло больше предела.
  const item = { id: 'ждун', score: 0.9, queuedAt: now - maxAgeMs - 60000, ageAtQueue: 5 };

  assert.equal(backlog.isStale(item, S, { seenPosts: [] }, now), true);
});

test('ниже порога отбора копилка ничего не отдаёт', () => {
  const now = 1_000_000;
  const weak = { id: 'слабый', score: S.scoring.minScore - 0.05, queuedAt: now, ageAtQueue: 10 };

  const r = backlog.takeBest({ backlog: [weak], seenPosts: [] }, S, now);
  assert.equal(r.item, null);
});

test('копилка не растёт бесконечно и режет по ценности', () => {
  const now = 1_000_000;
  const many = Array.from({ length: 200 }, (_, i) => cand(`p${i}`, 0.4 + (i / 1000)));

  const r = backlog.addCandidates({ backlog: [], seenPosts: [] }, many, S, now);
  assert.ok(r.backlog.length <= 120, `копилка выросла до ${r.backlog.length}`);

  // Обрезка снимает слабейших, а не первых попавшихся.
  const scores = r.backlog.map((i) => i.score);
  assert.ok(Math.max(...scores) > 0.59, 'лучшие записи потерялись при обрезке');
});

test('восстановленная из копилки цель годится для конвейера', () => {
  const now = 1_000_000;
  const r = backlog.addCandidates({ backlog: [], seenPosts: [] }, [cand('p1', 0.7)], S, now);
  const t = backlog.toTarget(r.backlog[0]);

  assert.equal(t.post.id, 'p1');
  assert.ok(t.post.url, 'без адреса ветку не открыть');
  assert.equal(t.post.authorHandle, 'a');
  assert.equal(typeof t.score, 'number');
  assert.equal(t.fromBacklog, true);
});

test('веса источников дают перевес поиску, но не отключают главную', () => {
  const w = S.niche.sourceWeights;
  assert.ok(w.search > w.home, 'поиск должен выпадать чаще главной');
  assert.ok(w.home > 0, 'без чтения своей ленты она не настроится');
});

test('порог темы по ветке мягче, чем по карточке', () => {
  // Разбор ветки уже оплачен, а обсуждение по краю темы — часто как раз то,
  // где есть что сказать. Порог строже карточного означал бы платить за разбор
  // и выбрасывать результат.
  assert.ok(S.scoring.minThreadTopic < S.scoring.minRelevance);
  assert.ok(S.scoring.minThreadTopic > 0);
});

/* ----------------------------- Новизна ------------------------------------ */

test('новизна падает на повторе формулировки', () => {
  const prev = ['промпт с примерами работает лучше длинных инструкций'];
  const same = novelty.noveltyOf('промпт с примерами работает лучше длинных инструкций', prev);
  const other = novelty.noveltyOf('вчера потратил час на отладку MCP-сервера, оказалось дело в путях', prev);

  assert.ok(same.score < 0.3, `повтор дал новизну ${same.score}`);
  assert.ok(other.score > 0.6, `непохожий текст дал новизну ${other.score}`);
});

test('новизна падает на повторе темы даже при разных словах', () => {
  /*
   * То, что замечает человек первым: профиль, где каждый второй пост про одно
   * и то же, читается однообразным, даже если ни одна фраза не повторилась.
   */
  const prev = [
    'claude code разбирает репозиторий быстрее если сузить контекст',
    'в claude code полезно держать план отдельно от кода',
    'claude code перестал путаться после того как убрал лишние файлы',
  ];
  const sameTopic = novelty.noveltyOf('claude code лучше работает когда контекст короче', prev);
  const newTopic = novelty.noveltyOf('нашёл толковый сервер для генерации схем базы', prev);

  assert.ok(sameTopic.score < newTopic.score,
    `тема ${sameTopic.score} против новой ${newTopic.score}`);
});

test('новизна ловит одинаковые зачины', () => {
  const openings = ['короче я тут', 'короче я тут', 'короче я тут'];
  const r = novelty.noveltyOf('короче я тут наконец разобрался с настройкой', [], { openings });
  assert.ok(r.score < 0.2, `зачин-шаблон дал новизну ${r.score}`);
  assert.equal(r.worst, 'зачин');
});

test('без истории всё считается новым', () => {
  assert.equal(novelty.noveltyOf('любой текст', []).score, 1);
});

test('надоевшие темы находятся по повторам', () => {
  const recent = [
    'claude code и контекст', 'claude code и планы', 'claude code и файлы',
    'сегодня про базы данных',
  ];
  const tired = novelty.tiredTopics(recent);
  assert.ok(tired.includes('claude'), `надоевшие: ${tired.join(', ')}`);
  assert.ok(!tired.includes('базы'), 'однократная тема попала в надоевшие');
});

/* ------------------------- Автопостинг: расписание ------------------------ */

const P = { ...S.posting, enabled: true };

test('слоты укладываются в дневное окно и не выходят за него', () => {
  const slots = postplan.daySlots(P);
  assert.ok(slots.length >= 3, `слотов всего ${slots.length}`);
  assert.ok(slots[0] >= P.windowFromHour * 60);
  assert.ok(slots[slots.length - 1] < P.windowToHour * 60);

  // Ночью профиль обязан молчать: круглосуточная публикация с ровным шагом —
  // самый простой признак автоматизации.
  for (const m of slots) {
    const h = Math.floor(m / 60);
    assert.ok(h >= P.windowFromHour && h < P.windowToHour, `слот в ${h}:00 вне окна`);
  }
});

test('интервал между слотами соответствует настройке', () => {
  const slots = postplan.daySlots(P);
  for (let i = 1; i < slots.length; i++) {
    assert.equal(slots[i] - slots[i - 1], P.intervalHours * 60);
  }
});

test('разброс слота детерминирован', () => {
  // Иначе смещение прыгает на каждой проверке и слот то наступает, то нет.
  const a = postplan.slotJitter('2026-07-27', 2, 30);
  const b = postplan.slotJitter('2026-07-27', 2, 30);
  assert.equal(a, b);
  assert.ok(Math.abs(a) <= 30);

  // Разные дни и слоты не должны совпадать поголовно.
  const spread = new Set([0, 1, 2, 3, 4].map((i) => postplan.slotJitter('2026-07-27', i, 30)));
  assert.ok(spread.size >= 3, `разброс вырожден: ${[...spread]}`);
});

test('дневной лимит закрывает публикации независимо от слотов', () => {
  const st = { postedSlots: { [postplan.moscowNow().key]: [0, 1, 2, 3, 4] } };
  const r = postplan.slotDue({ ...P, perDay: 5 }, st);
  assert.equal(r.due, false);
  assert.match(r.why, /лимит/);
});

test('выключённый автопостинг не выдаёт слотов', () => {
  assert.equal(postplan.slotDue({ ...P, enabled: false }, {}).due, false);
});

test('просроченные слоты не догоняются пачкой', () => {
  // Агент был выключен полдня. При возвращении не должно вылететь четыре поста.
  const t = postplan.moscowNow();
  const st = { postedSlots: {} };
  const r = postplan.slotDue({ ...P, graceMin: 75 }, st);
  if (r.due) {
    const slots = postplan.daySlots(P);
    const at = slots[r.slot] + postplan.slotJitter(t.key, r.slot, P.jitterMin);
    assert.ok(t.minutes - at <= 75, `слот просрочен на ${t.minutes - at} мин, а всё равно наступил`);
  }
});

/* ------------------------ Автопостинг: потерянные слоты ------------------- */

/*
 * Живой случай 03.08.2026, ради которого появились проверки ниже.
 *
 * Квота на день — шесть постов, слоты 08:19, 11:19, 13:40, 16:40, 19:27, 22:27.
 * Первые три отработаны, а слот 16:40 (второй за день полезный разбор) пропал
 * целиком: сессия закрылась в 16:36 с перерывом в 32 минуты, окно догона тогда
 * было 25 минут, а расписание проверяется только внутри сессии. Агент проснулся
 * в 17:08 — на три минуты позже, чем окно закрылось. В журнале об этом не
 * появилось ни строки.
 */
const LIVE_P = {
  enabled: true,
  windowFromHour: 7,
  windowToHour: 24,
  perDayMin: 6,
  perDayMax: 11,
  perDay: 50,
  intervalHours: 0.5,
  jitterMin: 25,
  graceMin: 25,
};
const MSK = (hhmm) => new Date(`2026-08-03T${hhmm}:00+03:00`);

test('слот, истёкший в перерыве, попадает в журнал ровно один раз', () => {
  const st = { postedSlots: { '2026-08-03': [0, 1, 2] } };

  const missed = postplan.expiredSlots(LIVE_P, st, MSK('17:10'));
  assert.deepEqual(missed.map((m) => m.slot), [3], 'потерянный слот не замечен');
  assert.ok(missed[0].lateMin > LIVE_P.graceMin, 'слот назван пропущенным раньше срока');

  // Названный вслух пропуск не повторяется: иначе журнал каждый тик твердит одно.
  postplan.markSlotMissed(st, 3, MSK('17:10'));
  assert.deepEqual(postplan.expiredSlots(LIVE_P, st, MSK('17:40')), [], 'пропуск объявлен дважды');
});

test('слот в окне догона пропуском не считается', () => {
  const st = { postedSlots: { '2026-08-03': [0, 1, 2] } };
  const at = MSK('16:55');   // опоздание 15 мин при окне 25

  assert.deepEqual(postplan.expiredSlots(LIVE_P, st, at), [], 'слот ещё можно отработать');
  assert.equal(postplan.slotDue(LIVE_P, st, at).due, true, 'а раз можно — он обязан наступить');
});

test('исчерпанный дневной потолок не превращает остаток дня в пропуски', () => {
  // Потолок закрыл публикации осознанно — это не потеря, и в журнале ей не место.
  const st = { postedSlots: { '2026-08-03': [0, 1, 2] } };
  assert.deepEqual(postplan.expiredSlots({ ...LIVE_P, perDay: 3 }, st, MSK('23:59')), []);
});

test('окно догона упирается в следующий слот, а не только в graceMin', () => {
  /*
   * Одиннадцать постов в окне 7:00–24:00 — это шаг в полтора часа, и при
   * разбросе ±25 минут соседние слоты сходятся до сорока трёх. Окно догона
   * шире этого промежутка означало бы два поста подряд с разницей в пять
   * минут: агент опубликовал бы поздний слот, а следом догнал ранний.
   */
  const dense = { ...defaults.PRESETS.boost.posting, perDayMin: 11, perDayMax: 11, graceMin: 55 };
  const key = '2026-08-03';
  const slots = postplan.daySlots(dense, key);

  for (let i = 0; i < slots.length - 1; i++) {
    const at = slots[i] + postplan.slotJitter(key, i, dense.jitterMin);
    const next = slots[i + 1] + postplan.slotJitter(key, i + 1, dense.jitterMin);

    // Момент сразу после наступления следующего слота: ранний обязан быть закрыт.
    const now = new Date(`2026-08-03T00:00:00+03:00`);
    now.setMinutes(now.getMinutes() + next + 1);

    const st = { postedSlots: { [key]: [i + 1] } };
    const due = postplan.slotDue(dense, st, now);
    assert.notEqual(due.slot, i,
      `слот ${i} (${at} мин) наступил, когда уже пришёл слот ${i + 1} (${next} мин)`);
  }
});

test('формат не повторяется подряд', () => {
  const st = { lastPostKind: 'news', recentPostKinds: ['news'] };
  for (let i = 0; i < 40; i++) {
    assert.notEqual(postplan.pickKind(st, { hasMaterial: true }), 'news');
  }
});

test('без материала не выпадают форматы, которым он нужен', () => {
  const st = {};
  for (let i = 0; i < 60; i++) {
    const k = postplan.pickKind(st, { hasMaterial: false });
    assert.equal(postplan.POST_KINDS[k].needsMaterial, false, `формат ${k} требует материала`);
  }
});

test('часто выходивший формат теряет в шансах', () => {
  const st = { recentPostKinds: ['tip', 'tip', 'tip', 'tip'] };
  let tips = 0;
  for (let i = 0; i < 400; i++) if (postplan.pickKind(st, { hasMaterial: true }) === 'tip') tips++;
  assert.ok(tips / 400 < 0.15, `«приём» выпал в ${Math.round((tips / 400) * 100)}% случаев`);
});

test('отметка слота хранит историю по дням и подрезает старое', () => {
  let st = {};
  st = postplan.markSlotPosted(st, 0, 'news');
  st = postplan.markSlotPosted(st, 1, 'tip');

  const key = postplan.moscowNow().key;
  assert.deepEqual(st.postedSlots[key], [0, 1]);
  assert.equal(st.lastPostKind, 'tip');

  st.postedSlots = { '2026-01-01': [0], '2026-01-02': [0], '2026-01-03': [0], '2026-01-04': [0] };
  st = postplan.markSlotPosted(st, 2, 'news');
  assert.ok(Object.keys(st.postedSlots).length <= 3, 'история дней не подрезается');
});

/* ------------------------ Автопостинг: проверка текста -------------------- */

const POST_S = { ...S, posting: P };

test('пост со ссылкой бракуется', () => {
  // Ни в одном из 104 собранных постов Threads ссылки не было.
  const v = poster.checkPost('Вышла новая модель, подробности тут https://example.com', 'news', POST_S);
  assert.equal(v.ok, false);
  assert.match(v.reason, /ссылк/);
});

test('пост со списком бракуется', () => {
  // Список — самый проигрышный признак по собранным данным: ×0.28.
  const t = 'Три вещи про агентов:\n- первое\n- второе';
  const v = poster.checkPost(t, 'tip', POST_S);
  assert.equal(v.ok, false);
  assert.match(v.reason, /список/);
});

test('многострочный пост бракуется', () => {
  const t = 'раз\nдва\nтри\nчетыре и ещё немного текста чтобы пройти по длине точно';
  const v = poster.checkPost(t, 'tip', POST_S);
  assert.equal(v.ok, false);
  assert.match(v.reason, /строк/);
});

test('пост с хэштегом бракуется', () => {
  const v = poster.checkPost('Забавно, что агенты всё ещё путаются в путях #нейросети', 'take', POST_S);
  assert.equal(v.ok, false);
  assert.match(v.reason, /хэштег/);
});

test('нормальный короткий пост проходит', () => {
  const t = 'Оказалось, что половина моих промптов не нужна: модель и так это делает, если просто не мешать';
  assert.equal(poster.checkPost(t, 'take', POST_S).ok, true, poster.checkPost(t, 'take', POST_S).reason);
});

test('повтор недавнего поста бракуется', () => {
  const t = 'Оказалось, что половина моих промптов не нужна: модель и так это делает';
  const recent = ['Оказалось что половина моих промптов не нужна, модель и так это делает сама'];
  const v = poster.checkPost(t, 'take', POST_S, recent);
  assert.equal(v.ok, false);
  assert.match(v.reason, /похоже/);
});

/* --------------------------- Длина постов -------------------------------- */

/*
 * Ожидания берутся из схемы, а не переписываются числами.
 *
 * Прежняя версия этих двух проверок хранила «120» и «150» рядом с теми же
 * числами в `POST_KINDS`, и правка форматов по свежей разведке уронила их обе,
 * хотя проверяемое свойство не менялось ни на йоту. Дубль схемы в тесте ловит
 * не поломку, а факт правки — это шум, о котором в уроках уже записано.
 */
test('потолок длины берётся из настройки, а не из кода', () => {
  const long = postplan.POST_KINDS.prompts;
  const tight = { ...POST_S, posting: { ...P, maxLen: long.len[1] - 40 } };
  const wide = { ...POST_S, posting: { ...P, maxLen: 500 } };

  assert.equal(postplan.lenLimits('prompts', tight).max, long.len[1] - 40,
    'настройка ниже потолка формата обязана его срезать');
  assert.equal(postplan.lenLimits('prompts', wide).max, long.len[1],
    'настройка выше потолка формата не должна его поднимать');
});

test('потолок не удлиняет короткие форматы', () => {
  // Гибрид: разбору и промптам длина нужна, вопросу и наблюдению — нет.
  const wide = { ...POST_S, posting: { ...P, maxLen: 500 } };
  for (const name of ['question', 'take', 'tool', 'hottake']) {
    assert.equal(postplan.lenLimits(name, wide).max, postplan.POST_KINDS[name].len[1],
      `«${name}» удлинился вслед за общей настройкой, а не должен был`);
  }
  assert.ok(postplan.lenLimits('prompts', wide).max > postplan.POST_KINDS.question.len[1],
    'формату, которому длина нужна по существу, она остаётся доступна');
});

test('длина ограничена возможностями Threads при любой настройке', () => {
  const absurd = { ...POST_S, posting: { ...P, maxLen: 9000 } };
  assert.ok(postplan.lenLimits('prompts', absurd).max <= postplan.THREADS_MAX_LEN);
});

test('промпт называет ровно тот потолок, который проверяет checkPost', () => {
  /*
   * Тот самый рассинхрон, который стоил слота: промпт просил 70-160, проверка
   * сравнивала с 175, а модель написала 194. Пока эти числа приходят из
   * разных мест, расхождение вернётся — тест держит их вместе.
   */
  for (const kind of Object.keys(postplan.POST_KINDS)) {
    const lim = postplan.lenLimits(kind, POST_S);
    const sys = postplan.POST_KINDS[kind].parts > 1 || Array.isArray(postplan.POST_KINDS[kind].parts)
      ? prompts.threadSystem(POST_S, postplan.POST_KINDS[kind], 3, lim)
      : prompts.postSystem(POST_S, postplan.POST_KINDS[kind], lim);

    assert.ok(sys.includes(String(lim.max)), `формат ${kind}: промпт не называет потолок ${lim.max}`);
    const border = 'x'.repeat(lim.max);
    assert.notEqual(poster.checkPost(border, kind, POST_S).code, 'too_long',
      `формат ${kind}: текст ровно в потолок ${lim.max} признан длинным`);
  }
});

test('перебор по длине помечается кодом, а не только словами', () => {
  const lim = postplan.lenLimits('take', POST_S);
  const v = poster.checkPost('а'.repeat(lim.max + 30), 'take', POST_S);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'too_long');
  assert.equal(v.over, 30);
});

test('гуманизация не может вытолкнуть пост за потолок', () => {
  // Исходник помещается, гуманизированный вариант — нет: откатываем косметику.
  const raw = 'модель и так это делает, если ей просто не мешать лишними инструкциями';
  const humanized = `${raw} (ну, почти) 🙂`;
  const fit = poster.fitToLimit(humanized, raw, raw.length);

  assert.equal(fit.text, raw);
  assert.match(fit.cut, /гуманизация/);
});

test('обрезка укладывается в потолок и не рвёт слово', () => {
  const long = 'Первое предложение про агентов. Второе предложение про промпты и тесты. '
    + 'Третье предложение, которое уже никуда не влезает по длине.';
  const max = 70;
  const fit = poster.fitToLimit(long, long, max);

  assert.ok(fit.text.length <= max, `вышло ${fit.text.length} при потолке ${max}`);
  assert.ok(long.startsWith(fit.text.replace(/[.…]+$/, '').trim().slice(0, 20)));
  assert.equal(humanizer.endsDangling(fit.text), false, `висящее слово: «${fit.text}»`);
});

test('спасённый обрезкой пост проходит проверку', () => {
  const lim = postplan.lenLimits('take', POST_S);
  const long = `${'Мысль про агентов и промпты. '.repeat(20)}Конец.`;
  const fit = poster.fitToLimit(long, long, lim.max);

  assert.ok(fit.text.length <= lim.max);
  assert.ok(fit.text.length >= lim.floor, 'обрезка не должна уводить текст ниже нижней границы');
});

test('в постах опечаток нет, в комментариях есть', () => {
  /*
   * Разное отношение к опечаткам — осознанное решение, а не недосмотр.
   * Комментарий живёт день в чужой ветке, пост остаётся в профиле навсегда.
   * Тест держит обе стороны: пропадут опечатки в комментариях — упадёт,
   * появятся в постах — тоже.
   */
  const text = 'проверяем поведение гуманизатора на достаточно длинном тексте про нейросети и агентов';
  const loud = {
    ...S,
    humanize: { ...S.humanize, enabled: true, typoPerWord: 1, typoMinWordLen: 4, typoMaxPerComment: 5 },
  };

  let commentTypos = 0;
  for (let i = 0; i < 40; i++) {
    if (humanizer.humanize(text, loud).applied.some((a) => /опечат/i.test(a))) commentTypos++;
  }
  assert.ok(commentTypos > 0, 'опечатки пропали и из комментариев');

  // Через ту же функцию, которой пользуется генератор постов, а не через копию
  // её логики: копия проверяла бы сама себя.
  for (let i = 0; i < 40; i++) {
    const r = humanizer.humanize(text, poster.forPost(loud));
    assert.ok(!r.applied.some((a) => /опечат/i.test(a)), 'в посте появилась опечатка');
  }
});

test('строчная в начале не ломает аббревиатуру', () => {
  /*
   * Живой случай: пост начинался со слова «ИИ», и опускание первой буквы дало
   * «иИ». Человек так не печатает никогда — получилась не небрежность, а
   * очевидная поломка, ровно та, ради маскировки которой приём и нужен.
   */
  // Эмодзи выключены: они приписываются в начало и мешают смотреть на регистр.
  const forced = {
    ...S,
    humanize: {
      ...S.humanize,
      enabled: true, lowercaseStart: 1, insertFiller: 0, typoPerWord: 0, addEmoji: 0,
    },
  };

  const abbr = humanizer.humanize('ИИ часто валит код из-за грязного входа', forced);
  assert.ok(!/иИ/.test(abbr.text), `аббревиатура сломана: «${abbr.text.slice(0, 14)}»`);

  const usual = humanizer.humanize('Перестал давать модели весь репозиторий сразу', forced);
  assert.ok(usual.text.startsWith('перестал'), `обычное слово не понизилось: «${usual.text.slice(0, 14)}»`);
});

test('открывающее сообщение ветки без слов-паразитов', () => {
  // «типа, ИИ часто валит код…» — в комментарии уместно, в первой строке
  // разбора сбивает крючок и делает автора несерьёзным.
  const loud = {
    ...S,
    humanize: { ...S.humanize, enabled: true, insertFiller: 1, stretchVowel: 1 },
    style: { ...S.style, fillers: ['типа', 'короче'] },
  };
  const text = 'сначала прошу план и правлю его руками, только потом отдаю на код';

  for (let i = 0; i < 25; i++) {
    const opener = humanizer.humanize(text, poster.forPost(loud, { opener: true }));
    assert.ok(!/^(типа|короче)/i.test(opener.text), `паразит в начале: «${opener.text.slice(0, 20)}»`);
  }

  // Внутри ветки они остаются: там уже идёт живая речь.
  let withFiller = 0;
  for (let i = 0; i < 25; i++) {
    const inner = humanizer.humanize(text, poster.forPost(loud));
    if (/типа|короче/i.test(inner.text)) withFiller++;
  }
  assert.ok(withFiller > 0, 'паразиты пропали и из середины ветки');
});

test('пост сохраняет всю остальную гуманизацию', () => {
  // Отключение опечаток не должно заодно выключить то, ради чего гуманизатор
  // вообще нужен: длинное тире и кавычки-ёлочки — главные маркеры ИИ-текста.
  const forced = {
    ...S,
    humanize: { ...S.humanize, enabled: true, killEmDash: 1, normalizeEllipsis: 1 },
  };
  const r = humanizer.humanize('Модель — это инструмент «для работы»…', poster.forPost(forced));
  assert.ok(!r.text.includes('—'), 'длинное тире осталось');
  assert.ok(!r.text.includes('«'), 'кавычки-ёлочки остались');
  assert.ok(!r.text.includes('…'), 'многоточие осталось');
});

/* ---------------------------- Ветки из нескольких ------------------------- */

test('многочастные форматы объявляют число сообщений', () => {
  const multi = Object.entries(postplan.POST_KINDS)
    .filter(([, k]) => Array.isArray(k.parts) || (k.parts ?? 1) > 1);

  assert.ok(multi.length >= 3, `многочастных форматов всего ${multi.length}`);
  for (const [name, k] of multi) {
    const [lo, hi] = Array.isArray(k.parts) ? k.parts : [k.parts, k.parts];
    assert.ok(lo >= 2, `«${name}»: ветка из ${lo} сообщений — это не ветка`);
    assert.ok(hi <= 5, `«${name}»: ${hi} сообщений слишком много для одной мысли`);
  }
});

test('число частей попадает в объявленный диапазон', () => {
  for (const name of Object.keys(postplan.POST_KINDS)) {
    const k = postplan.POST_KINDS[name];
    const [lo, hi] = Array.isArray(k.parts) ? k.parts : [k.parts ?? 1, k.parts ?? 1];
    for (let i = 0; i < 50; i++) {
      const n = postplan.partsFor(name);
      assert.ok(n >= lo && n <= hi, `«${name}»: выпало ${n} при диапазоне ${lo}-${hi}`);
    }
  }
});

test('вопрос заметен, но профиль не состоит из одних вопросов', () => {
  /*
   * Проверка перевёрнута 01.08, и повод стоит записать здесь же.
   *
   * Прежняя версия требовала вопросу меньше десятой доли веса, опираясь на
   * разведку «×0.69». Та разведка считала сумму реакций по верхушке поиска за
   * всё время, а верхушка наполовину состоит из приманок «напиши слово ПРОМПТ»
   * — две тысячи комментариев без единого вопросительного знака. На такой
   * выборке вопрос обязан был выглядеть проигрышным.
   *
   * Свежий срез — 371 пост из текущей выдачи, 71 русскоязычный моложе трёх
   * суток, метрика «скорость набора» — дал обратное: вопрос в последней строке
   * ×3.1 по среднему и ×1.3 по медиане, доля постов выше медианы 67% против
   * 50% по выборке. Прямая проверка по восьми живым аккаунтам ниши того же
   * размера сходится: у тех, кто спрашивает, медиана отклика 4–9, у тех, кто
   * только утверждает, — ноль. Наш собственный профиль во второй группе.
   *
   * Но верхняя граница остаётся, и по прежней причине: профиль, где вопрос за
   * вопросом, читается навязчиво и не даёт повода подписаться.
   */
  const total = Object.values(postplan.POST_KINDS).reduce((s, k) => s + k.share, 0);
  const q = postplan.POST_KINDS.question.share / total;

  assert.ok(q > 0.12, `вопросу отдано всего ${Math.round(q * 100)}% веса — это самый быстрый формат ниши`);
  assert.ok(q < 0.35, `вопросов ${Math.round(q * 100)}%, профиль превратится в опросник`);

  const other = 1 - q;
  assert.ok(other > 0.6, 'кроме вопросов профилю нужно что-то, ради чего на него подписываются');
});

test('части ветки могут делить тему, но не формулировку', () => {
  /*
   * Части одной ветки обязаны быть про одно — в этом её смысл. Прогонять их
   * через проверку тематической новизны значило бы браковать вторую часть за
   * то, что она продолжает первую.
   */
  const S2 = { ...S, posting: { ...S.posting, minNovelty: 0.55, maxSimilarity: 0.42 } };
  const first = 'вот как я готовлю контекст перед большой задачей в claude code:';
  const second = 'сначала прошу план и правлю его руками, только потом отдаю на код';

  const sameTopic = poster.checkPost(second, 'guide', S2, [], [], [first]);
  assert.equal(sameTopic.ok, true, sameTopic.reason);

  const repeat = poster.checkPost(first, 'guide', S2, [], [], [first]);
  assert.equal(repeat.ok, false);
  assert.match(repeat.reason, /соседн/);
});

test('чистка снимает кавычки и подпись формата', () => {
  assert.equal(poster.cleanPost('«текст поста»'), 'текст поста');
  assert.equal(poster.cleanPost('Пост: вот такой'), 'вот такой');
  assert.equal(poster.cleanPost('раз\n\n\nдва'), 'раз\nдва');
});

/* --------------------------- Новостной источник --------------------------- */

test('адрес чистится от меток кампаний', () => {
  const u = newsfeed.canonicalUrl('https://example.com/a?utm_source=x&id=7#top');
  assert.ok(!u.includes('utm_source'));
  assert.ok(u.includes('id=7'), 'полезный параметр потерялся');
  assert.ok(!u.includes('#top'));
});

test('дедуп схлопывает перефразированные заголовки', () => {
  const items = [
    { title: 'OpenAI выпустила новую модель для агентов', url: 'a', tier: 2, sourceId: 's1' },
    { title: 'OpenAI выпустила новую модель для агентов сегодня', url: 'b', tier: 3, sourceId: 's2' },
    { title: 'Anthropic обновила Claude Code', url: 'c', tier: 1, sourceId: 's3' },
  ];
  const out = newsfeed.dedupe(items);
  assert.equal(out.length, 2, `осталось ${out.length}: ${out.map((i) => i.title)}`);
});

test('дедуп оставляет версию от более авторитетного источника', () => {
  const items = [
    { title: 'Модель X стала быстрее в два раза', url: 'a', tier: 3, sourceId: 'blog' },
    { title: 'Модель X стала быстрее в два раза заметно', url: 'b', tier: 1, sourceId: 'openai' },
  ];
  const out = newsfeed.dedupe(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 1, 'осталась версия от слабого источника');
});

test('разбор RSS достаёт заголовок, ссылку и дату', () => {
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[Claude Code теперь умеет больше]]></title>
      <link>https://example.com/post?utm_source=rss</link>
      <description>Короткое описание того, что произошло на этой неделе</description>
      <pubDate>Sat, 26 Jul 2026 10:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;
  const out = newsfeed.parseFeed(xml, { id: 'x', name: 'X', tier: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Claude Code теперь умеет больше');
  assert.ok(!out[0].url.includes('utm_source'));
  assert.ok(out[0].publishedAt > 0);
});

test('свежая новость от первоисточника обгоняет старую от агрегатора', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  const fresh = newsfeed.scoreItem({
    title: 'Anthropic выпустила MCP-сервер', summary: 'подробное описание того что случилось',
    tier: 1, publishedAt: now - 3600000,
  }, now);
  const old = newsfeed.scoreItem({
    title: 'Обзор недели в мире технологий', summary: 'подробное описание того что случилось',
    tier: 3, publishedAt: now - 40 * 3600000,
  }, now);
  assert.ok(fresh.score > old.score, `${fresh.score} vs ${old.score}`);
});

test('кликбейт штрафуется', () => {
  const now = Date.now();
  const base = { summary: 'описание достаточной длины для проверки', tier: 2, publishedAt: now };
  const normal = newsfeed.scoreItem({ ...base, title: 'Вышла новая версия Claude Code' }, now);
  const bait = newsfeed.scoreItem({ ...base, title: 'Вы не поверите, что случилось с Claude Code' }, now);
  assert.ok(bait.score < normal.score);
});

/* ------------------------------- Пресеты ---------------------------------- */

test('дефолты совпадают с выбранным по умолчанию пресетом', () => {
  /*
   * Смысл в том, чтобы после установки ничего не настраивать. Если дефолты
   * разойдутся с пресетом, который в них же и записан, пользователь получит
   * режим, которого не выбирал, и узнает об этом только по поведению.
   */
  const p = defaults.PRESETS[S.preset];
  assert.ok(p, `пресет «${S.preset}» не существует`);

  for (const block of ['limits', 'timing', 'scoring', 'filters', 'posting', 'safety']) {
    for (const [k, v] of Object.entries(p[block] || {})) {
      assert.equal(S[block][k], v, `${block}.${k}: дефолт ${S[block][k]}, пресет ${v}`);
    }
  }
  assert.equal(S.autopilot, false, 'новая публичная установка должна требовать ручного включения');
  assert.deepEqual(S.niche.sourceWeights, p.niche.sourceWeights);
});

test('публичные пресеты не включают автопилот', () => {
  /*
   * Выбор пресета — это и есть решение «работай сам». Раздельные выключатели
   * давали состояние «режим выбран, а агент молчит», и разбираться, почему
   * ничего не происходит, приходилось в настройках.
   */
  for (const [name, p] of Object.entries(defaults.PRESETS)) {
    assert.equal(p.autopilot, false, `пресет «${name}» сам включил автопилот`);
  }
});

test('пресет оставляет автопилот выключенным при применении', () => {
  const base = JSON.parse(JSON.stringify(S));
  base.autopilot = false;
  for (const name of Object.keys(defaults.PRESETS)) {
    assert.equal(defaults.applyPreset(base, name).autopilot, false, `«${name}» включил автопилот`);
  }
});

test('смена режима сразу меняет дневной лимит', () => {
  /*
   * Пользовательский случай: выбрал «Осторожный» — 8 комментариев, — а внизу
   * по-прежнему стоял лимит прежнего режима. Лимит разыгрывался только со
   * сменой суток, поэтому правка выглядела проигнорированной до полуночи.
   */
  const state = { day: '2026-07-27', dayCount: 0, firstRunDate: '2026-01-01' };

  limiter.resyncDayLimit(defaults.applyPreset(structuredClone(S), 'active'), state);
  const big = state.dayLimit;
  assert.ok(big > 0);

  limiter.resyncDayLimit(defaults.applyPreset(structuredClone(S), 'careful'), state);
  assert.ok(state.dayLimit < big, `после «Осторожного» лимит ${state.dayLimit}, было ${big}`);
});

test('повторное сохранение не переигрывает лимит без причины', () => {
  // Иначе «осталось три комментария» меняется на каждом сохранении настроек и
  // перестаёт что-либо значить.
  const s = defaults.applyPreset(structuredClone(S), 'normal');
  const state = { day: '2026-07-27', dayCount: 0, firstRunDate: '2026-01-01' };

  limiter.resyncDayLimit(s, state);
  const first = state.dayLimit;
  for (let i = 0; i < 10; i++) limiter.resyncDayLimit(s, state);

  assert.equal(state.dayLimit, first, 'лимит переигрался при неизменном режиме');
});

test('пресет накрывает всё, что настраивалось в боевом прогоне', () => {
  /*
   * Перечень собран из того, что дневной прогон выставлял вручную. Смысл теста
   * прост: человек выбирает режим и больше ничего не трогает, поэтому каждая
   * настройка, влиявшая на поведение в прогоне, обязана приходить из пресета.
   *
   * Если сюда добавится новая настройка, а в пресеты нет — тест назовёт её
   * поимённо, а не промолчит.
   */
  const REQUIRED = {
    limits: ['perDay', 'perHour', 'dailyJitter', 'warmupDays', 'warmupStartPerDay',
      'viewsPerComment', 'likesPerComment', 'likeWithoutCommentChance',
      'idleSessionChance', 'abandonAfterOpenChance', 'authorCooldownHours', 'maxPerThread'],
    timing: ['sessionMinActions', 'sessionMaxActions', 'sessionMinMinutes', 'sessionMaxMinutes',
      'inSessionMeanSec', 'inSessionMinSec', 'inSessionMaxSec',
      'breakMeanMinutes', 'breakMinMinutes', 'breakMaxMinutes'],
    scoring: ['minScore', 'minRelevance', 'minThreadTopic', 'maxBatchesPerScan'],
    filters: ['maxAgeHours', 'skipCold', 'hotOnly', 'skipMedia'],
    posting: ['enabled', 'perDay', 'intervalHours', 'windowFromHour', 'windowToHour',
      'jitterMin', 'maxSimilarity', 'minNovelty'],
    safety: ['technicalStreakLimit', 'breakerThreshold', 'shadowFailThreshold',
      'onShadowFailPauseHours', 'onBlockPauseHours', 'recheckEnabled', 'vanishedLimit',
      'similarityThreshold', 'maxRegen'],
  };

  for (const [name, p] of Object.entries(defaults.PRESETS)) {
    for (const [block, keys] of Object.entries(REQUIRED)) {
      const missing = keys.filter((k) => p[block]?.[k] === undefined);
      assert.deepEqual(missing, [], `«${name}» не задаёт ${block}: ${missing.join(', ')}`);
    }
  }
});

test('защиты есть в каждом пресете, различается только терпение', () => {
  // Ни один режим не имеет права остаться без предохранителей: «Активный»
  // терпит больше единичных сбоев, но останавливается на тех же признаках.
  for (const [name, p] of Object.entries(defaults.PRESETS)) {
    assert.ok(p.safety.technicalStreakLimit > 0, `«${name}»: нет предела техсбоев`);
    assert.ok(p.safety.breakerThreshold > 0, `«${name}»: выключен предохранитель`);
    assert.ok(p.safety.shadowFailThreshold > 0, `«${name}»: нет защиты от теневого бана`);
    assert.equal(p.safety.recheckEnabled, true, `«${name}»: выключена перепроверка ответов`);
    assert.ok(p.safety.vanishedLimit > 0, `«${name}»: нет предела пропаж`);
    // Сутки — нижняя граница, а не точное значение: осторожный режим ждёт
    // дольше намеренно. Ограничение платформы — не повод возвращаться завтра
    // к прежнему темпу, и в режиме для возвращения после бана это тем вернее.
    assert.ok(p.safety.onBlockPauseHours >= 24, `«${name}»: пауза после блокировки короче суток`);
  }

  const { careful, normal, active } = defaults.PRESETS;
  assert.ok(careful.safety.technicalStreakLimit <= normal.safety.technicalStreakLimit);
  assert.ok(normal.safety.technicalStreakLimit <= active.safety.technicalStreakLimit);
  assert.ok(careful.safety.onBlockPauseHours >= normal.safety.onBlockPauseHours,
    'осторожный режим не может ждать после блокировки меньше обычного');
});

test('пресет применяется целиком, а не только таймингами', () => {
  // Раньше пресет накрывал два блока из пяти, и «Осторожный» отличался от
  // «Активного» только частотой при одинаково мягком отборе.
  const base = JSON.parse(JSON.stringify(S));
  const out = defaults.applyPreset(base, 'careful');

  assert.equal(out.preset, 'careful');
  assert.equal(out.limits.perDay, defaults.PRESETS.careful.limits.perDay);
  assert.equal(out.scoring.minScore, defaults.PRESETS.careful.scoring.minScore);
  assert.equal(out.filters.maxAgeHours, defaults.PRESETS.careful.filters.maxAgeHours);
  assert.equal(out.posting.perDay, defaults.PRESETS.careful.posting.perDay);

  // Ключи, которых в пресете нет, не должны теряться.
  assert.equal(out.scoring.topK, S.scoring.topK, 'пресет затёр соседнюю настройку');
  assert.equal(out.posting.sourceUrl, S.posting.sourceUrl);
});

test('пресеты упорядочены по осторожности', () => {
  const { careful, normal, active } = defaults.PRESETS;

  // Чем активнее режим, тем больше пишем.
  assert.ok(careful.limits.perDay < normal.limits.perDay);
  assert.ok(normal.limits.perDay < active.limits.perDay);
  assert.ok(careful.posting.perDay < normal.posting.perDay);
  assert.ok(normal.posting.perDay < active.posting.perDay);

  // И тем мягче отбор — иначе поднятый лимит недостижим: живой прогон упирался
  // не в лимит, а в число подходящих постов.
  assert.ok(careful.scoring.minScore > normal.scoring.minScore);
  assert.ok(normal.scoring.minScore > active.scoring.minScore);
  assert.ok(careful.filters.maxAgeHours < normal.filters.maxAgeHours);
  assert.ok(normal.filters.maxAgeHours < active.filters.maxAgeHours);

  // Перерывы, наоборот, короче.
  assert.ok(careful.timing.breakMeanMinutes > normal.timing.breakMeanMinutes);
  assert.ok(normal.timing.breakMeanMinutes > active.timing.breakMeanMinutes);
});

test('интерфейсы показывают режимы в порядке фактической нагрузки', async () => {
  const order = ['careful', 'normal', 'boost', 'active'];
  const comments = order.map((name) => defaults.PRESETS[name].limits.perDay);
  const posts = order.map((name) => defaults.PRESETS[name].posting.perDay);

  assert.deepEqual(comments, [...comments].sort((a, b) => a - b), 'лимиты комментариев идут не по возрастанию');
  assert.deepEqual(posts, [...posts].sort((a, b) => a - b), 'лимиты постов идут не по возрастанию');
  assert.equal(new Set(order.map((name) => defaults.PRESETS[name].label)).size, order.length,
    'у режимов должны быть разные названия');

  for (const file of ['ui/options.js', 'ui/popup.js']) {
    const source = await readFile(join(EXT, file), 'utf8');
    assert.match(source, /PRESET_ORDER\s*=\s*\['careful', 'normal', 'boost', 'active'\]/,
      `${file} показывает режимы не в порядке нагрузки`);
  }
});

test('popup не расширяет окно основной кнопкой', async () => {
  const css = await readFile(join(EXT, 'ui', 'popup.css'), 'utf8');
  const startRules = [...css.matchAll(/\.bigStart\s*\{([^}]+)\}/g)].map((m) => m[1]).join('\n');

  assert.doesNotMatch(startRules, /(?<!-)width:\s*100%/, 'кнопка старта снова прибавит к ширине padding окна');
  assert.match(startRules, /(?<!-)width:\s*auto/, 'кнопка старта не растягивается grid-контейнером');
  assert.match(startRules, /justify-self:\s*stretch/, 'кнопка должна занять доступную, а не фиксированную ширину');
  assert.match(css, /body\s*\{[^}]*max-width:\s*100vw[^}]*overflow-x:\s*hidden/s,
    'popup не защищён от горизонтального переполнения');
});

test('каждый пресет задаёт все пять блоков', () => {
  for (const [name, p] of Object.entries(defaults.PRESETS)) {
    for (const block of ['limits', 'timing', 'scoring', 'filters', 'posting']) {
      assert.ok(p[block], `в пресете «${name}» нет блока ${block}`);
    }
    assert.ok(p.label && p.hint, `у пресета «${name}» нет подписи`);
  }
});

test('во всех пресетах путь до первого комментария короче сессии', () => {
  // Иначе комментарий внутри сессии практически невозможен, и ошибка молчит:
  // агент открывает сессию, листает ленту, уходит на перерыв, в журнале пусто.
  for (const [name, p] of Object.entries(defaults.PRESETS)) {
    const cfg = defaults.applyPreset(JSON.parse(JSON.stringify(S)), name);
    const est = scheduler.estimateDailyActions(cfg);
    assert.ok(
      est.minutesToFirstComment <= cfg.timing.sessionMaxMinutes,
      `«${name}»: до комментария ${est.minutesToFirstComment} мин при сессии до ${cfg.timing.sessionMaxMinutes}`,
    );
  }
});

test('сброс счётчиков не стирает память о сделанном', async () => {
  /*
   * Живой случай: перезапуск обнулил отработанные слоты и использованные
   * новости, и агент через двенадцать минут начал писать почти такой же пост
   * про тот же релиз. Кнопка называется «Сбросить счётчики» — счётчики можно,
   * память о сделанном нельзя.
   *
   * Тест читает список исключений прямо из кода: иначе он проверял бы
   * собственную копию списка, а не настоящую.
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(EXT, 'common', 'storage.js'), 'utf8');

  const block = /const KEEP_ON_RESET\s*=\s*\[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'список KEEP_ON_RESET не найден — разбор сломался');

  const keep = new Set([...block[1].matchAll(/'(\w+)'/g)].map((m) => m[1]));
  assert.ok(keep.size >= 8, `в списке подозрительно мало полей: ${keep.size}`);

  // Реестры, потеря которых даёт повтор уже сделанного.
  for (const field of ['seenPosts', 'postedNews', 'postedSlots', 'recentPosts', 'published']) {
    assert.ok(keep.has(field), `${field} стирается при сбросе — будет повтор`);
  }

  // Счётчики, наоборот, обязаны обнуляться: иначе сброс ничего не сбрасывает.
  for (const counter of ['dayCount', 'dayLikes', 'dayPosts', 'vanished']) {
    assert.ok(!keep.has(counter), `${counter} переживает сброс, хотя это счётчик`);
  }
});

/* ------------------------ Выживаемость ответов ---------------------------- */

test('свежий ответ на перепроверку не берётся', () => {
  // Он и так подтверждён при отправке; исчезает позже.
  const now = 1_000_000_000;
  const st = {
    published: [{ url: 'a', needle: 'текст', at: now - 5 * 60000, checkedAt: null }],
    lastRecheckAt: 0,
  };
  assert.equal(survival.pickForRecheck(st, S, now), null);
});

test('отлежавшийся ответ берётся на перепроверку', () => {
  const now = 1_000_000_000;
  const old = now - (S.safety.recheckAfterMin + 10) * 60000;
  const st = { published: [{ url: 'a', needle: 'текст', at: old, checkedAt: null }], lastRecheckAt: 0 };

  const pick = survival.pickForRecheck(st, S, now);
  assert.ok(pick, 'ответ не выбран');
  assert.equal(pick.url, 'a');
});

test('перепроверки не идут чаще заданной паузы', () => {
  const now = 1_000_000_000;
  const old = now - (S.safety.recheckAfterMin + 10) * 60000;
  const st = {
    published: [{ url: 'a', needle: 'текст', at: old, checkedAt: null }],
    lastRecheckAt: now - 5 * 60000,
  };
  assert.equal(survival.pickForRecheck(st, S, now), null);
});

test('проверенный ответ повторно не берётся', () => {
  const now = 1_000_000_000;
  const old = now - (S.safety.recheckAfterMin + 10) * 60000;
  const st = {
    published: [{ url: 'a', needle: 'т', at: old, checkedAt: now - 1000, alive: true }],
    lastRecheckAt: 0,
  };
  assert.equal(survival.pickForRecheck(st, S, now), null);
});

test('живой ответ обнуляет серию пропаж', () => {
  let st = { published: [{ url: 'a' }, { url: 'b' }], vanished: 2 };
  st = survival.recordRecheck(st, 'a', false);
  assert.equal(st.vanished, 3);
  st = survival.recordRecheck(st, 'b', true);
  assert.equal(st.vanished, 0, 'серия не прервалась живым ответом');
});

test('одна пропажа не останавливает агента', () => {
  // Автор вправе удалить любой комментарий: единичный случай к нам может не
  // иметь отношения вовсе. Значение имеет только серия.
  let st = { published: [{ url: 'a' }], vanished: 0 };
  st = survival.recordRecheck(st, 'a', false);
  assert.equal(survival.shouldHalt(st, S), false);
});

test('серия пропаж подряд останавливает агента', () => {
  let st = { published: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], vanished: 0 };
  for (const u of ['a', 'b', 'c']) st = survival.recordRecheck(st, u, false);
  assert.equal(st.vanished, S.safety.vanishedLimit);
  assert.equal(survival.shouldHalt(st, S), true);
});

test('перепроверяем самый свежий из подошедших, а не самый старый', () => {
  /*
   * Замер 04.08 на боевом сервере: под наблюдением сорок ответов, проверен
   * один — опубликованный за сорок один час до проверки, при замысле «через
   * сорок минут». Причина в порядке выбора: очередь непроверенных не
   * опустошается никогда (публикуем 28–45 в сутки, проверить успеваем не
   * больше двадцати), а брали из неё всегда самый старый — то есть край.
   */
  const now = Date.now();
  const M = 60000;
  const st = {
    lastRecheckAt: 0,
    published: [
      { url: 'старый',  at: now - 200 * M, checkedAt: null },
      { url: 'средний', at: now - 120 * M, checkedAt: null },
      { url: 'свежий',  at: now - 60 * M,  checkedAt: null },
      { url: 'рано',    at: now - 10 * M,  checkedAt: null },
    ],
  };

  const pick = survival.pickForRecheck(st, S, now);
  assert.ok(pick, 'ни один ответ не подошёл');
  assert.equal(pick.url, 'свежий', 'взят не самый свежий из отлежавшихся');
});

test('слишком старый ответ не проверяется вовсе', () => {
  // Пропажа через сутки не доказывает ничего: автор мог удалить, ветку снять.
  const now = Date.now();
  const M = 60000;
  const st = {
    lastRecheckAt: 0,
    published: [{ url: 'вчерашний', at: now - 26 * 60 * M, checkedAt: null }],
  };
  assert.equal(survival.pickForRecheck(st, S, now), null);
});

test('просроченные закрываются и не числятся ждущими', () => {
  const now = Date.now();
  const M = 60000;
  const st = {
    published: [
      { url: 'вчерашний', at: now - 26 * 60 * M, checkedAt: null },
      { url: 'свежий',    at: now - 60 * M,      checkedAt: null },
    ],
  };

  assert.equal(survival.staleCount(st, S, now), 1);
  assert.equal(survival.expireStale(st, S, now), 1);

  const old = st.published.find((p) => p.url === 'вчерашний');
  assert.ok(old.checkedAt, 'просроченный так и остался ждущим');
  assert.equal(old.alive, null, 'просроченный не должен числиться ни живым, ни пропавшим');
  assert.equal(old.expired, true);

  // Свежего это не касается, и повторный проход ничего не находит.
  assert.equal(st.published.find((p) => p.url === 'свежий').checkedAt, null);
  assert.equal(survival.staleCount(st, S, now), 0);

  // Серию просроченные не двигают: это не пропажи.
  const stats = survival.survivalStats(st);
  assert.equal(stats.vanished, 0);
  assert.equal(stats.unknown, 1);
});

test('«не смогли посмотреть» не считается пропажей', () => {
  // Живой случай 03.08: под постом с полусотней ответов Threads показывает
  // десяток, нашего среди них не оказалось — и агент записал это в пропажу.
  // Три такие «пропажи» подряд остановили его на четырнадцать часов.
  let st = { published: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], vanished: 0 };
  for (const u of ['a', 'b', 'c']) st = survival.recordRecheck(st, u, null);

  assert.equal(st.vanished, 0, 'серия выросла на непроверенных');
  assert.equal(survival.shouldHalt(st, S), false);
  assert.equal(st.published[0].alive, null, 'исход должен остаться неизвестным');
  assert.ok(st.published[0].checkedAt, 'заход был, и он должен быть отмечен');
});

test('непроверенный ответ не рвёт серию и не числится пропавшим', () => {
  let st = { published: [{ url: 'a' }, { url: 'b' }], vanished: 2 };
  st = survival.recordRecheck(st, 'a', null);
  assert.equal(st.vanished, 2, 'серия не должна обнуляться от неизвестного исхода');

  const stats = survival.survivalStats(st);
  assert.equal(stats.vanished, 0, 'в пропавшие попал тот, кого не смотрели');
  assert.equal(stats.unknown, 1);

  // А настоящий живой ответ серию по-прежнему рвёт.
  st = survival.recordRecheck(st, 'b', true);
  assert.equal(st.vanished, 0);
});

test('карта страниц узнаёт все места, где агент бывает', async () => {
  const pages = await load('common/pages.js');
  const cases = [
    ['https://www.threads.com/', 'feed'],
    ['https://www.threads.com/for-you', 'feed'],
    ['https://www.threads.com/following', 'feed'],
    ['https://www.threads.com/search?q=claude&serp_type=default', 'search'],
    ['https://www.threads.com/@example_user', 'profile'],
    ['https://www.threads.com/@example_user/', 'profile'],
    ['https://www.threads.com/@example_user/replies', 'profile_replies'],
    ['https://www.threads.com/activity', 'activity'],
    ['https://www.threads.com/activity/replies', 'activity'],
    ['https://www.threads.com/@example_user/post/ExamplePost', 'post'],
    ['https://www.threads.com/settings/account', 'other'],
  ];

  for (const [url, want] of cases) {
    assert.equal(pages.pageKindOf(url), want, `${url} опознан неверно`);
  }

  // Путь без домена — тот же ответ: страница спрашивает про свой location.
  assert.equal(pages.pageKindOf('/@example_user/post/X'), 'post');
  assert.equal(pages.pageKindOf('/search?q=%D0%B0'), 'search');
  assert.equal(pages.pageKindOf(''), 'feed');
});

test('страница поста опознаётся постом, а не профилем', () => {
  // Порядок образцов значим: адрес поста подходит и под профиль тоже.
  // Перепутать значит отправить агента листать «бесконечную» ветку.
  const idx = (kind) => PAGES.ROUTES.findIndex(([, k]) => k === kind);
  assert.ok(idx('post') < idx('profile'), 'пост обязан проверяться раньше профиля');
  assert.ok(idx('profile_replies') < idx('profile'), 'ответы профиля — раньше самого профиля');
});

test('бесконечны только лента и поиск', () => {
  /*
   * 04.08 агент семнадцать минут листал одну ветку: страницы поста и профиля
   * конечны, а обходились как лента. Список должен оставаться коротким.
   */
  assert.deepEqual([...PAGES.ENDLESS].sort(), ['feed', 'search']);
  for (const finite of ['post', 'profile', 'profile_replies', 'activity', 'other']) {
    assert.equal(PAGES.ENDLESS.has(finite), false, `«${finite}» посчитали бесконечной`);
  }
});

test('у каждого вида страницы есть человеческое название', () => {
  // Названия уезжают в журнал: «остались в undefined» никому не поможет.
  for (const kind of Object.values(PAGES.PAGE)) {
    assert.ok(PAGES.PAGE_LABEL[kind], `нет названия для «${kind}»`);
  }
});

test('адрес известен для тех мест, куда агент ходит сам', () => {
  for (const kind of ['feed', 'activity']) {
    assert.ok(/^https:\/\/www\.threads\.com\//.test(PAGES.PAGE_URL[kind] || ''),
      `некуда идти за «${kind}»`);
  }
});

test('серия, пережившая свою остановку, начинается заново', () => {
  /*
   * 04.08: неисправную остановку сняли, а счётчик пропаж остался равен пределу.
   * Агент вернулся к работе на волосок от следующей остановки — первая же
   * пропажа снова уложила бы его на несколько часов, без новой серии.
   */
  const st = { halt: null, vanished: S.safety.vanishedLimit, consecutiveShadowFails: 2 };
  assert.equal(survival.shouldHalt(st, S), true, 'подготовка теста бессмысленна');

  assert.equal(survival.releaseSpentStreak(st, S), true);
  assert.equal(st.vanished, 0);
  assert.equal(st.consecutiveShadowFails, 0);
  assert.equal(survival.shouldHalt(st, S), false);
});

test('пока остановка действует, серия не сбрасывается', () => {
  // Иначе пауза снималась бы сама собой, не дождавшись срока.
  const st = { halt: { reason: 'shadow_ban', until: Date.now() + 3600000 }, vanished: S.safety.vanishedLimit };
  assert.equal(survival.releaseSpentStreak(st, S), false);
  assert.equal(st.vanished, S.safety.vanishedLimit);
});

test('недобравшую серию никто не трогает', () => {
  const st = { halt: null, vanished: 1 };
  assert.equal(survival.releaseSpentStreak(st, S), false);
  assert.equal(st.vanished, 1);
});

test('остановка с истёкшим сроком снимается', () => {
  const st = limiter.halt({}, 'shadow_ban', 'проверка', 1000);
  limiter.refreshHalt(st, 999);
  assert.ok(st.halt, 'сняли раньше срока');
  limiter.refreshHalt(st, 1000);
  assert.equal(st.halt, null);
});

test('бессрочная остановка с известной причиной держится', () => {
  // Проверка аккаунта снимается только человеком — и так и должно быть.
  const st = limiter.halt({}, 'challenge', 'нужна проверка', 0);
  limiter.refreshHalt(st, Date.now() + 30 * 86400000);
  assert.ok(st.halt, 'бессрочную остановку по делу снимать нельзя');
});

test('остановка с причиной не из перечня снимается', () => {
  /*
   * Ровно то, что случилось 03.08: `HALT.SHADOW` вместо `HALT.SHADOW_BAN` дало
   * `reason: undefined`. Показать нечем, сопоставить не с чем, срока нет —
   * снять могла только рука. Такая остановка означает ошибку в коде, а не
   * запрет работать.
   */
  const st = { halt: { detail: 'ответы исчезают из веток', at: 1, until: 0 } };
  limiter.refreshHalt(st, 2);
  assert.equal(st.halt, null);

  const bogus = { halt: { reason: 'shadow', detail: '', at: 1, until: 0 } };
  limiter.refreshHalt(bogus, 2);
  assert.equal(bogus.halt, null, 'похожее, но не существующее имя — тоже ошибка');
});

test('у каждой причины остановки есть человеческая подпись', async () => {
  // Иначе в плашке и в попапе окажется машинный код, а то и `undefined`.
  const msgs = await load('common/messages.js');
  for (const reason of Object.values(msgs.HALT)) {
    assert.ok(msgs.HALT_LABEL[reason], `нет подписи для «${reason}»`);
  }
});

test('наблюдение не растёт бесконечно', () => {
  let st = {};
  for (let i = 0; i < 80; i++) {
    st = survival.recordPublished(st, { url: `u${i}`, text: `ответ номер ${i}` }, 1000 + i);
  }
  assert.ok(st.published.length <= 40, `под наблюдением ${st.published.length}`);
  // Остаются свежие, а не первые попавшиеся.
  assert.equal(st.published[st.published.length - 1].url, 'u79');
});

test('повторная публикация по тому же адресу не плодит записей', () => {
  let st = {};
  st = survival.recordPublished(st, { url: 'a', text: 'первый' }, 1000);
  st = survival.recordPublished(st, { url: 'a', text: 'второй' }, 2000);
  assert.equal(st.published.length, 1);
  assert.equal(st.published[0].needle, 'второй');
});

test('протокол сообщений одинаков в фоне и в content-скриптах', async () => {
  /*
   * Типы сообщений живут в двух местах: `common/messages.js` для фона и
   * `TA.MSG` в `content/lib/util.js` для классических скриптов, куда модуль не
   * импортируется. Расхождение между копиями не ловится ничем: команда просто
   * не совпадает ни с одной веткой `switch` и исчезает без следа.
   *
   * Так и вышло с `CMD_POST` — добавили в общий список, забыли в копию, и
   * публикация тихо не происходила: ни отчёта, ни ошибки, агент шёл дальше.
   */
  const { readFileSync } = await import('node:fs');
  const messages = await load('common/messages.js');

  const utilSrc = readFileSync(join(EXT, 'content', 'lib', 'util.js'), 'utf8');
  const block = /TA\.MSG\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(utilSrc);
  assert.ok(block, 'не нашёлся объект TA.MSG — разбор сломался');

  const contentMsg = {};
  for (const line of block[1].split('\n')) {
    const m = /^\s*(\w+)\s*:\s*['"]([^'"]+)['"]/.exec(line);
    if (m) contentMsg[m[1]] = m[2];
  }
  assert.ok(Object.keys(contentMsg).length > 8, 'разобрано подозрительно мало сообщений');

  // Все команды из общего списка обязаны быть в копии: их исполняет content.
  const missing = Object.keys(messages.MSG)
    .filter((k) => k.startsWith('CMD_'))
    .filter((k) => !(k in contentMsg));
  assert.deepEqual(missing, [], `в TA.MSG нет команд: ${missing.join(', ')}`);

  // Совпадающие ключи обязаны иметь одинаковые значения.
  for (const [k, v] of Object.entries(contentMsg)) {
    if (k in messages.MSG) {
      assert.equal(v, messages.MSG[k], `значение ${k} разошлось: «${v}» против «${messages.MSG[k]}»`);
    }
  }
});

test('в прайсе есть все модели по умолчанию', () => {
  for (const m of [S.ai.modelScore, S.ai.modelWrite, S.ai.modelStyle]) {
    assert.ok(defaults.PRICING[m], `нет цены для модели ${m}`);
  }
});

test('модели 5.6 не получают параметров, которых не принимают', () => {
  const noSampling = defaults.traitsOf('gpt-5.6-luna');
  assert.equal(noSampling.sampling, false, 'linейке 5.6 нельзя слать temperature/top_p/штрафы');
  assert.equal(noSampling.reasoning, true, 'у 5.6 есть размышление, его нужно гасить явно');

  const classic = defaults.traitsOf('gpt-5.4-mini');
  assert.equal(classic.sampling, true);
  assert.equal(classic.reasoning, false);

  // Модель новее нашего кода считается такой же, как вся линейка 5.6:
  // ошибиться в эту сторону дешевле, чем получить 400 на каждом запросе.
  assert.equal(defaults.traitsOf('gpt-5.7-nova').sampling, false);
  assert.equal(defaults.traitsOf('gpt-4o-mini').sampling, true);
});

test('лишние вопросы срезаются, но не в ущерб длине', () => {
  const two = 'А как ты задавал метрики успеха и что считалось вредит/помогает? '
    + 'Какая была выборка, чтобы отделить плацебо от регресса к среднему?';
  const cut = safety.trimExtraQuestions(two, 25);
  assert.equal((cut.match(/\?/g) || []).length, 1, 'должен остаться один вопрос');
  assert.ok(cut.length >= 25, 'обрезка не должна уводить ниже минимума');

  // Один вопрос не трогаем вовсе.
  const one = 'А как ты мерил эффект, чтобы не было шума от разных задач?';
  assert.equal(safety.trimExtraQuestions(one, 25), one);

  // Утверждение после вопроса — опора, ради которой вопрос и задан.
  const withTail = 'А метрики кроме help/hurt учитывал? Интересно, сколько было прогонов.';
  assert.ok(safety.trimExtraQuestions(withTail, 25).includes('Интересно'));

  // Если после обрезки останется огрызок, лучше оставить два вопроса.
  const tiny = 'Как? И зачем?';
  assert.equal(safety.trimExtraQuestions(tiny, 25), tiny);
});

test('сторож берёт на учёт вкладку, от которой пульса не было вовсе', async () => {
  /*
   * `beats` живёт в памяти service worker и обнуляется вместе с ним. Если
   * content script в открытой вкладке мёртв, пульса не будет никогда, и до
   * правки сторож обходил пустую карту: агент простоял полчаса после
   * обновления расширения 31.07 именно так.
   */
  const reloaded = [];
  const settings = {
    ...defaults.DEFAULTS,
    enabled: true,
    safety: { ...defaults.DEFAULTS.safety, watchdogEnabled: true },
  };

  globalThis.chrome = {
    runtime: { getManifest: () => ({ content_scripts: [{ matches: ['https://www.threads.com/*'] }] }) },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.threads.com/' }],
      get: async (id) => (id === 7 ? { id: 7, url: 'https://www.threads.com/' } : null),
      reload: async (id) => { reloaded.push(id); },
    },
    storage: {
      local: {
        get: async (k) => (k === 'settings' ? { settings } : { log: [] }),
        set: async () => {},
      },
    },
    alarms: { create: async () => {}, clear: async () => {} },
  };

  const watchdog = await load('bg/watchdog.js');

  // Первый обход только заводит отметку — перезагружать нечего.
  await watchdog.checkPulse();
  assert.deepEqual(reloaded, [], 'свежая вкладка не должна перезагружаться');

  // Спустя порог тишины вкладка без единого пульса считается зависшей.
  const realNow = Date.now;
  Date.now = () => realNow() + 9 * 60000;
  try {
    await watchdog.checkPulse();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(reloaded, [7], 'молчащая вкладка обязана быть перезагружена');

  watchdog.forgetTab(7);
  delete globalThis.chrome;
});

/* ------------------------------------------------------------------ *
 * Распознавание тем
 *
 * Проверяется не «нашлась ли тема», а свойства, ради которых модуль устроен
 * именно так: что всплеск отличает разгорающееся от постоянно большого, что
 * повторная встреча даёт настоящую скорость, и что один автор темой не
 * считается. Каждое из этих свойств легко потерять правкой, которая выглядит
 * безобидно.
 * ------------------------------------------------------------------ */

const TRENDS_SETTINGS = {
  trends: {
    enabled: true, windowHours: 48, hotHours: 8,
    minObservations: 4, minPostsPerTrend: 2, minAuthors: 2, topN: 12,
  },
  niche: { searchQueries: ['нейросети'] },
};

/** Пост, каким его отдаёт разбор ленты. */
const obsPost = (id, author, text, likes, replies, ageMinutes) => ({
  id, authorHandle: author, text, likes, replies, reposts: 0, ageMinutes, url: `u/${id}`,
});

test('termsOf: берёт и слова, и пары, и выбрасывает служебное', () => {
  const t = trends.termsOf('В Claude Code сломался контекст, и это уже не смешно');
  assert.ok(t.includes('claude'), 'одиночное слово');
  assert.ok(t.includes('claude code'), 'пара соседних слов');
  assert.ok(!t.includes('и'), 'союз не может быть темой');
  assert.ok(!t.includes('это'), 'местоимение не может быть темой');
});

test('подписи самого Threads темой не становятся', () => {
  /*
   * Поймано в бою 01.08. Разбор карточки прихватывает кнопки платформы вместе
   * с текстом: у иноязычного поста в тело попадает «Перевести»/«Translate».
   * Слово встречается у множества авторов сразу, легко берёт все пороги, и
   * «translate» действительно дошло до поисковых фраз агента — оно нашлось в
   * его же `queryStats` на боевом сервере.
   */
  const t = trends.termsOf('Кто-то завайбкодил замену Duolingo и попал в YC Translate Ещё');
  for (const junk of ['translate', 'ещё', 'еще']) {
    assert.ok(!t.includes(junk), `подпись Threads «${junk}» принята за тему`);
  }
  assert.ok(t.includes('duolingo'), 'вместе с мусором выброшено содержание');
});

test('termsOf: короткая латиница остаётся, короткая кириллица нет', () => {
  const t = trends.termsOf('mcp и его api дают рост');
  assert.ok(t.includes('mcp'), 'mcp — название, а не мусор');
  assert.ok(t.includes('api'), 'api тоже');
  assert.ok(!t.includes('его'), 'трёхбуквенное русское служебное выброшено');
});

test('observe: повторная встреча не дублирует запись, а даёт прирост', () => {
  const s = { observations: [] };
  const t0 = 1_000_000_000_000;

  trends.observe(s, [obsPost('a', 'u1', 'разбор mcp сервера', 10, 2, 60)], TRENDS_SETTINGS, t0);
  assert.equal(s.observations.length, 1);
  assert.equal(s.observations[0].firstScore, 16);

  trends.observe(s, [obsPost('a', 'u1', 'разбор mcp сервера', 40, 6, 120)], TRENDS_SETTINGS,
    t0 + 60 * 60000);

  assert.equal(s.observations.length, 1, 'дубля быть не должно');
  assert.equal(s.observations[0].firstScore, 16, 'первый снимок неприкосновенен');
  assert.equal(s.observations[0].lastScore, 58, 'последний обновлён');

  // 58 − 16 = 42 очка за час: измерение, а не оценка по возрасту.
  const v = trends.velocityOf(s.observations[0], t0 + 60 * 60000);
  assert.ok(Math.abs(v - 42) < 0.5, `скорость по приросту, получено ${v}`);
});

test('observe: упавший счётчик не принимается за прирост', () => {
  const s = { observations: [] };
  const t0 = 1_000_000_000_000;
  trends.observe(s, [obsPost('a', 'u1', 'текст про нейросети', 50, 10, 60)], TRENDS_SETTINGS, t0);
  trends.observe(s, [obsPost('a', 'u1', 'текст про нейросети', 0, 0, 90)], TRENDS_SETTINGS,
    t0 + 40 * 60000);
  assert.equal(s.observations[0].lastScore, 80, 'нечитаемый счётчик не должен обнулять историю');
});

test('detectTrends: разгорающаяся тема обгоняет постоянно большую', () => {
  const now = 2_000_000_000_000;
  const s = { observations: [] };

  /*
   * «нейросети» — фон ниши: много постов и вчера, и сегодня, доля не выросла.
   * «протокол шума» — новое: вчера ни одного, сегодня три автора.
   * По сумме реакций фон впереди, по всплеску — новое. Побеждать должно новое,
   * иначе агент будет вечно писать про нейросети вообще.
   */
  const old = [];
  for (let i = 0; i < 8; i++) {
    old.push(obsPost(`o${i}`, `oldman${i}`, 'нейросети меняют работу целиком', 60, 12, 30 * 60));
  }
  trends.observe(s, old, TRENDS_SETTINGS, now - 30 * 3600000);

  const fresh = [];
  for (let i = 0; i < 4; i++) {
    fresh.push(obsPost(`n${i}`, `newman${i}`, 'нейросети и протокол шума ломают контекст', 20, 6, 60));
  }
  trends.observe(s, fresh, TRENDS_SETTINGS, now);

  const found = trends.dedupeTrends(trends.detectTrends(s, TRENDS_SETTINGS, now));
  assert.ok(found.length, 'хоть одна тема обязана найтись');

  const names = found.map((t) => t.term);
  const iNew = names.findIndex((t) => t.includes('протокол'));
  const iOld = names.findIndex((t) => t === 'нейросети');
  assert.ok(iNew >= 0, `новая тема должна быть в списке, есть: ${names.slice(0, 6)}`);
  assert.ok(iOld < 0 || iNew < iOld, 'разгорающаяся тема обязана стоять выше фоновой');
});

test('общее слово языка темой не становится, даже если разгорелось', () => {
  /*
   * Боевой случай 02.08. Верхушку трендов заняли «сначала» (×9 всплеск),
   * «автор», «одного», «людей»: обычные русские слова, прошедшие и стоп-лист,
   * и порог в три автора. Из них вышел пост «Threads разгоняет тему
   * "сначала"», а следом они уехали в поисковые фразы — агент искал цели для
   * комментариев по слову «сначала» и приносил ленту не по теме.
   *
   * Проверяется не список слов, а правило: тема обязана быть про нишу.
   */
  const s = { niche: { includeKeywords: ['промпт', 'нейросет', 'chatgpt', 'claude', 'контекст', 'seedance', 'вайбкод', 'агент'] } };

  for (const junk of ['сначала', 'автор', 'одного', 'людей', 'каждый', 'дальше']) {
    assert.equal(trends.nicheRelevant(junk, s), false, `«${junk}» не должно быть темой`);
  }

  for (const real of ['промптов', 'нейросеть', 'chatgpt', 'claude', 'claude code',
    'контекстное окно', 'seedance 2', 'вайбкодинг', 'агентов']) {
    assert.equal(trends.nicheRelevant(real, s), true, `«${real}» — настоящая тема ниши`);
  }

  // Пара слов проходит по нишевому слову, а не по любому.
  assert.equal(trends.nicheRelevant('сначала промпт', s), true);
  assert.equal(trends.nicheRelevant('сначала автор', s), false);

  // Без списка корней проверка обязана пропускать: данных нет — запрета нет.
  assert.equal(trends.nicheRelevant('что угодно', { niche: {} }), true);
});

test('detectTrends: один автор темой не считается', () => {
  const now = 2_000_000_000_000;
  const s = { observations: [] };
  const solo = [];
  for (let i = 0; i < 6; i++) {
    solo.push(obsPost(`s${i}`, 'oneguy', 'мой личный маршрут через квазары', 30, 8, 60));
  }
  trends.observe(s, solo, TRENDS_SETTINGS, now);

  const found = trends.detectTrends(s, TRENDS_SETTINGS, now);
  assert.ok(!found.some((t) => t.term.includes('квазар')),
    'шесть постов одного автора — это автор, а не тема');
});

test('словосочетание и имя продукта весят больше общего слова', () => {
  /*
   * Первые боевые тренды были «модель», «тредс», «проекты» — формально верно,
   * а повода в них нет: пост «в ленте обсуждают модель» не сообщает ничего.
   * Владелец попросил темы поинтереснее, и различает их специфичность.
   */
  assert.ok(trends.specificity('claude code') > trends.specificity('claude'),
    'пара слов должна быть весомее одиночного');
  assert.ok(trends.specificity('контекстное окно') > trends.specificity('окно'),
    'пара называет предмет, одиночное слово — только область');
  assert.ok(trends.specificity('seedance 2') > trends.specificity('модель'),
    'название релиза должно обгонять родовое слово');
  assert.ok(trends.specificity('тредс') < 1,
    'короткое общее слово должно штрафоваться');
});

test('относительные местоимения не становятся темой', () => {
  // «которая» прошла первую версию списка и вышла темой на живых данных.
  const t = trends.termsOf('модель, которая переписала весь модуль за вечер');
  for (const w of ['которая', 'которую', 'которым']) {
    assert.ok(!t.includes(w), `«${w}» принято за тему`);
  }
});

test('risingPosts: что выстрелило, безотносительно тем', () => {
  /*
   * Отдельный вопрос от «о чём говорят». Одиночный пост, собравший много за
   * час, темой не станет никогда — нет ни трёх постов, ни трёх авторов, — но
   * увидеть его надо: именно по таким видно, что сейчас работает.
   */
  const now = 3_000_000_000_000;
  const s = { observations: [] };
  trends.observe(s, [
    obsPost('slow', 'a1', 'обычный пост про нейросети и рабочие процессы в команде', 4, 1, 120),
    obsPost('fast', 'a2', 'один пост, который за час собрал больше, чем профиль за неделю', 200, 40, 60),
    obsPost('old', 'a3', 'старый пост про нейросети, набравший своё очень давно', 900, 200, 60 * 24 * 30),
  ], TRENDS_SETTINGS, now);

  const top = trends.risingPosts(s, TRENDS_SETTINGS, { now, limit: 5 });
  assert.equal(top[0].id, 'fast', `первым вышел ${top[0]?.id}`);
  assert.ok(!top.some((o) => o.id === 'old'),
    'месячный пост не может быть тем, что залетает сейчас');
});

test('trendsAsMaterial: форма совпадает с той, что отдаёт сбор новостей', () => {
  const material = trends.trendsAsMaterial([{
    term: 'протокол шума', heat: 12, burst: 4.2, score: 9, posts: 3, authors: 3, replyRate: 0.5,
    sample: [{ text: 'протокол шума ломает контекст в длинных ветках, проверял на своём проекте', url: 'u/1' }],
  }]);

  const m = material[0];
  for (const key of ['id', 'title', 'summary', 'url', 'publishedAt', 'sourceId', 'sourceName', 'tier']) {
    assert.ok(key in m, `в материале нет поля ${key}, генератор его ждёт`);
  }
  /*
   * Заголовок — сама реплика, а не ярлык темы. Именно он уходит в промпт как
   * «что произошло»: по слову «протокол шума» модель напишет рассуждение о
   * категории, по живой фразе — о конкретном.
   */
  assert.ok(m.title.includes('протокол шума ломает контекст'),
    `заголовок должен вести репликой, а не ярлыком: «${m.title}»`);
  assert.ok(m.summary.includes('протокол шума'), 'ярлык темы остаётся в описании');
  assert.ok(/не пересказ/.test(m.summary),
    'в поводе должно стоять требование написать своё, а не пересказать чужое');
});

test('trendQueries: не повторяет то, что и так есть в настройках', () => {
  const qs = trends.trendQueries(
    [{ term: 'нейросети' }, { term: 'протокол шума' }, { term: 'mcp' }],
    TRENDS_SETTINGS, 5,
  );
  assert.ok(!qs.includes('нейросети'), 'фраза из настроек не дублируется');
  assert.ok(qs.includes('протокол шума'), 'новая тема должна попасть в запросы');
  assert.ok(!qs.includes('mcp'), 'слишком короткое одиночное слово даст выдачу ни о чём');
});

/* ------------------------- Живая пунктуация ------------------------- */

test('имя продукта не пишется строчным в начале', () => {
  /*
   * Живой пост 01.08: «claude Code без тестов ускоряет не разработку».
   * Внутри русского текста латинское слово с заглавной — почти всегда
   * название: Claude, Cursor, Python. Второй случай той же болезни, что «иИ»:
   * приём против «слишком правильного» текста портит имя, и это заметнее, чем
   * то, ради чего он существует.
   */
  const s = {
    ...defaults.DEFAULTS,
    humanize: {
      ...defaults.DEFAULTS.humanize,
      lowercaseStart: 1,
      typoPerWord: 0, insertFiller: 0, addEmoji: 0, parenAside: 0,
      stretchVowel: 0, dropFinalPeriod: 0, dropComma: 0, dashInstead: 0,
      missingSpaceAfterComma: 0, spaceBeforePunct: 0,
    },
  };

  for (const src of ['Claude Code без тестов ускоряет не разработку',
    'Cursor стал заметно быстрее на больших файлах',
    'Python тут лишний, хватило bash']) {
    const out = humanizer.humanize(src, s).text;
    assert.equal(out.charAt(0), src.charAt(0), `имя испорчено: ${out}`);
  }

  // Обратная сторона: русское слово в начале приём обязан опускать, иначе это
  // не лечение, а выключение.
  const ru = humanizer.humanize('Перед задачей описываю критерий готовности', s).text;
  assert.equal(ru.charAt(0), 'п', `русское начало не опущено: ${ru}`);
});

test('гласные не тянутся в деловом тексте', () => {
  /*
   * Живой случай 01.08: на технической реплике вышло «сааама по себе слабое
   * доказательство». В короткой эмоциональной реакции растянутая гласная —
   * живость, посреди объяснения с числами и названиями инструментов — явная
   * опечатка. Тот же класс, что «иИ» из аббревиатуры.
   */
  const s = {
    ...defaults.DEFAULTS,
    humanize: {
      ...defaults.DEFAULTS.humanize,
      stretchVowel: 1,   // приём включён наверняка
      typoPerWord: 0, insertFiller: 0, addEmoji: 0, parenAside: 0,
      lowercaseStart: 0, dropFinalPeriod: 0, dropComma: 0, dashInstead: 0,
      missingSpaceAfterComma: 0, spaceBeforePunct: 0,
    },
  };

  const business = [
    'запись экрана сама по себе слабое доказательство, надежнее показать 3 автосейва',
    'перед задачей в Claude Code описываю критерий готовности, и правок меньше',
  ];
  for (const src of business) {
    const out = humanizer.humanize(src, s).text;
    assert.ok(!/([аеиоуыэюя])\1{2,}/i.test(out), `гласная растянута в деловом тексте: ${out}`);
  }

  // Обратная сторона: в живой реплике приём обязан работать, иначе это не
  // лечение, а выключение.
  const casual = humanizer.humanize('ну да, вот так вот оно и вышло у меня', s).text;
  assert.ok(/([аеиоуыэюя])\1{2,}/i.test(casual),
    `в разговорной реплике гласная должна тянуться: ${casual}`);
});

test('скобки не ставятся вокруг того, что нельзя изъять из фразы', () => {
  /*
   * Поймано на живой генерации 01.08. Модель написала:
   *
   *   «Claude Code ускоряет не написание кода, а поиск места, где ты ошибся»
   *
   * а гуманизатор выдал:
   *
   *   «Claude Code ускоряет не написание кода (а поиск места) где ты ошибся»
   *
   * Приём сам по себе верный: уточнение в переписке чаще уходит в скобки, чем
   * обособляется запятыми. Но вставка в скобках обязана быть **изымаемой** —
   * убери её, и фраза останется целой. Кусок, начинающийся с союза, изъять
   * нельзя: без него разваливается конструкция «не X, а Y».
   *
   * Это тот же класс, что и «иИ» из аббревиатуры: маскировка, которая себя
   * выдаёт, хуже её отсутствия — вместо небрежности выходит явная поломка.
   */
  const settings = {
    ...defaults.DEFAULTS,
    humanize: {
      ...defaults.DEFAULTS.humanize,
      parenAside: 1,          // приём включён наверняка
      typoPerWord: 0, insertFiller: 0, addEmoji: 0, stretchVowel: 0,
      lowercaseStart: 0, dropFinalPeriod: 0, dropComma: 0, dashInstead: 0,
      missingSpaceAfterComma: 0, spaceBeforePunct: 0,
    },
  };

  const bound = [
    'Claude Code ускоряет не написание кода, а поиск места, где ты ошибся в архитектуре',
    'дело не в модели, а в промпте, который ты дал ей вчера',
    'проблема была не в коде, но в окружении, и это выяснилось поздно',
  ];
  for (const src of bound) {
    const out = humanizer.humanize(src, settings).text;
    assert.ok(!/\(/.test(out), `связанный кусок взят в скобки: ${out}`);
  }

  // Обратная сторона: настоящее уточнение в скобки уходить обязано, иначе
  // «лечение» свелось бы к выключению приёма.
  const free = 'поднял лимит токенов, обычная история, и всё заработало как надо';
  const out = humanizer.humanize(free, settings).text;
  assert.ok(/\(обычная история\)/.test(out), `настоящее уточнение не обособлено: ${out}`);
});

/* ------------------- Обучение на своих результатах ------------------- */

/* Настройки берём из схемы, а не переписываем числами: они там подобраны
   перебором, и тест обязан проверять именно их. */
const LEARN_S = { learning: { ...defaults.DEFAULTS.learning } };

/** Готовая запись измеренного поста. */
const post = (kind, hit, ageDays = 0) => ({
  kind,
  key: `${kind}-${Math.random()}`,
  parts: 1,
  publishedAt: Date.now() - ageDays * 864e5,
  likes: hit ? 1 : 0,
  replies: 0,
  measuredAt: Date.now(),
});

test('успех — факт чужой реакции, а не её величина', () => {
  /*
   * Отклик у нас редкий и с тяжёлым хвостом: девятнадцать постов из двадцати
   * собирают ноль, двадцатый — сорок. Среднее по такой выборке скачет от
   * одного поста; доля «хоть что-то пришло» устойчива на десятке наблюдений.
   */
  assert.equal(learning.isHit({ likes: 0, replies: 0 }), false);
  assert.equal(learning.isHit({ likes: 1, replies: 0 }), true);
  assert.equal(learning.isHit({ likes: 0, replies: 1 }), true);
  assert.equal(learning.isHit({ likes: 40, replies: 3 }), true, 'сорок лайков не «успешнее» одного');
});

test('на малой выборке веса не трогаются вовсе', () => {
  const state = { myPosts: [post('question', true), post('news', false)] };
  const stats = learning.formatStats(state, LEARN_S);
  assert.equal(learning.learnedFactor('question', stats, LEARN_S), 1,
    'два поста — не основание менять расписание');
});

test('оценка формата сглаживается к общей доле', () => {
  /*
   * Три поста формата, из них три с откликом, — это не «100% успеха», а
   * «мы почти ничего не знаем». Априорная сила восемь означает, что при трёх
   * наблюдениях оценка сдвигается к своей доле меньше чем наполовину.
   */
  const state = { myPosts: [] };
  for (let i = 0; i < 3; i++) state.myPosts.push(post('question', true));
  for (let i = 0; i < 12; i++) state.myPosts.push(post('news', false));

  const stats = learning.formatStats(state, LEARN_S);
  const q = stats.byKind.question;

  assert.equal(q.raw, 1, 'сырая доля должна быть единицей');
  assert.ok(q.rate < 0.5,
    `сглаженная оценка ${q.rate.toFixed(2)} — три поста не должны давать уверенность`);
  assert.ok(q.rate > stats.base, 'но и выше общей доли она быть обязана');
});

test('множитель не выпускает формат за коридор', () => {
  const state = { myPosts: [] };
  for (let i = 0; i < 40; i++) state.myPosts.push(post('question', true));
  for (let i = 0; i < 40; i++) state.myPosts.push(post('news', false));

  const stats = learning.formatStats(state, LEARN_S);
  const up = learning.learnedFactor('question', stats, LEARN_S);
  const down = learning.learnedFactor('news', stats, LEARN_S);

  assert.ok(up <= 2.0001, `множитель ${up} вышел за потолок`);
  assert.ok(down >= 0.4999, `множитель ${down} упал ниже пола`);
  assert.ok(up > 1 && down < 1, 'направление поправки неверное');
});

test('старые наблюдения весят меньше свежих', () => {
  const fresh = { myPosts: [] };
  const old = { myPosts: [] };
  for (let i = 0; i < 10; i++) {
    fresh.myPosts.push(post('question', true, 0));
    old.myPosts.push(post('question', true, 28));   // четыре периода полураспада
  }
  for (let i = 0; i < 10; i++) {
    fresh.myPosts.push(post('news', false, 0));
    old.myPosts.push(post('news', false, 28));
  }

  const a = learning.formatStats(fresh, LEARN_S).byKind.question.rate;
  const b = learning.formatStats(old, LEARN_S).byKind.question.rate;
  assert.ok(a > b, `свежие данные должны убеждать сильнее: ${a.toFixed(2)} против ${b.toFixed(2)}`);
});

test('части своей же ветки не считаются откликом', () => {
  /*
   * У корня многочастной ветки в счётчике ответов лежат наши собственные
   * продолжения. Не вычесть их значит записать себе в успех разговор с самим
   * собой, и формат «разбор» из трёх частей выглядел бы втрое успешнее.
   */
  const state = {
    myPosts: [{
      kind: 'guide', key: 'разбор про агентов', parts: 3,
      publishedAt: Date.now() - 5 * 3.6e6, likes: null, replies: null, measuredAt: null,
    }],
  };
  learning.measurePosts(state, [{ text: 'разбор про агентов', replies: 2, likes: 0 }], LEARN_S);

  const rec = state.myPosts[0];
  assert.equal(rec.replies, 0, 'две своих части приняты за чужие ответы');
  assert.equal(learning.isHit(rec), false, 'разговор с самим собой засчитан успехом');
});

test('слишком свежий пост не измеряется', () => {
  const state = {
    myPosts: [{
      kind: 'tip', key: 'приём про критерии', parts: 1,
      publishedAt: Date.now() - 5 * 60000, likes: null, replies: null, measuredAt: null,
    }],
  };
  const r = learning.measurePosts(state, [{ text: 'приём про критерии', replies: 0, likes: 0 }], LEARN_S);

  assert.equal(r.updated, 0, 'ноль реакций через пять минут — не результат формата');
  assert.equal(state.myPosts[0].measuredAt, null,
    '«не смотрели» и «посмотрели, там пусто» — разные вещи');
});

/**
 * Один месяц жизни агента в мире с известной правдой.
 *
 * Возвращает множители, назначенные форматам, и сколько раз каждый вышел.
 */
function simulateMonth(seed0, truth, defaultRate = 0.20, days = 30, perDay = 10) {
  let seed = seed0;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  const state = { myPosts: [], recentPostKinds: [], lastPostKind: null };
  const counts = {};
  const now = Date.now();

  for (let day = 0; day < days; day++) {
    for (let i = 0; i < perDay; i++) {
      const stats = learning.formatStats(state, LEARN_S, now);
      const kind = postplan.pickKind(state, { hasMaterial: true, rand, settings: LEARN_S, stats });

      counts[kind] = (counts[kind] || 0) + 1;
      state.lastPostKind = kind;
      state.recentPostKinds = [...state.recentPostKinds, kind].slice(-8);

      state.myPosts.push({
        kind, key: `k${day}-${i}`, parts: 1,
        publishedAt: now - (days - day) * 864e5,
        likes: rand() < (truth[kind] ?? defaultRate) ? 1 : 0,
        replies: 0, measuredAt: now,
      });
      if (state.myPosts.length > 250) state.myPosts.shift();
    }
  }

  const stats = learning.formatStats(state, LEARN_S, now);
  const factors = {};
  for (const k of Object.keys(postplan.POST_KINDS)) {
    factors[k] = learning.learnedFactor(k, stats, LEARN_S);
  }
  return { factors, counts, stats, total: days * perDay };
}

test('симуляция: агент находит работающий формат за месяц', () => {
  /*
   * Главная проверка: не свойство отдельной функции, а итог месяца работы.
   *
   * Проверяется на многих независимых мирах, потому что один прогон ничего не
   * значит — при выборке в десяток постов разброс сопоставим с самим эффектом.
   * Требование сформулировано как «в большинстве миров», а не «всегда»: обещать
   * второе на таких выборках было бы враньём, и тест либо стал бы
   * нестабильным, либо потребовал бы ослабить консерватизм математики.
   */
  const truth = { question: 0.40, hottake: 0.32, prompts: 0.08, guide: 0.10 };

  let foundGood = 0;
  let foundBad = 0;
  const RUNS = 20;

  for (let r = 0; r < RUNS; r++) {
    const { factors } = simulateMonth(1000 + r * 7919, truth);
    if (factors.question > 1.1) foundGood++;
    if (factors.prompts < 0.95 || factors.guide < 0.95) foundBad++;
  }

  assert.ok(foundGood >= RUNS * 0.8,
    `лучший формат опознан лишь в ${foundGood} мирах из ${RUNS}`);
  assert.ok(foundBad >= RUNS * 0.6,
    `слабые форматы опознаны лишь в ${foundBad} мирах из ${RUNS}`);
});

test('симуляция: агент не верит шуму', () => {
  /*
   * Обратная сторона, и она важнее первой. В мире, где все форматы одинаковы,
   * агент обязан оставить веса почти нетронутыми: любой уверенный наклон здесь
   * — вера в случайность.
   *
   * Ради этого свойства и подобраны сила априора и гашение: перебор показал,
   * что при силе 4 агент врёт вчетверо чаще при той же пользе.
   */
  let confidentShifts = 0;
  const RUNS = 20;

  for (let r = 0; r < RUNS; r++) {
    const { factors } = simulateMonth(500 + r * 6271, {});   // мир без различий
    for (const f of Object.values(factors)) {
      if (f > 1.35 || f < 0.74) confidentShifts++;
    }
  }

  assert.ok(confidentShifts <= RUNS,
    `в мире без различий агент уверенно наклонил веса ${confidentShifts} раз на ${RUNS} прогонов`);
});

test('симуляция: ни один формат не исчезает из расписания', () => {
  /*
   * Исследование. Формат, которому не повезло на первых постах, обязан
   * получать новые попытки — иначе агент застрянет в том, что случайно
   * сработало на первой неделе, и никогда об этом не узнает.
   */
  const truth = { question: 0.45, prompts: 0.05 };
  const { counts, total } = simulateMonth(31337, truth);

  const missing = Object.keys(postplan.POST_KINDS).filter((k) => !counts[k]);
  assert.deepEqual(missing, [], `форматы пропали совсем: ${missing.join(', ')}`);

  const worst = Math.min(...Object.keys(postplan.POST_KINDS).map((k) => (counts[k] || 0) / total));
  assert.ok(worst > 0.005,
    `самый редкий формат сжался до ${(worst * 100).toFixed(2)}% — исследование сломано`);
});

test('множитель ограничен коридором при любых данных', () => {
  /* Границы — не украшение: они и есть гарантия, что расписание не выродится. */
  const truth = { question: 0.95, prompts: 0.0 };
  const { factors } = simulateMonth(777, truth);

  for (const [k, f] of Object.entries(factors)) {
    assert.ok(f <= 2.0001 && f >= 0.4999, `«${k}» вышел за коридор: ${f.toFixed(2)}`);
  }
});

test('выключенное обучение ничего не меняет', () => {
  const state = { myPosts: [] };
  for (let i = 0; i < 40; i++) state.myPosts.push(post('question', true));
  for (let i = 0; i < 40; i++) state.myPosts.push(post('news', false));

  const off = { learning: { ...LEARN_S.learning, enabled: false } };
  const stats = learning.formatStats(state, off);
  assert.equal(learning.learnedFactor('question', stats, off), 1);
});

test('отчёт об обучении называет числа, а не «всё хорошо»', () => {
  const state = { myPosts: [] };
  for (let i = 0; i < 20; i++) state.myPosts.push(post('question', i % 2 === 0));
  const line = learning.learningReport(state, LEARN_S);

  assert.match(line, /измерено 20/, 'не сказано, на скольких постах вывод');
  assert.match(line, /question ×/, 'не названы множители по форматам');
});

/* ------------------- Ответы своим читателям (hosting) ------------------- */

const HOST_S = {
  hosting: { enabled: true, everyMin: 40, maxPerDay: 15, maxPostAgeHours: 48, minReplyLen: 20 },
};

const mkThread = (replies) => ({
  root: { url: 'https://www.threads.com/@example_user/post/ABC123', text: 'мой пост про агентов' },
  replies,
});

test('отвечаем первому по порядку, а не самому длинному', () => {
  /*
   * Разговор идёт сверху вниз. Отвечать вразнобой — верный признак обхода по
   * списку, а не участия в беседе.
   */
  const t = mkThread([
    { authorHandle: 'petya', text: 'а как ты ограничиваешь область правок агенту?' },
    { authorHandle: 'vasya', text: 'у меня был случай, когда агент переписал соседний модуль и уронил сборку на проде' },
  ]);
  const p = hosting.pickReplyToAnswer(t, HOST_S, {}, 'example_user');
  assert.equal(p.reply.author, 'petya', `выбран @${p.reply.author}`);
  assert.equal(p.index, 0);
});

test('свои реплики собеседниками не считаются', () => {
  const t = mkThread([
    { authorHandle: 'example_user', text: 'продолжение моей же ветки, вторая часть поста' },
    { authorHandle: 'petya', text: 'интересно, а на длинных задачах это работает?' },
  ]);
  const p = hosting.pickReplyToAnswer(t, HOST_S, {}, 'example_user');
  assert.equal(p.reply.author, 'petya', 'агент собрался отвечать сам себе');
});

test('на «+» и «согласен» не отвечаем', () => {
  /* На такое человек отвечает лайком; развёрнутый ответ выглядит натужно. */
  const t = mkThread([
    { authorHandle: 'petya', text: '+' },
    { authorHandle: 'vasya', text: 'согласен' },
  ]);
  assert.equal(hosting.pickReplyToAnswer(t, HOST_S, {}, 'example_user'), null);
});

test('дважды одному человеку под одним постом не отвечаем', () => {
  const t = mkThread([
    { authorHandle: 'petya', text: 'а как ты ограничиваешь область правок агенту?' },
  ]);
  const state = {};
  const first = hosting.pickReplyToAnswer(t, HOST_S, state, 'example_user');
  assert.ok(first, 'первый раз ответить обязаны');

  hosting.rememberAnswer(state, t.root.url, 'petya');
  assert.equal(hosting.pickReplyToAnswer(t, HOST_S, state, 'example_user'), null,
    'ответили второй раз тому же человеку под тем же постом');
  assert.equal(state.dayHostReplies, 1);
});

test('ключ ответа строится по посту и автору, а не по тексту', () => {
  /*
   * Человек может поправить свой комментарий. По тексту реплика выглядела бы
   * новой, и агент ответил бы ещё раз.
   */
  const a = hosting.answerKey('https://www.threads.com/@x/post/ABC123', 'Petya');
  const b = hosting.answerKey('https://www.threads.com/@x/post/ABC123?xmt=1', '@petya');
  assert.equal(a, b, 'ключ разошёлся из-за регистра или хвоста адреса');
});

test('проверка своего профиля идёт по расписанию и упирается в дневной предел', () => {
  const now = 1_000_000_000_000;
  assert.equal(hosting.shouldCheckOwn(HOST_S, { lastOwnCheckAt: 0 }, now).check, true);

  const justChecked = { lastOwnCheckAt: now - 5 * 60000 };
  assert.equal(hosting.shouldCheckOwn(HOST_S, justChecked, now).check, false, 'заглядываем слишком часто');

  const spent = { lastOwnCheckAt: 0, dayHostReplies: 15 };
  const v = hosting.shouldCheckOwn(HOST_S, spent, now);
  assert.equal(v.check, false);
  assert.match(v.why, /предел/);

  assert.equal(hosting.shouldCheckOwn({ hosting: { enabled: false } }, {}, now).check, false);
});

test('обслуживаем только свои свежие посты, где есть ответы', () => {
  const cards = [
    { authorHandle: 'example_user', url: 'u/1', replies: 2, ageMinutes: 30 },
    { authorHandle: 'example_user', url: 'u/2', replies: 0, ageMinutes: 10 },   // не отвечали
    { authorHandle: 'example_user', url: 'u/3', replies: 5, ageMinutes: 60 * 96 }, // протух
    { authorHandle: 'someone', url: 'u/4', replies: 9, ageMinutes: 20 },    // чужой
    { authorHandle: 'example_user', url: 'u/5', replies: 1, ageMinutes: 120 },
  ];
  const got = hosting.pickOwnPosts(cards, HOST_S, {}, 'example_user');
  assert.deepEqual(got.map((c) => c.url), ['u/1', 'u/5'], 'отобраны не те посты');
});

test('свои же части ветки не считаются ответами читателей', () => {
  /*
   * Поймано в бою 02.08: девятнадцать заходов в профиль подряд сообщали «с
   * ответами 1» и заканчивались «отвечать некому». Постом с ответами
   * оказывалась наша собственная ветка из трёх частей — в счётчике ответов
   * лежали два наших продолжения.
   */
  const state = {
    myPosts: [
      { key: 'разбор новости про агентов часть первая', parts: 3, publishedAt: 1 },
      { key: 'одиночный пост без продолжения', parts: 1, publishedAt: 1 },
    ],
  };
  const cards = [
    // Ветка из трёх частей, чужих ответов нет.
    { authorHandle: 'example_user', url: 'u/1', replies: 2, ageMinutes: 30,
      text: 'Разбор новости про агентов: часть первая' },
    // Та же ветка, но один человек всё-таки ответил.
    { authorHandle: 'example_user', url: 'u/2', replies: 3, ageMinutes: 40,
      text: 'Разбор новости про агентов: часть первая' },
    // Одиночный пост с настоящим ответом.
    { authorHandle: 'example_user', url: 'u/3', replies: 1, ageMinutes: 50,
      text: 'Одиночный пост без продолжения' },
  ];

  assert.equal(hosting.outsideReplies(cards[0], state), 0, 'свои части приняты за ответы');
  assert.equal(hosting.outsideReplies(cards[1], state), 1);
  assert.equal(hosting.outsideReplies(cards[2], state), 1);

  const got = hosting.pickOwnPosts(cards, HOST_S, state, 'example_user');
  assert.deepEqual(got.map((c) => c.url), ['u/2', 'u/3'],
    'в обслуживание попала ветка без единого чужого ответа');
});

test('опечатка не превращает слово в другое существующее', () => {
  /*
   * Живой ответ читателю 02.08: «ручные правки» вышли как «русные правки» —
   * «ч» и «с» соседи в нижнем ряду. Читатель видит не спешку, а бессмыслицу.
   *
   * Замена соседней клавишей — единственный вид опечатки, который на это
   * способен, и чем короче слово, тем выше шанс попасть в существующее.
   * Перестановка, пропуск и удвоение дают форму, которой в языке нет.
   */
  const only = (kind) => ({ swap: 0, drop: 0, double: 0, neighbor: 0, [kind]: 1 });

  for (const w of ['ручные', 'код', 'база', 'тест', 'ключ', 'модель']) {
    for (let i = 0; i < 50; i++) {
      assert.equal(humanizer.typoWord(w, only('neighbor')), null,
        `на коротком слове «${w}» соседняя клавиша должна быть отключена`);
    }
  }

  // На длинных словах приём остаётся: там подходящего соседа-слова почти нет.
  const long = new Set();
  for (let i = 0; i < 80; i++) {
    const t = humanizer.typoWord('автоматизация', only('neighbor'));
    if (t) long.add(t);
  }
  assert.ok(long.size > 0, 'на длинном слове замена соседней клавишей пропала совсем');

  // Вес приёма опущен: он больше не каждая четвёртая опечатка.
  assert.ok(defaults.DEFAULTS.humanize.typoMix.neighbor <= 0.12,
    `вес соседней клавиши ${defaults.DEFAULTS.humanize.typoMix.neighbor} — слишком много для приёма, меняющего смысл`);
});

test('в короткой реплике опечатка одна, а не две', () => {
  /*
   * Две опечатки на 170 знаков — та самая живая реплика 02.08. Для развёрнутого
   * комментария на четверть тысячи знаков две уместны, для короткой реплики
   * это уже неряшливость. Потолок считается от длины текста.
   */
  const s = structuredClone(defaults.DEFAULTS);
  s.humanize = {
    ...s.humanize,
    typoPerWord: 1,          // опечатка в каждом подходящем слове
    typoMaxPerComment: 2,
    lowercaseStart: 0, dropFinalPeriod: 0, yoToE: 0, dropComma: 0, dashInstead: 0,
    missingSpaceAfterComma: 0, spaceBeforePunct: 0, stretchVowel: 0, insertFiller: 0,
    addEmoji: 0, typoMix: { swap: 1, drop: 0, double: 0, neighbor: 0 },
  };

  const short = 'да, финальный промпт без промежуточных шагов выглядит слишком узким '
    + 'доказательством, лучше сохранять исходники и даты';
  const long = `${short} ${short}`;

  const nShort = (humanizer.humanize(short, s).applied.find((a) => a.startsWith('опечаток')) || '').match(/\d+/);
  const nLong = (humanizer.humanize(long, s).applied.find((a) => a.startsWith('опечаток')) || '').match(/\d+/);

  assert.equal(Number(nShort?.[0] || 0), 1, `в реплике на ${short.length} знаков опечаток больше одной`);
  assert.equal(Number(nLong?.[0] || 0), 2, `в тексте на ${long.length} знаков потолок должен оставаться прежним`);
});

test('промпт ответа своим не просит того, что фильтр забракует', () => {
  /*
   * Промпт разрешал 40 символов, а `checkComment` бракует всё короче
   * `style.minLen` = 45. Модель, послушавшись промпта, получала бы «короче 45
   * символов» и три попытки перегенерации подряд — на ровном месте.
   *
   * Проверка не про числа, а про их согласованность: границу можно двигать,
   * но промпт и фильтр обязаны говорить одно и то же.
   */
  const s = defaults.DEFAULTS;
  const text = prompts.hostSystem(s);
  const m = text.match(/Длина (\d+)-(\d+) символов/);
  assert.ok(m, 'в промпте ответа своим больше не названа длина');

  assert.ok(Number(m[1]) >= s.style.minLen,
    `промпт разрешает ${m[1]} символов, а фильтр требует ${s.style.minLen}`);
  assert.ok(Number(m[2]) <= s.style.maxLen * 1.35,
    `промпт разрешает ${m[2]} символов, а фильтр бракует длиннее ${Math.round(s.style.maxLen * 1.35)}`);
});

test('обслуженный пост уступает очередь соседнему, но возвращается с новым ответом', () => {
  /*
   * Регрессионный случай. Агент ответил @reader_one под своим постом, и шесть
   * следующих заходов в профиль закончились «отвечать некому»: список идёт от
   * свежих к старым, а самый свежий пост остаётся самым свежим. Читателей под
   * соседними постами к вечеру набралось четверо, и ни один ответа не получил.
   */
  const state = { myPosts: [], ownServed: {} };
  const fresh = { authorHandle: 'example_user', url: 'https://www.threads.com/@example_user/post/AAA', replies: 1, ageMinutes: 30, text: 'свежий' };
  const older = { authorHandle: 'example_user', url: 'https://www.threads.com/@example_user/post/BBB', replies: 1, ageMinutes: 300, text: 'вчерашний' };

  assert.deepEqual(hosting.pickOwnPosts([fresh, older], HOST_S, state, 'example_user').map((c) => c.url),
    [fresh.url, older.url], 'сначала свежий — так и задумано');

  // Под свежим всем ответили: он уходит из очереди, соседний остаётся.
  hosting.markOwnServed(state, fresh.url, 1);
  assert.deepEqual(hosting.pickOwnPosts([fresh, older], HOST_S, state, 'example_user').map((c) => c.url),
    [older.url], 'обслуженный пост не уступил очередь');

  // Пришёл новый человек — пост снова в очереди, без всяких сроков.
  const grown = { ...fresh, replies: 2 };
  assert.deepEqual(hosting.pickOwnPosts([grown, older], HOST_S, state, 'example_user').map((c) => c.url),
    [grown.url, older.url], 'новый ответ не вернул пост в очередь');
});

test('незнакомый пост считается по счётчику как есть', () => {
  // Пост, опубликованный до появления учёта, записи не имеет — вычитать нечего.
  assert.equal(hosting.outsideReplies({ replies: 2, text: 'что-то давнее' }, { myPosts: [] }), 2);
});

/* --------------------------- Комментарии: замер --------------------------- */

test('комментарии и посты настроены на противоположную длину, и это осознанно', () => {
  /*
   * Замер 01.08 на 485 живых репликах: ответ получают 44% комментариев, у
   * реплик короче сорока символов — 34%, у реплик от ста шестидесяти — 54%.
   * У постов зависимость обратная: до ста символов ×2.4 по скорости, 350+ ×0.5.
   *
   * Разница не в платформе, а в роли текста, и её легко потерять при правке
   * «приведём всё к одному». Проверка держит именно это различие.
   */
  const s = defaults.DEFAULTS;
  assert.ok(s.style.minLen >= 40,
    `минимум комментария ${s.style.minLen}: реплики короче сорока получают ответ вдвое реже`);
  assert.ok(s.style.targetLen >= 140,
    `цель комментария ${s.style.targetLen} — коротко для чужой ветки`);

  const shortPost = postplan.POST_KINDS.question;
  assert.ok(shortPost.len[1] < s.style.targetLen,
    'пост-вопрос должен быть короче типичного комментария, а не длиннее');
});

test('вопрос перестал быть главным углом захода', () => {
  /*
   * Вес 22 из 104 стоял на общем соображении «автор почти всегда ответит».
   * Замер: вопрос 45% против 44% по всем репликам — то есть ровно ничего.
   * Личный опыт 51%, совет 49%, несогласие 49%.
   */
  const w = defaults.DEFAULTS.angles.weights;
  const total = Object.values(w).reduce((a, b) => a + b, 0);

  assert.ok(w.question / total < 0.15,
    `на вопрос ${Math.round(w.question / total * 100)}% веса, а он не даёт отклика сверх среднего`);
  for (const better of ['personal_story', 'practical_tip', 'gentle_disagree']) {
    assert.ok(w[better] > w.question,
      `«${better}» замерен выше вопроса, а весит меньше`);
  }
  assert.ok(w.question > 0, 'совсем выключать вопрос не за что: он не хуже среднего');
});

test('промпт комментария требует вложенного, а не спрошенного', () => {
  const sys = prompts.writeSystem(defaults.DEFAULTS);
  assert.ok(/что-то ТВОЁ/.test(sys), 'требование конкретики пропало из промпта');
  assert.ok(/состоящий из одного вопроса, не пиши/.test(sys),
    'запрет на комментарий-вопрос пропал');
});

/* ------------------------------- Темы постов ------------------------------ */

const TOPIC_S = {
  niche: { tags: ['нейросети', 'вайбкодинг', 'программирование', 'Claude', 'стартап'] },
};

test('тема выбирается по тому, о чём пост', () => {
  const t = postplan.pickTopic(
    'в Claude Code правки стали точнее, когда я описал формат результата',
    TOPIC_S, {},
  );
  assert.equal(t, 'Claude', `выбрана «${t}», а пост про Claude`);

  const v = postplan.pickTopic('вайбкодинг ускоряет прототип, но ломает архитектуру', TOPIC_S, {});
  assert.equal(v, 'вайбкодинг');
});

test('тема ищется по корню, а не по точному слову', () => {
  /*
   * `\b` с кириллицей не работает, а падежи в русском есть всегда: пост «про
   * нейросеть» обязан получить тему «нейросети». Это тот самый класс ошибок,
   * на котором проект уже обжигался трижды.
   */
  const t = postplan.pickTopic('нейросеть переписала мне весь модуль за вечер', TOPIC_S, {});
  assert.equal(t, 'нейросети', `по корню не нашлось, выбрано «${t}»`);
});

test('из нескольких подходящих тем берётся более точная', () => {
  const s = { niche: { tags: ['ии', 'вайбкодинг'] } };
  const t = postplan.pickTopic('ии и вайбкодинг за один вечер', s, {});
  assert.equal(t, 'вайбкодинг', 'короткая общая тема победила длинную точную');
});

test('одна тема не ставится два раза подряд', () => {
  const state = { recentTopics: ['Claude'] };
  const t = postplan.pickTopic('снова про Claude Code и его правки', TOPIC_S, state);
  assert.notEqual(t, 'Claude', 'тема повторилась подряд');
  assert.ok(t, 'вместо повтора не должно быть пусто — пост без темы никуда не попадает');
});

test('без совпадения по тексту тема всё равно ставится', () => {
  const t = postplan.pickTopic('сегодня отличная погода и кофе', TOPIC_S, {}, () => 0);
  assert.ok(TOPIC_S.niche.tags.includes(t),
    'тема обязана быть из проверенного списка, а не выдуманной');
});

test('пустой список тем не выдумывает тему', () => {
  assert.equal(postplan.pickTopic('что угодно', { niche: { tags: [] } }, {}), null);
});

test('rememberTopic копит историю и не растёт бесконечно', () => {
  const s = {};
  for (let i = 0; i < 20; i++) postplan.rememberTopic(s, `тема${i}`);
  assert.ok(s.recentTopics.length <= 6, `история тем разрослась до ${s.recentTopics.length}`);
  assert.equal(s.recentTopics.at(-1), 'тема19');

  postplan.rememberTopic(s, null);
  assert.equal(s.recentTopics.at(-1), 'тема19', 'пустая тема не должна попадать в историю');
});

/* --------------------- Здоровье поисковых фраз --------------------- */

test('фраза откладывается после трёх пустых подряд, но не после двух', () => {
  const s = {};
  const q = 'ии агент';
  trends.noteQueryResult(s, q, 0);
  trends.noteQueryResult(s, q, 0);
  assert.deepEqual(trends.benchedQueries(s), [], 'две пустые — ещё не приговор');

  trends.noteQueryResult(s, q, 0);
  assert.equal(trends.benchedQueries(s).length, 1, 'третья пустая обязана отложить фразу');
  assert.deepEqual(trends.healthyQueries(s, [q, 'нейросети']), ['нейросети']);
});

test('любая находка обнуляет серию', () => {
  const s = {};
  const q = 'нейросети';
  trends.noteQueryResult(s, q, 0);
  trends.noteQueryResult(s, q, 0);
  trends.noteQueryResult(s, q, 14);   // нашлось
  trends.noteQueryResult(s, q, 0);
  assert.deepEqual(trends.benchedQueries(s), [],
    'фраза, дающая посты через раз, рабочая — хоронить её нельзя');
});

test('когда отложены все фразы, агент не остаётся вовсе без источника', () => {
  const s = {};
  const all = ['a-фраза', 'b-фраза'];
  for (const q of all) for (let i = 0; i < 3; i++) trends.noteQueryResult(s, q, 0);

  assert.deepEqual(trends.healthyQueries(s, all), all,
    'массовое обнуление скорее означает поломку разбора страницы, чем конец тем в нише');
});

test('отложенная фраза возвращается в игру через сутки', () => {
  const s = {};
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 3; i++) trends.noteQueryResult(s, 'mcp сервер', 0, t0);

  assert.deepEqual(trends.healthyQueries(s, ['mcp сервер', 'нейросети'], t0 + 3.6e6), ['нейросети']);
  assert.deepEqual(
    trends.healthyQueries(s, ['mcp сервер', 'нейросети'], t0 + 25 * 3.6e6),
    ['mcp сервер', 'нейросети'],
    'выдача Threads меняется, приговор не может быть вечным',
  );
});

test('миграция v15 сохраняет пользовательскую нишу и ставит агент на паузу', () => {
  const settings = defaults.deepMerge(defaults.DEFAULTS, {
    version: 14,
    enabled: true,
    autopilot: true,
    niche: {
      description: 'Моя собственная тема',
      searchQueries: ['свой запрос'],
      tags: ['своя тема'],
    },
  });

  defaults.migrateSettings(settings, 14);
  assert.equal(settings.niche.description, 'Моя собственная тема');
  assert.deepEqual(settings.niche.searchQueries, ['свой запрос']);
  assert.deepEqual(settings.niche.tags, ['своя тема']);
  assert.equal(settings.enabled, false, 'обновлённый агент обязан ждать проверки настроек');
  assert.equal(settings.autopilot, false, 'автопилот нельзя включать миграцией');
});

test('в поисковой фразе не смешиваются алфавиты', () => {
  /*
   * Единственное правило, которое выдержало проверку фактом.
   *
   * Браузерная проба 01.08 по всем двадцати двум фразам прежнего списка: из
   * шести фраз со смесью кириллицы и латиницы — «mcp сервер», «ai агенты»,
   * «ai инструменты», «телеграм бот на python», «n8n автоматизация»,
   * «скиллы claude» — пусты **все шесть**.
   *
   * Соблазнительное правило «не больше двух слов» пришлось выбросить: оно
   * опровергается с двух сторон сразу. «нейросети для бизнеса» из трёх слов
   * даёт двадцать русских постов, а двухсловные «ии агент», «промпт
   * инжиниринг» и «нейросеть код» — ноль. Предсказать пустую фразу по её виду
   * нельзя, и остаются два honest-пути: проверять фактом (сделано, см.
   * комментарий к списку) и ловить протухание в бою (`noteQueryResult`).
   */
  for (const q of defaults.DEFAULTS.niche.searchQueries) {
    const cyr = /[а-яё]/i.test(q);
    const lat = /[a-z]/i.test(q);
    assert.ok(!(cyr && lat), `«${q}»: смесь алфавитов — все такие фразы в пробе были пусты`);
  }
});

/* --------------------- Расписание на новом объёме --------------------- */

test('daySlots: получасовой шаг даёт больше суточных слотов, чем прежний потолок', () => {
  const slots = postplan.daySlots({
    windowFromHour: 7, windowToHour: 24, intervalHours: 0.5,
  });
  assert.equal(slots.length, 34, `окно 7–24 с шагом 30 мин — 34 слота, получено ${slots.length}`);
  // Прежний код резал список двадцатью четырьмя, и настройка выглядела бы
  // применённой, оставаясь недействующей.
  assert.ok(slots.length > 24, 'потолок в 24 слота снят');
});

test('daySlots: слишком частый шаг не принимается', () => {
  const slots = postplan.daySlots({
    windowFromHour: 0, windowToHour: 24, intervalHours: 0.01,
  });
  const step = slots[1] - slots[0];
  assert.ok(step >= 20, `шаг не может быть меньше 20 минут, получено ${step}`);
});

test('пресет «Интенсивный» согласован сам с собой', () => {
  const p = defaults.PRESETS.boost;
  assert.ok(p, 'пресет должен существовать');
  assert.equal(p.posting.perDay, 4);

  const slots = postplan.daySlots(p.posting, '2026-08-02');
  assert.ok(slots.length <= p.posting.perDay,
    `слотов ${slots.length} больше дневного потолка ${p.posting.perDay} — потолок обессмыслен`);

  /*
   * Публикаций в день столько, сколько обещает коридор, а не сколько влезет в
   * окно: с 02.08 план дня задают `perDayMin`/`perDayMax`, а `perDay` остался
   * предохранителем сверху для ручных запусков.
   */
  assert.ok(slots.length >= p.posting.perDayMin && slots.length <= p.posting.perDayMax,
    `слотов ${slots.length} вне коридора ${p.posting.perDayMin}–${p.posting.perDayMax}`);

  // Комментариев в день больше, чем постов: комментарий приносит показы у чужой
  // аудитории, пост — только у своей, а своей у аккаунта почти нет.
  assert.ok(p.limits.perDay > p.posting.perDayMax, 'комментариев должно быть больше, чем постов');

  /*
   * Часовой потолок согласован с дневным: коридор 2–3 в час при окне 7:00–1:00
   * упирается в тридцать раньше, чем в закрытие окна, — агент выбирает норму и
   * замолкает, а не пишет до полуночи ровным темпом.
   */
  const hours = (24 - p.timing.activeFrom) + p.timing.activeTo;
  assert.ok(p.limits.perDay <= hours * p.limits.perHour,
    `дневной лимит ${p.limits.perDay} недостижим: ${hours} ч × ${p.limits.perHour} в час`);
  assert.ok(p.timing.sessionMaxActions <= p.limits.perHour,
    'сессия планирует больше действий, чем разрешает час — половина сессии уйдёт в отказ');

  /*
   * Окно догона обязано перекрывать самый долгий перерыв.
   *
   * Расписание проверяется только внутри сессии, поэтому слот, чьё окно
   * целиком легло в перерыв, теряется молча. 03.08 так пропал слот 16:40:
   * перерыв 32 минуты при окне догона 25.
   */
  assert.ok(p.posting.graceMin >= p.timing.breakMaxMinutes,
    `окно догона ${p.posting.graceMin} мин короче перерыва ${p.timing.breakMaxMinutes} мин`
    + ' — слот, попавший в перерыв, потеряется');
});

test('миграция v15 добавляет универсальные настройки AI без смены выбранных моделей', () => {
  const settings = defaults.deepMerge(defaults.DEFAULTS, {
    version: 14,
    ai: {
      provider: undefined,
      protocol: undefined,
      modelScore: 'my-score-model',
      modelWrite: 'my-write-model',
      defaultPricing: undefined,
      promptOverrides: undefined,
    },
  });

  defaults.migrateSettings(settings, 14);
  assert.equal(settings.ai.provider, 'openai');
  assert.equal(settings.ai.protocol, 'openai');
  assert.equal(settings.ai.modelScore, 'my-score-model');
  assert.equal(settings.ai.modelWrite, 'my-write-model');
  assert.deepEqual(settings.ai.defaultPricing, defaults.DEFAULTS.ai.defaultPricing);
  assert.deepEqual(settings.ai.promptOverrides, defaults.DEFAULTS.ai.promptOverrides);
});

test('миграция v15 выключает воронку, но сохраняет пользовательские тексты', () => {
  const settings = defaults.deepMerge(defaults.DEFAULTS, {
    version: 14,
    funnel: {
      enabled: true,
      tails: ['мой текст'],
      followup: { enabled: true, texts: ['мой ответ {link}'] },
    },
  });

  defaults.migrateSettings(settings, 14);
  assert.equal(settings.funnel.enabled, false);
  assert.equal(settings.funnel.followup.enabled, false);
  assert.deepEqual(settings.funnel.tails, ['мой текст']);
  assert.deepEqual(settings.funnel.followup.texts, ['мой ответ {link}']);
});

test('миграция v12 доносит расширенное окно догона до установленного расширения', () => {
  /*
   * Тот же случай, что с коридором публикаций в v8 и ссылкой в v11: значение
   * уже лежит в хранилище, и `deepMerge` оставляет сохранённое поверх нового.
   */
  const live = defaults.deepMerge(defaults.DEFAULTS, { version: 11, posting: { graceMin: 25 } });
  defaults.migrateSettings(live, 11);
  assert.equal(live.posting.graceMin, 55, 'окно догона не доехало');

  // Правленое руками не трогаем: у миграции нет права переписывать решение человека.
  const tuned = defaults.deepMerge(defaults.DEFAULTS, { version: 11, posting: { graceMin: 40 } });
  defaults.migrateSettings(tuned, 11);
  assert.equal(tuned.posting.graceMin, 40, 'ручная настройка затёрта миграцией');
});

test('миграция v15 не навязывает прежний профиль активности', () => {
  const settings = defaults.deepMerge(defaults.DEFAULTS, {
    version: 14,
    enabled: true,
    autopilot: true,
    limits: { perDay: 9 },
    posting: { perDay: 4, intervalHours: 3 },
  });

  defaults.migrateSettings(settings, 14);
  assert.equal(settings.limits.perDay, 9);
  assert.equal(settings.posting.perDay, 4);
  assert.equal(settings.posting.intervalHours, 3);
  assert.equal(settings.enabled, false);
  assert.equal(settings.autopilot, false);
});

test('форматы постов: короткие теперь весят больше длинных', () => {
  const K = postplan.POST_KINDS;
  const shortShare = Object.values(K)
    .filter((k) => k.parts === 1 && k.len[1] <= 140)
    .reduce((s, k) => s + k.share, 0);
  const longShare = Object.values(K)
    .filter((k) => k.len[1] > 200)
    .reduce((s, k) => s + k.share, 0);

  assert.ok(shortShare > longShare,
    `короткие форматы ${shortShare} против длинных ${longShare}: по замерам 01.08 `
    + 'пост до ста символов набирает быстрее, а 350+ вдвое медленнее среднего');
  assert.ok(K.question.share >= 4, 'вопрос — самый быстрый формат ниши, вес не может быть низким');
});

test('короткому формату промпт просит краткость, длинному — наоборот', () => {
  const s = defaults.DEFAULTS;
  const shortSys = prompts.postSystem(s, postplan.POST_KINDS.question,
    postplan.lenLimits('question', s));
  const longSys = prompts.postSystem(s, postplan.POST_KINDS.prompts,
    postplan.lenLimits('prompts', s));

  assert.ok(/Чем короче, тем лучше/.test(shortSys), 'вопрос не должен гнаться за потолком');
  assert.ok(/верхнюю половину/.test(longSys), 'промптам длина нужна по существу');
});

/* ------------------------------------------------------------------ */

// Дожидаемся асинхронных проверок: без этого итог печатается до их исхода.

/* ------------------- Полезные разборы инструментов ---------------------- */

test('команда установки собирается только из данных, а не по догадке', () => {
  /*
   * Главное правило формата: ни одной выдуманной команды. Читатель, у которого
   * скопированная строка не сработала, второй раз не придёт, и один такой
   * случай стоит дороже десяти удачных постов.
   */
  const npm = { name: 'ai.foo/weather', pkg: { registryType: 'npm', identifier: 'weather-mcp' } };
  assert.equal(tools.installCommand(npm), 'claude mcp add weather -- npx -y weather-mcp');

  const py = { name: 'x/db', pkg: { registryType: 'pypi', identifier: 'db-mcp' } };
  assert.equal(tools.installCommand(py), 'claude mcp add db -- uvx db-mcp');

  // Неизвестный тип реестра — не команда «на всякий случай», а честный отказ.
  assert.equal(tools.installCommand({ name: 'x/y', pkg: { registryType: 'brew', identifier: 'z' } }), null);
  assert.equal(tools.installCommand({ name: 'x/y' }), null);
});

test('в разбор не идут ни списки, ни гиганты, ни заброшенное', () => {
  const now = Date.parse('2026-08-02T12:00:00Z');
  const fresh = new Date(now - 5 * 864e5).toISOString();
  const wanted = ['mcp', 'claude'];

  const good = {
    name: 'a/mcp-notion',
    description: 'MCP server for Notion: search, read and update pages from Claude Code',
    stars: 3200,
    updatedAt: fresh,
    pkg: { registryType: 'npm', identifier: 'notion-mcp' },
  };
  assert.ok(tools.scoreTool(good, now, wanted) > 0.5, 'нишевый живой инструмент обязан проходить');

  /*
   * Гигант формально по теме, а пост о нём не несёт ничего: о нём знает каждый,
   * кто открывал тему. Живой прогон вынес наверх n8n и gemini-cli со ста
   * тысячами звёзд — отсюда окно популярности вместо «чем больше, тем лучше».
   */
  const giant = { ...good, stars: 190000 };
  assert.ok(tools.scoreTool(giant, now, wanted) < tools.scoreTool(good, now, wanted) * 0.5,
    'стотысячник должен уступать нишевому инструменту');

  // Список инструментов — не инструмент.
  const list = { ...good, name: 'x/awesome-mcp', description: 'Awesome curated list of MCP servers and clients' };
  assert.equal(tools.scoreTool(list, now, wanted), 0);

  // Заброшенное: читатель поставит и упрётся в несовместимость.
  const dead = { ...good, updatedAt: new Date(now - 700 * 864e5).toISOString() };
  assert.ok(tools.scoreTool(dead, now, wanted) < tools.scoreTool(good, now, wanted) * 0.2);

  /*
   * Тема репозитория ставится автором и врёт: скрапер Google Maps с меткой
   * mcp-server прошёл первый вариант фильтра и чуть не уехал в пост. Поэтому
   * нишевость проверяется по имени и описанию.
   */
  const offtopic = {
    name: 'g/google-maps-scraper',
    description: 'Scrape data from Google Maps: name, address, phone, reviews',
    stars: 5000,
    updatedAt: fresh,
    topics: ['mcp-server'],
    pkg: null,
  };
  assert.equal(tools.scoreTool(offtopic, now, wanted), 0);
});

test('об одном инструменте не рассказываем дважды', () => {
  const pool = [{ id: 'a', score: 2 }, { id: 'b', score: 1 }];
  const state = { toldTools: [] };

  assert.equal(tools.pickTool(state, pool).id, 'a', 'сначала тот, кем пользуется больше людей');
  tools.rememberTool(state, { id: 'a' });
  assert.equal(tools.pickTool(state, pool).id, 'b');
  tools.rememberTool(state, { id: 'b' });
  assert.equal(tools.pickTool(state, pool), null, 'закончились — значит закончились, а не по кругу');
});

test('полезные слоты разнесены по дню и не зависят от розыгрыша', () => {
  /*
   * «Дважды в день полезный пост» — обещание, а не пожелание. При доле в общем
   * мешке форматов такой пост в один день вышел бы трижды, в другой не вышел
   * бы вовсе.
   */
  const posting = {
    perDayMin: 6, perDayMax: 11, windowFromHour: 7, windowToHour: 24,
    guidesPerDay: 2, jitterMin: 25,
  };

  for (const day of ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']) {
    const slots = postplan.daySlots(posting, day);
    const guides = [...postplan.guideSlots(posting, day)].sort((a, b) => a - b);

    assert.equal(guides.length, 2, `на ${day} полезных слотов ${guides.length}`);
    assert.ok(guides.every((i) => i >= 0 && i < slots.length), 'слот вне расписания');
    assert.ok(guides[1] - guides[0] >= 2,
      `на ${day} разборы идут подряд (${guides}) — это полтора часа инструкций и день тишины`);
  }

  assert.equal(postplan.guideSlots({ ...posting, guidesPerDay: 0 }, '2026-08-02').size, 0,
    'ноль обязан выключать формат целиком');
});

/* ------------------------------ Воронка --------------------------------- */

test('подпись воронки не повторяет предыдущую и не ломает длину', () => {
  const settings = { funnel: { tails: ['раз', 'два', 'три'] } };
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(funnel.pickTail(settings, { lastTail: 'раз' }));
  assert.ok(!seen.has('раз'), 'выпала подпись, которая была прошлой');
  assert.ok(seen.size >= 2, 'подпись не меняется вовсе');

  const parts = ['первое', 'второе'];
  const fit = funnel.appendTail(parts, 'ссылка в профиле', 100);
  assert.ok(fit.added && fit.parts[1].includes('ссылка в профиле'));
  assert.equal(fit.parts[0], 'первое', 'подпись ушла не в ту часть');

  /*
   * Подпись — добавка. Ради неё нельзя ни сокращать разбор, ни ломать потолок:
   * разбор без подписи полезен, подпись без разбора бессмысленна.
   */
  const tight = funnel.appendTail(['x'.repeat(95)], 'ссылка в профиле', 100);
  assert.equal(tight.added, false);
  assert.equal(tight.parts[0].length, 95, 'исходный текст пострадал');
});

test('пост ждёт комментария со ссылкой и получает его один раз', () => {
  const now = Date.parse('2026-08-02T20:00:00Z');
  const state = {};
  funnel.queueFollowup(state, 'Разбор drawio-skill: диаграммы из текста', now);
  assert.equal(state.followupQueue.length, 1);

  // Повторная постановка того же поста ничего не удваивает.
  funnel.queueFollowup(state, 'Разбор drawio-skill: диаграммы из текста', now);
  assert.equal(state.followupQueue.length, 1);

  const cards = [
    { authorHandle: 'someone', url: 'u/x', text: 'чужой пост', ageMinutes: 5 },
    { authorHandle: 'example_user', url: 'u/1', text: 'Разбор drawio-skill: диаграммы из текста', ageMinutes: 40 },
    { authorHandle: 'example_user', url: 'u/2', text: 'другой мой пост', ageMinutes: 10 },
  ];

  const found = funnel.pickFollowup(cards, state, 'example_user', now);
  assert.ok(found, 'свой пост из очереди не опознан');
  assert.equal(found.card.url, 'u/1');

  funnel.dropFollowup(state, found.entry.key);
  assert.equal(funnel.pickFollowup(cards, state, 'example_user', now), null,
    'после попытки пост обязан выйти из очереди — второй комментарий выглядит навязчиво');

  // Остывший пост не обслуживаем: под вчерашним постом ссылку никто не увидит.
  const old = {};
  funnel.queueFollowup(old, 'старый пост', now - 30 * 3.6e6);
  const oldCards = [{ authorHandle: 'example_user', url: 'u/3', text: 'старый пост', ageMinutes: 1800 }];
  assert.equal(funnel.pickFollowup(oldCards, old, 'example_user', now), null);
});

test('ссылка в комментарии собирается кодом, а не моделью', () => {
  const settings = {
    funnel: {
      telegram: 'https://example.com/community',
      followup: { enabled: true, texts: ['вот: {link}', 'тут: {link}'] },
    },
  };
  const r = funnel.followupText(settings, {});
  assert.ok(r.text.includes('https://example.com/community'), 'адрес не подставился');
  assert.equal(funnel.followupText({ funnel: { followup: { enabled: false } } }, {}), null);
});

/* ----------------------------- Карточка --------------------------------- */

test('перенос строк на карточке не теряет текст молча', () => {
  /*
   * Канвас переносов не умеет вовсе: рисует одну строку и обрезает остальное
   * без единой жалобы. Заголовок из шести слов превратился бы в три с половиной.
   */
  const ctx = { measureText: (s) => ({ width: s.length * 10 }) };

  const lines = cardimage.wrap(ctx, 'короткий заголовок инструмента', 200);
  assert.ok(lines.length >= 2, 'длинная строка не разбилась');

  // Обрезанное должно выглядеть обрезанным.
  const clipped = cardimage.wrap(ctx, 'одно два три четыре пять шесть семь восемь', 100, 2);
  assert.equal(clipped.length, 2);
  assert.ok(clipped[1].endsWith('…'), 'обрезка молчит о том, что текст не поместился');
});

test('на карточку идёт первое предложение справки, а не абзац', () => {
  const s = cardimage.firstSentence('Генерирует диаграммы из текста. Поддерживает UML, BPMN и C4. Ещё много всего.');
  assert.equal(s, 'Генерирует диаграммы из текста. Поддерживает UML, BPMN и C4.',
    'на карточку должно попасть столько предложений, сколько складывается в мысль');
  assert.ok(cardimage.firstSentence('Одно очень длинное предложение без точки на конце '.repeat(6), 120).length <= 120);
  assert.equal(cardimage.formatStars(6197), '6.2k');
  assert.equal(cardimage.formatStars(940), '940');
});

/* ------------------------------------------------------------------ *
 * Ритм дня
 *
 * Проверяется не «функция что-то вернула», а свойства, ради которых модуль и
 * написан: дни различаются, распорядок держится в заданных границах, выходной
 * действительно пустой, а не «почти обычный», и вчерашний план не выдаёт себя
 * за сегодняшний.
 * ------------------------------------------------------------------ */

const rhythm = await load('bg/rhythm.js');

test('распорядок отличается день ото дня', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');
  s.enabled = true;

  const wakes = new Set();
  const moods = new Set();
  for (let i = 0; i < 200; i++) {
    const plan = rhythm.rollDay(s, new Date());
    wakes.add(plan.wake);
    moods.add(plan.mood);
  }

  assert.ok(wakes.size > 20, `подъём должен плавать, а вышло ${wakes.size} различных значений`);
  assert.ok(moods.size >= 3, `настроений дня должно быть несколько, а вышло ${[...moods].join(', ')}`);
});

test('подъём и отбой не уезжают дальше заданного разброса', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');
  const drift = s.rhythm.driftHours;

  for (let i = 0; i < 300; i++) {
    const plan = rhythm.rollDay(s, new Date());
    if (plan.mood === 'off') continue;   // у выходного своё короткое окно
    assert.ok(Math.abs(plan.wake - s.timing.activeFrom) <= drift + 0.01,
      `подъём ${plan.wake} вышел за ±${drift} от ${s.timing.activeFrom}`);
    assert.ok(Math.abs(plan.sleep - s.timing.activeTo) <= drift + 0.01,
      `отбой ${plan.sleep} вышел за ±${drift} от ${s.timing.activeTo}`);
  }
});

test('в выходной дневная норма нулевая, но агент не исчезает совсем', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');
  s.enabled = true;
  s.limits.warmupDays = 0;   // смотрим на настроение, а не на прогрев

  let seenOff = 0;
  for (let i = 0; i < 400 && seenOff < 5; i++) {
    const plan = rhythm.rollDay(s, new Date());
    if (plan.mood !== 'off') continue;
    seenOff++;

    const st = { rhythm: plan, firstRunDate: '2020-01-01' };
    assert.equal(limiter.rollDailyLimit(s, st), 0, 'в выходной комментариев быть не должно');

    const len = ((plan.sleep - plan.wake) + 24) % 24;
    assert.ok(len >= 0.4 && len <= 2.2,
      `в выходной агент заглядывает ненадолго, а окно вышло ${len.toFixed(2)} ч`);
  }
  assert.ok(seenOff > 0, 'при доле 18% выходной обязан выпасть хотя бы раз за 400 попыток');
});

test('отлучки лежат внутри дня и не наслаиваются', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');

  for (let i = 0; i < 200; i++) {
    const plan = rhythm.rollDay(s, new Date());
    if (plan.mood === 'off') continue;

    for (let k = 1; k < plan.gaps.length; k++) {
      assert.ok(plan.gaps[k].from > plan.gaps[k - 1].to,
        'пересекающиеся отлучки должны были слиться в одну');
    }
    for (const g of plan.gaps) {
      assert.ok(g.to > g.from, 'отлучка нулевой длины бессмысленна');
      assert.ok(g.from >= plan.wake, 'отлучка не может начаться до подъёма');
    }
  }
});

test('вчерашний распорядок не считается сегодняшним', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');
  const yesterday = new Date(Date.now() - 86400000);
  const stale = rhythm.rollDay(s, yesterday);

  assert.equal(rhythm.planFresh(stale), false, 'план вчерашних суток обязан протухнуть');
  assert.equal(rhythm.planFresh(rhythm.rollDay(s, new Date())), true);

  // А расписание без свежего плана возвращается к неподвижной рамке настроек.
  const t = scheduler.effectiveTiming(s, { rhythm: stale });
  assert.equal(t.activeFrom, s.timing.activeFrom, 'протухший план не должен двигать окно');
});

test('прогрев после ограничения считается заново, а не от первого запуска', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');

  const old = { firstRunDate: '2020-01-01', restartDate: null };
  assert.equal(limiter.warmupLimit(s, old), s.limits.perDay,
    'аккаунт трёхлетней давности прогрева не требует');

  const restarted = { firstRunDate: '2020-01-01' };
  limiter.restartWarmup(restarted);
  assert.equal(limiter.warmupLimit(s, restarted), s.limits.warmupStartPerDay,
    'после перезапуска прогрева норма начинается со стартовой');
});

test('пологая кривая держит первую неделю почти пустой', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');
  const at = (day) => limiter.warmupLimit(s, {
    restartDate: new Date(Date.now() - day * 86400000).toISOString().slice(0, 10),
  });

  assert.ok(at(0) <= 1, `первый день должен давать один комментарий, а вышло ${at(0)}`);
  assert.ok(at(6) <= 2, `к концу первой недели не больше двух, а вышло ${at(6)}`);
  assert.ok(at(20) >= 5, `к третьей неделе норма должна подойти к полной, а вышло ${at(20)}`);
  assert.equal(at(25), s.limits.perDay, 'после прогрева работает полная норма');

  // Монотонность: норма не должна проседать назад ни на одном дне.
  for (let d = 1; d <= 25; d++) {
    assert.ok(at(d) >= at(d - 1), `на дне ${d} норма упала: ${at(d - 1)} → ${at(d)}`);
  }
});

test('свои посты начинаются не раньше назначенного дня', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');
  const state = (day) => ({
    postedSlots: {},
    restartDate: new Date(Date.now() - day * 86400000).toISOString().slice(0, 10),
  });

  assert.equal(postplan.slotDue(s.posting, state(1)).due, false, 'на второй день своих постов быть не должно');
  assert.match(postplan.slotDue(s.posting, state(1)).why, /с 10-го дня/);
  // А после срока запрет снимается — дальше решает уже расписание слотов.
  assert.doesNotMatch(postplan.slotDue(s.posting, state(12)).why || '', /с 10-го дня/);
});

test('длина комментария разыгрывается, а не повторяет одно число', () => {
  const s = defaults.applyPreset(structuredClone(defaults.DEFAULTS), 'careful');

  const targets = new Set();
  const labels = new Set();
  for (let i = 0; i < 300; i++) {
    const len = prompts.rollLength(s.style);
    targets.add(len.target);
    labels.add(len.label);
    assert.ok(len.min < len.max, 'диапазон длины должен быть непустым');
    assert.ok(len.target >= len.min && len.target <= len.max, 'цель обязана лежать внутри диапазона');
    assert.ok(len.max <= s.style.maxLen, 'разброс не должен пробивать потолок стиля');
  }

  assert.equal(labels.size, 3, 'должны встречаться все три длины реплики');
  assert.ok(targets.size > 30, `цель должна плавать, а вышло ${targets.size} различных значений`);
});

await Promise.all(pending);

console.log(`\n${'='.repeat(46)}`);
console.log(`Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);

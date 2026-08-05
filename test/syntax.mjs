/**
 * Проверка синтаксиса всех файлов расширения.
 *
 * Модули из bg/common/ui грузятся как ES-модули. Content-скрипты — классические
 * скрипты в общей области, импортов у них нет, поэтому они проверяются
 * компиляцией в vm.Script: полноценно выполнить их вне браузера всё равно
 * нельзя, но синтаксическую ошибку это ловит.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';

// fileURLToPath, а не .pathname: путь содержит кириллицу и пробел,
// в URL они процентно-закодированы.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const isContent = (p) => p.split(sep).includes('content');

let failed = 0;
let checked = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  try {
    if (isContent(file)) {
      // eslint-disable-next-line no-new
      new vm.Script(readFileSync(file, 'utf8'), { filename: file });
    } else {
      await import(pathToFileURL(file).href);
    }
    checked++;
  } catch (e) {
    // Модуль загрузился и упал на обращении к браузерному API — значит,
    // синтаксис в порядке. Это и есть предмет проверки; исполнить код
    // расширения вне браузера всё равно невозможно.
    if (/(chrome|document|window|location|navigator) is not defined|Cannot read properties of (undefined|null)/.test(e.message)) {
      checked++;
      continue;
    }
    failed++;
    console.error(`FAIL  ${rel}\n      ${e.name}: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Обращения к несуществующим функциям соседних модулей
 *
 * Content-скрипты общаются через общий объект `window.__TA`. Никакого импорта
 * между ними нет, поэтому опечатка в имени функции ничем себя не выдаёт до
 * самого исполнения — и всплывает уже на живой странице.
 *
 * Живой случай: в публикаторе стояло `TA.scroll.human(...)`, тогда как модуль
 * прокрутки экспортирует `by`, `screenDown`, `browse`, `waitForMore`, `toTop`,
 * `fidget`. Синтаксис безупречен, все тесты зелёные, падение — в бою после
 * успешной публикации.
 *
 * Проверка простая: собрать, что каждый модуль кладёт в `TA.<имя> = {...}`, и
 * сверить с тем, что у него вызывают остальные.
 * ------------------------------------------------------------------ */

const exportsByModule = new Map();
const contentFiles = files.filter(isContent);

/**
 * Тело объекта от открывающей скобки до парной ей.
 *
 * Регулярным выражением это не берётся: модули пишут экспорт и в одну строку,
 * и в десять, и с вложенными объектами внутри. Первая версия разбора искала
 * `};` с переноса строки и молча пропускала однострочные — то есть ровно те
 * модули, где ошибка и жила.
 */
function objectBody(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

for (const file of contentFiles) {
  const src = readFileSync(file, 'utf8');
  const re = /TA\.(\w+)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const body = objectBody(src, m.index + m[0].length - 1);
    if (body == null) continue;

    // Ключи верхнего уровня: вложенные объекты и подписи пропускаем.
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const names = new Set();
    let depth = 0;
    let token = '';
    for (const ch of `${clean},`) {
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;

      if (ch === ',' && depth === 0) {
        const key = /^\s*(\w+)\s*(?::|$)/.exec(token);
        if (key) names.add(key[1]);
        token = '';
      } else {
        token += ch;
      }
    }

    exportsByModule.set(name, new Set([...(exportsByModule.get(name) || []), ...names]));
  }
}

/* Модули, которых в content нет: они приходят из фона или браузера. */
const EXTERNAL = new Set(['util', 'rng']);

/*
 * Проверка обязана доказать, что она вообще что-то видит.
 *
 * Разбор идёт регулярным выражением по форматированию, а форматирование
 * меняется. Если однажды перестанет распознаваться половина модулей, проверка
 * не упадёт — она просто замолчит, и молчание будет неотличимо от успеха. Эти
 * имена и есть страховка от такого исхода.
 */
const MUST_SEE = ['sel', 'scroll', 'composer', 'typing', 'thread'];
const missed = MUST_SEE.filter((m) => !exportsByModule.has(m));
if (missed.length) {
  console.error(`FAIL  разбор экспортов сломался: не видно модулей ${missed.join(', ')}`);
  console.error('      проверка обращений между модулями стала бесполезной');
  failed += missed.length;
}

let apiFails = 0;
for (const file of contentFiles) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');

  const use = /\bTA\.(\w+)\.(\w+)\s*\(/g;
  let m;
  while ((m = use.exec(src))) {
    const [, mod, fn] = m;
    if (EXTERNAL.has(mod)) continue;

    const known = exportsByModule.get(mod);
    if (!known) continue;            // модуль собирается иначе — не наше дело
    if (known.has(fn)) continue;

    apiFails++;
    console.error(`FAIL  ${rel}\n      TA.${mod}.${fn}() — модуль такого не экспортирует`);
    console.error(`      есть: ${[...known].sort().join(', ')}`);
  }
}

/* ------------------------------------------------------------------ *
 * Обращения к несуществующим ключам перечней
 *
 * Перечни вроде `HALT`, `MSG`, `SKIP` — обычные объекты, и опечатка в имени
 * ключа даёт не ошибку, а `undefined`. Дальше это `undefined` едет по коду как
 * настоящее значение и всплывает в самом неудобном месте.
 *
 * Живой случай, ради которого проверка написана. В `orchestrator.js` стояло
 * `HALT.SHADOW`, тогда как перечень знает `SHADOW_BAN`. Агент остановился
 * 03.08 в 23:41 с причиной `undefined`: показать её было нечем (в плашке
 * «остановка: undefined»), сопоставить `reason === HALT.BUDGET` — тоже, а срок
 * у остановки не проставили, поэтому снять её могла только рука. Простой
 * составил четырнадцать часов, и в журнале об этом не было ни строки.
 *
 * Сверка идёт с живым объектом, а не со списком имён: список пришлось бы
 * поддерживать, и он бы отстал.
 * ------------------------------------------------------------------ */

const ENUM_MODULES = ['common/messages.js', 'common/skipcodes.js', 'bg/recovery.js', 'common/pages.js'];
const enums = new Map();

for (const rel of ENUM_MODULES) {
  const mod = await import(pathToFileURL(join(ROOT, 'src', rel)).href);
  for (const [name, value] of Object.entries(mod)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const keys = Object.keys(value);
    // Перечень — это объект, у которого все ключи в ВЕРХНЕМ_РЕГИСТРЕ.
    if (!keys.length || !keys.every((k) => /^[A-Z][A-Z0-9_]*$/.test(k))) continue;
    enums.set(name, new Set(keys));
  }
}

let enumFails = 0;
let enumUses = 0;

if (enums.size) {
  const names = [...enums.keys()].sort((a, b) => b.length - a.length).join('|');
  for (const file of files) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const use = new RegExp(`\\b(${names})\\.([A-Za-z_]\\w*)\\b`, 'g');
    let m;
    while ((m = use.exec(src))) {
      const [, name, key] = m;
      const known = enums.get(name);
      enumUses++;
      if (known.has(key)) continue;

      enumFails++;
      console.error(`FAIL  ${rel}\n      ${name}.${key} — такого ключа в перечне нет`);
      console.error(`      есть: ${[...known].sort().join(', ')}`);
    }
  }
}

/*
 * Та же страховка, что и у сверки модулей: проверка, которая ничего не нашла,
 * молчит точно так же, как проверка, у которой всё сошлось.
 */
if (enums.size < 3 || enumUses < 50) {
  console.error(`FAIL  разбор перечней сломался: ${enums.size} перечней, ${enumUses} обращений`);
  enumFails++;
}

/* ------------------------------------------------------------------ *
 * Настройки пресета доезжают до кода
 *
 * Пресет — это обещание: «выбрал режим, и агент работает так». Обещание
 * нарушалось дважды и молча. Сначала `applyPreset` переносил только семь
 * поимённо перечисленных разделов, и всё, что писали в пресет сверх этого
 * списка, терялось по дороге. Потом настройку заводили в пресете, а читать её
 * в коде забывали — она честно лежала в хранилище и ни на что не влияла.
 *
 * Обе беды невидимы снаружи: агент работает, журнал чист, а режим не тот,
 * который выбрали. Проверка ловит их так:
 *
 *  1. каждый путь из пресета обязан существовать в схеме `DEFAULTS` —
 *     иначе настройка висит в воздухе и в UI её никто не увидит;
 *  2. `applyPreset` обязан донести значение до настроек — сверяем результатом,
 *     а не чтением кода;
 *  3. имя ключа обязано встречаться в коде расширения — настройка, которую
 *     никто не читает, не работает, что бы в ней ни стояло.
 * ------------------------------------------------------------------ */

const { PRESETS, DEFAULTS, applyPreset } = await import(
  pathToFileURL(join(ROOT, 'src/common/defaults.js')).href
);

const PRESET_META = new Set(['label', 'hint']);

function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (prefix === '' && PRESET_META.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, path));
    else out.push(path);
  }
  return out;
}

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/*
 * Срез кода без самой схемы.
 *
 * `defaults.js` исключён намеренно: там настройка объявлена по определению, и
 * с ним в выборке проверка «ключ встречается в коде» всегда проходила бы —
 * то есть не проверяла бы ничего. Нас интересует ровно обратное: читает ли
 * настройку хоть кто-нибудь, кроме того места, где её завели.
 */
const allCode = files
  .filter((f) => !f.endsWith('defaults.js'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

let presetFails = 0;
let presetChecks = 0;

for (const [name, preset] of Object.entries(PRESETS)) {
  const applied = applyPreset(structuredClone(DEFAULTS), name);

  for (const path of leafPaths(preset)) {
    presetChecks++;
    const want = at(preset, path);

    if (at(DEFAULTS, path) === undefined) {
      presetFails++;
      console.error(`FAIL  пресет ${name}: ${path} — такого пути нет в DEFAULTS`);
      continue;
    }

    const got = at(applied, path);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      presetFails++;
      console.error(`FAIL  пресет ${name}: ${path} не доехал через applyPreset`);
      console.error(`      в пресете ${JSON.stringify(want)}, в настройках ${JSON.stringify(got)}`);
      continue;
    }

    const key = path.split('.').pop();
    if (!new RegExp(`\\b${key}\\b`).test(allCode)) {
      presetFails++;
      console.error(`FAIL  пресет ${name}: ${path} — ключ «${key}» не встречается в коде расширения`);
    }
  }
}

if (presetChecks < 50) {
  console.error(`FAIL  разбор пресетов сломался: проверок ${presetChecks}`);
  presetFails++;
}

console.log(`\nПроверено файлов: ${checked}, ошибок: ${failed + apiFails + enumFails + presetFails}`);
if (!apiFails) console.log(`Сверено обращений между модулями: ${exportsByModule.size} модулей`);
if (!enumFails) console.log(`Сверено обращений к перечням: ${enumUses} в ${enums.size} перечнях`);
if (!presetFails) console.log(`Сверено настроек пресетов: ${presetChecks} в ${Object.keys(PRESETS).length} режимах`);
process.exit(failed + apiFails + enumFails + presetFails ? 1 : 0);

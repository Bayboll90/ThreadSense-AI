/**
 * Гуманизация текста.
 *
 * Почему это отдельный локальный слой, а не строчка в промпте. Языковые модели
 * плохо исполняют инструкцию «пиши с ошибками»: они либо игнорируют её, либо
 * выдают карикатуру — «прривет как дилаа». Настоящие опечатки имеют физическую
 * природу: палец соскользнул на соседнюю клавишу, буквы поменялись местами из-за
 * скорости, клавиша отскочила и продублировала символ. Это моделируется кодом
 * точнее, чем текстовой просьбой, и главное — предсказуемо по частоте.
 *
 * Второе назначение — вычистка стилистических отпечатков ИИ. Длинное тире,
 * идеальная пунктуация, обороты вида «Стоит отметить» и «Таким образом» узнаются
 * мгновенно и человеком, и классификатором.
 */

import { chance, pick, weightedPick, randInt, uniform } from '../common/rng.js';
import { truncateWords } from '../common/text.js';

/* ------------------------- Раскладка ЙЦУКЕН ------------------------------ */

const ROWS_RU = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];
const ROWS_EN = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Карта соседей по физической клавиатуре: слева, справа, сверху, снизу. */
function buildNeighbors(rows) {
  const map = {};
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      const n = new Set();
      if (c > 0) n.add(row[c - 1]);
      if (c < row.length - 1) n.add(row[c + 1]);
      // Ряды смещены примерно на пол-клавиши, поэтому берём две соседние сверху и снизу.
      for (const dr of [-1, 1]) {
        const other = rows[r + dr];
        if (!other) continue;
        for (const dc of [0, -1, 1]) {
          const idx = c + dc;
          if (idx >= 0 && idx < other.length) n.add(other[idx]);
        }
      }
      map[ch] = [...n];
    }
  });
  return map;
}

const NEIGHBORS = { ...buildNeighbors(ROWS_RU), ...buildNeighbors(ROWS_EN) };

/** Сосед по клавиатуре с сохранением регистра. */
export function neighborKey(ch) {
  const lower = ch.toLowerCase();
  const list = NEIGHBORS[lower];
  if (!list || !list.length) return null;
  const rep = pick(list);
  return ch === ch.toUpperCase() && ch !== lower ? rep.toUpperCase() : rep;
}

/* ------------------------------- Опечатки -------------------------------- */

const VOWELS_RU = 'аеиоуыэюя';

/** Внести одну опечатку в слово. Возвращает null, если слово не подошло. */
export function typoWord(word, mix) {
  if (word.length < 3) return null;

  const kind = weightedPick([
    ['swap', mix.swap],
    ['drop', mix.drop],
    ['double', mix.double],
    ['neighbor', mix.neighbor],
  ]);

  // Первую букву не трогаем: опечатка в начале слова слишком бросается в глаза
  // и читается как небрежность, а не как быстрый набор.
  const lo = 1;
  const hi = word.length - 1;
  if (hi <= lo) return null;

  switch (kind) {
    case 'swap': {
      const i = randInt(lo, hi - 1);
      if (word[i] === word[i + 1]) return null;
      return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    }
    case 'drop': {
      // Последнюю букву не выбрасываем. «трогай» → «трога» читается не как
      // промах пальца, а как обрубленное слово: глаз спотыкается сильнее,
      // чем на любой опечатке в середине.
      if (hi - 1 < lo) return null;
      const i = randInt(lo, hi - 1);
      return word.slice(0, i) + word.slice(i + 1);
    }
    case 'double': {
      const i = randInt(lo, hi);
      return word.slice(0, i + 1) + word[i] + word.slice(i + 1);
    }
    case 'neighbor': {
      /*
       * Замена буквы соседней по клавиатуре — единственный вид опечатки,
       * который способен превратить слово в **другое настоящее слово**, и это
       * не теория. Живой ответ читателю 02.08: «ручные правки» вышли как
       * «русные правки» — «ч» и «с» стоят рядом в нижнем ряду. Читатель видит
       * не спешку, а бессмыслицу, и смысл фразы меняется.
       *
       * Чем короче слово, тем выше шанс попасть в существующее: «код» → «кот»,
       * «база» → «ваза», «тест» → «текст». У длинных слов такого соседа
       * практически не находится, поэтому граница по длине, а не запрет.
       *
       * Остальные три вида безопасны по построению: перестановка, пропуск и
       * удвоение дают форму, которой в языке нет, — она читается ровно как
       * то, чем является, как промах пальца.
       */
      if (word.length < NEIGHBOR_MIN_LEN) return null;
      const i = randInt(lo, hi);
      const rep = neighborKey(word[i]);
      if (!rep) return null;
      return word.slice(0, i) + rep + word.slice(i + 1);
    }
    default:
      return null;
  }
}

/** Короче этого замена соседней клавишей слишком часто даёт другое слово. */
const NEIGHBOR_MIN_LEN = 8;

/** Растянуть гласную: «ну» → «нуууу». */
export function stretchVowel(word) {
  const idxs = [];
  for (let i = 0; i < word.length; i++) {
    if (VOWELS_RU.includes(word[i].toLowerCase())) idxs.push(i);
  }
  if (!idxs.length) return null;
  const i = pick(idxs);
  return word.slice(0, i) + word[i].repeat(randInt(3, 5)) + word.slice(i + 1);
}

/* --------------------------- Уборка после вырезки -------------------------- */

/**
 * Привести пунктуацию в порядок после удаления штампа из середины фразы.
 *
 * Вырезка оборота почти всегда оставляет мусор. «Кстати, важно отметить, что
 * результат зависит от данных» после удаления двух штампов превращается в
 * «. , что результат зависит от данных»: осиротевшая запятая и придаточное
 * без главного предложения. Читается это хуже, чем исходный штамп.
 */
export function tidyAfterRemoval(text) {
  let t = String(text || '');

  // Придаточное, оставшееся без главного: «, что результат…» → «результат…».
  // Ведущие пробелы учитываем: после вырезки штампа строка начинается с них.
  // Граница слова задана явным просмотром вперёд, а не \b: в JavaScript \b
  // определяется по ASCII, и после кириллической буквы он не срабатывает
  // никогда — «\bчто\b» не совпадает ни с чем.
  t = t.replace(
    /(^\s*|[.!?]\s*)[,;:]\s*(что|чтобы|как|где|когда|который|которая)(?![\p{L}\p{N}_])\s*/giu,
    '$1',
  );

  // Осиротевшая пунктуация сразу после конца предложения или в начале строки.
  t = t.replace(/([.!?])\s*[,;:]+\s*/g, '$1 ');
  t = t.replace(/^\s*[,;:.!?]+\s*/, '');

  // Сдвоенные разделители и пробелы перед ними.
  t = t.replace(/\s+([,;:.!?])/g, '$1');
  t = t.replace(/([,;:])\s*\1+/g, '$1');
  t = t.replace(/\s{2,}/g, ' ');

  t = t.trim();

  // Первая буква фразы после вырезки могла остаться строчной посреди
  // предложения — поднимаем её, регистр всё равно потом разыгрывается отдельно.
  if (t && /[а-яa-z]/.test(t[0])) t = t[0].toUpperCase() + t.slice(1);

  return t;
}

/* -------------------------------- Обрезка --------------------------------- */

/**
 * Служебные слова, на которых нельзя оборвать фразу.
 * Обрезка строго по границе слова оставляет висящие союзы и предлоги:
 * «…добивал тестовыми наборами. иначе» — фраза выглядит не сокращённой,
 * а брошенной на полуслове.
 */
const DANGLING = new Set([
  'и', 'а', 'но', 'или', 'либо', 'да', 'что', 'чтобы', 'если', 'иначе',
  'потому', 'поэтому', 'значит', 'как', 'когда', 'где', 'куда', 'пока',
  'то', 'же', 'бы', 'ли', 'не', 'ни', 'вот', 'так', 'там', 'тут', 'ещё', 'еще',
  'уже', 'только', 'даже', 'чем', 'тем', 'это', 'этот', 'эта', 'тот', 'та',
  'в', 'во', 'на', 'с', 'со', 'по', 'за', 'из', 'от', 'до', 'для', 'про',
  'у', 'о', 'об', 'при', 'над', 'под', 'без', 'через', 'между', 'перед',
  'мой', 'наш', 'их', 'его', 'её', 'ее', 'свой', 'один', 'одна',
]);

/** Обрывается ли текст на служебном слове. */
export function endsDangling(text) {
  const words = String(text || '').trim().split(/\s+/);
  const last = (words[words.length - 1] || '').toLowerCase().replace(/[^\p{L}]/gu, '');
  return !!last && DANGLING.has(last);
}

/**
 * Умная обрезка до предела.
 *
 * Сначала пробуем закончить на границе предложения — так текст выглядит
 * законченным, а не оборванным. Если предложение целиком не влезает, режем
 * по слову и снимаем повисшие служебные слова.
 */
export function smartTruncate(text, maxLen) {
  const t = String(text || '').trim();
  if (t.length <= maxLen) return t;

  // Конец предложения внутри лимита, если он оставляет хотя бы половину текста.
  const head = t.slice(0, maxLen + 1);
  const lastSentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (lastSentence > maxLen * 0.5) return t.slice(0, lastSentence + 1).trim();

  let out = truncateWords(t, maxLen);

  // Снимаем висящие союзы и предлоги, до трёх подряд.
  for (let i = 0; i < 3; i++) {
    const words = out.split(/\s+/);
    const last = words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '');
    if (!last || !DANGLING.has(last)) break;
    words.pop();
    out = words.join(' ');
  }

  return out.replace(/[\s,;:—-]+$/, '').trim();
}

/* ------------------------------ Слова-паразиты ---------------------------- */

/**
 * Отсеять из списка паразитов то, что нельзя приклеить к началу фразы.
 *
 * Автообучение стиля вытаскивает из текстов не только частицы, но и целые
 * обороты вроде «а вы тоже» — они требуют продолжения, и подстановка в начало
 * даёт мусор: «а вы тоже я бы начинал с шаблона». Настоящий паразит —
 * самодостаточная вставка, после которой фраза продолжается как ни в чём
 * не бывало.
 */
const FILLER_TAIL_BAN = /(^|\s)(я|ты|вы|мы|он|она|они|это|тоже|также|же|бы|ли|не|и|а|но|что|как|где|когда|у|в|на|с|по|за|из|от|до|для|про)$/i;

/**
 * Кусок, который нельзя изъять из фразы, — то есть нельзя взять в скобки.
 *
 * Скобки говорят читателю «это можно пропустить». Оборот, открывающийся союзом
 * или союзным словом, пропустить нельзя: без него разваливается конструкция,
 * частью которой он является. Живой случай — «не написание кода, а поиск
 * места» превратилось в «не написание кода (а поиск места)».
 *
 * `\b` с кириллицей не работает (см. отдельный урок), поэтому граница слова
 * задаётся явным классом.
 */
const BOUND_OPENER = /^(?:а|но|и|или|либо|да|что|чтобы|где|куда|когда|пока|если|хотя|потому|поэтому|который|которая|которое|которые|кто|чем|тогда|значит|зато|причём|тем|то)(?![\p{L}\p{N}_])/iu;

export function usableFillers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((f) => String(f || '').trim().replace(/[.,!?…]+$/, ''))
    .filter((f) => {
      if (f.length < 2 || f.length > 14) return false;
      if (f.split(/\s+/).length > 2) return false;   // не длиннее двух слов
      if (FILLER_TAIL_BAN.test(f)) return false;      // требует продолжения
      if (/[?!]/.test(f)) return false;
      return true;
    });
}

/* ------------------------------- Пайплайн -------------------------------- */

/**
 * Прогнать текст через гуманизатор.
 *
 * @param {string} text  результат генерации
 * @param {object} settings полные настройки
 * @param {object} [opts] { force: применять всё детерминированно — для предпросмотра }
 * @returns {{text: string, applied: string[]}}
 */
export function humanize(text, settings, opts = {}) {
  const h = settings.humanize;
  const st = settings.style;
  const applied = [];

  let out = String(text || '').trim();
  if (!h?.enabled) return { text: out, applied };

  const roll = (p) => (opts.force ? p > 0 : chance(p));

  /* --- 1. Снятие типографики ИИ --- */

  if (roll(h.killEmDash)) {
    const before = out;
    out = out.replace(/\s*[—–]\s*/g, ' - ');
    if (out !== before) applied.push('длинное тире');
  }

  if (roll(h.normalizeEllipsis)) {
    const before = out;
    out = out.replace(/…/g, '...');
    if (out !== before) applied.push('многоточие');
  }

  // Кавычки-ёлочки и типографские лапки в соцсетях почти никто не ставит.
  const beforeQuotes = out;
  out = out.replace(/[«»“”„]/g, '"').replace(/[‘’]/g, "'");
  if (out !== beforeQuotes) applied.push('кавычки');

  /* --- 2. Вычистка штампов --- */

  if (roll(h.killCliches) && st.bannedPhrases?.length) {
    let stripped = out;
    for (const phrase of st.bannedPhrases) {
      const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      stripped = stripped.replace(new RegExp(`\\s*${esc}\\s*`, 'gi'), ' ');
    }
    // Уборку запускаем только если что-то действительно вырезали: иначе она
    // молча правит регистр в тексте, к которому не было претензий.
    if (stripped !== out) {
      out = tidyAfterRemoval(stripped);
      applied.push('штампы');
    }
  }

  // Модель любит открывать ответ вводным словом. Срезаем.
  const beforeLead = out;
  out = out.replace(/^(да\s+уж|ну\s+да|итак|что\s*ж|ох|эх)[,!.]?\s+/i, '');
  if (out !== beforeLead) applied.push('вводное слово');

  /* --- 2а. Живая пунктуация --- */

  /*
   * Скобка вместо запятой в пояснении.
   *
   * Модель почти всегда обособляет уточнение запятыми — правильно и ровно. В
   * переписке то же самое чаще уходит в скобки, и текст сразу читается менее
   * причёсанным. Берём только короткие вставки: длинная в скобках выглядит
   * сноской, а не репликой.
   *
   * И только **изымаемые**. Проверка на изымаемость — не педантизм, а
   * единственное, что отличает приём от поломки: скобки означают «это можно
   * пропустить при чтении», и если пропустить нельзя, фраза разваливается.
   * Живой случай 01.08: «ускоряет не написание кода, а поиск места, где ты
   * ошибся» превратилось в «ускоряет не написание кода (а поиск места) где ты
   * ошибся». Кусок, открывающийся союзом или союзным словом, связан с
   * остатком фразы грамматически и в скобки не годится никогда.
   */
  if (roll(h.parenAside ?? 0.12)) {
    const before = out;
    out = out.replace(/,\s([^,.!?()]{8,34}),\s/, (m, inner) => (BOUND_OPENER.test(inner) ? m : ` (${inner}) `));
    if (out !== before) applied.push('скобка вместо запятых');
  }

  /*
   * Обрывок вместо придаточного.
   *
   * «…, потому что дорого» → «… потому что дорого». Мелочь, но именно из таких
   * мелочей складывается ощущение, что писали быстро, а не составляли.
   */
  if (roll(h.dropComma ?? 0.1)) {
    const before = out;
    out = out.replace(/,\s(потому что|хотя|если|когда|пока)\s/i, ' $1 ');
    if (out !== before) applied.push('без запятой перед союзом');
  }

  /*
   * Тире вместо двоеточия.
   *
   * Двоеточие — признак письменной речи; в быстрой переписке на его месте чаще
   * оказывается дефис. Длинное тире при этом остаётся под запретом: оно как раз
   * главный маркер машинного текста.
   */
  if (roll(h.dashInstead ?? 0.14)) {
    const before = out;
    out = out.replace(/(\S):\s(?=\S)/, '$1 - ');
    if (out !== before) applied.push('тире вместо двоеточия');
  }

  /* --- 3. Опечатки --- */

  if (h.typoPerWord > 0) {
    const words = out.split(/(\s+)/); // разделители сохраняем
    let count = 0;
    let wordIndex = 0;
    let lastTypoAt = -99;

    /*
     * Потолок опечаток считается от длины текста, а не от настройки целиком.
     *
     * Две опечатки — норма для развёрнутого комментария на четверть тысячи
     * знаков и перебор для короткой реплики. Живой случай 02.08: ответ
     * читателю на 170 знаков вышел с двумя промахами сразу, и текст стал
     * выглядеть неряшливо там, где должен был выглядеть быстро набранным.
     * Одна опечатка на сотню знаков — та плотность, при которой она читается
     * как спешка.
     */
    const cap = Math.max(1, Math.min(h.typoMaxPerComment, Math.round(out.length / 110)));

    for (let i = 0; i < words.length && count < cap; i++) {
      const w = words[i];
      if (/^\s+$/.test(w)) continue;
      wordIndex++;

      // Первое слово не трогаем: на него смотрят внимательнее всего,
      // и опечатка там читается не как спешка, а как неграмотность.
      if (wordIndex === 1) continue;
      // Две ошибки подряд выглядят неправдоподобно: разносим их по тексту.
      if (wordIndex - lastTypoAt < 3) continue;

      if (w.length < h.typoMinWordLen) continue;
      if (/[^\p{L}]/u.test(w)) continue; // слова со знаками не трогаем
      if (!roll(h.typoPerWord)) continue;

      const t = typoWord(w, h.typoMix);
      if (t && t !== w) {
        words[i] = t;
        count++;
        lastTypoAt = wordIndex;
      }
    }
    if (count) {
      out = words.join('');
      applied.push(`опечаток: ${count}`);
    }
  }

  /* --- 4. Разговорные приёмы --- */

  /*
   * Растянутая гласная — приём разговорный, и в разборе он работает наоборот.
   *
   * Живой случай 01.08: на технической реплике «запись экрана сама по себе
   * слабое доказательство, надёжнее показать исходник с историей слоёв»
   * вышло «сааама». В короткой эмоциональной реакции это живость, а посреди
   * объяснения с числами и названиями инструментов читается как опечатка —
   * ровно тот же класс, что «иИ» из аббревиатуры.
   *
   * Признак делового текста берём наблюдаемый: числа и латиница. Там, где
   * человек приводит цифру или название, он не тянет гласные.
   */
  const businesslike = /\d/.test(out) || /[a-z]{3,}/i.test(out);

  if (!businesslike && roll(h.stretchVowel)) {
    const words = out.split(/(\s+)/);
    const cands = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!/^\s+$/.test(w) && w.length >= 2 && w.length <= 6 && /^[\p{L}]+$/u.test(w)) cands.push(i);
    }
    if (cands.length) {
      const i = pick(cands);
      const s = stretchVowel(words[i]);
      if (s) {
        words[i] = s;
        out = words.join('');
        applied.push('растянутая гласная');
      }
    }
  }

  if (roll(h.insertFiller)) {
    const filler = pick(usableFillers(st.fillers));
    if (filler) {
      // Вставляем после первого знака препинания либо в начало — там, где
      // слово-паразит и появляется в живой речи. В начале обязательно с
      // запятой: без неё «короче я бы начинал» читается как оборванная фраза.
      const m = out.match(/^([^,.!?]{8,60}[,.!?])\s+/);
      if (m && chance(0.6)) {
        out = `${m[1]} ${filler}, ${out.slice(m[0].length)}`;
      } else {
        out = `${filler}, ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
      }
      applied.push(`слово-паразит: ${filler}`);
    }
  }

  /* --- 5. Пунктуация и регистр --- */

  if (roll(h.missingSpaceAfterComma)) {
    const idxs = [];
    for (let i = 0; i < out.length - 1; i++) if (out[i] === ',' && out[i + 1] === ' ') idxs.push(i);
    if (idxs.length) {
      const i = pick(idxs);
      out = out.slice(0, i + 1) + out.slice(i + 2);
      applied.push('пропущен пробел');
    }
  }

  if (roll(h.spaceBeforePunct)) {
    const idxs = [];
    for (let i = 1; i < out.length; i++) if (',.!?'.includes(out[i]) && out[i - 1] !== ' ') idxs.push(i);
    if (idxs.length) {
      const i = pick(idxs);
      out = `${out.slice(0, i)} ${out.slice(i)}`;
      applied.push('лишний пробел');
    }
  }

  if (roll(h.yoToE)) {
    const before = out;
    out = out.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
    if (out !== before) applied.push('ё → е');
  }

  /*
   * Строчная в начале — но не в аббревиатуре.
   *
   * Живой случай: пост начинался со слова «ИИ», и опускание первой буквы дало
   * «иИ». Человек так не печатает никогда: он либо пишет всё строчными, либо
   * оставляет аббревиатуру как есть. Получилась не небрежность, а очевидная
   * поломка — ровно та, ради маскировки которой приём и существует.
   *
   * Признак аббревиатуры простой: вторая буква тоже заглавная.
   */
  if (roll(h.lowercaseStart) && out.length > 1) {
    const first = out.charAt(0);
    const second = out.charAt(1);
    const isAbbrev = second === second.toUpperCase() && second !== second.toLowerCase();

    /*
     * Имя продукта строчным не пишут — второй случай той же болезни, что «иИ».
     *
     * Живой пост 01.08 вышел как «claude Code без тестов ускоряет не
     * разработку». Внутри русского текста латинское слово с заглавной — это
     * почти всегда название: Claude, Cursor, Python, Figma. Опустив в нём
     * первую букву, приём не добавляет небрежности, а портит имя, и заметно
     * это сильнее, чем сама «слишком правильная» заглавная.
     *
     * Проверка по алфавиту, а не по списку названий: список пришлось бы
     * пополнять на каждый новый инструмент, а свойство «латиница в русском
     * тексте» не устаревает.
     */
    const isLatinName = /[a-z]/i.test(first);

    if (!isAbbrev && !isLatinName
      && first === first.toUpperCase() && first !== first.toLowerCase()) {
      out = first.toLowerCase() + out.slice(1);
      applied.push('строчная в начале');
    }
  }

  if (roll(h.dropFinalPeriod)) {
    const before = out;
    out = out.replace(/\.$/, '');
    if (out !== before) applied.push('без точки в конце');
  }

  /* --- 6. Эмодзи --- */

  if (roll(h.addEmoji) && st.emojis?.length && !/\p{Extended_Pictographic}/u.test(out)) {
    const e = pick(st.emojis);
    out = chance(0.85) ? `${out} ${e}` : `${e} ${out}`;
    applied.push(`эмодзи ${e}`);
  }

  /* --- 7. Финальная чистка --- */

  if (roll(h.collapseSpaces)) {
    out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  }
  out = out.replace(/^["'`]+|["'`]+$/g, '').trim();

  if (out.length > st.maxLen) {
    out = smartTruncate(out, st.maxLen);
    applied.push('обрезано по длине');
  }

  return { text: out, applied };
}

/**
 * Предпросмотр для страницы настроек: несколько вариантов одного текста,
 * чтобы было видно разброс, а не один случайный исход.
 */
export function previewHumanize(text, settings, n = 4) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(humanize(text, settings));
  return out;
}

/**
 * Задержка «прочтения» поста перед ответом.
 *
 * Пропорциональна объёму текста: скорость чтения около 900 знаков в минуту,
 * с широким разбросом. Мгновенный ответ на длинный пост физически невозможен —
 * это одна из немногих метрик, которую платформа может проверить точно.
 */
export function readingTimeMs(text, { minMs = 2500, maxMs = 45000 } = {}) {
  const chars = String(text || '').length;
  const base = (chars / 900) * 60000;
  const withNoise = base * uniform(0.7, 1.6) + uniform(800, 3000);
  return Math.min(maxMs, Math.max(minMs, withNoise));
}

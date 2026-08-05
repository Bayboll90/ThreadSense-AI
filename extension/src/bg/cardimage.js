/**
 * Картинка к посту: карточка, нарисованная прямо в расширении.
 *
 * Зачем она нужна. Пост с изображением занимает в ленте втрое больше места и
 * останавливает палец — это работает у всех, кто ведёт ленты, и не требует
 * доказательств. Но для нас у картинки есть вторая работа, которая важнее
 * первой: **на ней можно поставить адрес**. Ссылка в тексте поста уводит
 * читателя с платформы, и платформа это видит; надпись на картинке — просто
 * пиксели. Человек, которому пригодился разбор, запоминает, откуда он.
 *
 * Почему рисуем сами. Условие было простым: без чужих сервисов и без затрат.
 * Всё, что нужно, уже есть в браузере — `OffscreenCanvas` работает прямо в
 * service worker, шрифты берутся системные. Ни одной установки на сервер, ни
 * одного запроса наружу, ни одного ключа.
 *
 * Стоимость: несколько миллисекунд на отрисовку и десятки на кодирование,
 * дважды в сутки. Замер уходит в журнал — если на боевой машине это окажется
 * дороже расчётного, это будет видно числом.
 *
 * JPEG, а не PNG: для плоских заливок разницы на глаз нет, а кодируется он
 * быстрее и весит втрое меньше — на сервере, где кроме нас живут ещё пять
 * проектов, это не мелочь.
 */

/**
 * Квадрат, а не вертикаль 4:5.
 *
 * Первый же снимок показал, почему: содержания на карточке немного — название,
 * пара строк пользы и команда, — и на вертикали между ними оставалась дыра в
 * треть высоты. Пустое место читается не как «воздух», а как «недоделали».
 * Формат подгоняется под содержание, а не наоборот.
 */
const W = 1080;
const H = 1080;

/** Палитра снята с оформления профиля и сайта, чтобы карточка читалась своей. */
const THEME = {
  bg: '#0a0e14',
  panel: '#111823',
  accent: '#31b0ff',
  accentSoft: 'rgba(49,176,255,0.14)',
  text: '#eef3f8',
  dim: '#8fa3b8',
  code: '#7ee0a5',
};

/**
 * Разбить строку по ширине.
 *
 * Своими руками, потому что канвас переносов не умеет вовсе: он рисует одну
 * строку и обрезает всё, что не влезло. Молча — то есть заголовок из шести слов
 * превратился бы в три с половиной без единой жалобы.
 */
export function wrap(ctx, text, maxWidth, maxLines = 99) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (ctx.measureText(probe).width <= maxWidth || !line) {
      line = probe;
    } else {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);

  /* Обрезанный текст обязан выглядеть обрезанным: многоточие честнее, чем
     строка, оборванная на середине слова. */
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[,.;:\s]+$/, '')}…`;
  }

  return lines;
}

/** Прямоугольник со скруглением: `roundRect` есть не во всех сборках. */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Нарисовать карточку разбора.
 *
 * Содержание карточки — не пересказ поста, а его оглавление: что за
 * инструмент, чем полезен и какой командой ставится. Человек, пролиставший
 * ленту, должен понять пользу, не читая текст; человек, прочитавший текст,
 * должен получить в картинке шпаргалку, которую удобно сохранить.
 *
 * @param {object} m материал инструмента (см. `tools.toolMaterial`)
 * @param {object} brand { site, handle } — что подписать внизу
 * @returns {Promise<{dataUrl: string, bytes: number, ms: number}>}
 */
export async function renderToolCard(m, brand = {}) {
  const started = Date.now();

  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas недоступен');
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');

  /* Фон и мягкое пятно акцента: плоская заливка выглядит дешёвым шаблоном. */
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.82, H * 0.12, 20, W * 0.82, H * 0.12, W * 0.7);
  glow.addColorStop(0, THEME.accentSoft);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const pad = 84;
  let y = pad + 34;

  /* Плашка типа: читателю сразу видно, что это разбор инструмента, а не мысль. */
  const label = ({ mcp: 'MCP-СЕРВЕР', skill: 'SKILL ДЛЯ CLAUDE CODE', plugin: 'ПЛАГИН CLAUDE CODE' })[m.installKind]
    || 'ИНСТРУМЕНТ';
  ctx.font = 'bold 28px "Segoe UI", Arial, sans-serif';
  const lw = ctx.measureText(label).width;
  ctx.fillStyle = THEME.accentSoft;
  roundRect(ctx, pad, y - 34, lw + 44, 52, 26);
  ctx.fill();
  ctx.fillStyle = THEME.accent;
  ctx.fillText(label, pad + 22, y);

  y += 88;

  /* Название инструмента — главное, что должно читаться с ленты. */
  ctx.fillStyle = THEME.text;
  ctx.font = 'bold 72px "Segoe UI", Arial, sans-serif';
  for (const line of wrap(ctx, m.title || m.name, W - pad * 2, 3)) {
    ctx.fillText(line, pad, y);
    y += 84;
  }

  y += 20;

  /* Польза — пара фраз. Карточку читают за секунду, абзац здесь не живёт. */
  ctx.fillStyle = THEME.dim;
  ctx.font = '38px "Segoe UI", Arial, sans-serif';
  for (const line of wrap(ctx, firstSentence(m.summary), W - pad * 2, 4)) {
    ctx.fillText(line, pad, y);
    y += 52;
  }

  /*
   * Команда установки — то, ради чего карточку сохранят.
   *
   * Блок идёт следом за текстом, а не прибит к низу: высота содержания
   * плавает от инструмента к инструменту, и фиксированная позиция оставляла
   * посреди карточки пустоту в треть высоты.
   */
  if (m.install) {
    ctx.font = '30px Consolas, "Courier New", monospace';
    const cmd = wrap(ctx, m.install, W - pad * 2 - 72, 3);
    const boxH = 76 + cmd.length * 42;
    const boxY = Math.min(y + 40, H - 200 - boxH);

    ctx.fillStyle = THEME.panel;
    roundRect(ctx, pad, boxY, W - pad * 2, boxH, 24);
    ctx.fill();

    ctx.fillStyle = THEME.dim;
    ctx.font = '30px "Segoe UI", Arial, sans-serif';
    ctx.fillText('установка', pad + 36, boxY + 52);

    ctx.fillStyle = THEME.code;
    ctx.font = '30px Consolas, "Courier New", monospace';
    let cy = boxY + 104;
    for (const line of cmd) {
      ctx.fillText(line, pad + 36, cy);
      cy += 42;
    }

    let below = boxY + boxH + 52;

    /* Вторым шагом — то, что делают следом: без него инструкция обрывается на
       середине, а место под него уже есть. */
    if (m.installSecond && below < H - 200) {
      ctx.fillStyle = THEME.dim;
      ctx.font = '30px "Segoe UI", Arial, sans-serif';
      for (const line of wrap(ctx, `затем: ${m.installSecond}`, W - pad * 2, 2)) {
        ctx.fillText(line, pad, below);
        below += 42;
      }
    }

    /*
     * Адрес репозитория — последняя фактическая деталь, и она же закрывает
     * пустоту между инструкцией и подписью. Читатель, которому инструмент
     * интересен, найдёт его по этой строке даже без ссылки в тексте.
     */
    if (m.repo && below + 40 < H - 200) {
      ctx.fillStyle = THEME.dim;
      ctx.font = '28px Consolas, "Courier New", monospace';
      ctx.fillText(`github.com/${m.repo}`, pad, below + 24);
    }
  }

  /* Подпись: адрес и ник. Единственная «ссылка», которую платформа не считает
     ссылкой, — и единственная причина, по которой картинка вообще окупается. */
  ctx.fillStyle = THEME.accent;
  ctx.fillRect(pad, H - 168, 96, 5);

  ctx.fillStyle = THEME.text;
  ctx.font = 'bold 40px "Segoe UI", Arial, sans-serif';
  ctx.fillText(brand.site || 'ThreadSense AI', pad, H - 104);

  ctx.fillStyle = THEME.dim;
  ctx.font = '32px "Segoe UI", Arial, sans-serif';
  ctx.fillText(brand.handle ? `@${String(brand.handle).replace(/^@/, '')}` : '', pad, H - 56);

  if (m.stars) {
    const s = `${formatStars(m.stars)} звёзд на GitHub`;
    ctx.font = '30px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = THEME.dim;
    ctx.fillText(s, W - pad - ctx.measureText(s).width, H - 56);
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const dataUrl = await blobToDataUrl(blob);

  return { dataUrl, bytes: blob.size, ms: Date.now() - started };
}

/** Первое предложение справки: карточке нужен смысл, а не абзац. */
export function firstSentence(text, max = 200) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';

  /*
   * Предложения набираются, пока не наберётся смысл.
   *
   * Одного первого мало: «Генерирует диаграммы из текста.» — это ещё не польза,
   * а половина мысли. Пары коротких хватает, а длинного первого хватает и
   * одного. Поэтому не «первое предложение», а «сколько складывается в мысль,
   * но строго по границе предложения»: карточку читают за секунду.
   */
  const out = [];
  let len = 0;

  for (const s of t.split(/(?<=[.!?])\s+/)) {
    if (len && len + s.length > max) break;
    out.push(s);
    len += s.length + 1;
    if (len >= 60) break;
  }

  const joined = out.join(' ').trim();
  return joined.length > max ? `${joined.slice(0, max - 1).trim()}…` : joined;
}

/** 6197 → «6.2k»: точное число на картинке ничего не добавляет. */
export function formatStars(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1).replace('.0', '')}k` : String(v);
}

function blobToDataUrl(blob) {
  /* FileReader в service worker недоступен, поэтому вручную: байты → base64.
     Кусками, потому что `String.fromCharCode` с сотней тысяч аргументов
     переполняет стек — на большой картинке это падение, а не медленная работа. */
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type};base64,${btoa(bin)}`;
  });
}

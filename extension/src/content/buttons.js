/**
 * Поиск кнопок скорингом, а не селектором.
 *
 * Жёсткий селектор ломается от любой правки разметки, и ломается молча:
 * агент просто перестаёт находить кнопку ответа. Взвешенная оценка ведёт себя
 * иначе — при потере одного признака кандидат теряет часть баллов, но всё ещё
 * побеждает остальных. Расширение переживает редизайн без правок.
 *
 * Признаков три вида, и они независимы. Подпись доступности — самый надёжный,
 * но Threads не всегда её ставит. Положение в панели действий — работает без
 * подписи вовсе. Форма иконки — последний рубеж: у кнопки может не быть ни
 * текста, ни aria-label, но `d`-атрибут у path остаётся.
 *
 * Отдельная забота — не нажать не то. У композера рядом с «Опубликовать»
 * стоят «Настройки ответов», «Добавить в ветку», «Прикрепить». Промах по ним
 * в лучшем случае теряет комментарий, в худшем меняет настройки поста.
 * Поэтому чёрный список проверяется раньше любых баллов.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.buttons) return;
  const { isVisible, textOf, closestBy, sleep } = TA.util;
  const { uniform } = TA.rng;

  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

  /* ------------------------------------------------------------------ *
   * Словари
   * ------------------------------------------------------------------ */

  /** Подписи кнопки ответа. Threads меняет их между гостевым и рабочим видом. */
  const REPLY_LABELS = [
    'ответить', 'ответ', 'комментировать', 'комментарий',
    'reply', 'comment', 'respond',
    'відповісти', 'відповідь',
    'responder', 'répondre', 'antworten', 'rispondi', 'odpowiedz',
    '返信', '回复', '댓글', 'رد',
  ];

  /** Подписи кнопки отправки. */
  const SUBMIT_LABELS = [
    'опубликовать', 'отправить', 'ответить', 'запостить',
    'post', 'reply', 'send', 'publish', 'submit',
    'опублікувати', 'надіслати',
    'publicar', 'enviar', 'publier', 'envoyer', 'veröffentlichen', 'senden',
    'pubblica', 'invia', 'opublikuj', 'wyślij',
    '投稿', '送信', '返信', '发布', '發佈', '게시', '보내기',
    'نشر', 'إرسال', 'gönder', 'paylaş', 'trimite', 'publicera',
  ];

  /**
   * Чего нажимать нельзя ни при каких баллах.
   * Список длинный намеренно: цена промаха выше цены лишней строки.
   */
  const FORBIDDEN_LABELS = [
    'отмена', 'отменить', 'закрыть', 'удалить', 'черновик', 'сохранить черновик',
    'настройки ответов', 'кто может отвечать', 'аудитория', 'запланировать',
    'расписание', 'добавить в ветку', 'добавить к ветке', 'ещё', 'еще',
    'прикрепить', 'фото', 'видео', 'гиф', 'опрос', 'местоположение', 'геометка',
    'эмодзи', 'смайл', 'развернуть', 'свернуть', 'markdown', 'тег', 'упомянуть',
    'подписаться', 'отписаться', 'пожаловаться', 'скопировать', 'поделиться',
    'репост', 'цитировать', 'нравится', 'сохранить',

    'cancel', 'close', 'discard', 'delete', 'draft', 'save draft',
    'reply settings', 'who can reply', 'audience', 'schedule', 'add to thread',
    'more', 'attach', 'photo', 'video', 'gif', 'poll', 'location', 'emoji',
    'expand', 'collapse', 'mention', 'tag', 'follow', 'unfollow', 'report',
    'copy', 'share', 'repost', 'quote', 'like', 'save', 'bookmark',
  ];

  const matchesAny = (label, list) => {
    const l = norm(label);
    if (!l) return false;
    return list.some((k) => l.includes(norm(k)));
  };

  const isForbidden = (label) => matchesAny(label, FORBIDDEN_LABELS);

  /** Все подписи элемента: свои атрибуты плюс подписи вложенного svg. */
  function labelsOf(el) {
    const out = [];
    const push = (v) => { if (v) out.push(String(v)); };

    push(el.getAttribute?.('aria-label'));
    push(el.getAttribute?.('title'));
    push(el.getAttribute?.('data-tooltip-content'));

    for (const svg of el.querySelectorAll?.('svg[aria-label], svg > title') || []) {
      push(svg.getAttribute?.('aria-label') || svg.textContent);
    }

    const t = textOf(el);
    if (t && t.length <= 40) push(t);

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Сигнатуры иконок
   * ------------------------------------------------------------------ */

  /**
   * Иконка ответа Threads — «облачко» со стрелкой.
   *
   * Опознаётся по форме контура. Смысл приёма в том, что у кнопки может не
   * быть ни текста, ни подписи доступности: в такой разметке форма пути —
   * единственное, за что можно зацепиться.
   */
  function isReplyIcon(svg) {
    if (!svg) return false;
    try {
      const box = svg.getAttribute('viewBox') || '';
      const path = svg.querySelector('path');
      const d = path?.getAttribute('d') || '';
      if (!d) return false;
      const flat = d.replace(/\s+/g, '');

      if (box === '0 0 18 18') {
        const shape = /M15\.\d*\s*13\.\d*L16\.\d*\s*16\.\d*L12\.\d*\s*15\.\d*C12\.\d*/;
        const round = (path.getAttribute('stroke-linejoin') || '').toLowerCase() === 'round';
        if (round && shape.test(d)) return true;
      }

      if (box === '0 0 24 24') {
        const shape = /M12\s*3C7\.\d+\s*3\s*3\s*7\.\d+\s*3\s*12C3\s*16\.\d+/;
        if (shape.test(d) && (flat.includes('ZM112C1') || flat.includes('L20.'))) return true;
      }

      // Общий случай: замкнутое «облако» без заливки, близкое к квадрату.
      const [, , w, h] = box.split(/\s+/).map(Number);
      if (w && h && Math.abs(w - h) < 2 && /^M/.test(d) && d.length > 40) {
        const label = svg.getAttribute('aria-label');
        if (label && matchesAny(label, REPLY_LABELS)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Иконка отправки — стрелка вправо или вверх. */
  function isSubmitIcon(svg) {
    if (!svg) return false;
    try {
      const d = svg.querySelector('path')?.getAttribute('d') || '';
      if (!d) return false;
      // Простая стрелка: горизонтальная линия и «птичка» наконечника.
      if (/M1\s*6\s*h?10/i.test(d) && /l?4\s*-?4/i.test(d)) return true;
      // Бумажный самолётик.
      if (/M22\s*2L11\s*13/i.test(d) || /M2\s*21L23\s*12L2\s*3/i.test(d)) return true;
      return false;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Панель действий
   * ------------------------------------------------------------------ */

  /**
   * Заставить Threads отрисовать панель действий.
   *
   * Часть кнопок появляется только по наведению. Без этого шага скоринг
   * честно работает по пустому множеству и ничего не находит — отказ выглядит
   * как поломка селекторов, хотя разметка в порядке.
   */
  async function primeActions(card) {
    if (!card) return;
    try {
      const r = card.getBoundingClientRect();
      const x = r.left + r.width * uniform(0.6, 0.8);
      const y = r.top + r.height * uniform(0.7, 0.85);
      for (const type of ['pointerover', 'pointermove', 'mouseover', 'mousemove']) {
        card.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
        }));
      }
      await sleep(uniform(120, 260));
    } catch { /* панель могла быть уже отрисована */ }
  }

  /** Кнопки-кандидаты внутри контейнера. */
  function candidates(root) {
    const list = [...root.querySelectorAll('[role="button"], button, div[tabindex], a[role="button"]')];
    return list.filter((el) => {
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 12) return false;
      if (r.width > 400) return false;                  // это контейнер, а не кнопка
      if (el.querySelector('img')) return false;        // аватар, а не действие
      if (el.closest('a[href^="/@"]')) return false;    // имя автора
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * Кнопка ответа
   * ------------------------------------------------------------------ */

  /**
   * Найти кнопку «Ответить» в карточке поста.
   * @returns {{el: Element, score: number, why: string[]}|null}
   */
  function findReply(card) {
    if (!card) return null;

    const scored = [];
    for (const el of candidates(card)) {
      const labels = labelsOf(el);
      if (labels.some(isForbidden)) continue;

      let score = 0;
      const why = [];

      if (labels.some((l) => matchesAny(l, REPLY_LABELS))) { score += 160; why.push('подпись'); }

      const svg = el.querySelector('svg');
      if (isReplyIcon(svg)) { score += 70; why.push('иконка'); }

      // Вторая позиция в панели действий: лайк, ответ, репост, поделиться.
      const bar = actionRow(card);
      if (bar) {
        const idx = bar.indexOf(el);
        if (idx === 1) { score += 95; why.push('вторая в панели'); }
        else if (idx >= 0) { score += 20; why.push(`позиция ${idx}`); }
      }

      const r = el.getBoundingClientRect();
      score += Math.min((r.width * r.height) / 1200, 20);

      if (score > 0) scored.push({ el, score, why });
    }

    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
  }

  /**
   * Панель действий как упорядоченный слева направо список кнопок.
   * Определяется по общей вертикали: у кнопок одной строки совпадает top.
   */
  function actionRow(card) {
    const btns = candidates(card).filter((el) => el.querySelector('svg'));
    if (btns.length < 2) return null;

    const rows = new Map();
    for (const b of btns) {
      const top = Math.round(b.getBoundingClientRect().top / 12) * 12;
      if (!rows.has(top)) rows.set(top, []);
      rows.get(top).push(b);
    }

    let best = null;
    for (const row of rows.values()) {
      if (!best || row.length > best.length) best = row;
    }
    if (!best || best.length < 2) return null;

    return best.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  }

  /* ------------------------------------------------------------------ *
   * Кнопка отправки
   * ------------------------------------------------------------------ */

  /**
   * Найти кнопку публикации рядом с полем ввода.
   *
   * Скоуп сужается до диалога или ближайшего к редактору контейнера: искать по
   * всей странице опасно, там полно кнопок с подписью «Опубликовать» от
   * основного композера.
   */
  function findSubmit(editor) {
    const dialog = TA.sel.findDialog();
    const scope = dialog
      || (editor && closestBy(editor, (e) => e.getBoundingClientRect().height > 80, 8))
      || document;

    const editorRect = editor?.getBoundingClientRect();
    const scored = [];

    for (const el of candidates(scope)) {
      const labels = labelsOf(el);
      if (labels.some(isForbidden)) continue;
      if (el.getAttribute('aria-disabled') === 'true' || el.disabled) continue;
      if (getComputedStyle(el).pointerEvents === 'none') continue;

      // Чисто числовая подпись — это счётчик, а не действие.
      const t = norm(textOf(el));
      if (t && /^\d[\d\s.,]*(тыс\.?|млн|k|m)?$/i.test(t)) continue;
      if (t.startsWith('@')) continue;

      let score = 0;
      const why = [];

      if (labels.some((l) => matchesAny(l, SUBMIT_LABELS))) { score += 170; why.push('подпись'); }
      if (isSubmitIcon(el.querySelector('svg'))) { score += 60; why.push('иконка-стрелка'); }

      if (editorRect) {
        const r = el.getBoundingClientRect();
        // Подвал композера: ниже поля и правее его середины.
        if (r.top >= editorRect.bottom - 8 && r.top - editorRect.bottom < 160) {
          score += 70;
          why.push('в подвале');
          if (r.left > editorRect.left + editorRect.width * 0.5) { score += 40; why.push('справа'); }
        }
        // Кнопка на одной высоте с полем, сразу за ним.
        if (Math.abs(r.top - editorRect.top) < 32 && r.left > editorRect.right - 8) {
          score += 55;
          why.push('справа от поля');
        }
      }

      if (dialog && dialog.contains(el)) { score += 45; why.push('в диалоге'); }

      if (score > 0) scored.push({ el, score, why });
    }

    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
  }

  /* ------------------------------------------------------------------ *
   * Выбор редактора
   * ------------------------------------------------------------------ */

  /**
   * Выбрать лучшее поле ввода из нескольких видимых.
   *
   * На странице легко оказаться с двумя открытыми редакторами: основной
   * композер сверху и форма ответа. Печатать надо во второй.
   */
  function pickEditor(editors, { card = null } = {}) {
    if (!editors?.length) return null;
    if (editors.length === 1) return editors[0];

    const dialog = TA.sel.findDialog();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    let best = null;
    let bestScore = -Infinity;

    for (const el of editors) {
      const r = el.getBoundingClientRect();
      let score = 0;

      if (dialog?.contains(el)) score += 220;
      if (card?.contains(el)) score += 120;

      const z = Number(getComputedStyle(el).zIndex);
      if (Number.isFinite(z)) score += Math.min(Math.max(z, 0), 200);

      score += Math.min((r.width * r.height) / 900, 60);
      score -= Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy) / 10;

      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  TA.buttons = {
    findReply, findSubmit, pickEditor, primeActions, actionRow,
    isReplyIcon, isSubmitIcon, isForbidden, labelsOf, candidates,
    REPLY_LABELS, SUBMIT_LABELS, FORBIDDEN_LABELS,
  };
})();

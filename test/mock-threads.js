/**
 * Макет страницы Threads.
 *
 * Воспроизводит разметку в том виде, в каком её отдаёт React Native Web:
 * обфусцированные классы, data-pressable-container на карточках, ссылки вида
 * /@author/post/shortcode с вложенным time[datetime], svg с aria-label вместо
 * текстовых кнопок, редактор на contenteditable с data-lexical-editor.
 *
 * Отдаётся через перехват запросов на реальный домен — иначе content-скрипты
 * не инжектятся, а именно их поведение и проверяется.
 */

/** Пост: подобраны так, чтобы проверить и попадание в нишу, и отсев. */
export const POSTS = [
  {
    sc: 'DAbc001', author: 'devkate', name: 'Катя · разработка',
    text: 'Полгода пилила автоматизацию отчётов на python, и главный вывод такой: '
        + 'самое дорогое не написать скрипт, а договориться, что именно считать. '
        + 'Код занял два дня, согласование формул — полтора месяца.',
    likes: 214, replies: 18, minutes: 47,
  },
  {
    sc: 'DAbc002', author: 'ml_anton', name: 'Антон',
    text: 'Перевёл продовый пайплайн с gpt-4.1 на nano модель. Качество просело '
        + 'процентов на пять, цена упала втрое. Для классификации это отличный размен, '
        + 'для генерации текста — нет.',
    likes: 87, replies: 4, minutes: 22,
  },
  {
    sc: 'DAbc003', author: 'foodblog_msk', name: 'Едим вкусно',
    text: 'Открыли новую кофейню на Патриках, флэт уайт там наливают просто нереальный. '
        + 'Заходите обязательно, атмосфера очень уютная и персонал приятный.',
    likes: 340, replies: 27, minutes: 90,
  },
  {
    sc: 'DAbc004', author: 'spam_king', name: 'ЗАРАБОТОК',
    text: 'СРОЧНО!!! Подпишись на канал https://t.me/money и забери курс бесплатно '
        + '#заработок #деньги #успех #мотивация #инвестиции',
    likes: 3, replies: 0, minutes: 15,
  },
  {
    sc: 'DAbc005', author: 'nocode_pro', name: 'Лена',
    text: 'Собрала телеграм-бота для клиента вообще без кода за вечер. Но потом два дня '
        + 'чинила вебхуки, потому что no-code платформа молча теряла запросы при таймауте.',
    likes: 42, replies: 2, minutes: 12,
  },
  {
    sc: 'DAbc006', author: 'example_user', name: 'Example',
    text: 'Мой собственный пост про агентов и автоматизацию, его трогать нельзя ни при каких условиях.',
    likes: 51, replies: 7, minutes: 130,
  },
];

/** Ответы в ветке первого поста. */
export const REPLIES = [
  { author: 'backend_yura', text: 'огонь', likes: 2, minutes: 40 },
  {
    author: 'anna_pm',
    text: 'Вот это прям в точку. У нас на согласовании метрик ушло два квартала, '
        + 'причём половина споров была про то, считать ли отменённые заказы.',
    likes: 14, minutes: 35,
  },
  { author: 'devops_max', text: 'а на чём считали, pandas или сразу в sql?', likes: 1, minutes: 20 },
];

const cls = () => `x${Math.random().toString(36).slice(2, 9)}`;

function isoAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function relLabel(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} мин`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} ч`;
  return `${Math.round(minutes / 1440)} д`;
}

function fmtCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')} тыс.`;
  return String(n);
}

/** Разметка одной карточки. */
function card(p, { isReply = false } = {}) {
  const href = `/@${p.author}/post/${p.sc}`;
  return `
<div class="${cls()}" data-pressable-container="true">
  <div class="${cls()}">
    <div class="${cls()}">
      <img alt="Фото профиля ${p.author}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="36" height="36">
    </div>
    <div class="${cls()}">
      <div class="${cls()}">
        <a href="/@${p.author}" role="link"><span dir="auto">${p.author}</span></a>
        <a href="${href}" role="link"><time datetime="${isoAgo(p.minutes)}">${relLabel(p.minutes)}</time></a>
        <div role="button" tabindex="0"><svg aria-label="Ещё" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/></svg></div>
      </div>
      <div class="${cls()}" dir="auto"><span dir="auto">${p.text}</span></div>
      <div class="${cls()}">
        <div role="button" tabindex="0" class="${cls()}" data-act="like">
          <svg aria-label="Нравится" viewBox="0 0 24 24" fill="none"><path d="M12 21 3 12a5 5 0 019-3 5 5 0 019 3z"/></svg>
          <span dir="auto">${fmtCount(p.likes)}</span>
        </div>
        <div role="button" tabindex="0" class="${cls()}" data-act="reply" data-sc="${p.sc}" data-author="${p.author}">
          <svg aria-label="Ответить" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-3-6.7"/></svg>
          <span dir="auto">${fmtCount(p.replies ?? 0)}</span>
        </div>
        <div role="button" tabindex="0" class="${cls()}">
          <svg aria-label="Репост" viewBox="0 0 24 24" fill="none"><path d="M4 8h16M8 4l-4 4 4 4"/></svg>
        </div>
        <div role="button" tabindex="0" class="${cls()}">
          <svg aria-label="Поделиться" viewBox="0 0 24 24" fill="none"><path d="M4 12v8h16v-8"/></svg>
        </div>
      </div>
      ${isReply ? '' : `<div class="${cls()}"><span dir="auto">${p.replies} ответов · ${fmtCount(p.likes)} отметок «Нравится»</span></div>`}
    </div>
  </div>
</div>`;
}

/**
 * Навигация залогиненного пользователя.
 *
 * Без неё агент справедливо отказывается работать: Threads показывает гостям
 * такую же ленту, и отличить сессию можно только по личным разделам —
 * вкладке активности, сохранённому и ссылке на свой профиль с аватаром.
 */
const NAV = `
<nav aria-label="Основная навигация" style="position:fixed;left:0;top:0;bottom:0;width:70px;
     display:flex;flex-direction:column;gap:14px;align-items:center;padding:16px 0;
     border-right:1px solid #1e1e1e;background:#0a0a0a;z-index:10">
  <a href="/" aria-label="Главная">🏠</a>
  <a href="/search" aria-label="Поиск">🔍</a>
  <div role="button" tabindex="0" aria-label="Создать">✏️</div>
  <a href="/activity" aria-label="Активность">❤️</a>
  <a href="/saved" aria-label="Сохранённое">🔖</a>
  <a href="/@example_user" aria-label="Профиль">
    <img alt="Фото профиля example_user" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
         width="26" height="26" style="border-radius:50%;background:#2a2a2a">
  </a>
</nav>`;

const SHELL_CSS = `
  *{box-sizing:border-box}
  nav a{font-size:20px;text-decoration:none}
  main{margin-left:70px}
  body{margin:0;background:#0a0a0a;color:#f3f5f7;font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
  a{color:inherit;text-decoration:none}
  header{position:sticky;top:0;background:#0a0a0a;border-bottom:1px solid #1e1e1e;padding:12px 16px;z-index:5}
  main{max-width:600px;margin:0 auto;padding:8px 16px 400px}
  [data-pressable-container]{border-bottom:1px solid #1e1e1e;padding:16px 0;cursor:pointer}
  [data-pressable-container] > div{display:flex;gap:12px}
  [data-pressable-container] img{border-radius:50%;background:#2a2a2a}
  [data-pressable-container] > div > div:last-child{flex:1;min-width:0}
  [dir="auto"]{white-space:pre-wrap;word-break:break-word}
  time{color:#777;font-size:13px;margin-left:8px}
  [role="button"]{display:inline-flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;color:#999;font-size:13px;cursor:pointer}
  [role="button"]:hover{background:#161616}
  svg{width:20px;height:20px;stroke:currentColor;stroke-width:1.8;fill:none}
  [role="dialog"]{position:fixed;inset:0;background:rgba(0,0,0,.72);display:grid;place-items:center;z-index:50}
  .modal{width:min(560px,92vw);background:#101010;border:1px solid #262626;border-radius:16px;padding:18px}
  [contenteditable]{min-height:76px;padding:10px;border-radius:10px;background:#0a0a0a;border:1px solid #262626;outline:none;color:#f3f5f7}
  [contenteditable]:empty:before{content:attr(data-placeholder);color:#5a5a5a}
  .modalFoot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
  .modalFoot [role="button"]{border:1px solid #2b2b2b;color:#f3f5f7}
`;

/** Скрипт страницы: открытие формы ответа, лайки, добавление ответа в ветку. */
const SHELL_JS = `
(function(){
  // Журнал действий переживает переходы между страницами: агент между
  // действиями уходит на ленту, и хранение в памяти страницы стирало бы
  // всё, что он успел сделать до перехода.
  function load(k){ try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } }
  function save(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  window.__mock = {
    likes: load('__mock_likes'),
    posted: load('__mock_posted'),
    ownPosts: load('__mock_own'),
    dialogOpens: Number(localStorage.getItem('__mock_dialogs') || 0),
  };

  window.__mockSave = function(){
    save('__mock_likes', window.__mock.likes);
    save('__mock_posted', window.__mock.posted);
    save('__mock_own', window.__mock.ownPosts || []);
    localStorage.setItem('__mock_dialogs', String(window.__mock.dialogOpens));
  };

  window.__mockReset = function(){
    window.__mock = { likes: [], posted: [], ownPosts: [], dialogOpens: 0 };
    window.__mockSave();
  };

  // Клик по телу карточки уводит на страницу поста — как в настоящем Threads.
  // Без этого агент честно доходил до выбора цели и упирался в «не удалось
  // открыть ветку»: карточки были некликабельны.
  document.addEventListener('click', function(e){
    if (e.target.closest('[role="button"]') || e.target.closest('a')) return;
    var card = e.target.closest('[data-pressable-container]');
    if (!card) return;
    var href = card.querySelector('a[href*="/post/"]')?.getAttribute('href');
    if (href && !/\\/post\\//.test(location.pathname)) location.href = href;
  }, false);

  document.addEventListener('click', function(e){
    var btn = e.target.closest('[role="button"]');
    if (!btn) return;

    if (btn.dataset.act === 'like') {
      var svg = btn.querySelector('svg');
      var on = svg.getAttribute('aria-label') === 'Нравится';
      svg.setAttribute('aria-label', on ? 'Убрать отметку «Нравится»' : 'Нравится');
      svg.setAttribute('fill', on ? '#ff3040' : 'none');
      window.__mock.likes.push({ sc: btn.closest('[data-pressable-container]')
        ?.querySelector('a[href*="/post/"]')?.getAttribute('href'), at: Date.now() });
      window.__mockSave();
      return;
    }

    if (btn.dataset.act === 'reply') {
      openComposer(btn.dataset.sc, btn.dataset.author);
      return;
    }
  }, true);

  function openComposer(sc, author){
    if (document.querySelector('[role="dialog"]')) return;
    window.__mock.dialogOpens++;
    window.__mockSave();
    var d = document.createElement('div');
    d.setAttribute('role','dialog');
    d.setAttribute('aria-label','Ответить');
    d.innerHTML = '<div class="modal">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
      +   '<strong style="flex:1;font-size:14px">Ответить @' + author + '</strong>'
      +   '<div role="button" tabindex="0" aria-label="Закрыть">×</div>'
      + '</div>'
      + '<div contenteditable="true" role="textbox" data-lexical-editor="true" '
      +      'data-placeholder="Напишите что-нибудь..." aria-label="Поле ввода ответа"></div>'
      + '<div class="modalFoot"><div role="button" tabindex="0">Опубликовать</div></div>'
      + '</div>';
    document.body.appendChild(d);

    var ed = d.querySelector('[contenteditable]');

    d.querySelector('[aria-label="Закрыть"]').addEventListener('click', function(){ d.remove(); });

    d.querySelector('.modalFoot [role="button"]').addEventListener('click', function(){
      var text = (ed.innerText || '').trim();
      if (!text) return;
      window.__mock.posted.push({ sc: sc, author: author, text: text, at: Date.now() });
      window.__mockSave();
      d.remove();
      appendReply(text);
    });
  }

  /*
   * Форма собственного поста со сборкой ветки.
   *
   * Повторяет живое поведение: кнопка «Дополнить ветку» добавляет ещё одно
   * поле, публикация одна на всю ветку. Подпись намеренно продублирована на
   * вложенных элементах — в настоящем Threads она встречается трижды, и на
   * этом уже спотыкался поиск кнопки.
   */
  function openOwnComposer(){
    if (document.querySelector('[role="dialog"]')) return;
    var d = document.createElement('div');
    d.setAttribute('role','dialog');
    d.setAttribute('aria-label','Новая публикация');
    /*
     * Строка автора с полем темы — как в живом Threads: имя, стрелка, тема.
     * Поле с автодополнением, варианты появляются после набора двух символов.
     * Без него нечем проверить, что публикатор ставит тему и, главное, что он
     * не срывает публикацию, когда поля нет.
     *
     * Обратные кавычки в этом файле недопустимы: разметка макета живёт внутри
     * шаблонной строки, и первая же кавычка закрывает её посреди комментария.
     */
    d.innerHTML = '<div class="modal">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
      +   '<strong style="flex:1;font-size:14px">Новая ветка</strong>'
      +   '<div role="button" tabindex="0" aria-label="Закрыть">×</div>'
      + '</div>'
      + (window.__mock.noTopicField ? '' :
          '<div class="mockTopicRow" style="display:flex;align-items:center;gap:6px;margin-bottom:8px">'
        +   '<span>example_user</span><span>&gt;</span>'
        +   '<input class="mockTopic" type="text" placeholder="Добавить тему"'
        +     ' role="combobox" aria-expanded="false" style="flex:1">'
        +   '<div class="mockTopicList" role="listbox" style="display:none"></div>'
        + '</div>')
      + '<div class="mockParts"></div>'
      /*
       * Скрытое поле выбора файла — как в живом Threads: кнопка «прикрепить»
       * не открывает диалог сама, а кликает по этому input. Через него агент и
       * подставляет нарисованную карточку.
       */
      + '<input type="file" accept="image/*" multiple style="display:none" class="mockFile">'
      + '<div class="mockPreview"></div>'
      + '<div class="mockAddWrap"><div role="button" tabindex="0" class="mockAdd">'
      +   '<span>Дополнить ветку</span></div></div>'
      + '<div class="modalFoot"><div role="button" tabindex="0">Опубликовать</div></div>'
      + '</div>';
    document.body.appendChild(d);

    var parts = d.querySelector('.mockParts');

    function addField(){
      var ed = document.createElement('div');
      ed.setAttribute('contenteditable','true');
      ed.setAttribute('role','textbox');
      ed.setAttribute('data-lexical-editor','true');
      ed.setAttribute('data-placeholder','Что нового?');
      ed.setAttribute('aria-label','Пустое текстовое поле. Введите текст, чтобы создать новую публикацию.');
      ed.style.cssText = 'min-height:48px;margin-bottom:8px;outline:none';
      parts.appendChild(ed);
      return ed;
    }
    addField();

    d.querySelector('[aria-label="Закрыть"]').addEventListener('click', function(){ d.remove(); });
    d.querySelector('.mockAdd').addEventListener('click', function(){ addField(); });

    /* Выбранный файл превращается в превью — по нему видно, что вложение
       принято. Живой Threads показывает ровно это. */
    var fileInput = d.querySelector('.mockFile');
    var preview = d.querySelector('.mockPreview');
    fileInput.addEventListener('change', function(){
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      window.__mock.attached = (window.__mock.attached || []).concat([{ name: f.name, type: f.type, size: f.size }]);
      window.__mockSave();
      var img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      img.style.cssText = 'max-width:160px;border-radius:8px;margin:8px 0';
      preview.appendChild(img);
    });

    /* Автодополнение темы. Подсказки те же, что видны на живом Threads. */
    var topicInput = d.querySelector('.mockTopic');
    var topicList = d.querySelector('.mockTopicList');
    var KNOWN = ['Технологии', 'Фотография', 'Путешествия',
      'Книги', 'Музыка', 'Спорт', 'Образование', 'Кулинария'];

    if (topicInput) {
      topicInput.addEventListener('input', function(){
        var q = (topicInput.value || '').trim().toLowerCase();
        topicList.innerHTML = '';
        // Живой Threads 01.08 подсказок с ролью option не отдал вовсе, и тема
        // всё равно встала набранным текстом. Этот режим воспроизводит именно
        // такую страницу.
        if (window.__mock.noTopicList) { topicList.style.display = 'none'; return; }
        if (q.length < 2) { topicList.style.display = 'none'; return; }
        var hits = KNOWN.filter(function(t){ return t.toLowerCase().indexOf(q) === 0; });
        if (!hits.length) { topicList.style.display = 'none'; return; }
        hits.forEach(function(t){
          var o = document.createElement('div');
          o.setAttribute('role', 'option');
          o.textContent = t;
          o.style.cssText = 'padding:6px;cursor:pointer';
          o.addEventListener('click', function(){
            window.__mock.chosenTopic = t;
            topicInput.value = t;
            topicList.style.display = 'none';
          });
          topicList.appendChild(o);
        });
        topicList.style.display = 'block';
      });
    }

    d.querySelector('.modalFoot [role="button"]').addEventListener('click', function(){
      var texts = [].slice.call(parts.querySelectorAll('[contenteditable]'))
        .map(function(e){ return (e.innerText || '').trim(); })
        .filter(Boolean);
      if (!texts.length) return;
      // Threads принимает и набранное вручную, а не только выбранное из
      // подсказки — так тема и вставала в бою при неопознанном списке.
      var typedTopic = topicInput ? (topicInput.value || '').trim() : '';
      window.__mock.ownPosts = (window.__mock.ownPosts || []).concat([
        { parts: texts, topic: window.__mock.chosenTopic || typedTopic || null, at: Date.now() }]);
      window.__mockSave();
      d.remove();
    });
  }

  var composeEntry = document.getElementById('mockCompose');
  if (composeEntry) composeEntry.addEventListener('click', openOwnComposer);

  function appendReply(text){
    var host = document.querySelector('main');
    var wrap = document.createElement('div');
    wrap.setAttribute('data-pressable-container','true');
    wrap.innerHTML = '<div><div><img alt="Фото профиля example_user" width="36" height="36"></div>'
      + '<div><div><a href="/@example_user"><span dir="auto">example_user</span></a>'
      + '<a href="/@example_user/post/NEW' + Date.now().toString(36) + '"><time datetime="'
      + new Date().toISOString() + '">сейчас</time></a></div>'
      + '<div dir="auto"><span dir="auto">' + text.replace(/[<>&]/g, '') + '</span></div>'
      + '<div><div role="button" tabindex="0" data-act="like">'
      + '<svg aria-label="Нравится" viewBox="0 0 24 24" fill="none"><path d="M12 21 3 12"/></svg>'
      + '<span dir="auto">0</span></div></div></div></div>';
    host.appendChild(wrap);
  }

  /** Показать предупреждение об ограничении — для проверки сторожа. */
  window.__mockActionBlocked = function(){
    var d = document.createElement('div');
    d.setAttribute('role','dialog');
    d.innerHTML = '<div class="modal"><strong>Действие заблокировано</strong>'
      + '<p style="color:#999;font-size:13px">Мы ограничили некоторые действия для вашего аккаунта. '
      + 'Попробуйте позже.</p></div>';
    document.body.appendChild(d);
  };
})();
`;

/** Страница ленты. */
/**
 * Заглушка «Что нового?» вверху ленты.
 *
 * Точка входа в собственный пост. Разметка повторяет живую: `div[role=button]`
 * с подписью-приглашением и тем же aria-label, по которому агент её и находит.
 */
const COMPOSER_ROW = `
<div style="max-width:600px;margin:0 auto;padding:12px 16px 0">
  <div role="button" tabindex="0" id="mockCompose"
       aria-label="Пустое текстовое поле. Введите текст, чтобы создать новую публикацию."
       style="border:1px solid #2a2f3a;border-radius:12px;padding:10px 14px;color:#8b93a7;cursor:pointer">
    <span>Что нового?</span>
  </div>
</div>`;

export function feedHtml(posts = POSTS) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Threads</title><style>${SHELL_CSS}</style></head><body>
${NAV}<header><strong>Threads</strong> · Для вас</header>
${COMPOSER_ROW}
<main>${posts.map((p) => card(p)).join('')}</main>
<script>${SHELL_JS}</script></body></html>`;
}

/** Страница отдельного поста с ответами. */
export function postHtml(post = POSTS[0], replies = REPLIES) {
  const replyCards = replies.map((r, i) => card({
    sc: `REPLY${i}`, author: r.author, name: r.author,
    text: r.text, likes: r.likes, replies: 0, minutes: r.minutes,
  }, { isReply: true })).join('');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>${post.author} в Threads</title><style>${SHELL_CSS}</style></head><body>
${NAV}<header><strong>Threads</strong> · Публикация</header>
<main>${card(post)}${replyCards}</main>
<script>${SHELL_JS}</script></body></html>`;
}

/** Профиль пользователя — для проверки сбора стиля. */
export function profileHtml(handle, texts) {
  const posts = texts.map((t, i) => card({
    sc: `OWN${i}`, author: handle, name: handle,
    text: t, likes: 10 + i * 3, replies: i % 4, minutes: 60 * (i + 1),
  }));
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>${handle}</title><style>${SHELL_CSS}</style></head><body>
${NAV}<header><strong>@${handle}</strong></header>
<main>${posts.join('')}</main>
<script>${SHELL_JS}</script></body></html>`;
}

/** Повесить перехват на контекст Playwright. */
export async function installRoutes(ctx, { ownTexts = null } = {}) {
  await ctx.route('https://www.threads.com/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    let body;
    if (/\/post\//.test(p)) {
      const sc = p.split('/post/')[1].replace(/\/$/, '');
      const post = POSTS.find((x) => x.sc === sc) || POSTS[0];
      body = postHtml(post, sc === POSTS[0].sc ? REPLIES : REPLIES.slice(0, 1));
    } else if (/^\/@/.test(p)) {
      const handle = p.match(/^\/@([^/]+)/)[1];
      body = profileHtml(handle, ownTexts || [
        'опять полдня чинил вебхуки вместо того чтобы писать фичи, классика',
        'если проект собирается дольше минуты, я успеваю забыть зачем его собирал',
        'no-code штука хорошая пока не упрёшься в первый нестандартный кейс',
        'самое дорогое в автоматизации это не код а договориться что автоматизируем',
        'nano модели для классификации топ, для генерации все таки нужна модель побольше',
        'по опыту, промпт длиннее двух экранов почти всегда можно ужать вдвое без потерь',
      ]);
    } else {
      body = feedHtml();
    }

    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
}

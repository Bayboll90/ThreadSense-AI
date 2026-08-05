/**
 * Полезные инструменты для агентов: MCP-серверы, скиллы и плагины Claude Code.
 *
 * Зачем это существует. До сих пор поводом для поста была либо новость, либо
 * тема из ленты. И то и другое — разговор: агент высказывался о происходящем.
 * Разговор набирает лайки, но не даёт причины подписаться: сказанное прочитали
 * и забыли. Инструкция, по которой человек у себя что-то настроил и это
 * заработало, — другая валюта. За ней возвращаются, её сохраняют, по ней
 * приходят в профиль.
 *
 * Отсюда правило формата: **ни одной выдуманной команды**. Всё, что выглядит
 * как инструкция, обязано быть проверяемым, иначе один неверный `npx` стоит
 * дороже десяти удачных постов. Поэтому имя пакета, команда установки и адрес
 * репозитория берутся из данных, а не из модели: модель пишет текст вокруг
 * фактов и не имеет права их придумывать (см. `guideSystem` в `prompts.js` и
 * проверку `checkGuide` в `poster.js`).
 *
 * ─────────────────────────────────────────────────────────────────────
 *
 * ОТКУДА ДАННЫЕ, И ПОЧЕМУ ИМЕННО ОТТУДА
 *
 * Три источника, все бесплатные и без ключей — это было условием.
 *
 * **Официальный реестр MCP** (`registry.modelcontextprotocol.io`) — единственное
 * место, где команда установки лежит в структурированном виде: тип реестра
 * (npm/pypi/oci) и идентификатор пакета. Из этой пары команда собирается
 * однозначно, без разбора чужого README регулярками.
 *
 * **Поиск GitHub** — сигнал качества. В реестре публикуется кто угодно, и
 * половина записей там — сканеры маркетинговых текстов и прочее, что нашей
 * аудитории не нужно вовсе. Звёзды и дата последнего коммита отсекают это
 * дешевле любой модели.
 *
 * **README репозитория** — подробности: чем инструмент полезен на практике,
 * что требуется, как выглядит настройка. Забирается сырым текстом с
 * `raw.githubusercontent.com`.
 *
 * Ни один источник не покрывает задачу в одиночку: реестр знает установку, но
 * не знает популярность; GitHub знает популярность, но команду установки
 * пришлось бы угадывать по README. Поэтому записи сшиваются по адресу
 * репозитория.
 */

import { hash, normalize } from '../common/text.js';

const TIMEOUT_MS = 12000;

/** Сколько инструментов держим в копилке. */
const POOL_MAX = 40;

/** Сколько имён помним, чтобы не писать об одном дважды. */
const MEMORY_MAX = 200;

async function fetchJson(url, { timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, { timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ *
 * Команда установки
 * ------------------------------------------------------------------ */

/**
 * Как поставить инструмент — одной строкой, которую можно скопировать.
 *
 * Для MCP-сервера правильная команда — не «поставь пакет», а «зарегистрируй
 * сервер у клиента»: сам по себе пакет ничего не делает, он запускается
 * клиентом по требованию. `claude mcp add` — штатный способ Claude Code, и он
 * же понятен читателю, у которого стоит Codex или Cursor: там та же пара
 * «команда + аргументы», только вписывается в свой конфиг.
 *
 * Возвращается `null`, если данных на однозначную команду не хватает.
 * Догадываться здесь нельзя: неверная команда в посте с инструкцией хуже
 * отсутствия поста.
 */
export function installCommand(card) {
  const short = shortName(card.name);
  const pkg = card.pkg;
  if (!pkg?.identifier) return null;

  switch (pkg.registryType) {
    case 'npm':
      return `claude mcp add ${short} -- npx -y ${pkg.identifier}`;
    case 'pypi':
      return `claude mcp add ${short} -- uvx ${pkg.identifier}`;
    case 'oci':
      return `claude mcp add ${short} -- docker run -i --rm ${pkg.identifier}`;
    default:
      return null;
  }
}

/** Короткое имя для регистрации: `ai.foo/weather` → `weather`. */
export function shortName(name) {
  const tail = String(name || '').split('/').pop() || '';
  return tail.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'server';
}

/* ------------------------------------------------------------------ *
 * Сбор
 * ------------------------------------------------------------------ */

/**
 * Отсев мусора по описанию.
 *
 * В реестре и в поиске полно инструментов, которые формально относятся к теме,
 * а нашей аудитории бесполезны: корпоративные интеграции с одной компанией,
 * заготовки-пустышки, чужеязычные учебные проекты. Дешёвый фильтр по словам
 * убирает их до того, как за них заплатит модель.
 */
const JUNK_RE = /\b(test|demo|example|boilerplate|template|starter|playground|tutorial|hello[- ]world|sample|awesome|curated|(list|collection|directory) of)\b/i;

/**
 * Слова, по которым видно, что инструмент про нашу нишу.
 *
 * Проверяются **имя и описание**, но не темы репозитория. Тема ставится
 * автором и врёт чаще, чем описание: живой прогон вынес наверх скрапер Google
 * Maps на Go — у него стоит `topic:mcp-server`, а в описании ни слова про
 * агентов, потому что инструмент не про них. Читателю нужен разбор того, чем
 * он будет пользоваться в Claude Code, а не всего, что автор пометил модным
 * ярлыком.
 */
/**
 * Кандидаты из официального реестра MCP.
 *
 * Берутся только записи с пакетом: без него не собрать команду установки, а
 * пост без команды — не инструкция, а пересказ.
 */
export async function fromRegistry({ limit = 100 } = {}) {
  const out = [];
  let cursor = null;

  /* Постранично, но не бесконечно: три страницы по сорок — достаточный запас
     на пару недель публикаций, а больше значило бы качать реестр целиком. */
  for (let page = 0; page < 3 && out.length < limit; page++) {
    const url = 'https://registry.modelcontextprotocol.io/v0/servers?limit=40'
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

    let j;
    try { j = await fetchJson(url); } catch { break; }

    for (const row of j.servers || []) {
      const s = row.server || {};
      const pkg = (s.packages || [])[0];
      if (!pkg?.identifier) continue;

      const repo = repoOf(s.repository?.url || s.repository);
      out.push({
        source: 'registry',
        name: s.name || '',
        title: s.title || shortName(s.name),
        description: s.description || '',
        version: s.version || null,
        repo,
        pkg: { registryType: pkg.registryType, identifier: pkg.identifier, version: pkg.version || null },
        updatedAt: row._meta?.['io.modelcontextprotocol.registry/official']?.updatedAt || null,
      });
    }

    cursor = j.metadata?.nextCursor;
    if (!cursor) break;
  }

  return out;
}

/** `https://github.com/owner/repo` → `owner/repo`. */
export function repoOf(url) {
  const m = String(url || '').match(/github\.com\/([\w.-]+\/[\w.-]+)/i);
  return m ? m[1].replace(/\.git$/, '') : null;
}

/**
 * Кандидаты из поиска GitHub.
 *
 * Здесь берётся то, чего нет в реестре: скиллы и плагины Claude Code, которые
 * ставятся не как MCP-сервер, а копированием в каталог. Плюс сигнал качества
 * для тех, кто в реестре есть.
 *
 * Поиск без ключа ограничен десятью запросами в минуту. Нам нужно два поста в
 * сутки, так что запас стократный — но запросов всё равно ровно столько,
 * сколько тем, и не больше.
 */
export async function fromGithub(queries, { perPage = 20 } = {}) {
  const out = [];

  for (const q of queries) {
    const url = 'https://api.github.com/search/repositories?q='
      + encodeURIComponent(q) + `&sort=stars&order=desc&per_page=${perPage}`;

    let j;
    try { j = await fetchJson(url); } catch { continue; }

    for (const it of j.items || []) {
      out.push({
        source: 'github',
        name: it.full_name,
        title: it.name,
        description: it.description || '',
        repo: it.full_name,
        stars: it.stargazers_count || 0,
        updatedAt: it.pushed_at || null,
        topics: it.topics || [],
        pkg: null,
      });
    }
  }

  return out;
}

/**
 * Сшить два списка и оценить.
 *
 * Запись реестра и запись поиска — это один и тот же инструмент, если совпал
 * адрес репозитория. Сшивая, берём лучшее от обоих: команду установки от
 * реестра, звёзды и свежесть от GitHub.
 */
export function merge(registry, github) {
  const byRepo = new Map();

  for (const r of registry) {
    const key = r.repo || `reg:${r.name}`;
    byRepo.set(key, { ...r });
  }

  for (const g of github) {
    const key = g.repo;
    const prev = byRepo.get(key);
    if (prev) {
      byRepo.set(key, { ...prev, stars: g.stars, topics: g.topics, updatedAt: g.updatedAt || prev.updatedAt });
    } else {
      byRepo.set(key, { ...g });
    }
  }

  return [...byRepo.values()];
}

/**
 * Насколько инструмент годится в пост.
 *
 * Три вещи в порядке важности: есть ли по нему что рассказать (команда
 * установки и внятное описание), пользуются ли им (звёзды), жив ли он
 * (последний коммит). Мёртвый репозиторий с тысячей звёзд — плохой совет:
 * читатель поставит и упрётся в несовместимость.
 */
export function scoreTool(card, now = Date.now(), includeKeywords = []) {
  const desc = String(card.description || '');
  if (!desc || desc.length < 20) return 0;
  if (JUNK_RE.test(`${card.name} ${desc}`)) return 0;
  const wanted = (includeKeywords || []).map(normalize).filter(Boolean);
  // Repository topics are author-controlled and too noisy for a hard niche filter.
  const hay = normalize(`${card.name} ${desc}`);
  if (wanted.length && !wanted.some((word) => hay.includes(word))) return 0;

  const stars = card.stars || 0;
  const ageDays = card.updatedAt ? (now - Date.parse(card.updatedAt)) / 864e5 : 365;

  /*
   * Популярность — окно, а не «чем больше, тем лучше».
   *
   * Первый же прогон на живых данных вынес наверх n8n и gemini-cli со ста
   * тысячами звёзд. Формально они по теме, практически — пост о них не несёт
   * ничего: про них знает каждый, кто вообще открывал эту тему. Польза
   * инструкции обратна известности инструмента, но и совсем безвестный не
   * годится — за ним нет ни поддержки, ни ответов на вопросы.
   *
   * Отсюда колокол вокруг нескольких тысяч звёзд: ниже — «слишком сыро»,
   * выше — «и так все знают».
   */
  const SWEET = Math.log10(3000);
  const spread = 1.1;
  const popular = stars > 0
    ? Math.exp(-Math.pow((Math.log10(stars) - SWEET) / spread, 2))
    : 0.15;

  /* Свежесть: полгода без коммитов гасит вдвое, год — вчетверо. */
  const fresh = Math.pow(0.5, Math.max(0, ageDays) / 180);

  /*
   * Готовая команда установки — то, ради чего пост пишется.
   *
   * Запись реестра несёт её сразу; у репозитория с GitHub способ установки ещё
   * предстоит выяснить по содержимому (`resolveInstall`), и до тех пор он идёт
   * с понижением — но не выбывает: скиллы и плагины Claude Code в реестре MCP
   * не публикуются вовсе, а это ровно то, что нашей аудитории интереснее.
   */
  const installable = installCommand(card) ? 1.6 : (looksInstallable(card) ? 1 : 0.35);

  return popular * fresh * installable;
}

/** Похоже ли, что у репозитория есть понятный способ установки. */
export function looksInstallable(card) {
  const hay = `${card.name} ${card.description} ${(card.topics || []).join(' ')}`.toLowerCase();
  return /\b(mcp|skill|skills|plugin|marketplace|agent[- ]?os|claude-code)\b/.test(hay);
}

/**
 * Выяснить, как ставится репозиторий, у которого нет записи в реестре.
 *
 * Смотрим корень репозитория — по нему видно, что перед нами:
 *
 * - `.claude-plugin/` — это маркетплейс плагинов Claude Code, и ставится он
 *   штатной командой, а не копированием файлов;
 * - `skills/` — набор скиллов, который кладут в свой каталог скиллов;
 * - `package.json` у пакета с признаками MCP — обычный npm-пакет, который
 *   регистрируется как сервер.
 *
 * Один запрос на кандидата, и только для того, кого собираемся разбирать.
 * Гадать по описанию нельзя: команда в посте обязана быть настоящей.
 */
export async function resolveInstall(card) {
  const ready = installCommand(card);
  if (ready) return { command: ready, kind: 'mcp' };
  if (!card?.repo) return null;

  let files;
  try {
    files = await fetchJson(`https://api.github.com/repos/${card.repo}/contents/`);
  } catch {
    return null;
  }
  if (!Array.isArray(files)) return null;

  const names = new Set(files.map((f) => String(f.name || '').toLowerCase()));
  const short = shortName(card.title || card.name);

  if (names.has('.claude-plugin')) {
    return {
      kind: 'plugin',
      command: `claude plugin marketplace add ${card.repo}`,
      second: `/plugin install ${short}`,
    };
  }

  if (names.has('skills')) {
    /*
     * Папки `skills/` мало: она бывает у чего угодно. Скилл Claude Code
     * опознаётся файлом `SKILL.md` внутри — без него мы предложили бы читателю
     * склонировать в каталог скиллов, например, скрапер на Go. Такой случай
     * поймал первый же прогон на живых данных.
     */
    const ok = await hasSkillManifest(card.repo).catch(() => false);
    if (ok) {
      return {
        kind: 'skill',
        command: `git clone https://github.com/${card.repo} ~/.claude/skills/${short}`,
        second: 'перезапусти Claude Code — скилл подхватится сам',
      };
    }
  }

  if (names.has('package.json')) {
    try {
      const pkg = await fetchJson(`https://raw.githubusercontent.com/${card.repo}/HEAD/package.json`);
      const id = pkg?.name;
      const isMcp = /mcp/i.test(`${id} ${pkg?.description} ${(pkg?.keywords || []).join(' ')}`);
      if (id && isMcp && pkg?.bin) {
        return { kind: 'mcp', command: `claude mcp add ${short} -- npx -y ${id}` };
      }
    } catch { /* не npm-пакет — идём дальше */ }
  }

  return null;
}

/**
 * Собрать копилку инструментов.
 *
 * Копилка обновляется редко и живёт в состоянии: сеть здесь дорога не деньгами,
 * а временем и чужими лимитами, а инструменты не появляются ежеминутно.
 */
export async function collectTools(settings, { now = Date.now() } = {}) {
  const cfg = settings?.tools || {};

  const queries = Array.isArray(cfg.githubQueries) ? cfg.githubQueries.filter(Boolean) : [];
  if (!cfg.registryEnabled && !queries.length) return [];
  const includeKeywords = cfg.includeKeywords?.length
    ? cfg.includeKeywords
    : (settings?.niche?.includeKeywords || []);

  const [reg, gh] = await Promise.all([
    cfg.registryEnabled ? fromRegistry().catch(() => []) : [],
    queries.length ? fromGithub(queries).catch(() => []) : [],
  ]);

  const merged = merge(reg, gh)
    .map((c) => ({ ...c, id: hash(c.repo || c.name), score: scoreTool(c, now, includeKeywords) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, POOL_MAX);

  return merged;
}

/* ------------------------------------------------------------------ *
 * Выбор и память
 * ------------------------------------------------------------------ */

/**
 * Какой инструмент разбирать следующим.
 *
 * Из копилки берётся лучший из тех, о которых мы ещё не писали. Порядок не
 * случайный: разбор — не развлечение и не «разнообразие ради разнообразия»,
 * читателю сначала стоит показать то, чем пользуется больше людей.
 */
export function pickTool(state, pool, { minScore = 0.6 } = {}) {
  const told = new Set(state?.toldTools || []);
  return (pool || [])
    .filter((c) => c.score >= minScore && !told.has(c.id))
    .sort((a, b) => b.score - a.score)[0] || null;
}

/** Запомнить, что об этом уже рассказали. */
export function rememberTool(state, card) {
  if (!card?.id) return state;
  const list = state.toldTools || [];
  if (!list.includes(card.id)) state.toldTools = [...list, card.id].slice(-MEMORY_MAX);
  return state;
}

/* ------------------------------------------------------------------ *
 * Подробности из README
 * ------------------------------------------------------------------ */

/** Есть ли в `skills/` хоть один настоящий скилл — файл `SKILL.md`. */
export async function hasSkillManifest(repo) {
  const list = await fetchJson(`https://api.github.com/repos/${repo}/contents/skills`);
  if (!Array.isArray(list)) return false;

  // Скилл лежит либо файлом прямо здесь, либо папкой со своим SKILL.md.
  if (list.some((f) => /^skill\.md$/i.test(f.name || ''))) return true;

  const dir = list.find((f) => f.type === 'dir');
  if (!dir) return false;

  const inner = await fetchJson(`https://api.github.com/repos/${repo}/contents/skills/${dir.name}`)
    .catch(() => null);
  return Array.isArray(inner) && inner.some((f) => /^skill\.md$/i.test(f.name || ''));
}

/**
 * Вытащить из README то, что стоит рассказать.
 *
 * Не пересказ и не резюме — только куски, на которые можно опереться: первый
 * содержательный абзац (что это), блок про возможности, пример конфигурации.
 * Модель получит их как факты; сочинять по ним она может, выдумывать — нет.
 *
 * Разбор нарочно грубый. README пишут все по-разному, и попытка вытащить
 * структуру точнее упирается в бесконечные исключения; здесь достаточно
 * отсечь заголовки, значки и разметку.
 */
export function readmeFacts(md, { maxChars = 1200 } = {}) {
  const text = String(md || '');
  if (!text) return null;

  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')                 // код разберём отдельно
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')           // значки
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // ссылки — только подпись
    .replace(/^#{1,6}\s.*$/gm, ' ')                  // заголовки
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/[*_>`|]/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const paragraphs = clean.split('\n').map((s) => s.trim()).filter((s) => s.length >= 40);

  /* Примеры конфигурации ценнее прозы: по ним видно, что инструмент реально
     делает и что от пользователя требуется. */
  const blocks = [...text.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)]
    .map((m) => m[1].trim())
    .filter((b) => b.length > 20 && b.length < 400)
    .slice(0, 2);

  const summary = paragraphs.slice(0, 6).join(' ').slice(0, maxChars);
  if (!summary) return null;

  return { summary, snippets: blocks };
}

/** Забрать README репозитория. Ветка неизвестна, поэтому пробуем обе обычные. */
export async function fetchReadme(repo) {
  if (!repo) return null;
  for (const branch of ['main', 'master']) {
    for (const file of ['README.md', 'readme.md']) {
      try {
        const md = await fetchText(`https://raw.githubusercontent.com/${repo}/${branch}/${file}`);
        if (md && md.length > 100) return md;
      } catch { /* следующая попытка */ }
    }
  }
  return null;
}

/**
 * Собрать карточку в тот вид, в котором её понимает генератор.
 *
 * Форма намеренно та же, что у новости из `collectNews`: генератору всё равно,
 * откуда пришёл повод, и ни один общий промпт от этого не меняется. Разница
 * только в содержании и в том, что здесь есть поле `install` — единственная
 * строка, которую модели запрещено переписывать.
 */
export async function toolMaterial(card, { withReadme = true } = {}) {
  if (!card) return null;

  const how = await resolveInstall(card).catch(() => null);
  if (!how?.command) return null;   // без команды разбор не пишется, см. заголовок файла

  const facts = withReadme ? readmeFacts(await fetchReadme(card.repo).catch(() => null)) : null;

  return {
    kind: 'tool',
    id: card.id,
    title: card.title || shortName(card.name),
    name: card.name,
    repo: card.repo,
    url: card.repo ? `https://github.com/${card.repo}` : null,
    stars: card.stars || null,
    install: how.command,
    installSecond: how.second || null,
    installKind: how.kind,
    pkg: card.pkg || null,
    summary: [card.description, facts?.summary].filter(Boolean).join(' ').slice(0, 1400),
    snippets: facts?.snippets || [],
    /* Ключ новизны: тот же, что у новостей, — по нему проверяется, не писали ли
       мы об этом раньше другими словами. */
    key: normalize(`${card.title} ${card.description}`).slice(0, 80),
  };
}

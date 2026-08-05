/**
 * Главный экран агента.
 *
 * Пять блоков и ничего больше: режим, старт-стоп, что сделано сегодня,
 * автопилот, события. Всё, ради чего нужно разбираться в настройках, вынесено
 * на отдельную страницу и по умолчанию скрыто.
 *
 * Принцип отбора того, что сюда попадает: на экране остаётся только то, что
 * человек может **решить** или **должен знать**. Диагностика подсистем —
 * аренда вкладки, реестр, ступень восстановления — сюда не идёт: повлиять на
 * них нельзя, а внимание они забирают. Исключение одно: если агент
 * остановился, причина показывается крупно и с кнопкой.
 */

import { MSG, HALT_LABEL } from '../common/messages.js';
import { PRESETS } from '../common/defaults.js';
import { GITHUB_REPOSITORY_URL } from '../common/update.js';

const $ = (sel) => document.querySelector(sel);
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const DEMO_UPDATE = new URLSearchParams(location.search).get('update') === '1';

const els = {
  dot: $('#dot'),
  power: $('#power'),
  statusLine: $('#statusLine'),
  alert: $('#alert'),
  setup: $('#setup'),
  presets: $('#presets'),
  dayCount: $('#dayCount'),
  dayBar: $('#dayBar').firstElementChild,
  dayPosts: $('#dayPosts'),
  postBar: $('#postBar').firstElementChild,
  dayLikes: $('#dayLikes'),
  dayViews: $('#dayViews'),
  daySpend: $('#daySpend'),
  warmupLine: $('#warmupLine'),
  autopilot: $('#autopilot'),
  autopilotHint: $('#autopilotHint'),
  openQueue: $('#openQueue'),
  queueCount: $('#queueCount'),
  logList: $('#logList'),
  eventCard: $('.eventCard'),
  update: $('#popupUpdate'),
};

const demoUpdate = () => ({
  currentVersion: DEMO_UPDATE ? '2.2.0' : '2.3.0',
  available: DEMO_UPDATE ? {
    tag: 'v2.3.0',
    releaseUrl: 'https://github.com/sany86russ/ThreadSense-AI/releases/tag/v2.3.0',
    downloadUrl: 'https://github.com/sany86russ/ThreadSense-AI/releases/download/v2.3.0/ThreadSense-AI-v2.3.0-unpacked.zip',
  } : null,
  visible: DEMO_UPDATE,
});

async function demoSend(msg) {
  if (msg.type === MSG.UI_GET_STATUS) return {
    ok: true, enabled: false, autopilot: false, hasKey: true, aiVerified: true, setupReady: true,
    preset: 'careful', handle: 'your_profile', topicReady: true, halt: null, breaker: 'closed',
    dayCount: 3, dayLimit: 8, dayPosts: 1, postingEnabled: true, postLimit: 4,
    dayLikes: 7, dayViews: 31, daySpend: 0.018, budget: 1, warmupDay: 1, warmupDays: 7,
    session: { active: false }, nextSessionAt: 0, queued: 2, recovery: null, pipeline: null,
    survival: { checked: 3, alive: 3 }, lease: null, update: demoUpdate(),
  };
  if (msg.type === MSG.UI_CHECK_UPDATE) return { ok: true, update: demoUpdate() };
  if (msg.type === MSG.UI_DISMISS_UPDATE) return { ok: true, update: { ...demoUpdate(), visible: false } };
  if (msg.type === 'ui_get_log') return { ok: true, log: [] };
  return { ok: true };
}

const send = (msg) => DEMO ? demoSend(msg) : chrome.runtime.sendMessage(msg);

let busy = false;
let currentStatus = {};
let lastUpdate = null;

const PRESET_ORDER = ['careful', 'normal', 'boost', 'active'];

/* --------------------------------- Режимы -------------------------------- */

function renderPresets(current) {
  els.presets.innerHTML = '';

  for (const key of PRESET_ORDER) {
    const p = PRESETS[key];
    if (!p) continue;
    const b = document.createElement('button');
    b.className = `presetBtn${key === current ? ' on' : ''}`;
    b.innerHTML = `
      <strong>${p.label}</strong>
      <span class="tiny">до ${p.limits.perDay} · ${currentStatus.postingEnabled ? `посты до ${p.posting.perDay}` : 'посты выкл.'}</span>`;
    b.title = p.hint;
    b.onclick = async () => {
      if (busy) return;
      busy = true;
      const s = await send({ type: MSG.UI_SET_PRESET, preset: key });
      busy = false;
      if (s?.ok) render(s);
    };
    els.presets.appendChild(b);
  }
}

/* -------------------------------- Отрисовка ------------------------------ */

function render(s) {
  currentStatus = s;
  renderPresets(s.preset);
  renderUpdate(s.update);

  els.autopilot.checked = !s.autopilot;
  els.autopilotHint.textContent = s.autopilot
    ? 'Автопубликация включена — тексты уходят без подтверждения'
    : 'Черновики ждут подтверждения; лайки в этом режиме отключены';

  /* Старт-стоп */

  els.power.innerHTML = s.enabled
    ? '<span>Остановить агента</span><small>Текущая сессия будет завершена</small>'
    : '<span>Запустить агента</span><small>Только чтение и черновики, без лайков</small>';
  els.power.className = `bigStart${s.enabled ? ' on' : ''}`;
  els.power.disabled = !s.enabled && !s.setupReady;

  /* Что мешает начать — отдельно и понятным языком. */

  const missing = [];
  if (!s.hasKey) missing.push('ключ API');
  else if (!s.aiVerified) missing.push('успешная проверка AI');
  if (!s.handle) missing.push('свой хэндл в Threads');
  if (!s.topicReady) missing.push('описание темы');

  if (missing.length) {
    els.setup.classList.remove('hidden');
    const completed = 4 - missing.length;
    els.setup.innerHTML = `<div class="setupTop"><span class="setupIcon">${Math.max(0, completed)}/4</span><div><strong>Завершите первоначальную настройку</strong><p>Не хватает: ${escapeHtml(missing.join(', '))}.</p></div></div>`;
    const btn = document.createElement('button');
    btn.className = 'sm';
    btn.textContent = 'Продолжить настройку →';
    btn.onclick = () => openOptions('');
    els.setup.appendChild(btn);
  } else {
    els.setup.classList.add('hidden');
  }

  /* Статус одной строкой */

  let dotClass = 'dot';
  let status;

  if (s.halt) {
    dotClass += ' err';
    status = HALT_LABEL[s.halt.reason] || s.halt.reason;
  } else if (!s.aiVerified) {
    dotClass += ' warn';
    status = s.hasKey ? 'проверьте AI' : 'нужен ключ API';
  } else if (!s.setupReady) {
    dotClass += ' warn';
    status = 'нужно завершить настройку';
  } else if (!s.enabled) {
    status = 'остановлен';
  } else if (s.breaker === 'open') {
    dotClass += ' warn';
    status = 'пауза после сбоев';
  } else if (s.recovery?.step) {
    dotClass += ' warn';
    status = `восстановление: ${s.recovery.label}`;
  } else if (s.pipeline) {
    dotClass += ' ok';
    status = phaseLabel(s.pipeline.phase);
  } else if (s.session?.active) {
    dotClass += ' ok';
    status = s.session.idle
      ? 'читает ленту'
      : `работает · ${s.session.doneActions} из ${s.session.plannedActions}`;
  } else if (s.nextSessionAt > Date.now()) {
    dotClass += ' ok';
    status = `перерыв, продолжит через ${fmtLeft(s.nextSessionAt - Date.now())}`;
  } else {
    dotClass += ' ok';
    status = 'ждёт подходящего момента';
  }

  els.dot.className = dotClass;
  els.statusLine.textContent = status;

  /* Остановка: единственная диагностика, которая сюда попадает. */

  if (s.halt) {
    els.alert.classList.remove('hidden');
    const until = s.halt.until
      ? `Пауза до ${new Date(s.halt.until).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}.`
      : 'Нужно твоё вмешательство.';
    els.alert.innerHTML = `
      <div><strong>${HALT_LABEL[s.halt.reason] || s.halt.reason}</strong></div>
      <div class="tiny">${escapeHtml(s.halt.detail || '')} ${until}</div>`;
    const btn = document.createElement('button');
    btn.className = 'sm';
    btn.textContent = 'Снять остановку';
    btn.onclick = async () => { await send({ type: MSG.UI_CLEAR_HALT }); refresh(); };
    els.alert.appendChild(btn);
  } else {
    els.alert.classList.add('hidden');
  }

  /* Сегодня */

  els.dayCount.textContent = `${s.dayCount} / ${s.dayLimit}`;
  const pct = s.dayLimit ? Math.min(100, (s.dayCount / s.dayLimit) * 100) : 0;
  els.dayBar.style.width = `${pct}%`;
  els.dayBar.parentElement.className = `bar${pct >= 100 ? ' warn' : ''}`;

  els.dayPosts.textContent = s.postingEnabled ? `${s.dayPosts || 0} / ${s.postLimit || 0}` : 'выключены';
  const pPct = s.postLimit ? Math.min(100, ((s.dayPosts || 0) / s.postLimit) * 100) : 0;
  els.postBar.style.width = `${pPct}%`;

  els.dayLikes.textContent = s.dayLikes;
  els.dayViews.textContent = s.dayViews;
  els.daySpend.textContent = `$${(s.daySpend || 0).toFixed(3)}`;
  els.daySpend.style.color = s.daySpend >= s.budget ? 'var(--err)' : '';

  /* Одна поясняющая строка. Прогрев важнее прогноза: он объясняет, почему
     лимит сегодня ниже обещанного, и без него это выглядит поломкой. */

  const notes = [];
  if (s.warmupDay < s.warmupDays) {
    notes.push(`прогрев: день ${s.warmupDay + 1} из ${s.warmupDays}`);
  }
  if (s.survival?.checked) {
    notes.push(`ответы на месте: ${s.survival.alive} из ${s.survival.checked}`);
  }
  if (s.lease && s.enabled) notes.push('работает в другой вкладке');
  els.warmupLine.textContent = notes.join(' · ');

  /* Очередь показывается только когда в ней что-то есть. */

  els.queueCount.textContent = s.queued;
  els.openQueue.classList.toggle('hidden', !s.queued);
}

function openExternal(url) {
  if (!/^https:\/\/github\.com\/sany86russ\/ThreadSense-AI(?:\/|$)/i.test(String(url || ''))) return;
  chrome.tabs.create({ url });
  window.close();
}

function renderUpdate(update) {
  lastUpdate = update || lastUpdate;
  const release = update?.available;
  els.update.classList.toggle('hidden', !release || !update.visible);
  if (!release) return;
  $('#popupUpdateTitle').textContent = `Доступна ${release.tag}`;
  $('#popupUpdateText').textContent = `Сейчас ${update.currentVersion} · готовый ZIP на GitHub`;
}

function phaseLabel(phase) {
  return {
    need_scan: 'ищет посты',
    need_open: 'открывает ветку',
    need_reply: 'пишет ответ',
  }[phase] || 'работает';
}

function fmtLeft(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'минуту';
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/* ---------------------------------- Лог ---------------------------------- */

/*
 * События фильтруются: на главном экране нужны те, о которых человек мог бы
 * рассказать другому человеку. «Опубликовал комментарий» — да. «Собрано 22,
 * прошло префильтр 5» — нет, это диагностика, ей место в полном журнале.
 */
const NOISE = new Set(['scan', 'lease', 'heartbeat', 'preset', 'toggle', 'reset']);

async function renderLog() {
  const r = await send({ type: 'ui_get_log' });
  const log = (r?.log || [])
    .filter((e) => !NOISE.has(e.event) || e.level === 'error')
    .slice(-12)
    .reverse();

  els.logList.innerHTML = '';
  if (!log.length) {
    els.eventCard.classList.add('hidden');
    return;
  }

  els.eventCard.classList.remove('hidden');

  for (const e of log) {
    const div = document.createElement('div');
    div.className = 'logItem';
    div.title = [e.msg, e.detail].filter(Boolean).join('\n\n');
    div.innerHTML = `
      <span class="dot ${levelClass(e.level)}"></span>
      <span class="txt">${escapeHtml(e.msg || '')}</span>
      <span class="ts">${new Date(e.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>`;
    els.logList.appendChild(div);
  }
}

function ruCount(n, forms) {
  const value = Math.abs(Number(n)) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

const levelClass = (l) => ({ success: 'ok', warn: 'warn', error: 'err' }[l] || '');

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* -------------------------------- События -------------------------------- */

els.power.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  els.power.disabled = true;
  const r = await send({ type: MSG.UI_TOGGLE, enabled: els.power.className.includes('on') ? false : true });
  busy = false;
  els.power.disabled = false;
  if (r?.ok) render(r);
});

els.autopilot.addEventListener('change', async () => {
  const enableAutopilot = !els.autopilot.checked;
  if (enableAutopilot && !window.confirm('Включить автопубликацию? Агент будет отправлять тексты без вашего подтверждения.')) {
    els.autopilot.checked = true;
    return;
  }
  await send({ type: 'ui_save_settings', patch: { autopilot: enableAutopilot } });
  refresh();
});

els.openQueue.onclick = () => openOptions('#queue');
$('#openOptions').onclick = () => openOptions('');
$('#openLog').onclick = () => openOptions('#log');
$('#openThreads').onclick = () => {
  chrome.tabs.create({ url: 'https://www.threads.com/' });
  window.close();
};
$('#openGitHub').onclick = () => openExternal(GITHUB_REPOSITORY_URL);
$('#downloadUpdatePopup').onclick = () => openExternal(lastUpdate?.available?.downloadUrl);
$('#dismissUpdatePopup').onclick = async () => {
  const result = await send({ type: MSG.UI_DISMISS_UPDATE, tag: lastUpdate?.available?.tag });
  if (result?.update) renderUpdate(result.update);
};

function openOptions(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/ui/options.html${hash}`) });
  window.close();
}

/* --------------------------------- Запуск -------------------------------- */

async function refresh(checkUpdate = false) {
  if (busy) return;
  if (checkUpdate) await send({ type: MSG.UI_CHECK_UPDATE });
  const s = await send({ type: MSG.UI_GET_STATUS });
  if (s?.ok) render(s);
  await renderLog();
}

refresh(true);
setInterval(refresh, 3000);

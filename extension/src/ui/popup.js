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

const $ = (sel) => document.querySelector(sel);

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
};

const send = (msg) => chrome.runtime.sendMessage(msg);

let busy = false;

/* --------------------------------- Режимы -------------------------------- */

function renderPresets(current) {
  els.presets.innerHTML = '';

  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = `presetBtn${key === current ? ' on' : ''}`;
    b.innerHTML = `
      <strong>${p.label}</strong>
      <span class="tiny">${p.limits.perDay} комм · ${p.posting.perDay} пост${p.posting.perDay === 1 ? '' : 'а'}</span>`;
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
  renderPresets(s.preset);

  els.autopilot.checked = !!s.autopilot;
  els.autopilotHint.textContent = s.autopilot
    ? 'Комментарии, лайки и посты уходят сами'
    : 'Всё копится в очереди и ждёт твоего клика';

  /* Старт-стоп */

  els.power.textContent = s.enabled ? 'Остановить' : 'Запустить';
  els.power.className = `bigStart${s.enabled ? ' on' : ''}`;
  els.power.disabled = !s.hasKey;

  /* Что мешает начать — отдельно и понятным языком. */

  const missing = [];
  if (!s.hasKey) missing.push('ключ API');
  if (!s.handle) missing.push('свой хэндл в Threads');

  if (missing.length) {
    els.setup.classList.remove('hidden');
    els.setup.innerHTML = `<div><strong>Для работы не хватает: ${missing.join(' и ')}</strong></div>`;
    const btn = document.createElement('button');
    btn.className = 'sm';
    btn.textContent = 'Открыть настройки';
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
  } else if (!s.hasKey) {
    dotClass += ' warn';
    status = 'нужен ключ API';
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

  els.dayPosts.textContent = `${s.dayPosts || 0} / ${s.postLimit || 0}`;
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
    els.logList.innerHTML = '<div class="tiny dim" style="padding:4px 8px">пока пусто</div>';
    return;
  }

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
  await send({ type: 'ui_save_settings', patch: { autopilot: els.autopilot.checked } });
  refresh();
});

els.openQueue.onclick = () => openOptions('#queue');
$('#openOptions').onclick = () => openOptions('');
$('#openLog').onclick = () => openOptions('#log');
$('#openThreads').onclick = () => {
  chrome.tabs.create({ url: 'https://www.threads.com/' });
  window.close();
};

function openOptions(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/ui/options.html${hash}`) });
  window.close();
}

/* --------------------------------- Запуск -------------------------------- */

async function refresh() {
  if (busy) return;
  const s = await send({ type: MSG.UI_GET_STATUS });
  if (s?.ok) render(s);
  await renderLog();
}

refresh();
setInterval(refresh, 3000);

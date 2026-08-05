/**
 * Страница настроек.
 *
 * Форма собирается из описания в fields.js — руками сотню полей не сверстать
 * так, чтобы они не разъехались со схемой. Здесь же живут вкладки, которые
 * описанием не выражаются: очередь, журнал, диагностика и мастер запуска.
 */

import { MSG, HALT_LABEL } from '../common/messages.js';
import { PRESETS, ANGLES, applyPreset } from '../common/defaults.js';
import { AI_PROVIDERS, providerDefaults } from '../common/providers.js';
import { SCHEMA } from './fields.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const send = (msg) => chrome.runtime.sendMessage(msg);

let settings = null;
let saveTimer = null;

const PRESET_ORDER = ['careful', 'normal', 'boost', 'active'];
const PRESET_META = {
  careful: { tag: 'Рекомендуется', desc: 'Максимум пауз и плавный прогрев.' },
  normal: { tag: 'Баланс', desc: 'Для уже настроенного и живого профиля.' },
  boost: { tag: 'Под контролем', desc: 'Плотнее, но с умеренным дневным потолком.' },
  active: { tag: 'Максимум', desc: 'Только для прогретого профиля.' },
};

async function ensureApiPermission(value) {
  let origin;
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    origin = `${url.origin}/*`;
  } catch {
    return false;
  }
  if (!chrome.permissions?.contains) return true;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

/* ------------------------------------------------------------------ *
 * Работа с настройками
 * ------------------------------------------------------------------ */

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
}

/** Отложенное сохранение: ползунки шлют события десятками в секунду. */
function scheduleSave(immediate = false) {
  clearTimeout(saveTimer);
  const doSave = async () => {
    $('#saveState').textContent = 'Сохраняем изменения…';
    await send({ type: 'ui_replace_settings', settings });
    $('#saveState').textContent = 'Сохранено автоматически';
    refreshEstimate();
    renderReadiness();
  };
  if (immediate) return doSave();
  saveTimer = setTimeout(doSave, 400);
  return Promise.resolve();
}

/* ------------------------------------------------------------------ *
 * Построение полей
 * ------------------------------------------------------------------ */

function buildField(f) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = `<span>${escape(f.label)}</span>`;
  wrap.appendChild(label);

  const value = getPath(settings, f.path);
  let control;

  switch (f.type) {
    case 'toggle': {
      wrap.className = 'field inline';
      const sw = document.createElement('label');
      sw.className = 'switch';
      sw.innerHTML = '<input type="checkbox"><span></span>';
      control = $('input', sw);
      control.checked = !!value;
      control.onchange = () => { setPath(settings, f.path, control.checked); scheduleSave(); };
      wrap.insertBefore(sw, label);
      break;
    }

    case 'range': {
      const badge = document.createElement('span');
      badge.className = 'value';
      label.appendChild(badge);

      const row = document.createElement('div');
      row.className = 'rangeRow';
      row.innerHTML = `
        <input type="range" min="${f.min}" max="${f.max}" step="${f.step ?? 0.01}">
        <input type="number" min="${f.min}" max="${f.max}" step="${f.step ?? 0.01}">`;
      const [range, num] = $$('input', row);
      range.value = num.value = value;
      badge.textContent = fmtNum(value);

      const apply = (v) => {
        const n = clampNum(Number(v), f.min, f.max);
        range.value = num.value = n;
        badge.textContent = fmtNum(n);
        setPath(settings, f.path, n);
        scheduleSave();
      };
      range.oninput = () => apply(range.value);
      num.onchange = () => apply(num.value);

      control = row;
      wrap.appendChild(row);
      break;
    }

    case 'number': {
      control = document.createElement('input');
      control.type = 'number';
      if (f.min != null) control.min = f.min;
      if (f.max != null) control.max = f.max;
      if (f.step != null) control.step = f.step;
      control.value = value;
      control.dataset.path = f.path;
      control.onchange = () => {
        const n = clampNum(Number(control.value), f.min ?? -Infinity, f.max ?? Infinity);
        control.value = n;
        setPath(settings, f.path, n);
        scheduleSave();
      };
      wrap.appendChild(control);
      break;
    }

    case 'select': {
      control = document.createElement('select');
      control.dataset.path = f.path;
      const modelField = /^ai\.model(?:Score|Write|Style)$/.test(f.path);
      const fieldOptions = modelField
        ? (AI_PROVIDERS[settings.ai.provider]?.models || [])
        : f.options;
      for (const o of fieldOptions) {
        const opt = document.createElement('option');
        opt.value = typeof o === 'object' ? o.value : o;
        opt.textContent = typeof o === 'object' ? o.label : o;
        control.appendChild(opt);
      }
      // Модель может быть задана вручную и отсутствовать в списке.
      const optionValues = fieldOptions.map((o) => typeof o === 'object' ? o.value : o);
      if (value && !optionValues.includes(value)) {
        const opt = document.createElement('option');
        opt.value = opt.textContent = value;
        control.appendChild(opt);
      }
      control.value = value;
      control.onchange = () => {
        if (f.path === 'ai.provider') {
          const apiKey = settings.ai.apiKey;
          settings.ai = { ...settings.ai, ...providerDefaults(control.value), apiKey };
          scheduleSave(true).then(() => renderTab('ai'));
          return;
        }
        setPath(settings, f.path, control.value);
        scheduleSave();
      };
      wrap.appendChild(control);
      break;
    }

    case 'textarea': {
      control = document.createElement('textarea');
      control.rows = f.rows || 4;
      control.value = value || '';
      control.oninput = () => { setPath(settings, f.path, control.value); scheduleSave(); };
      if (f.path === 'ai.baseUrl') {
        control.onchange = async () => {
          setPath(settings, f.path, control.value.trim());
          await ensureApiPermission(control.value);
          scheduleSave(true);
        };
      }
      wrap.appendChild(control);
      break;
    }

    case 'tags': {
      control = buildTags(value || [], (next) => {
        setPath(settings, f.path, next);
        scheduleSave();
      });
      wrap.appendChild(control);
      break;
    }

    case 'password':
    case 'text':
    default: {
      const row = document.createElement('div');
      row.className = f.action ? 'row' : '';
      control = document.createElement('input');
      control.type = f.type === 'password' ? 'password' : 'text';
      control.value = value || '';
      control.autocomplete = 'off';
      control.oninput = () => { setPath(settings, f.path, control.value); scheduleSave(); };
      row.appendChild(control);

      if (f.action) {
        const btn = document.createElement('button');
        btn.textContent = f.action.label;
        btn.style.flex = 'none';
        btn.dataset.action = f.action.id;
        row.appendChild(btn);
        const out = document.createElement('span');
        out.className = 'tiny muted';
        out.dataset.actionOut = f.action.id;
        row.appendChild(out);
      }
      wrap.appendChild(row);
      break;
    }
  }

  if (f.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = f.hint;
    wrap.appendChild(hint);
  }

  return wrap;
}

function buildTags(items, onChange) {
  const box = document.createElement('div');
  box.className = 'tagInput';
  const input = document.createElement('input');
  input.placeholder = 'добавить и Enter';

  let list = [...items];

  const render = () => {
    $$('.tag', box).forEach((t) => t.remove());
    list.forEach((item, i) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.title = item;
      const text = String(item);
      tag.innerHTML = `<span>${escape(text.length > 60 ? `${text.slice(0, 60)}…` : text)}</span><b>×</b>`;
      $('b', tag).onclick = () => { list.splice(i, 1); render(); onChange(list); };
      box.insertBefore(tag, input);
    });
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      if (v && !list.includes(v)) { list.push(v); input.value = ''; render(); onChange(list); }
    } else if (e.key === 'Backspace' && !input.value && list.length) {
      list.pop(); render(); onChange(list);
    }
  };
  // Вставка списком: строки или через запятую.
  input.onpaste = (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/[\n,]/.test(text)) return;
    e.preventDefault();
    const parts = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) if (!list.includes(p)) list.push(p);
    render();
    onChange(list);
  };

  box.appendChild(input);
  render();
  box.setList = (next) => { list = [...next]; render(); };
  return box;
}

function renderTab(tab) {
  const host = $(`#f-${tab}`);
  if (!host || !SCHEMA[tab]) return;
  host.innerHTML = '';

  for (const group of SCHEMA[tab]) {
    const g = document.createElement('div');
    g.className = 'group';
    const h = document.createElement('h3');
    h.textContent = group.title;
    g.appendChild(h);
    for (const f of group.fields) g.appendChild(buildField(f));
    host.appendChild(g);
  }

  bindActions(host);
}

function renderAllTabs() {
  for (const tab of Object.keys(SCHEMA)) renderTab(tab);
  renderCircadian();
}

/* ------------------------------------------------------------------ *
 * Кнопки внутри полей
 * ------------------------------------------------------------------ */

function bindActions(root) {
  const testBtn = $('[data-action="testKey"]', root);
  if (testBtn) {
    testBtn.onclick = async () => {
      const out = $('[data-action-out="testKey"]', root);
      testBtn.disabled = true;
      out.textContent = 'проверяю…';
      if (!await ensureApiPermission(settings.ai.baseUrl)) {
        testBtn.disabled = false;
        out.textContent = 'разреши доступ к адресу API';
        out.style.color = 'var(--err)';
        return;
      }
      const r = await send({ type: MSG.UI_TEST_KEY, ai: { ...settings.ai } });
      testBtn.disabled = false;
      if (r?.models?.length) applyAvailableModels(r.models, r.model);
      out.textContent = r?.ok
        ? `работает · ${r.model}`
        : `ошибка: ${r?.error || 'нет ответа'}`;
      out.style.color = r?.ok ? 'var(--ok)' : 'var(--err)';
    };
  }

  const detectBtn = $('[data-action="detectHandle"]', root);
  if (detectBtn) {
    detectBtn.onclick = async () => {
      const out = $('[data-action-out="detectHandle"]', root);
      out.textContent = 'ищу…';
      const tab = await threadsTab();
      if (!tab) { out.textContent = 'открой вкладку Threads'; out.style.color = 'var(--warn)'; return; }
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'ta_detect_handle' }).catch(() => null);
      if (r?.handle) {
        settings.handle = r.handle;
        renderTab('niche');
        scheduleSave(true);
      } else {
        out.textContent = 'не удалось определить';
        out.style.color = 'var(--warn)';
      }
    };
  }
}

function applyAvailableModels(models, preferredModel = '') {
  const clean = [...new Set((models || []).map(String).filter(Boolean))].sort();
  for (const path of ['ai.modelScore', 'ai.modelWrite', 'ai.modelStyle']) {
    const select = document.querySelector(`select[data-path="${path}"]`);
    if (!select) continue;
    const current = getPath(settings, path);
    select.innerHTML = '';
    for (const model of clean) select.add(new Option(model, model));
    const selected = clean.includes(current)
      ? current
      : (clean.includes(preferredModel) ? preferredModel : clean[0] || current || '');
    if (selected && !clean.includes(selected)) select.add(new Option(selected, selected));
    select.value = selected;
    if (selected !== current) setPath(settings, path, selected);
  }
  scheduleSave();
}

/* ------------------------------------------------------------------ *
 * Циркадная кривая
 * ------------------------------------------------------------------ */

function renderCircadian() {
  const host = $('#circadian');
  if (!host) return;
  host.innerHTML = '';

  for (let h = 0; h < 24; h++) {
    const col = document.createElement('div');
    col.className = 'hour';
    col.title = `${String(h).padStart(2, '0')}:00 — множитель ${settings.timing.circadian[h]}`;
    col.innerHTML = `<i style="height:${settings.timing.circadian[h] * 100}%"></i><span>${h}</span>`;

    const setFrom = (e) => {
      const rect = col.getBoundingClientRect();
      // Нижние 12 пикселей заняты подписью часа.
      const usable = rect.height - 12;
      const v = clampNum(1 - (e.clientY - rect.top) / usable, 0, 1);
      const rounded = Math.round(v * 20) / 20;
      settings.timing.circadian[h] = rounded;
      $('i', col).style.height = `${rounded * 100}%`;
      col.title = `${String(h).padStart(2, '0')}:00 — множитель ${rounded}`;
      scheduleSave();
    };

    col.onpointerdown = (e) => {
      col.setPointerCapture(e.pointerId);
      setFrom(e);
      col.onpointermove = (ev) => { if (ev.buttons) setFrom(ev); };
    };
    col.onpointerup = () => { col.onpointermove = null; };

    host.appendChild(col);
  }
}

/* ------------------------------------------------------------------ *
 * Вкладка «Старт»
 * ------------------------------------------------------------------ */

function renderPresets(host, current, onPick) {
  host.innerHTML = '';
  for (const key of PRESET_ORDER) {
    const p = PRESETS[key];
    if (!p) continue;
    const meta = PRESET_META[key] || {};
    const b = document.createElement('button');
    b.className = `preset${key === current ? ' on' : ''}`;
    b.innerHTML = `
      <i class="presetCheck"></i>
      <span class="presetTag">${escape(meta.tag || '')}</span>
      <strong>${escape(p.label)}</strong>
      <span class="presetNumbers">до ${p.limits.perDay} ${ruCount(p.limits.perDay, ['комментария', 'комментариев', 'комментариев'])} · ${p.posting.perDay} ${ruCount(p.posting.perDay, ['поста', 'поста', 'постов'])}</span>
      <span class="presetDesc">${escape(meta.desc || p.hint)}</span>`;
    b.onclick = () => onPick(key);
    host.appendChild(b);
  }
}

function readinessState() {
  if (!settings) return { ai: false, profile: false, topic: false, mode: false };
  const niche = settings.niche || {};
  return {
    ai: !!String(settings.ai?.apiKey || '').trim(),
    profile: !!String(settings.handle || '').trim(),
    topic: !!String(niche.description || '').trim()
      || !!niche.includeKeywords?.length
      || !!niche.searchQueries?.length,
    mode: !!PRESETS[settings.preset],
  };
}

function renderReadiness() {
  const state = readinessState();
  const entries = Object.entries(state);
  const done = entries.filter(([, ready]) => ready).length;
  const pct = Math.round((done / entries.length) * 100);
  $('#setupPercent').textContent = `${pct}%`;
  $('#setupRing').style.setProperty('--progress', `${pct * 3.6}deg`);
  $('#setupTitle').textContent = pct === 100 ? 'Базовая настройка завершена' : `Готово ${done} из ${entries.length} шагов`;
  $('#setupHint').textContent = pct === 100
    ? 'Можно запускать в ручном режиме и проверить первые черновики.'
    : 'Нажмите на незавершённый шаг — откроется нужный раздел.';
  $$('[data-ready]').forEach((el) => el.classList.toggle('done', !!state[el.dataset.ready]));
  const mode = PRESETS[settings.preset];
  $('#setupModeText').textContent = mode
    ? `${mode.label}: до ${mode.limits.perDay} комментариев и ${mode.posting.perDay} ${ruCount(mode.posting.perDay, ['поста', 'поста', 'постов'])}`
    : 'Безопасный режим работы';
}

async function refreshStatus() {
  const s = await send({ type: MSG.UI_GET_STATUS });
  if (!s?.ok) return;

  $('#stPower').checked = s.enabled;
  $('#stAutopilot').checked = !s.autopilot;
  $('#stAutopilotHint').textContent = s.autopilot
    ? 'Агент публикует автоматически. Включите проверку, чтобы вернуть ручное подтверждение.'
    : 'Рекомендуется новичкам: вы проверяете каждый текст перед отправкой.';
  $('#navQueue').textContent = s.queued;
  $('#navQueue').className = `pill${s.queued ? ' warn' : ''}`;

  let cls = 'dot';
  let status;
  if (s.halt) { cls += ' err'; status = HALT_LABEL[s.halt.reason] || s.halt.reason; }
  else if (!s.hasKey) { cls += ' warn'; status = 'нужен ключ API'; }
  else if (!s.enabled) { status = 'выключен'; }
  else if (s.breaker === 'open') { cls += ' warn'; status = 'предохранитель разомкнут'; }
  else if (s.session?.active) {
    cls += ' ok';
    status = s.session.idle ? 'холостая сессия' : `сессия · ${s.session.doneActions} из ${s.session.plannedActions}`;
  } else { cls += ' ok'; status = 'работает'; }

  $('#stDot').className = cls;
  $('#navDot').className = cls;
  $('#stStatus').textContent = status;
  $('#stWhy').textContent = s.blocked && s.enabled ? s.blocked : '';

  const alertBox = $('#stAlert');
  if (s.halt) {
    alertBox.classList.remove('hidden');
    alertBox.innerHTML = `<div><strong>${escape(HALT_LABEL[s.halt.reason] || s.halt.reason)}</strong></div>
      <div class="tiny">${escape(s.halt.detail || '')}</div>`;
    const btn = document.createElement('button');
    btn.className = 'sm';
    btn.textContent = 'Снять остановку';
    btn.onclick = async () => { await send({ type: MSG.UI_CLEAR_HALT }); refreshStatus(); };
    alertBox.appendChild(btn);
  } else {
    alertBox.classList.add('hidden');
  }

  $('#stDay').textContent = `${s.dayCount} / ${s.dayLimit}`;
  $('#stLikes').textContent = s.dayLikes;
  $('#stViews').textContent = s.dayViews;
  $('#stSpend').textContent = `$${(s.daySpend || 0).toFixed(3)}`;
  $('#stTotal').textContent = s.totals?.comments || 0;
  $('#stQueue').textContent = s.queued;

  renderHistory(s.history, s.day, s.dayCount);
  renderEstimate(s.estimate, s);
  renderReadiness();
}

function renderEstimate(est, s) {
  if (!est) return;
  $('#estimate').innerHTML = `
    <div><span class="tiny dim">сессий в день</span><strong>${est.sessionsPerDay}</strong></div>
    <div><span class="tiny dim">активных часов</span><strong>${est.awakeHours}</strong></div>
    <div><span class="tiny dim">комментариев в день</span><strong>${est.estimatedComments}</strong></div>
    <div><span class="tiny dim">цикл, минут</span><strong>${est.cycleMinutes}</strong></div>
    <div style="grid-column:1/-1" class="tiny muted">
      ${s.warmupDay < s.warmupDays
        ? `Прогрев: день ${s.warmupDay + 1} из ${s.warmupDays}, сегодняшний потолок ${s.dayLimit}.`
        : 'Прогрев завершён.'}
      Оценка учитывает окно активности, циркадную кривую, холостые сессии и долю лайков с просмотрами.
      Фактическое число ограничено дневным лимитом сверху.
    </div>`;
}

async function refreshEstimate() {
  const r = await send({ type: 'ui_estimate', settings });
  const s = await send({ type: MSG.UI_GET_STATUS });
  if (r?.ok && s?.ok) renderEstimate(r.estimate, s);
}

function renderHistory(history, today, todayCount) {
  const host = $('#history');
  if (!host) return;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ key, n: key === today ? todayCount : (history?.[key]?.comments || 0) });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  host.innerHTML = days.map((d) =>
    `<i class="${d.n ? '' : 'empty'}" style="height:${Math.max(3, (d.n / max) * 100)}%" title="${d.key}: ${d.n}"></i>`,
  ).join('');
}

/* ------------------------------------------------------------------ *
 * Очередь
 * ------------------------------------------------------------------ */

let showDone = false;

async function renderQueue() {
  const r = await send({ type: 'ui_get_queue', includeDone: showDone });
  const host = $('#queueList');
  const items = r?.items || [];

  if (!items.length) {
    host.innerHTML = '<div class="card muted">Пусто. Черновики появятся, когда агент найдёт подходящие ветки.</div>';
    return;
  }

  host.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = `qItem${it.status === 'sent' ? ' sent' : ''}`;

    const angle = ANGLES[it.draft?.angle]?.label || it.draft?.angle || '';
    const age = it.post?.ageMinutes != null ? `${Math.round(it.post.ageMinutes)} мин` : '';

    el.innerHTML = `
      <div class="qHead">
        <a href="${escape(it.post?.url || '#')}" target="_blank" rel="noopener">@${escape(it.post?.authorHandle || '?')}</a>
        <span class="dim tiny">${age ? `${age} назад · ` : ''}♥ ${it.post?.likes || 0} · ответов ${it.post?.replies || 0}</span>
        <span class="right tiny dim">${new Date(it.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="qPost">${escape(it.post?.text || '')}</div>
      ${it.replies?.length ? `<div class="qReplies">${it.replies.slice(0, 4).map((rp, i) =>
        `<div><b>${it.draft?.replyTo === i ? '→ ' : ''}@${escape(rp.authorHandle || '?')}</b>: ${escape(trim(rp.text, 160))}</div>`).join('')}</div>` : ''}
      <div class="qDraft">
        <textarea rows="3">${escape(it.draft?.text || '')}</textarea>
        <div class="qMeta">
          <span class="pill">${escape(angle)}</span>
          ${it.draft?.replyTo != null ? `<span class="pill">ответ на комментарий ${it.draft.replyTo}</span>` : '<span class="pill">ответ посту</span>'}
          ${it.score != null ? `<span class="pill">скор ${it.score.toFixed(2)}</span>` : ''}
          ${it.draft?.similarity != null ? `<span class="pill">повтор ${Math.round(it.draft.similarity * 100)}%</span>` : ''}
          <span class="pill">$${(it.draft?.cost || 0).toFixed(4)}</span>
        </div>
        ${it.draft?.gap ? `<div class="tiny dim">Зацепка: ${escape(it.draft.gap)}</div>` : ''}
        ${it.draft?.humanized?.length ? `<div class="tiny dim">Гуманизация: ${escape(it.draft.humanized.join(', '))}</div>` : ''}
      </div>
      <div class="qActions"></div>`;

    const ta = $('textarea', el);
    const actions = $('.qActions', el);

    if (it.status === 'sent') {
      actions.innerHTML = '<span class="pill ok">опубликовано</span>';
    } else {
      const approve = document.createElement('button');
      approve.className = 'primary';
      approve.textContent = 'Опубликовать';
      approve.onclick = async () => {
        approve.disabled = true;
        approve.textContent = 'печатаю…';
        const res = await send({ type: MSG.UI_QUEUE_ACTION, action: 'approve', id: it.id, text: ta.value });
        if (res?.ok) {
          approve.textContent = res.verified === false ? 'отправлено, но не подтвердилось' : 'готово';
          setTimeout(renderQueue, 1200);
        } else {
          approve.disabled = false;
          approve.textContent = 'Опубликовать';
          alert(`Не получилось: ${res?.error || 'нет ответа'}`);
        }
      };

      const save = document.createElement('button');
      save.textContent = 'Сохранить правку';
      save.onclick = async () => {
        await send({ type: MSG.UI_QUEUE_ACTION, action: 'edit', id: it.id, text: ta.value });
        save.textContent = 'сохранено';
        setTimeout(() => { save.textContent = 'Сохранить правку'; }, 1500);
      };

      const reject = document.createElement('button');
      reject.className = 'danger right';
      reject.textContent = 'Отклонить';
      reject.onclick = async () => {
        await send({ type: MSG.UI_QUEUE_ACTION, action: 'reject', id: it.id });
        renderQueue();
      };

      actions.append(approve, save, reject);
    }

    host.appendChild(el);
  }
}

/* ------------------------------------------------------------------ *
 * Журнал
 * ------------------------------------------------------------------ */

async function renderLog() {
  const r = await send({ type: 'ui_get_log' });
  const filter = $('#logFilter').value;
  let log = (r?.log || []).slice().reverse();

  if (filter === 'error') log = log.filter((e) => e.level === 'error');
  else if (filter) log = log.filter((e) => e.event === filter);

  const host = $('#logList');
  if (!log.length) {
    host.innerHTML = '<div class="card muted">Пусто</div>';
    return;
  }

  host.innerHTML = log.slice(0, 300).map((e) => `
    <div class="logRow">
      <span class="dot ${levelClass(e.level)}"></span>
      <span class="ts">${new Date(e.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      <div>
        <div>${escape(e.msg || '')}</div>
        ${e.detail ? `<div class="detail">${escape(e.detail)}</div>` : ''}
        ${e.url ? `<a class="tiny" href="${escape(e.url)}" target="_blank" rel="noopener">открыть пост</a>` : ''}
      </div>
    </div>`).join('');
}

const levelClass = (l) => ({ success: 'ok', warn: 'warn', error: 'err' }[l] || '');

/* ------------------------------------------------------------------ *
 * Диагностика
 * ------------------------------------------------------------------ */

async function threadsTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.threads.com/*', 'https://threads.com/*',
      'https://www.threads.net/*', 'https://threads.net/*'],
  });
  return tabs[0] || null;
}

$('#runInspector').onclick = async () => {
  const host = $('#inspectorResult');
  host.innerHTML = '<div class="tiny muted" style="margin-top:10px">проверяю…</div>';

  const r = await send({ type: 'ui_run_inspector' });
  if (!r?.ok) {
    host.innerHTML = `<div class="tiny" style="color:var(--err);margin-top:10px">${escape(r?.error || 'не вышло')}</div>`;
    return;
  }

  const rep = r.report;
  host.innerHTML = `
    <div class="row" style="margin:12px 0 4px">
      <span class="pill ${rep.healthy ? 'ok' : 'err'}">${escape(rep.summary)}</span>
      <span class="tiny dim">${escape(rep.pageKind)} · ${escape(rep.url)}</span>
    </div>
    ${rep.checks.map((c) => `
      <div class="checkRow">
        <span class="dot ${c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'err'}"></span>
        <div>
          <strong>${escape(c.name)}</strong>
          <div class="detail">${escape(c.detail || '')}</div>
          ${c.strategies ? `<div class="strat">${c.strategies.map((s) =>
            `${s.name}: ${s.found}${s.error ? ` (${escape(s.error)})` : ''}`).join('  ·  ')}</div>` : ''}
        </div>
      </div>`).join('')}
    ${rep.sample ? `<details style="margin-top:12px"><summary class="tiny muted">разбор первой карточки</summary>
      <pre class="raw">${escape(JSON.stringify(rep.sample, null, 2))}</pre></details>` : ''}`;
};

$('#highlightOn').onclick = () => toggleHighlight(true);
$('#highlightOff').onclick = () => toggleHighlight(false);

async function toggleHighlight(on) {
  const tab = await threadsTab();
  if (!tab) return alert('Открой вкладку с threads.com');
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'ta_highlight', on }).catch(() => null);
  if (on && r?.ok) chrome.tabs.update(tab.id, { active: true });
}

$('#runDry').onclick = async () => {
  const host = $('#dryResult');
  const text = $('#dryText').value.trim();
  if (!text) return;

  host.innerHTML = '<div class="tiny muted" style="margin-top:10px">генерирую…</div>';

  const replies = $('#dryReplies').value.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = l.match(/^([^:]{1,40}):\s*(.+)$/);
      return m ? { author: m[1], text: m[2] } : { author: 'user', text: l };
    });

  const r = await send({ type: MSG.UI_DRY_RUN, text, replies });
  if (!r?.ok) {
    host.innerHTML = `<div class="tiny" style="color:var(--err);margin-top:10px">${escape(r?.error || 'ошибка')}</div>`;
    return;
  }

  const res = r.result;
  if (!res.ok) {
    host.innerHTML = `<div class="previewItem" style="margin-top:11px">
      <span style="color:var(--warn)">Пропуск: ${escape(res.reason)}</span>
      <div class="applied">попыток ${res.attempts} · $${res.cost.toFixed(4)}</div></div>`;
    return;
  }

  host.innerHTML = `
    <div class="previewItem" style="margin-top:11px">
      <div style="font-size:13.5px">${escape(res.text)}</div>
      <div class="applied">
        угол: ${escape(ANGLES[res.angle]?.label || res.angle)} ·
        ${res.replyTo != null ? `ответ на комментарий ${res.replyTo}` : 'ответ посту'} ·
        попыток ${res.attempts} · $${res.cost.toFixed(4)}
        ${res.humanized?.length ? `<br>гуманизация: ${escape(res.humanized.join(', '))}` : ''}
      </div>
    </div>
    ${res.analysis?.gap ? `<div class="tiny dim" style="margin-top:7px">Зацепка от ИИ: ${escape(res.analysis.gap)}</div>` : ''}
    <details style="margin-top:9px"><summary class="tiny muted">до гуманизации</summary>
      <pre class="raw">${escape(res.raw || '')}</pre></details>`;
};

$('#exportSettings').onclick = () => {
  const clean = JSON.parse(JSON.stringify(settings));
  clean.ai.apiKey = ''; // ключ в выгрузку не кладём
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `threadsense-ai-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};

$('#importSettings').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    const key = settings.ai.apiKey;            // ключ из файла не берём
    const r = await send({ type: 'ui_replace_settings', settings: { ...obj, ai: { ...obj.ai, apiKey: key } } });
    if (r?.ok) { settings = r.settings; renderAllTabs(); refreshStatus(); }
  } catch (err) {
    alert(`Не разобрал файл: ${err.message}`);
  }
  e.target.value = '';
};

$('#resetSettings').onclick = async () => {
  if (!confirm('Полностью сбросить настройки, профиль, промпты и ключ API? Это действие нельзя отменить.')) return;
  const r = await send({ type: 'ui_replace_settings', settings: {} });
  if (r?.ok) { settings = r.settings; renderAllTabs(); refreshStatus(); }
};

$('#resetState').onclick = async () => {
  if (!confirm('Сбросить счётчики, прогрев, кулдауны авторов и журнал?')) return;
  await send({ type: MSG.UI_RESET_STATE });
  refreshStatus();
  renderLog();
};

/* ------------------------------------------------------------------ *
 * Гуманизация: предпросмотр
 * ------------------------------------------------------------------ */

$('#humPreview').onclick = async () => {
  const text = $('#humInput').value;
  const r = await send({ type: MSG.UI_PREVIEW_HUMANIZE, text, n: 4 });
  const host = $('#humOutput');
  if (!r?.ok) return;
  host.innerHTML = r.variants.map((v) => `
    <div class="previewItem">
      <div>${escape(v.text)}</div>
      <div class="applied">${v.applied.length ? escape(v.applied.join(' · ')) : 'без изменений'}</div>
    </div>`).join('');
};

/* ------------------------------------------------------------------ *
 * Обучение стиля
 * ------------------------------------------------------------------ */

async function trainStyle(outEl, btn) {
  const handle = (settings.handle || '').replace(/^@/, '').trim();
  if (!handle) { outEl.textContent = 'Сначала укажи свой хэндл на вкладке «Ниша».'; return false; }

  const tab = await threadsTab();
  if (!tab) { outEl.textContent = 'Открой вкладку с threads.com и залогинься.'; return false; }

  if (btn) btn.disabled = true;
  outEl.textContent = 'иду по профилю: посты, затем ответы. Это займёт около минуты…';
  chrome.tabs.update(tab.id, { active: true });

  const collected = await send({ type: 'ui_collect_style' });
  if (!collected?.ok) {
    const detail = collected?.perPage
      ? ` (${Object.entries(collected.perPage).map(([k, v]) => `${k}: ${v}`).join(', ')})`
      : '';
    outEl.textContent = `Не вышло: ${collected?.error || 'нет ответа от страницы'}${detail}`;
    if (btn) btn.disabled = false;
    return false;
  }

  const per = collected.perPage
    ? ` (${Object.entries(collected.perPage).map(([k, v]) => `${k}: ${v}`).join(', ')})`
    : '';
  outEl.textContent = `собрано ${collected.samples.length} текстов${per}, разбираю стиль…`;

  // Ответы задают целевой регистр: агент пишет комментарии, а не посты.
  // Их отсутствие меняет задачу разбора, поэтому фон должен об этом знать.
  const hasReplies = Number(collected.perPage?.['ответы'] || 0) > 0;

  const r = await send({ type: MSG.UI_TRAIN_STYLE, samples: collected.samples, hasReplies });
  if (btn) btn.disabled = false;

  if (!r?.ok) {
    outEl.textContent = `Не вышло: ${r?.error || 'ошибка модели'}`;
    return false;
  }

  const fresh = await send({ type: 'ui_get_settings' });
  if (fresh?.ok) { settings = fresh.settings; renderTab('style'); }

  const lines = [
    `<span style="color:var(--ok)">Готово.</span> Разобрано ${r.meta.samples} текстов,`,
    `средняя длина ${r.meta.avgLen} символов, примеров сохранено ${r.profile.examples.length}.`,
    `Стоимость $${(r.cost || 0).toFixed(4)}.`,
  ];

  if (!hasReplies) {
    lines.push(
      '<br><br><b>В профиле не нашлось твоих ответов — только посты.</b>',
      'Пост и комментарий пишутся по-разному: пост человек готовит, комментарий бросает на ходу.',
      'Модель вывела манеру комментариев из манеры постов, но это догадка, а не слепок.',
      r.meta.examplesAreSynthetic
        ? '<br>Примеры ниже <b>придуманы моделью</b> по твоему тону — вычитай их и правь смело.'
        : '<br>Примеров нет: впиши 8–15 своих комментариев вручную, это главный рычаг качества.',
    );
  }

  outEl.innerHTML = lines.join(' ');
  return true;
}

$('#trainStyle').onclick = (e) => trainStyle($('#trainResult'), e.target);

/* ------------------------------------------------------------------ *
 * Мастер первого запуска
 * ------------------------------------------------------------------ */

let wizStep = 1;

function showWizard() {
  $('#wizard').classList.remove('hidden');
  $('#wizHandle').value = settings.handle || '';
  renderPresets($('#wizPresets'), settings.preset, onPresetPick);
  wizGo(1);
}

function wizGo(step) {
  wizStep = step;
  $$('.wizStep').forEach((s) => s.classList.toggle('hidden', Number(s.dataset.step) !== step));
  $$('.wizSteps span').forEach((s) => {
    const n = Number(s.dataset.step);
    s.className = n === step ? 'on' : n < step ? 'done' : '';
  });
  $('#wizBack').style.visibility = step === 1 ? 'hidden' : 'visible';
  $('#wizNext').textContent = step === 3 ? 'Готово' : 'Дальше';
}

$('#wizBack').onclick = () => wizGo(Math.max(1, wizStep - 1));

$('#wizNext').onclick = async () => {
  if (wizStep === 1) {
    const key = $('#wizKey').value.trim();
    if (key) { settings.ai.apiKey = key; scheduleSave(true); }
    if (!settings.ai.apiKey) {
      $('#wizKeyResult').textContent = 'без ключа агент работать не сможет';
      $('#wizKeyResult').style.color = 'var(--warn)';
      return;
    }
  }
  if (wizStep === 3) {
    settings.handle = $('#wizHandle').value.replace(/^@/, '').trim() || settings.handle;
    settings.onboarded = true;
    scheduleSave(true);
    $('#wizard').classList.add('hidden');
    renderAllTabs();
    refreshStatus();
    return;
  }
  wizGo(wizStep + 1);
};

$('#wizTestKey').onclick = async () => {
  const key = $('#wizKey').value.trim();
  const out = $('#wizKeyResult');
  if (!key) { out.textContent = 'вставь ключ'; out.style.color = 'var(--warn)'; return; }
  out.textContent = 'проверяю…';
  out.style.color = '';
  if (!await ensureApiPermission(settings.ai.baseUrl)) {
    out.textContent = 'разреши доступ к адресу API';
    out.style.color = 'var(--err)';
    return;
  }
  const r = await send({ type: MSG.UI_TEST_KEY, ai: { ...settings.ai, apiKey: key } });
  if (r?.ok) {
    settings.ai.apiKey = key;
    scheduleSave(true);
    out.textContent = `работает · ${r.model}`;
    out.style.color = 'var(--ok)';
    if (r.models?.length) applyAvailableModels(r.models, r.model);
  } else {
    out.textContent = r?.error || 'не отвечает';
    out.style.color = 'var(--err)';
  }
};

$('#wizProvider').onchange = () => {
  const apiKey = $('#wizKey').value.trim() || settings.ai.apiKey;
  settings.ai = { ...settings.ai, ...providerDefaults($('#wizProvider').value), apiKey };
  scheduleSave(true);
};

$('#wizTrain').onclick = async (e) => {
  settings.handle = $('#wizHandle').value.replace(/^@/, '').trim();
  await scheduleSave(true);
  await trainStyle($('#wizTrainResult'), e.target);
};

$('#wizSkipTrain').onclick = () => {
  settings.onboarded = true;
  scheduleSave(true);
  $('#wizard').classList.add('hidden');
};

/* ------------------------------------------------------------------ *
 * Вкладки и запуск
 * ------------------------------------------------------------------ */

/*
 * Разделы разделены на постоянно нужные и редко нужные.
 *
 * Пресет задаёт весь режим целиком, поэтому всё, что лежит в «расширенных»,
 * уже настроено. Полтора десятка вкладок перед человеком, которому достаточно
 * выбрать один из трёх режимов, создают ощущение, что без них не заработает.
 */
const ADV_KEY = 'ta_adv_open';

$$('#nav button, #navAdv button').forEach((b) => {
  b.onclick = () => openTab(b.dataset.tab);
});

function setAdvanced(open) {
  $('#navAdv').classList.toggle('hidden', !open);
  $('#advToggle').setAttribute('aria-expanded', String(open));
  $('#advToggle').classList.toggle('on', open);
  try { localStorage.setItem(ADV_KEY, open ? '1' : '0'); } catch { /* не критично */ }
}

$('#advToggle').onclick = () => {
  setAdvanced($('#navAdv').classList.contains('hidden'));
};

function openTab(tab) {
  $$('#nav button, #navAdv button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('main .tab').forEach((s) => s.classList.toggle('on', s.dataset.tab === tab));
  location.hash = tab === 'start' ? '' : tab;

  // Переход по прямой ссылке на скрытый раздел обязан его показать: иначе
  // вкладка откроется, а в навигации не будет видно, где ты находишься.
  if ([...$$('#navAdv button')].some((b) => b.dataset.tab === tab)) setAdvanced(true);

  if (tab === 'queue') renderQueue();
  if (tab === 'log') renderLog();
}

$('#stPower').onchange = async (e) => {
  await send({ type: MSG.UI_TOGGLE, enabled: e.target.checked });
  refreshStatus();
};

$('#stAutopilot').onchange = (e) => {
  const enableAutopilot = !e.target.checked;
  if (enableAutopilot && !window.confirm('Включить автопубликацию? Тексты будут отправляться без вашего подтверждения. Для первого запуска рекомендуем оставить проверку черновиков.')) {
    e.target.checked = true;
    return;
  }
  settings.autopilot = enableAutopilot;
  scheduleSave(true);
};

$$('[data-open-tab]').forEach((b) => {
  b.onclick = () => openTab(b.dataset.openTab);
});

$('[data-ready="mode"]').onclick = () => $('#modeCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

$('#qRefresh').onclick = renderQueue;
$('#qShowDone').onclick = (e) => {
  showDone = !showDone;
  e.target.textContent = showDone ? 'Только ожидающие' : 'Показать обработанные';
  renderQueue();
};

$('#logRefresh').onclick = renderLog;
$('#logFilter').onchange = renderLog;
$('#logClear').onclick = async () => { await send({ type: 'ui_clear_log' }); renderLog(); };

/* -------------------------------- Утилиты -------------------------------- */

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function trim(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function clampNum(v, min, max) {
  if (!isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function fmtNum(v) {
  const n = Number(v);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 0.1 ? 3 : 2);
}

function ruCount(n, forms) {
  const value = Math.abs(Number(n)) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

/* --------------------------------- Init ---------------------------------- */

/** Выбор пресета применяется сразу и перерисовывает все зависимые поля. */
async function onPresetPick(key) {
  settings = applyPreset(settings, key);
  await scheduleSave(true);
  renderPresets($('#presets'), key, onPresetPick);
  if (!$('#wizard').classList.contains('hidden')) {
    renderPresets($('#wizPresets'), key, onPresetPick);
  }
  renderAllTabs();
  await refreshStatus();
}

async function init() {
  const r = await send({ type: 'ui_get_settings' });
  settings = r.settings;

  const providerSelect = $('#wizProvider');
  providerSelect.innerHTML = '';
  for (const [id, provider] of Object.entries(AI_PROVIDERS)) {
    providerSelect.add(new Option(provider.label, id));
  }
  providerSelect.value = settings.ai.provider || 'openai';

  renderAllTabs();
  renderPresets($('#presets'), settings.preset, onPresetPick);
  renderReadiness();

  // Раскрытое состояние расширенных разделов запоминается: кто их однажды
  // открыл, обычно возвращается туда снова.
  let advOpen = false;
  try { advOpen = localStorage.getItem(ADV_KEY) === '1'; } catch { /* не критично */ }
  setAdvanced(advOpen);

  const hash = location.hash.replace('#', '');
  if (hash === 'wizard' || !settings.onboarded) showWizard();
  else if (hash) openTab(hash);

  refreshStatus();
  setInterval(refreshStatus, 4000);
}

init();

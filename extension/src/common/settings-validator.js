import { DEFAULTS } from './defaults.js';
import { validateBaseUrl } from './providers.js';

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const LIMITS = Object.freeze({
  'ai.dailyBudgetUsd': [0.05, 50],
  'ai.requestTimeoutMs': [5000, 120000],
  'ai.maxRetries': [0, 6],
  'ai.maxOutputTokens': [60, 2000],
  'limits.perDay': [0, 100],
  'limits.perHour': [1, 20],
  'limits.perHourMin': [1, 20],
  'limits.warmupDays': [0, 90],
  'timing.tickSec': [5, 300],
  'timing.inSessionMinSec': [5, 3600],
  'timing.inSessionMaxSec': [5, 7200],
  'posting.perDay': [0, 20],
  'posting.perDayMin': [0, 20],
  'posting.perDayMax': [0, 20],
  'posting.intervalHours': [0.5, 24],
  'posting.windowFromHour': [0, 23],
  'posting.windowToHour': [0, 23],
  'posting.startAfterDay': [0, 60],
  'hosting.maxPerDay': [0, 100],
  'ui.logSize': [50, 2000],
});

function cleanPricing(input) {
  const out = structuredClone(DEFAULTS.ai.pricing);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [model, value] of Object.entries(input).slice(0, 200)) {
    if (BLOCKED_KEYS.has(model) || !/^[A-Za-z0-9._:/-]{1,120}$/.test(model) || !value || typeof value !== 'object') continue;
    const read = (key) => {
      const n = value[key];
      return typeof n === 'number' && Number.isFinite(n) ? Math.min(10000, Math.max(0, n)) : 0;
    };
    out[model] = { input: read('input'), cached: read('cached'), output: read('output') };
  }
  return out;
}

function clean(base, input, path = '') {
  if (Array.isArray(base)) {
    if (!Array.isArray(input)) return base.slice();
    const sample = base.find((item) => item != null);
    return input.slice(0, 500).filter((item) => {
      // Empty arrays in the public schema are text lists: keywords, languages,
      // model fallbacks, query templates and similar user-entered values.
      if (sample === undefined) return typeof item === 'string';
      return typeof item === typeof sample && (typeof item !== 'number' || Number.isFinite(item));
    }).map((item) => typeof item === 'string' ? item.slice(0, 2000) : item);
  }
  if (base && typeof base === 'object') {
    if (path === 'ai.pricing') return cleanPricing(input);
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = {};
    for (const [key, fallback] of Object.entries(base)) {
      if (BLOCKED_KEYS.has(key)) continue;
      out[key] = clean(fallback, source[key], path ? `${path}.${key}` : key);
    }
    return out;
  }
  if (typeof base === 'number') {
    const value = typeof input === 'number' && Number.isFinite(input) ? input : base;
    const bounds = LIMITS[path];
    return bounds ? Math.min(bounds[1], Math.max(bounds[0], value)) : value;
  }
  if (typeof base === 'boolean') return typeof input === 'boolean' ? input : base;
  if (typeof base === 'string') return typeof input === 'string' ? input.slice(0, 20000) : base;
  return base;
}

/** Безопасный профиль из файла: неизвестные ключи и несовместимые типы удаляются. */
export function sanitizeImportedSettings(input, current = DEFAULTS) {
  const safe = clean(DEFAULTS, input || {});
  safe.ai.apiKey = String(current?.ai?.apiKey || '');
  safe.posting.sourceToken = String(current?.posting?.sourceToken || '');
  safe.enabled = false;
  safe.autopilot = false;
  safe.onboarded = false;
  safe.ai.connectionVerified = false;

  if (!validateBaseUrl(safe.ai.baseUrl).ok) safe.ai.baseUrl = DEFAULTS.ai.baseUrl;
  if (safe.posting.sourceUrl) {
    try {
      const url = new URL(safe.posting.sourceUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) safe.posting.sourceUrl = '';
    } catch { safe.posting.sourceUrl = ''; }
  }
  return safe;
}

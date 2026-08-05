/**
 * Public AI provider catalog.
 *
 * `openai` means the widely supported Chat Completions wire format, not the
 * OpenAI company. Anthropic and Gemini use their native protocols.
 */
export const AI_PROVIDERS = Object.freeze({
  openai: {
    label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  },
  anthropic: {
    label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
  },
  deepseek: {
    label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  kimi: {
    label: 'Kimi / Moonshot AI', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.5'],
  },
  gemini: {
    label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'],
  },
  xai: {
    label: 'xAI / Grok', protocol: 'openai', baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3-mini'],
  },
  mistral: {
    label: 'Mistral AI', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'mistral-medium-latest'],
  },
  groq: {
    label: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
    models: [],
  },
  openrouter: {
    label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
  },
  together: {
    label: 'Together AI', protocol: 'openai', baseUrl: 'https://api.together.xyz/v1',
    models: [],
  },
  custom: {
    label: 'Свой OpenAI-совместимый API', protocol: 'openai', baseUrl: '', models: [],
  },
});

export const PROVIDER_CHOICES = Object.entries(AI_PROVIDERS)
  .map(([value, provider]) => ({ value, label: provider.label }));

export function providerOf(cfg = {}) {
  const id = Object.hasOwn(AI_PROVIDERS, cfg.provider) ? cfg.provider : 'openai';
  return { id, ...AI_PROVIDERS[id] };
}

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * API-ключ разрешено отправлять только по HTTPS. Незашифрованный HTTP
 * оставлен исключительно для сервера на этом же компьютере.
 */
export function validateBaseUrl(value) {
  try {
    const url = new URL(normalizeBaseUrl(value));
    if (url.username || url.password) return { ok: false, error: 'Логин и пароль нельзя указывать в адресе API' };
    if (url.protocol === 'https:') return { ok: true, url };
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && local) return { ok: true, url };
    return { ok: false, error: 'Удалённый API должен использовать HTTPS; HTTP разрешён только для localhost' };
  } catch {
    return { ok: false, error: 'Некорректный адрес API' };
  }
}

export function providerDefaults(id) {
  const p = AI_PROVIDERS[id] || AI_PROVIDERS.openai;
  const first = p.models[0] || '';
  return {
    provider: Object.hasOwn(AI_PROVIDERS, id) ? id : 'openai',
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    modelScore: first,
    modelWrite: first,
    modelStyle: first,
    fallbackChain: p.models.slice(1),
  };
}

/** Unified text-generation client for ThreadSense AI. */
import { PRICING, traitsOf } from '../common/defaults.js';
import { normalizeBaseUrl, providerOf } from '../common/providers.js';

export class AIProviderError extends Error {
  constructor(message, { status = 0, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

// Backward-compatible export for existing tests and integrations.
export const OpenAIError = AIProviderError;

export function costOf(model, usage, pricing = PRICING, fallback = null) {
  const p = pricing?.[model] || fallback;
  if (!p) return 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens || usage?.cache_read_input_tokens || 0;
  const input = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const output = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  return ((Math.max(0, input - cached) * p.input) + (cached * (p.cached ?? p.input)) + (output * p.output)) / 1e6;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compact = (value, max = 280) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function commonMessages(system, messages) {
  return [...(system ? [{ role: 'system', content: system }] : []), ...messages];
}

function openAIPayload(cfg, opts, model, providerId) {
  const traits = traitsOf(model);
  const body = {
    model,
    messages: commonMessages(opts.system, opts.messages || []),
  };
  const tokenField = providerId === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  body[tokenField] = opts.maxTokens ?? cfg.maxOutputTokens;
  if (traits.sampling) {
    body.temperature = opts.temperature ?? cfg.temperature;
    body.top_p = opts.topP ?? cfg.topP;
    body.presence_penalty = opts.presencePenalty ?? cfg.presencePenalty;
    body.frequency_penalty = opts.frequencyPenalty ?? cfg.frequencyPenalty;
  }
  if (traits.reasoning && cfg.reasoningEffort && cfg.reasoningEffort !== 'none') {
    body.reasoning_effort = cfg.reasoningEffort;
  }
  if (opts.json) body.response_format = { type: 'json_object' };
  return body;
}

function anthropicPayload(cfg, opts, model) {
  const messages = (opts.messages || []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  }));
  return {
    model,
    max_tokens: opts.maxTokens ?? cfg.maxOutputTokens,
    ...(opts.system ? { system: opts.system } : {}),
    messages,
    temperature: opts.temperature ?? cfg.temperature,
  };
}

function geminiPayload(cfg, opts) {
  const contents = (opts.messages || []).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }],
  }));
  return {
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
    contents,
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? cfg.maxOutputTokens,
      temperature: opts.temperature ?? cfg.temperature,
      topP: opts.topP ?? cfg.topP,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
}

function requestFor(cfg, opts, model) {
  const provider = providerOf(cfg);
  const base = normalizeBaseUrl(cfg.baseUrl || provider.baseUrl);
  if (!base) throw new AIProviderError('Не задан адрес API', { status: 400 });
  if (provider.protocol === 'anthropic') {
    return {
      url: `${base}/messages`,
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: anthropicPayload(cfg, opts, model),
    };
  }
  if (provider.protocol === 'gemini') {
    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: geminiPayload(cfg, opts),
    };
  }
  return {
    url: `${base}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: openAIPayload(cfg, opts, model, provider.id),
  };
}

function parseResponse(cfg, data) {
  const protocol = providerOf(cfg).protocol;
  if (protocol === 'anthropic') {
    return {
      text: (data?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join(''),
      usage: data?.usage || {}, finishReason: data?.stop_reason,
    };
  }
  if (protocol === 'gemini') {
    return {
      text: (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join(''),
      usage: {
        prompt_tokens: data?.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data?.usageMetadata?.candidatesTokenCount || 0,
      },
      finishReason: data?.candidates?.[0]?.finishReason,
    };
  }
  return {
    text: data?.choices?.[0]?.message?.content || '',
    usage: data?.usage || {}, finishReason: data?.choices?.[0]?.finish_reason,
  };
}

export async function chat(cfg, opts) {
  if (!cfg?.apiKey) throw new AIProviderError('Не задан ключ API', { status: 401 });
  const model = opts.model || cfg.modelWrite;
  if (!model) throw new AIProviderError('Не выбрана модель', { status: 400 });
  const request = requestFor(cfg, opts, model);
  let lastError;

  for (let attempt = 0; attempt <= (cfg.maxRetries ?? 2); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs ?? 45000);
    try {
      const response = await fetch(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
        throw new AIProviderError(`API ${response.status}: ${compact(errorBody)}`, {
          status: response.status, retryable, body: errorBody,
        });
      }
      const parsed = parseResponse(cfg, await response.json());
      if (!parsed.text.trim()) throw new AIProviderError('Модель вернула пустой ответ', { retryable: false });
      return {
        ...parsed, model, provider: providerOf(cfg).id,
        cost: costOf(model, parsed.usage, cfg.pricing, cfg.defaultPricing),
      };
    } catch (error) {
      clearTimeout(timer);
      lastError = error instanceof AIProviderError
        ? error
        : new AIProviderError(error.name === 'AbortError' ? 'Таймаут запроса к API' : `Сеть: ${error.message}`, { retryable: true });
      if (!lastError.retryable || attempt >= (cfg.maxRetries ?? 2)) throw lastError;
      await sleep((cfg.retryBaseMs ?? 900) * (2 ** attempt) * (0.7 + Math.random() * 0.6));
    }
  }
  throw lastError || new AIProviderError('Неизвестная ошибка API');
}

function canTryAnotherModel(error) {
  if (!(error instanceof AIProviderError)) return true;
  if ([400, 401, 402, 403].includes(error.status)) return false;
  return true;
}

export async function chatWithFallback(cfg, opts, chain) {
  const models = [...new Set([opts.model || cfg.modelWrite, ...(chain || [])])].filter(Boolean);
  const attempts = [];
  let lastError;
  for (const model of models) {
    try {
      const result = await chat(cfg, { ...opts, model });
      return { ...result, attempts: [...attempts, { model, ok: true }], fellBack: attempts.length > 0 };
    } catch (error) {
      lastError = error;
      attempts.push({ model, ok: false, error: error.message, status: error.status });
      if (!canTryAnotherModel(error)) break;
    }
  }
  if (lastError) lastError.attempts = attempts;
  throw lastError || new AIProviderError('Нет доступной модели');
}

export async function testKey(cfg) {
  try {
    const result = await chat({ ...cfg, maxRetries: 0, requestTimeoutMs: 20000 }, {
      model: cfg.modelScore || cfg.modelWrite,
      messages: [{ role: 'user', content: 'Reply with one word: OK' }],
      maxTokens: 64,
    });
    return { ok: true, provider: result.provider, model: result.model, reply: result.text.trim(), cost: result.cost };
  } catch (error) {
    return { ok: false, error: error.message, status: error.status };
  }
}

export async function listModels(cfg) {
  const provider = providerOf(cfg);
  const base = normalizeBaseUrl(cfg.baseUrl || provider.baseUrl);
  try {
    let url = `${base}/models`;
    let headers;
    if (provider.protocol === 'anthropic') headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
    else if (provider.protocol === 'gemini') headers = { 'x-goog-api-key': cfg.apiKey };
    else headers = { Authorization: `Bearer ${cfg.apiKey}` };
    const response = await fetch(url, { headers });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    const models = provider.protocol === 'gemini'
      ? (data.models || []).filter((item) => (item.supportedGenerationMethods || []).includes('generateContent')).map((item) => item.baseModelId || item.name?.replace(/^models\//, ''))
      : (data.data || []).map((item) => item.id);
    return { ok: true, models: [...new Set(models.filter(Boolean))].sort() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

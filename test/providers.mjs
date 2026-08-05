import assert from 'node:assert/strict';
import { chat, listModels } from '../extension/src/bg/openai.js';
import { AI_PROVIDERS, providerDefaults } from '../extension/src/common/providers.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok  ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const base = {
  apiKey: 'fixture-not-a-real-key',
  temperature: 0.7,
  topP: 0.9,
  presencePenalty: 0.1,
  frequencyPenalty: 0.1,
  maxOutputTokens: 120,
  requestTimeoutMs: 2000,
  maxRetries: 0,
  pricing: {},
  defaultPricing: { input: 1, cached: 0.5, output: 2 },
};

async function capture(responseBody, run, status = 200) {
  const before = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init = {}) => {
    request = { url: String(url), ...init, json: init.body ? JSON.parse(init.body) : null };
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await run();
    return { request, result };
  } finally {
    globalThis.fetch = before;
  }
}

await test('каталог содержит нативные и OpenAI-совместимые API', () => {
  assert.equal(AI_PROVIDERS.anthropic.protocol, 'anthropic');
  assert.equal(AI_PROVIDERS.gemini.protocol, 'gemini');
  assert.equal(AI_PROVIDERS.deepseek.protocol, 'openai');
  assert.equal(providerDefaults('kimi').provider, 'kimi');
});

await test('OpenAI использует max_completion_tokens', async () => {
  const { request, result } = await capture(
    { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    () => chat({ ...base, ...providerDefaults('openai'), apiKey: base.apiKey }, {
      model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'test' }],
    }),
  );
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.json.max_completion_tokens, 120);
  assert.equal(request.json.max_tokens, undefined);
  assert.equal(result.text, 'OK');
});

await test('OpenAI-совместимые провайдеры используют max_tokens', async () => {
  const { request } = await capture(
    { choices: [{ message: { content: 'done' } }], usage: {} },
    () => chat({ ...base, ...providerDefaults('deepseek'), apiKey: base.apiKey }, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: 'test' }],
    }),
  );
  assert.equal(request.json.max_tokens, 120);
  assert.equal(request.json.max_completion_tokens, undefined);
  assert.match(request.headers.Authorization, /^Bearer /);
});

await test('Anthropic Messages API собирается и разбирается нативно', async () => {
  const { request, result } = await capture(
    { content: [{ type: 'text', text: 'готово' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' },
    () => chat({ ...base, ...providerDefaults('anthropic'), apiKey: base.apiKey }, {
      model: 'claude-test', system: 'system', messages: [{ role: 'user', content: 'test' }],
    }),
  );
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'fixture-not-a-real-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.json.system, 'system');
  assert.equal(request.json.top_p, undefined);
  assert.equal(result.text, 'готово');
  assert.equal(result.cost, 0.00002);
});

await test('Gemini generateContent и список моделей работают нативно', async () => {
  const generated = await capture(
    {
      candidates: [{ content: { parts: [{ text: 'yes' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    },
    () => chat({ ...base, ...providerDefaults('gemini'), apiKey: base.apiKey }, {
      model: 'gemini-test', system: 'system', messages: [{ role: 'user', content: 'test' }], json: true,
    }),
  );
  assert.equal(generated.request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(generated.request.headers['x-goog-api-key'], 'fixture-not-a-real-key');
  assert.equal(generated.request.json.generationConfig.responseMimeType, 'application/json');
  assert.equal(generated.result.text, 'yes');

  const listed = await capture(
    { models: [
      { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embed-a', supportedGenerationMethods: ['embedContent'] },
    ] },
    () => listModels({ ...base, ...providerDefaults('gemini'), apiKey: base.apiKey }),
  );
  assert.deepEqual(listed.result.models, ['gemini-a']);
});

console.log(`\nПроверено провайдеров: ${passed}`);

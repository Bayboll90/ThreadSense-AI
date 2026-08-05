# Testing ThreadSense AI

## Public CI

`npm test` runs three hermetic suites:

- `test/syntax.mjs` parses every extension module, validates the manifest and checks cross-module contracts;
- `test/math.mjs` verifies scheduling, limits, scoring, generation guards, migrations, provider-independent logic and state machines.
- `test/providers.mjs` verifies OpenAI-compatible, Anthropic and Gemini request/response contracts with mocked network responses.

These tests need no account, browser profile or API key.

The regression suite also asserts public-safe defaults, manual-mode behavior, credential-free imports, secure custom endpoints and the schema migration that stops an older active installation before the new version can run.

## Local browser scenarios

Live browser probes are intentionally excluded from the public repository because they can contain account-specific selectors, logs and captured content. If you create one locally, use a dedicated test account and disposable profile. Never commit the profile, cookies, storage dumps, logs or `.env` file.

Live scenarios can read or type into Threads and may consume API tokens. Review each script before running it; publishing actions must remain disabled unless the operator explicitly intends a controlled test.

The project was previously exercised in a controlled real Threads run, including feed reading, selector diagnostics, drafting and publishing flows. That evidence demonstrates that the browser interaction chain worked at that point in time; it is not an anti-ban claim. The account used for the extended run was later permanently suspended, so the public release deliberately does not ship the former activity profile and does not repeat a live publishing test on somebody else's account.

## AI provider checks

The settings page offers a non-publishing connection test. A provider adapter is complete only when all of these paths work:

1. authentication failure is clear and does not trigger model fallback;
2. a minimal text response is parsed;
3. available models are listed for the entered key;
4. timeout, rate-limit and 5xx retries stop at the configured limit;
5. JSON mode and token usage normalize into the common result shape.

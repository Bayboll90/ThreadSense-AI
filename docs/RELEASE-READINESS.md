# Release readiness — 2.2.0

Checked on 2026-08-05.

## Public-safe state

- A fresh installation is stopped, uses the `careful` preset and has autopilot, own posts, external sources and privileged browser debugging disabled.
- Upgrading from schema 15 stops the agent and requires onboarding again before it can run.
- The start control remains unavailable until the AI connection succeeds and the user supplies both their own Threads handle and a topic.
- Manual mode creates reviewable drafts and never chooses automatic likes.
- Own posts are a separate opt-in; choosing an activity preset does not enable them.
- Settings export omits the AI key and material-source token. Import preserves local credentials, removes unknown or invalid values and returns the agent to a stopped, unverified state.
- Remote custom API and material endpoints require HTTPS. Plain HTTP is accepted only on loopback addresses for local development.
- The manifest does not request the Chrome `debugger` permission.

## AI compatibility

Native request/response adapters are present for Anthropic Messages and Google Gemini `generateContent`. OpenAI, DeepSeek, Kimi/Moonshot, xAI, Mistral, Groq, OpenRouter, Together AI and custom gateways use the Chat Completions-compatible adapter.

The setup page requests the model catalog with the entered key, lets the user choose separate models for scoring, writing and style, and then performs a real generation probe. Static model names are only a fallback for an unavailable catalog.

Provider tests use mocked network responses and verify URLs, authentication headers, request shapes, normalized text/usage and model discovery. They do not claim that a third-party account, quota or model entitlement is active. That final live check happens with the user's own key during onboarding.

## Verification evidence

- `npm test`: 63 extension files parsed; 269 deterministic/regression checks passed; 6 provider-contract checks passed.
- Public manifest, package version, preset paths and obvious credential patterns are checked by the test suite.
- The complete first-run browser journey was exercised from an empty profile through API verification, handle, topic, 100% readiness and manual launch.
- No browser console errors were observed in the settings or popup preview.
- Horizontal overflow was checked at popup widths 320, 360 and 390 px and settings widths 360 and 768 px. In every case `scrollWidth === clientWidth`.
- The repository's three existing Git commits and the current publish set were scanned for common API-key prefixes, private keys and public IPv4 addresses; no matches were found.

## Live Threads boundary

Earlier private test runs exercised real Threads selectors, feed reading, drafting and publishing. A longer run later ended with a permanently suspended account. This proves only that the interaction chain worked against the UI at that time; it does not prove safety or platform permission. Live profiles, cookies, captured content and operational probes remain ignored and are not part of the public repository.

Publish through Git, not by uploading the whole working directory. `git ls-files` is the release boundary; ignored browser profiles and private test artifacts must stay local.

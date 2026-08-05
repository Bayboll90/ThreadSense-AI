# Release readiness — 2.3.0

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

## GitHub release updates

- The repository button is visible at the top of both the popup and Settings and only opens `https://github.com/sany86russ/ThreadSense-AI`.
- The background checks GitHub's public `releases/latest` endpoint at startup and every 6 hours, ignores drafts, prereleases, malformed tags and versions that are not newer, and prefers the exact ready-to-use ZIP asset name.
- Failures, offline mode, timeouts and API rate limits are best-effort and never stop the agent. Concurrent checks are serialized and routine requests are throttled.
- A newer stable release produces one Chrome notification and dismissible banners in both UI surfaces. Remote strings are inserted as text, not HTML, and remote URLs are accepted only under the canonical GitHub repository.
- Because Chrome cannot let an unpacked extension safely overwrite itself, the UI guides the user through downloading, extracting and reloading the directory from `chrome://extensions`.

## Verification evidence

- `npm test`: 65 extension files parsed; 269 deterministic/regression checks passed; 6 provider-contract checks and the GitHub release contract passed.
- Public manifest, package version, preset paths and obvious credential patterns are checked by the test suite.
- The complete first-run browser journey was exercised from an empty profile through API verification, handle, topic, 100% readiness and manual launch.
- Clean reloads of the settings and popup previews produced no new browser console errors.
- The new controls were checked at 390 px and on a wide settings viewport. The popup reported `scrollWidth === innerWidth`, no button text clipping and no element outside the viewport; Settings had no overflow outside its deliberately scrollable mobile navigation.
- The repository's three existing Git commits and the current publish set were scanned for common API-key prefixes, private keys and public IPv4 addresses; no matches were found.

## Live Threads boundary

Earlier private test runs exercised real Threads selectors, feed reading, drafting and publishing. A longer run later ended with a permanently suspended account. This proves only that the interaction chain worked against the UI at that time; it does not prove safety or platform permission. Live profiles, cookies, captured content and operational probes remain ignored and are not part of the public repository.

Publish through Git, not by uploading the whole working directory. `git ls-files` is the release boundary; ignored browser profiles and private test artifacts must stay local.

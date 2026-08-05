# Security policy

Please do not publish API keys, cookies, browser profiles, storage dumps, private Threads content or server access details in issues.

For a vulnerability report, open a GitHub security advisory in this repository. Include affected version, reproduction steps, impact and a minimal redacted proof. Do not test against accounts or data you do not own.

API credentials are stored in `chrome.storage.local`; this is convenience storage, not a hardware-backed secret vault. Use a dedicated key, provider-side spending limits and regular rotation. Exported settings deliberately contain an empty `apiKey` and `sourceToken`. Remote custom AI and material endpoints must use HTTPS; plain HTTP is limited to local loopback development.

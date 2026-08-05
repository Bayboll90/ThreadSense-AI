# Privacy

ThreadSense AI runs as a local Chrome extension. It reads visible Threads page content needed for filtering, drafting and diagnostics. Settings, history, generated drafts and the selected API key are stored locally in Chrome extension storage.

Text sent for generation is transmitted to the AI provider selected by the user. Provider retention and training rules are governed by that provider's terms and account configuration. The connection test also requests the provider's model catalog. Optional material may be loaded from Google News and Hacker News using the user's niche terms. The GitHub and MCP sources are disabled by default and contact GitHub, raw.githubusercontent.com, and the public MCP registry only after the user enables and configures that source.

The project contains no analytics, advertising SDK or developer-operated telemetry endpoint. The API key is local convenience storage, not a hardware-backed vault. Exported settings omit it. Users can erase configuration and credentials with the full reset action in Settings → Diagnostics.

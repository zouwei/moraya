# Privacy Policy for Moraya

**Effective Date:** February 20, 2026

[moraya.app](https://moraya.app) develops and distributes Moraya, an open-source AI-powered Markdown editor (the "Software"). This Software is provided by moraya.app and is intended for use as is.

This Privacy Policy informs you of our policies regarding the collection, use, and disclosure of information when you use Moraya. By using Moraya, you agree to the collection and use of information in accordance with this policy.

The terms used in this Privacy Policy have the same meanings as in our Terms of Service (if any), accessible via our documentation or website, unless otherwise defined here.

This Privacy Policy applies only to the use of the Moraya Software itself. Visiting our official website (moraya.app), documentation, GitHub repository, or other related sites is governed by their respective privacy policies (if any).

## Information Collection and Use

Moraya is designed to operate primarily locally on your device with minimal data collection. **We do not collect any personal or usage data by default.**

### Anonymous Usage Data (Optional)

Moraya does not enable anonymous usage statistics by default. If a future update introduces an optional "Send Anonymous Usage Info" setting in the preferences panel, the following will apply:

- Anonymous data will only be sent if you explicitly enable this option.
- You may disable it at any time (a restart may be required for changes to take effect).
- Collected data would be strictly anonymous and used solely for improving the Software, including:
  - Moraya version, operating system, screen resolution, locale, and approximate country (derived from IP address).
  - General operation names (e.g., "launch", "new document", "AI assist") for aggregate usage statistics. No detailed user-specific sequences or sensitive content will be collected.
  - Session duration.
  - Non-sensitive preference settings (e.g., theme, editor mode).

When errors occur, and if anonymous reporting is enabled, we may collect stack traces, relevant settings, and runtime state to diagnose issues. This data will not contain personal or sensitive information.

### No Personal Data Collection

Moraya does not collect, store, or transmit any personal identifiers, document content, or sensitive data to our servers unless explicitly initiated by you (e.g., via feedback or AI features described below).

## AI Features and Third-Party Services

Moraya includes built-in AI assistance supporting multiple models: Claude (Anthropic), OpenAI, Gemini (Google), DeepSeek, and Ollama.

- **Cloud-based AI Models** (Claude, OpenAI, Gemini, DeepSeek):  
  When you use these models, your selected text, prompt, or context is sent directly to the respective third-party provider's servers for processing. Streaming responses are received in real-time.  
  **We do not store, log, or access this data.** Transmission occurs only when you explicitly invoke an AI feature.  
  These providers may collect and process your input according to their own privacy policies. We strongly recommend reviewing their policies:
  - Anthropic: https://www.anthropic.com/legal/privacy
  - OpenAI: https://openai.com/policies/privacy
  - Google Gemini: https://policies.google.com/privacy
  - DeepSeek: Check their official site for current policy

- **Local AI Model** (Ollama):  
  When configured to use Ollama, processing occurs entirely on your device. No data is sent externally.

Moraya does not automatically install or launch any third-party services. AI usage requires user configuration (e.g., API keys) and explicit activation.

### API Key Storage (Bring Your Own Key)

Moraya follows a **Bring Your Own Key (BYOK)** model — you provide your own API keys for the AI providers you choose to use. Your API keys are:

- **Stored exclusively on your device** in the operating system's native secure storage (macOS Keychain, Windows Credential Manager, or Linux Secret Service/libsecret). Keys are encrypted at rest by the OS.
- **Never transmitted to Moraya's servers.** We do not operate any server infrastructure that receives, stores, or processes your API keys.
- **Never included in logs, telemetry, error reports, or crash data.** API keys are resolved at runtime by the local Rust backend and are never exposed to the frontend or written to disk in plaintext.

You are responsible for obtaining and managing your own API keys from the respective providers.

### Direct Data Transfer (No Intermediary)

When you use AI features, your prompts and content are sent **directly from your device** to the selected provider's API endpoint. Specifically:

- **No relay or proxy servers.** Moraya does not operate any intermediary servers. There is no Moraya-hosted backend that your data passes through.
- **On-device authentication.** Moraya's local Rust backend retrieves your API key from the OS secure storage and injects the authentication header on your device — before the request leaves your machine.
- **Direct data path.** The network path is: **Your Device → Provider API** (e.g., `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`). No intermediate stops.
- **Direct response streaming.** Response data streams directly from the provider back to your device via the same direct connection.

This architecture ensures that Moraya never has access to your AI conversations or the ability to intercept, log, or analyze your prompts and responses.

We have no control over, and assume no responsibility for, the privacy practices of these third-party AI providers.

## External Resources and Links

Moraya supports embedding images, videos, iframes, and other resources from remote websites in your Markdown documents. When you open or preview such documents:

- These resources are loaded directly from their source URLs.
- The external sites may collect information about your request (e.g., IP address, user agent).

If your document contains links to third-party sites and you click them, you will be directed outside Moraya. We have no control over external sites and recommend reviewing their privacy policies.

## Log Data

Moraya generates minimal local logs on your device for debugging and performance purposes. These logs remain stored locally and are never transmitted unless you explicitly share them (e.g., during feedback).

## Backups and Local Storage

All documents, settings, and backups created by Moraya are stored exclusively on your local device. Automatic backups (if enabled) are designed to prevent data loss and remain local. No data is uploaded to our servers.

## Feedback and Bug Reports

If you submit feedback, bug reports, or support requests (via GitHub, email, or other channels), you may voluntarily provide information such as system details, steps to reproduce, or sample files. You control what you share and may refuse or redact sensitive content.

Any shared files will be used solely for debugging and improvement purposes. We will not disclose them to third parties without your permission and will delete them upon request after resolution.

Communication channels (e.g., GitHub, email) are third-party services with their own privacy policies.

## Service Providers

We do not share your data with third-party companies or individuals except as described above (AI providers during active use).

## Security

We prioritize local-first design to minimize risks. However, no method of electronic storage or transmission is 100% secure. You are responsible for securing your device and API keys.

## Children’s Privacy

Moraya is not intended for users under 13. We do not knowingly collect personal information from children under 13. If discovered, we will delete such information promptly. Parents/guardians should contact us if concerned.

## Changes to This Privacy Policy

We may update this Privacy Policy periodically. Changes will be posted on our website (moraya.app) or announced via update notes. Continued use of Moraya after changes constitutes acceptance.

## Contact Us

For questions or concerns about this Privacy Policy, please open an issue on our GitHub repository: https://github.com/zouwei/moraya/issues.

Thank you for using Moraya!
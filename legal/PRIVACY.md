# zWork Privacy Policy

**Last updated: August 10, 2026**

This Privacy Policy describes how zWork ("we", "us", or "the App") collects, uses, and protects your information when you use the zWork desktop application (the "App"). We are committed to minimizing data collection and maximizing your control.

## 1. What we collect

### 1.1 Information you provide
- **Account information:** When you sign in to zWork Cloud, we store your email address, display name, and subscription tier. This is transmitted over HTTPS and authenticated via a session token.
- **Bring-your-own-key (BYOK) credentials:** When you add your own API keys (OpenAI, Anthropic, DeepSeek, etc.), zWork stores them to make API requests on your behalf. On macOS, these are stored in the system Keychain (encrypted at rest). On other platforms, they are stored in a local file (`~/.zwork/secrets.json`) restricted to your user account (mode 0600). They are never transmitted to zWork's servers — they are used only for direct, local-to-provider API calls.
- **Integration tokens:** When you connect third-party services (Gmail, Google Calendar, Notion, Linear, GitHub, etc.) via Composio, the OAuth tokens are managed by Composio and referenced by zWork to execute your instructions.

### 1.2 Information collected automatically
- **Usage telemetry:** zWork uses PostHog to collect anonymized usage analytics, including: app launches, feature usage events, session heartbeats, and error events. Telemetry is **on by default** but can be disabled at any time in Settings → Privacy & Telemetry Dashboard. A random per-install ID (`telemetry_install_id`) is generated to correlate events across sessions; no cookies are used.
- **Crash data:** If the App crashes, a structured record (panic message, thread name, stack trace, App version) is written to a local log file (`~/.zwork/logs/crashes.jsonl` on the backend, `host-crashes.jsonl` in the App data directory). This is **local-only** and is never transmitted unless you explicitly share it.
- **Local logs:** The App writes diagnostic logs to your local filesystem (e.g. `backend.log`, `agent.jsonl`). These contain information about your conversations and tool executions and never leave your device unless you choose to share them for support.

### 1.3 Information we do NOT collect
- **Conversation content:** Your chat messages, agent tool calls, and task results are processed locally and are never transmitted to zWork's servers. They are sent only to the LLM provider you configure (OpenAI, Anthropic, etc.) and only for the purpose of generating responses.
- **File contents:** When zWork reads or writes files on your behalf (via the agent), those file contents stay on your machine.
- **Browsing history:** The Chrome browser bridge operates locally; zWork does not log or transmit your browsing activity.

## 2. How we use your information
- To provide and maintain the App (authentication, subscription management, auto-updates).
- To understand aggregate usage patterns and improve the product (via anonymized telemetry).
- To diagnose and fix crashes (when you choose to share local crash logs).
- To send you service notifications (e.g. security alerts) if necessary.

## 3. How we share your information
- **LLM providers:** When you use the App, your conversation turns are sent to the LLM provider whose API key you have configured (or to zWork Cloud's managed router if you are a Cloud subscriber). These providers have their own privacy policies governing how they handle your data.
- **Composio:** When you use integrations, your requests are routed through Composio's backend to the target service (Gmail, Calendar, etc.). Composio processes these requests on your behalf.
- **Service providers:** We use PostHog (analytics) and GitHub (release distribution and auto-updates). These providers receive only the telemetry and update-check data described above.
- **Legal compliance:** We may disclose information if required by law, court order, or to protect our legal rights.

## 4. Data retention and deletion
- **Telemetry:** PostHog retains event data for up to 12 months, after which it is automatically deleted.
- **Account data:** Retained for the life of your account. You can request deletion at any time by contacting us.
- **Local data:** You control all local data (conversations, logs, caches) and can delete it at any time via the "Clear Offline Chat Cache" option in Settings or by deleting the `~/.zwork` directory.
- **API keys:** Remove them at any time in Settings → Models. On macOS they are deleted from the Keychain; elsewhere from the secrets file.

## 5. Data security
- BYOK credentials are stored in the macOS Keychain (encrypted at rest, OS-gated) where available; otherwise in a 0600-permission local file.
- All network traffic to zWork Cloud, LLM providers, and Composio uses HTTPS/TLS.
- The local sidecar is token-gated and binds to loopback (127.0.0.1) so it is not reachable from other machines.
- The App is code-signed and notarized (macOS) or Authenticode-signed (Windows) to prevent tampering — verify the signature before trusting any download.

## 6. Your rights
- **Access & portability:** You can export your conversation history and local data at any time.
- **Deletion:** You can delete your account and all associated data by contacting us.
- **Opt-out:** Disable telemetry at any time in Settings. BYOK keys and integrations can be removed at any time.
- **California / EU residents:** You have additional rights under CCPA and GDPR respectively. Contact us to exercise them.

## 7. Children's privacy
The App is not directed to children under 13 (or 16 in the EU). We do not knowingly collect personal information from children. If you believe we have, contact us and we will delete it.

## 8. Changes to this policy
We may update this Privacy Policy from time to time. Material changes will be notified via the App or by email. Continued use after changes constitutes acceptance.

## 9. Contact
For privacy questions or requests, contact: **privacy@tryzwork.app**

---

*This document is provided as a template. Have legal counsel review and adapt it to your specific jurisdiction and business model before relying on it for compliance.*

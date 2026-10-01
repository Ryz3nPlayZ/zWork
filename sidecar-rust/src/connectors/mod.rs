//! Connectors: how the agent reaches the world beyond the local machine.
//!
//! * [`mcp`] — any Model Context Protocol server (stdio, Streamable HTTP,
//!   legacy SSE), configured in `~/.zwork/mcp.json` or imported from Claude,
//!   Cursor, VS Code, Windsurf, opencode, Gemini CLI and Codex.
//! * [`composio`] — hosted OAuth integrations (Gmail, Slack, Notion, …)
//!   brokered through the zWork cloud, so users never register OAuth apps.
//!
//! CLIs need no connector: the agent's `bash` tool runs them directly, with
//! the user's login-shell `PATH` (see `paths::hydrate_path`).

pub mod composio;
pub mod mcp;

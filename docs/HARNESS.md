# Claude Code Harness Architecture

> Reverse-engineered from leaked source. ~1,900 files, ~515K LoC TypeScript/TSX.

---

## High-Level Overview

Claude Code is a **terminal-native AI coding assistant** — a single-binary CLI running on the **Bun** runtime. The UI is **React 19 + Ink** (React reconciler for terminals). Every line rendered to the terminal goes through React's component tree, hooks, and state management.

```
User Input → CLI Parser → REPL Screen → QueryEngine (agent loop) → Anthropic API
                                  ↑                                      ↓
                                  └──── Tool Execution ←── tool_use blocks ←──┘
```

---

## 1. Entry & Startup Pipeline

### Entry points (`src/entrypoints/`)

| File | Role |
|------|------|
| `cli.tsx` | Bootstrap entry — fast-path dispatch before loading the full CLI |
| `init.ts` | Config, telemetry, OAuth, MDM policy, GrowthBook initialization |
| `mcp.ts` | MCP server mode (Claude Code as an MCP server) |
| `sdk/` | Agent SDK — programmatic API for embedding Claude Code |

### Startup sequence (latency-optimized)

**Phase 0 — Pre-import side effects** (`main.tsx:1-20`):
- `profileCheckpoint()` — profiling marker
- `startMdmRawRead()` — fires macOS MDM subprocess reads (plutil/reg query) in parallel with module evaluation
- `startKeychainPrefetch()` — fires both macOS keychain reads (OAuth + legacy API key) concurrently, saving ~65ms

**Phase 1 — Fast-path dispatch** (`cli.tsx`):
- `--version` / `-v` — zero imports, exits immediately
- `--claude-in-chrome-mcp`, `--chrome-native-host`, `--computer-use-mcp` — each has an isolated dynamic `import()` path, zero overhead for normal startup

**Phase 2 — Full initialization** (`init.ts`):
- `enableConfigs()` — validate and load configuration
- `applySafeConfigEnvironmentVariables()` — safe env vars before trust dialog
- `applyExtraCACertsFromConfig()` — TLS cert store before first handshake (Bun caches BoringSSL at boot, must happen first)
- `initializeGrowthBook()` — feature flags
- `initializeTelemetryAfterTrust()` — OpenTelemetry (~400KB) loaded lazily only after trust is established
- MDM policy, remote managed settings, policy limits all loaded in **parallel**

**Phase 3 — CLI parsing** (Commander.js, `main.tsx`):
- 50+ CLI flags: model, permission mode, agents, MCP servers, bridge, etc.
- Feature-gated subcommands via `feature()` from `bun:bundle` for dead-code elimination

**Phase 4 — REPL launch** (`replLauncher.tsx`):
- Dynamic `import()` of `App` and `REPL` to defer React/Ink module loading

---

## 2. Core Engine: QueryEngine

**`src/QueryEngine.ts`** (~46K lines in source, 1,300 in this snapshot) — the agentic loop controller:

- **Streaming response handling** — consumes SSE streams from Anthropic API
- **Tool-call loop** — when the LLM emits `tool_use` blocks:
  1. Extract tool name + input
  2. Look up tool in registry (`findToolByName`)
  3. Check permissions (`checkPermissions` → `useCanUseTool`)
  4. Execute (`tool.call()`)
  5. Feed `tool_result` back into conversation
  6. Continue loop until model emits `stop_reason`
- **Thinking mode** — extended thinking with budget management
- **Retry logic** — automatic retry with backoff for transient failures (429, 5xx)
- **Token counting & cost tracking** — per-turn usage in `cost-tracker.ts`
- **Context management** — monitors context window, triggers compaction
- **Abort handling** — user interruption (Ctrl-C) mid-generation

### API layer (`src/services/api/claude.ts`)

Wraps `@anthropic-ai/sdk` beta messages streaming API:
- Constructs the full message array (system prompt + history + user message)
- Handles streaming SSE events: `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`
- Provider abstraction via `getAPIProvider()` — supports Anthropic, AWS Bedrock, GCP Vertex, and OpenAI-compatible endpoints
- Prompt cache breakpoint management
- Accumulates usage (input/output tokens)

---

## 3. Tool System

### Factory pattern (`src/Tool.ts`)

Every tool is constructed via `buildTool()`:

```typescript
buildTool({
  name: 'ToolName',
  aliases: ['alias'],
  description: '...',
  inputSchema: z.object({ ... }),     // Zod v4 schema
  async call(args, context, canUseTool, parentMessage, onProgress) { ... },
  async checkPermissions(input, context) { ... },
  isConcurrencySafe(input) { ... },    // Can run in parallel?
  isReadOnly(input) { ... },           // Non-destructive?
  prompt(options) { ... },             // System prompt contribution
  renderToolUseMessage(...) { ... },   // Terminal UI for invocation
  renderToolResultMessage(...) { ... },// Terminal UI for result
})
```

### Tool registry (`src/tools.ts`, ~40 tools)

Three loading strategies:

1. **Static imports** — always-available tools (BashTool, FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, etc.)
2. **Feature-gated `require()`** — stripped at build time when the feature flag is off. Examples: `SleepTool` (PROACTIVE/KAIROS), `CronCreateTool` (AGENT_TRIGGERS), `MonitorTool` (MONITOR_TOOL), `PushNotificationTool` (KAIROS)
3. **Lazy `require()` getters** — break circular dependencies: `getTeamCreateTool()`, `getSendMessageTool()`
4. **Ant-only** — `process.env.USER_TYPE === 'ant'` gates for internal tools (REPLTool, SuggestBackgroundPRTool)

### Tool directory structure

Each tool is a self-contained module:

```
src/tools/BashTool/
├── BashTool.tsx          # Core execution (sandbox, timeout, security)
├── UI.tsx                # Terminal rendering
├── prompt.ts             # System prompt contribution
├── bashPermissions.ts    # Permission rules
├── bashSecurity.ts       # Security validation
├── shouldUseSandbox.ts   # Sandbox eligibility check
├── toolName.ts           # Tool name constant
└── utils.ts              # Helpers
```

### BashTool — the most complex tool

- AST-based command parsing (`src/utils/bash/ast.ts`)
- Security validation (dangerous commands, path traversal)
- Sandbox execution support
- Background task spawning for long-running commands
- File encoding detection, line ending detection
- File history tracking for edits
- Read-only constraint validation
- Timeout management (default + max configurable)
- Progress display for commands >2 seconds
- sed edit parsing for inline file modifications
- Permission model with wildcard pattern matching (`Bash(git *)`)

---

## 4. Command System

### Three command types

| Type | Interface | Example |
|------|-----------|---------|
| `PromptCommand` | Sends formatted prompt + tool allowlist to LLM | `/review`, `/commit` |
| `LocalCommand` | In-process, returns plain text | `/cost`, `/version` |
| `LocalJSXCommand` | In-process, returns React JSX | `/doctor`, `/install` |

### Registry (`src/commands.ts`)

~85 command subdirectories + 15 standalone command files. Feature-gated using the same `feature()` + `require()` pattern as tools. Commands are conditionally loaded for `BRIDGE_MODE`, `VOICE_MODE`, `KAIROS`, `PROACTIVE`, `COORDINATOR_MODE`, `WORKFLOW_SCRIPTS`, and more.

Commands cover: git operations, code review, session management, configuration, MCP/plugin management, authentication, diagnostics, IDE integration, and internal/debug functionality.

---

## 5. State Management

### Hybrid pattern: React context + observable store

```
App (provider tree)
 └─ FpsMetricsProvider
     └─ StatsProvider
         └─ AppStateProvider (initialState + onChangeAppState observer)
             └─ REPL
```

### Two tiers of state

**`bootstrap/state.ts`** — low-level bootstrap state (~200 fields):
- Session identity (`sessionId`, `parentSessionId`)
- Cost counters (`totalCostUSD`, `totalAPIDuration`, `totalToolDuration`)
- Telemetry providers (OpenTelemetry Meter, Logger, Tracer)
- OAuth tokens, API keys
- Agent color management
- Feature-specific state (kairosActive, strictToolResultPairing, etc.)

**`state/AppStateStore.ts`** — application-level state (~50 fields):
- Settings (`SettingsJson`)
- Model configuration
- Permission mode and context
- MCP connections
- Agent definitions
- Bridge state
- Speculation state
- Theme, vim mode, keybindings
- UI state (expanded views, footer selection)

### Key design choices

- `AppState` is passed into **every tool's execution context** (`ToolUseContext`), giving tools access to conversation history, settings, permissions, and runtime state
- `onChangeAppState.ts` fires side effects when specific state keys change
- State is `DeepImmutable` — updates create new references
- Tools read state via `context.getAppState()`

---

## 6. UI Layer (React + Ink)

### `src/ink.ts` — custom Ink wrapper

- Wraps all renders with `ThemeProvider`
- Re-exports core Ink primitives: `Box`, `Text`, `useInput`, `useStdin`, `useTerminalFocus`
- Adds custom components: `Button`, `Link`, `Ansi`, `Spacer`, `NoSelect`
- Uses **React Compiler** (`react/compiler-runtime`) for automatic memoization

### Screens

| Screen | Purpose |
|--------|---------|
| `REPL.tsx` | Main interactive screen — handles all input, message display, tool rendering, permissions |
| `Doctor.tsx` | Environment diagnostics |
| `ResumeConversation.tsx` | Session restore |

### Component tree (~140 components)

Organized by feature domain:
- `PromptInput/` — input line, footer pills (tasks, bridge, teams), queued commands, vim/input modes
- `messages/` — user messages, assistant messages, tool use blocks, tool results, progress indicators
- `permissions/` — permission request dialogs, tool use confirmations
- `Settings/` — configuration UI
- `design-system/` — themed primitives (ThemedBox, ThemedText, ThemeProvider)
- `mcp/`, `diff/`, `shell/`, `skills/`, `tasks/`, `teams/` — feature-specific components

### Hooks (~80 hooks)

- **Permission system:** `useCanUseTool`, handlers in `toolPermission/` (interactive, coordinator, swarm worker)
- **IDE integration:** `useIDEIntegration`, `useIdeConnectionStatus`, `useDiffInIDE`
- **Input:** `useTextInput`, `useVimInput`, `usePasteHandler`, `useInputBuffer`
- **Bridge:** `useReplBridge`, `useRemoteSession`, `useDirectConnect`
- **Session:** `useSessionBackgrounding`, `useAssistantHistory`
- **Voice:** `useVoiceIntegration`, `useVoiceEnabled`
- **Notifications:** rate limits, deprecation warnings, plugin updates

---

## 7. Bridge Layer (IDE Integration)

**31 files in `src/bridge/`** — the most architecturally sophisticated subsystem. Connects the CLI to VS Code, JetBrains, and `claude.ai` web UI.

### Two transport generations

| Version | Read Path | Write Path | Negotiation |
|---------|-----------|------------|-------------|
| v1 (env-based) | WebSocket to Session-Ingress | HTTP POST to Session-Ingress | Environments API poll/ack/dispatch |
| v2 (env-less) | SSE stream via `SSETransport` | `CCRClient` → `/worker/*` endpoints | Direct `POST /v1/code/sessions/{id}/bridge` → JWT |

### Authentication chain

1. OAuth tokens (claude.ai subscription required — `isClaudeAISubscriber()`)
2. JWT session tokens (`sk-ant-si-` prefix) with proactive refresh scheduling
3. Trusted Device token (`X-Trusted-Device-Token` header) for elevated security
4. WorkSecret (base64-encoded payload containing session ingress token, API URL, git sources, auth tokens)

### Message flow

```
IDE / claude.ai  ←→  Session-Ingress  ←→  CLI (replBridge)
```

- **Inbound:** user messages, control requests (initialize, set_model, interrupt, set_permission_mode), control responses (permission decisions from IDE)
- **Outbound:** assistant messages, user message echoes, result events, tool starts, activities
- **Dedup:** `BoundedUUIDSet` tracks recent posted/inbound UUIDs to reject echoes and re-deliveries

### Lifecycle

1. Entitlement check (`isBridgeEnabled()` → GrowthBook gate + OAuth subscriber check)
2. Session creation (`createBridgeSession()` → POST to API)
3. Transport init (v1 `HybridTransport` or v2 `SSETransport` + `CCRClient`)
4. Message pump (read inbound via transport, write outbound via batched POST)
5. Token refresh (proactive JWT refresh scheduler)
6. Teardown (flush pending → close transport → archive session)

### Spawn modes for `claude remote-control`

- `single-session` — one session in cwd, bridge tears down when it ends
- `worktree` — persistent server, each session gets an isolated git worktree
- `same-dir` — persistent server, sessions share cwd

All gated behind `feature('BRIDGE_MODE')` which defaults to `false`.

---

## 8. MCP (Model Context Protocol)

**Location:** `src/services/mcp/`

Claude Code acts as both **MCP client** and **MCP server**.

### Client

- `client.ts` — tool discovery, resource enumeration, connection management
- `MCPConnectionManager.tsx` — React component for connection lifecycle
- `config.ts` — MCP server configuration parsing (`.mcp.json`, settings files)
- `channelPermissions.ts` — MCP server permission model
- `InProcessTransport.ts` — in-process MCP transport for bundled servers
- `SdkControlTransport.ts` — SDK-based control transport
- `vscodeSdkMcp.ts` — VS Code SDK MCP integration
- OAuth support via `oauthPort.ts`, `xaaIdpLogin.ts`

### Server mode

`src/entrypoints/mcp.ts` — when launched as `claude mcp`, exposes Claude Code's own tools and resources via MCP protocol.

### MCP-specific tools

MCPTool, ListMcpResourcesTool, ReadMcpResourceTool, McpAuthTool, ToolSearchTool

---

## 9. Memory System

**Location:** `src/memdir/`

File-based persistent memory stored under `~/.claude/projects/<hash>/memory/`:

- `memdir.ts` — reads/writes memory files
- `memoryScan.ts` — scans and indexes memory entries
- `findRelevantMemories.ts` — semantic relevance matching
- `memoryTypes.ts` — typed entries: `user`, `feedback`, `project`, `reference`
- `memoryAge.ts` — staleness tracking
- `teamMemPaths.ts` / `teamMemPrompts.ts` — team-shared memory

Also: `CLAUDE.md` files at project root and `~/.claude/CLAUDE.md` for user-level instructions.

---

## 10. Task & Agent System

**Location:** `src/tasks/`

### Task types

| Type | Purpose |
|------|---------|
| `LocalShellTask` | Background shell execution with lifecycle management |
| `LocalAgentTask` | Sub-agent running locally (forked agent with isolated context) |
| `RemoteAgentTask` | Agent on a remote machine |
| `InProcessTeammateTask` | Parallel teammate agent sharing the process |
| `DreamTask` | Background ideation/"dreaming" |
| `LocalMainSessionTask` | Main session wrapped as a task |

### Agent tool (`AgentTool`)

Spawns sub-agents with configurable:
- Agent definitions (built-in, custom, or MCP-discovered)
- Model overrides
- Tool allowlists
- System prompts
- Color-coded terminal output

### Coordinator (`COORDINATOR_MODE`)

Multi-agent orchestration: TeamCreateTool, TeamDeleteTool, SendMessageTool for inter-agent communication.

---

## 11. Context & Prompt Assembly

### System context (`src/context.ts`)

Injected at the start of every conversation:
- `getSystemContext()` — OS, shell, date, platform, git status, git log (memoized)
- `getUserContext()` — project structure, CLAUDE.md content, memory files (memoized)
- Both cleared on `/clear` or context changes

### Prompt sections (`src/constants/systemPromptSections.ts`)

Modular, parallel-resolved prompt assembly:
- `systemPromptSection()` — memoized: computed once, cached until `/clear` or `/compact`
- `DANGEROUS_uncachedSystemPromptSection()` — volatile: recomputed every turn, breaks the Anthropic prompt cache when the value changes

### Compaction (`src/services/compact/`)

Context window management:
- `compact.ts` — main compaction: summarize old messages, drop large tool results, preserve recent context
- `autoCompact.ts` — automatic triggers based on token thresholds
- `reactiveCompact.ts` — alternative compaction strategy (behind `REACTIVE_COMPACT` flag)

---

## 12. Permission System

**Location:** `src/hooks/toolPermission/`

### Flow

Every tool invocation passes through:
1. `tool.checkPermissions(input, context)` — tool-specific check
2. `hasPermissionsToUseTool()` — checks against configured rules
3. If not auto-approved → user prompt (terminal or IDE bridge)
4. Handlers: `interactiveHandler.ts`, `coordinatorHandler.ts`, `swarmWorkerHandler.ts`

### Permission modes

| Mode | Behavior |
|------|----------|
| `default` | Prompt user for each potentially destructive operation |
| `plan` | Show full execution plan, ask once for batch approval |
| `bypassPermissions` | Auto-approve everything (dangerous) |
| `auto` | ML-based classifier decides (experimental) |

### Rule format

Wildcard patterns:
```
Bash(git *)           # Allow all git commands
FileEdit(/src/*)      # Allow edits to anything under src/
FileRead(*)           # Allow reading any file
```

---

## 13. Build System & Feature Flags

### Bun runtime

- Native JSX/TSX without transpilation
- `bun:bundle` `feature()` for compile-time dead code elimination
- ES modules with `.js` extensions (Bun convention)
- `package.json` `"bin"` → `src/entrypoints/cli.tsx`

### Feature flags (compile-time elimination)

Code inside inactive `feature()` blocks is completely stripped at build time:

```typescript
import { feature } from 'bun:bundle'
if (feature('VOICE_MODE')) {
  const voiceCommand = require('./commands/voice/index.js').default
}
```

| Flag | Feature |
|------|---------|
| `BRIDGE_MODE` | IDE bridge integration |
| `KAIROS` | Assistant/autonomous mode |
| `PROACTIVE` | Proactive agent |
| `VOICE_MODE` | Voice I/O |
| `DAEMON` | Background daemon |
| `COORDINATOR_MODE` | Multi-agent coordinator |
| `AGENT_TRIGGERS` | Cron scheduling |
| `AGENT_TRIGGERS_REMOTE` | Remote triggers |
| `MONITOR_TOOL` | Stream monitoring |
| `WORKFLOW_SCRIPTS` | Workflow automation |
| `WEB_BROWSER_TOOL` | Browser interaction |
| `EXPERIMENTAL_SKILL_SEARCH` | Skill semantic search |
| `ULTRAPLAN` | Ultra-planning mode |

### Key dependencies

- `@anthropic-ai/sdk` — Anthropic API client
- `@modelcontextprotocol/sdk` — MCP protocol
- `react` v19 + `react-reconciler` — UI framework
- `@growthbook/growthbook` — feature flags
- `@opentelemetry/*` — telemetry (lazy-loaded)
- `zod` v4 — schema validation
- `commander` — CLI argument parsing
- `chalk` — terminal colors

---

## 14. Key Architectural Patterns

### Dead code elimination via feature flags

Entire subsystems (bridge, voice, coordinator) are stripped at build time when their feature flag is off. This keeps the binary lean for production while allowing all code to coexist in one repo.

### Lazy dynamic imports

Heavy modules are loaded only when needed:
- OpenTelemetry (~400KB) — deferred until after trust dialog
- gRPC (~700KB) — deferred within telemetry init
- React components — `App` and `REPL` loaded via dynamic `import()` in `replLauncher.tsx`
- Bridge modules — only loaded when `remote-control` subcommand is invoked

### Circular dependency resolution

Lazy `require()` getter functions break circular chains at module evaluation time:
```typescript
const getTeammateUtils = () => require('./utils/teammate.js')
```

### Parallel initialization

MDM reads, keychain prefetch, API preconnect, GrowthBook init, and remote settings all run concurrently during startup to minimize time-to-interactive.

### Tool self-description

Each tool is fully self-contained — it defines its own input schema, permission model, execution logic, prompt text, and terminal UI. The system assembles these into the full agent at runtime.

### React Compiler

All TSX components are compiled with `react/compiler-runtime` (React 19's automatic memoization compiler), visible via the `"use react-compiler"` directive and `_c()` cache calls in compiled output.

---

## 15. Service Layer

**Location:** `src/services/`

| Service | Path | Role |
|---------|------|------|
| API | `api/` | Anthropic SDK client, file uploads, error handling, retry |
| Analytics | `analytics/` | GrowthBook feature flags, OpenTelemetry, event tracking |
| MCP | `mcp/` | MCP client connections, tool discovery, OAuth |
| OAuth | `oauth/` | OAuth 2.0 authentication flow |
| LSP | `lsp/` | Language Server Protocol manager |
| Compact | `compact/` | Context compression (auto, reactive) |
| Plugins | `plugins/` | Plugin loader and marketplace |
| Policy Limits | `policyLimits/` | Organization rate limits and quotas |
| Remote Settings | `remoteManagedSettings/` | Enterprise managed settings sync |
| Token Estimation | `tokenEstimation.ts` | Token count estimation |
| Team Memory | `teamMemorySync/` | Team knowledge synchronization |
| Tips | `tips/` | Contextual usage tips |
| Agent Summary | `AgentSummary/` | Agent work summaries |
| Prompt Suggestion | `PromptSuggestion/` | Suggested follow-up prompts |
| Session Memory | `SessionMemory/` | Session-level memory |
| Magic Docs | `MagicDocs/` | Documentation generation |
| Auto Dream | `autoDream/` | Background ideation |
| Voice | `voice.ts` | Voice I/O processing |

---

## 16. Summary Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                 CLI Entry (entrypoints/cli.tsx)              │
│  Fast paths: --version, --claude-in-chrome-mcp, --daemon    │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│              main.tsx (Commander.js CLI Parser)              │
│  Init: config, OAuth, GrowthBook, telemetry, policy limits   │
│  Feature flags gate conditional code paths at build time     │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│       replLauncher.tsx → App.tsx → REPL.tsx (React+Ink)     │
│  State: AppStateProvider → StatsProvider → FpsMetricsProvider│
│  ~140 components, ~80 hooks, ~10 context providers           │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┼────────────────┐
          ▼              ▼                ▼
    ┌──────────┐  ┌───────────┐   ┌──────────────┐
    │ Commands │  │QueryEngine│   │   Bridge      │
    │ ~85 /cmds│  │Agent Loop │   │  31 files     │
    │ 3 types  │  │Tool Calls │   │  IDE ↔ CLI    │
    └──────────┘  └─────┬─────┘   └──────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    ┌──────────┐  ┌───────────┐  ┌──────────┐
    │  Tools   │  │  API      │  │ Context/ │
    │  40 tools│  │ Anthropic │  │ Prompt   │
    │ buildTool│  │ Streaming │  │ Assembly │
    └──────────┘  └───────────┘  └──────────┘
          │
    ┌─────┴─────┬──────────┬──────────┐
    ▼           ▼          ▼          ▼
  BashTool  FileEdit  AgentTool  MCPTool ...
  (sandbox,  (string   (sub-agent (MCP
   security)  replace)  spawn)    clients)

┌─────────────────────────────────────────────────────────────┐
│                    Service Layer                             │
│  api/ analytics/ mcp/ oauth/ lsp/ compact/ plugins/         │
│  policyLimits/ remoteSettings/ tips/ voice/ tokenEstimation │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Infrastructure                            │
│  Bun runtime | React 19 + Ink | Zod v4 | GrowthBook | OTel │
│  Feature flags (bun:bundle) | Lazy imports | ESM (.js ext) │
└─────────────────────────────────────────────────────────────┘
```

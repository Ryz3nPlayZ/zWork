# Technology Stack

**Analysis Date:** 2026-05-25

## Languages

**Primary:**
- TypeScript - Frontend UI (`app/src/**/*.ts`, `app/src/**/*.tsx`)
- Python 3.12+ - Backend agent/server (`sidecar/**/*.py`)
- Rust - Tauri desktop shell (`app/src-tauri/src/main.rs`)

**Secondary:**
- CSS/Tailwind - Styling (`app/tailwind.config.js`, `app/src/index.css`)
- HTML - SPA entry (`app/index.html`)

## Runtime

**Environment:**
- Node.js (via Vite dev server) for frontend development
- Python 3.12+ for backend FastAPI server
- Rust (Tauri v2) for desktop shell

**Package Manager:**
- npm (frontend) - Lockfile: `app/package-lock.json` (assumed present)
- pip/setuptools (Python) - `pyproject.toml` with `setuptools` build backend
- Cargo (Rust) - `app/src-tauri/Cargo.lock`

## Frameworks

**Core:**
- React 18.3.1 - Frontend UI framework
- FastAPI 0.115+ - Python backend API framework
- Tauri 2.x - Desktop application shell (Rust)
- Vite 5.4.10 - Frontend build tool and dev server

**Testing:**
- Python `unittest` / `pytest` (inferred from `tests/` directory, no explicit runner config found)

**Build/Dev:**
- TypeScript 5.6.3 - Frontend type checking
- Tailwind CSS 3.4.14 - Utility-first CSS framework
- PostCSS + Autoprefixer - CSS processing
- tauri-build - Rust build helper for Tauri

## Key Dependencies

**Critical (Frontend):**
- `react` / `react-dom` ^18.3.1 - UI framework
- `zustand` ^4.5.5 - Global state management
- `framer-motion` ^12.38.0 - Animations
- `react-markdown` ^10.1.0 - Markdown rendering
- `react-syntax-highlighter` ^16.1.1 - Code syntax highlighting
- `lucide-react` ^0.453.0 - Icon library
- `three` ^0.184.0 / `@react-three/fiber` ^8.18.0 - 3D graphics (logo particles)
- `katex` / `rehype-katex` / `remark-math` - Math rendering
- `@tauri-apps/api` / `@tauri-apps/plugin-*` - Tauri desktop integration
- `@posthog/react` ^1.9.0 / `posthog-js` ^1.372.5 - Telemetry

**Critical (Backend):**
- `fastapi` >=0.115 - API framework
- `uvicorn[standard]` >=0.32 - ASGI server
- `httpx` >=0.27 - HTTP client (async)
- `pydantic` >=2.9 - Data validation
- `mcp` >=1.0 - Model Context Protocol client
- `keyring` >=25 - System secret store
- `pypdf` >=5.0 / `pdfplumber` >=0.11 - PDF text extraction
- `python-docx` >=1.1 - DOCX generation
- `openpyxl` >=3.1 - XLSX handling
- `python-pptx` >=1.0 - PPTX handling

**Infrastructure:**
- `tokio` (Rust) - Async runtime for Tauri sidecar management
- `serde` / `serde_json` (Rust) - Serialization

## Configuration

**Environment:**
- `.env` files loaded via `sidecar/agent/env_loader.py` (optional, not committed)
- Key env vars:
  - `ZWORK_HOST` / `ZWORK_PORT` - Backend bind address (default 127.0.0.1:8787)
  - `ZWORK_HOME` - Data directory override
  - `ZWORK_PYTHON` - Custom Python executable path
  - `ZWORK_MEMORY_LOG_INTERVAL_SECONDS` - Memory logging interval
  - `ZW_TELEMETRY_ENDPOINT` - Optional telemetry forward endpoint
  - `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`
  - `OPENAI_API_KEY` / `OPENAI_BASE_URL`
  - `GROQ_API_KEY` / `CEREBRAS_API_KEY` / `DEEPSEEK_API_KEY` / `ZAI_API_KEY`
  - `ZWORK_GATEWAY_TOKEN` - Cloud router token
  - `ZWORK_CLOUD_API_BASE` - Cloud API base URL (default https://api.tryzwork.app/api/composio)

**Build:**
- `app/vite.config.ts` - Vite configuration (port 1420, proxy /api to :8787)
- `app/tsconfig.json` - TypeScript config (ES2021, React JSX, strict)
- `app/tailwind.config.js` - Tailwind with CSS variable-based theming
- `app/postcss.config.js` - PostCSS pipeline
- `app/src-tauri/tauri.conf.json` - Tauri desktop config
- `app/src-tauri/Cargo.toml` - Rust dependencies
- `pyproject.toml` - Python project metadata and dependencies

## Platform Requirements

**Development:**
- Python 3.12+ with virtualenv (`.venv`)
- Node.js + npm
- Rust toolchain (for Tauri builds)
- OS: macOS, Windows, or Linux

**Production:**
- Desktop app: Tauri-bundled binary with embedded Python backend sidecar
- Web mode: Static SPA served via Caddy/reverse proxy to cloud API
- Backend binds to localhost only (127.0.0.1:8787) for security

---

*Stack analysis: 2026-05-25*

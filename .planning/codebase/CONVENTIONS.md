# Coding Conventions

**Analysis Date:** 2026-05-25

## Naming Patterns

**Files:**
- React components: PascalCase matching the component name, e.g. `ChatView.tsx`, `IconButton.tsx`, `ErrorBoundary.tsx`
- Utility/library files: camelCase or kebab-case, e.g. `store.ts`, `api.ts`, `thinkingWords.ts`, `cn.ts`
- Python modules: snake_case, e.g. `tools.py`, `providers.py`, `settings.py`, `secretstore.py`
- Test files: `test_{module}.py` for Python, no frontend tests detected

**Functions:**
- TypeScript/React: camelCase for functions and hooks, e.g. `useApp`, `useResolvedTheme`, `handleRetry`, `commitRename`
- Python: snake_case for functions and methods, e.g. `build_system_prompt`, `tool_risk`, `should_compact`, `summarize`
- Private helpers prefixed with underscore: `_extract_document`, `_make_pdf`, `_normalized_command`, `_targets_zwork_backend`

**Variables:**
- TypeScript: camelCase for locals, UPPER_SNAKE for module-level constants, e.g. `MAX_TURNS`, `READ_ONLY_TOOLS`, `ZWORK_ROUTER_BASE_URL`
- Python: snake_case for locals, UPPER_SNAKE for module-level constants, e.g. `DESTRUCTIVE_COMMAND_PATTERNS`, `SYSTEM_PROMPT_TEMPLATE`
- Boolean flags prefixed with `is`/`has`/`needs`, e.g. `isRecording`, `hasCompletedOnboardingLocally`, `needsManagedRouterMigration`

**Types:**
- TypeScript interfaces: PascalCase, e.g. `ApiMessage`, `ApiChat`, `SettingsPublic`, `StreamEvent`, `ArtifactKind`
- TypeScript type aliases: PascalCase, e.g. `View`, `ChatBucket`, `Role`, `TelemetryProps`
- Python dataclasses: PascalCase, e.g. `Credentials`, `Settings`, `MCPServerSpec`
- Python type hints used throughout with `from __future__ import annotations`

## Code Style

**Formatting:**
- Frontend: No Prettier config detected; relies on manual formatting consistent with the existing codebase
- Backend: `ruff format` enforced in CI (`ruff format --check sidecar/`)
- Python imports sorted logically (stdlib, third-party, local)
- TypeScript imports grouped by external then internal

**Linting:**
- Backend: `ruff check sidecar/` in CI
- Frontend: TypeScript strict mode enabled (`tsconfig.json`)
  - `strict: true`
  - `noUnusedLocals: true`
  - `noUnusedParameters: true`
  - `noFallthroughCasesInSwitch: true`
- No ESLint config detected for frontend

## Import Organization

**TypeScript Order:**
1. React and external libraries (e.g. `react`, `lucide-react`, `zustand`)
2. Absolute internal imports (e.g. `../lib/store`, `../lib/api`)
3. Relative component imports (e.g. `./IconButton`, `./Tooltip`)

**Python Order:**
1. `from __future__ import annotations` (always first when present)
2. Standard library imports
3. Third-party imports (e.g. `fastapi`, `httpx`, `pydantic`)
4. Local imports, often with fallback patterns for PyInstaller/script entrypoints:
   ```python
   try:
       from . import detect
   except ImportError:
       from sidecar.agent import detect
   ```

**Path Aliases:**
- No path aliases configured in `tsconfig.json`; all imports use relative paths
- Python uses relative imports within the `sidecar` package with fallback absolute imports

## Error Handling

**Patterns:**
- Frontend: `try/catch` with `console.warn` for non-fatal errors; silent swallowing for telemetry transport failures
  ```typescript
  await api.telemetryEvent({...}).catch(() => { /* ignore */ });
  ```
- Backend: FastAPI raises `HTTPException` for client errors; `ValueError` for domain validation
- Python tests use `assertRaises` and `pytest.raises` for error path verification
- Backend command execution uses regex-based risk classification (`safe`/`sensitive`/`destructive`) before running

## Logging

**Framework:** Python `logging` module for backend; `console.warn`/`console.error` for frontend

**Patterns:**
- Backend: Standard Python logging with `logging.getLogger(__name__)` pattern implied by imports
- Frontend: `console.warn` for recoverable failures (e.g. `refreshChats failed`), `console.error` for render errors
- Telemetry errors are swallowed silently to avoid cascading failures

## Comments

**When to Comment:**
- Docstrings at module and function level in Python explaining the contract
- JSDoc-style block comments for complex TypeScript functions (e.g. `api.ts`)
- Inline comments for non-obvious business logic, e.g.:
  ```typescript
  // Browser dev mode: stub already set, skip cloud fetch entirely
  ```

**JSDoc/TSDoc:**
- Used sparingly in TypeScript; more common in Python
- TypeScript types are self-documenting through interfaces

## Function Design

**Size:**
- Python functions tend to be focused; large files like `tools.py` (2878 lines) contain many small functions
- React components vary: `App.tsx` is large (637 lines) but composed of smaller inline components
- Store file `store.ts` is very large (1785 lines) with many action definitions

**Parameters:**
- Prefer object parameters for complex functions (React props pattern)
- Python uses dataclasses for configuration objects (e.g. `Credentials`, `Settings`)

**Return Values:**
- TypeScript: Explicit return types on exported functions and API methods
- Python: Type hints on function signatures; dataclasses for structured returns

## Module Design

**Exports:**
- TypeScript: Named exports preferred over default exports
  - `export function ChatView() {...}`
  - `export const useApp = create<AppState>(...)`
- Python: Module-level functions and classes; no `__all__` definitions detected

**Barrel Files:**
- No barrel files detected; imports reach directly into modules

## React-Specific Conventions

**Component Structure:**
- Functional components with hooks
- `forwardRef` used for reusable components like `IconButton`
- Lazy loading for route-level components in `App.tsx`:
  ```typescript
  const ChatView = lazy(loadChatView);
  ```

**State Management:**
- Zustand for global state (`useApp` store)
- `useState` and `useEffect` for local component state
- `useMemo` for computed values

**Styling:**
- Tailwind CSS with custom design tokens via CSS variables
- `cn()` utility from `clsx` + `tailwind-merge` for conditional class merging
- Custom color palette: `ink`, `paper`, `line`, `accent`, `bubble`

## Python-Specific Conventions

**Async Patterns:**
- Heavy use of `asyncio` and `async`/`await` for I/O-bound operations
- `AsyncIterator` used for streaming tool execution
- `httpx.AsyncClient` for HTTP requests

**Dataclasses:**
- `@dataclass` used for configuration and credential objects
- `asdict()` for serialization

**Type Safety:**
- `from __future__ import annotations` in all major modules
- Explicit type hints on function signatures
- `Optional` and union types used where appropriate

---

*Convention analysis: 2026-05-25*

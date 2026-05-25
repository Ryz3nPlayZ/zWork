# Testing Patterns

**Analysis Date:** 2026-05-25

## Test Framework

**Runner:**
- pytest (Python)
- Config: No `pytest.ini` or `pyproject.toml` pytest section detected; uses default pytest discovery

**Assertion Library:**
- Python: Built-in `unittest` assertions and `pytest` native assertions

**Run Commands:**
```bash
pytest                          # Run all tests
pytest --cov=sidecar --cov-report=xml  # Run with coverage
pytest tests/test_security.py   # Run specific test file
python -m unittest tests.test_extract_document  # Run via unittest
```

## Test File Organization

**Location:**
- All tests in `/home/zemul/Programming/zWork/tests/` directory (separate from source)
- No frontend tests detected

**Naming:**
- Python: `test_{module}.py` (e.g. `test_security.py`, `test_mcp.py`, `test_extract_document.py`)

**Structure:**
```
tests/
├── __init__.py
├── test_anthropic_caching.py
├── test_detect_mlx.py
├── test_extract_document.py
├── test_harness_tier_one.py
├── test_mcp.py
├── test_ollama_proxy_url.py
├── test_prev1_ollama_model.py
├── test_provider_presets.py
├── test_provider_retry.py
├── test_secret_store.py
├── test_security.py
├── test_security_enhancements.py
```

## Test Structure

**Suite Organization:**
```python
# unittest style (most common)
class TestServerSecurity(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)

    def test_cors_allows_desktop_and_dev_origins(self) -> None:
        response = self.client.options("/api/health", ...)
        self.assertEqual(response.status_code, 200)

# pytest style (also used)
def test_build_system_prompt_omits_project_block_when_empty() -> None:
    prompt = settings_mod.build_system_prompt()
    assert "Project context" not in prompt
```

**Patterns:**
- Setup: `setUp()` for unittest classes; `tmp_path` and `monkeypatch` fixtures for pytest
- Teardown: `tearDown()` for cleanup; `tempfile.TemporaryDirectory` for file system isolation
- Assertion: Mix of `self.assertEqual`/`self.assertIn` (unittest) and bare `assert` (pytest)

## Mocking

**Framework:** pytest `monkeypatch` fixture; manual class-based mocks

**Patterns:**
```python
# Manual mock class for HTTP client
class _Resp:
    status_code = 200
    def raise_for_status(self) -> None:
        pass
    def json(self) -> dict:
        return {"content": [{"type": "text", "text": "SUMMARIZED"}]}

class _Client:
    async def post(self, url, json=None, headers=None):
        captured["url"] = url
        return _Resp()

monkeypatch.setattr(compaction.httpx, "AsyncClient", _Client)
```

**What to Mock:**
- External HTTP clients (`httpx.AsyncClient`)
- File system paths (`monkeypatch` `chats_dir`)
- Environment variables (`os.environ` patches)

**What NOT to Mock:**
- FastAPI `TestClient` is used for real HTTP integration tests against the app
- Document extraction tests create real PDF/DOCX/XLSX/PPTX files and exercise actual libraries

## Fixtures and Factories

**Test Data:**
```python
# Factory functions for test file creation
def _make_pdf(path: Path, pages: list[str]) -> None:
    writer = pypdf.PdfWriter()
    # ... builds real PDF with content streams

def _make_docx(path: Path, paragraphs: list[str]) -> None:
    doc = docx.Document()
    for para in paragraphs:
        doc.add_paragraph(para)
    doc.save(str(path))
```

**Location:**
- Factory functions defined inline in test files
- `tmp_path` and `tempfile.TemporaryDirectory` used for isolated file system operations

## Coverage

**Requirements:** None explicitly enforced; CI generates coverage reports

**View Coverage:**
```bash
pytest --cov=sidecar --cov-report=xml
pytest --cov=sidecar --cov-report=term-missing
```

**CI Integration:**
- Coverage uploaded to Codecov via `codecov/codecov-action@v4`
- Backend test job runs `pytest --cov=sidecar --cov-report=xml`

## Test Types

**Unit Tests:**
- Pure function testing (e.g. `test_build_system_prompt_*`, `test_estimate_chars`)
- Risk classification logic (`test_destructive_commands_flagged`)
- Retry delay calculations (`test_openai_retry_delay`)
- Name encoding/decoding (`test_round_trip_simple`)

**Integration Tests:**
- FastAPI endpoint testing with `TestClient` (`test_security.py`, `test_security_enhancements.py`)
- Document extraction with real file formats (`test_extract_document.py`)
- Chat store persistence with real JSON files (`test_chatstore_persists_project_id_and_compaction`)

**E2E Tests:**
- Not detected

## Parametrized Tests

**Pattern:**
```python
@pytest.mark.parametrize("tool_name", list(tools.READ_ONLY_TOOLS))
def test_read_only_tools_classify_safe(tool_name: str) -> None:
    assert tools.tool_risk(tool_name, {})[0] == "safe"

@pytest.mark.parametrize("command", [
    "rm -rf /tmp/something",
    "sudo rm -rf ~/Documents",
    "git push --force origin main",
])
def test_destructive_commands_flagged(command: str) -> None:
    risk, reason = tools.tool_risk("run_command", {"command": command})
    assert risk == "destructive"
```

## Async Testing

**Pattern:**
```python
# asyncio.run for async functions in sync tests
out = asyncio.run(compaction.summarize(
    [...],
    creds=creds,
    model_id="claude-sonnet-4-5",
    shape="anthropic",
))
```

## Security Testing

**Pattern:**
- CORS origin validation
- Path traversal prevention in SPA catch-all
- SSRF protection on Ollama URL endpoints
- Input validation on route parameters (chat_id, project_id)
- Secret store migration verification

## CI/CD Test Integration

**GitHub Actions (`/.github/workflows/ci.yml`):**
```yaml
backend-test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/setup-python@v5
      with:
        python-version: '3.12'
    - run: pip install pytest pytest-asyncio pytest-cov
    - run: pip install -e .
    - run: pytest --cov=sidecar --cov-report=xml
```

**Frontend CI:**
- TypeScript type checking: `npx tsc --noEmit`
- Build verification: `npm run build`
- No test execution for frontend detected

## Testing Gaps

**Frontend:**
- No test files detected in `app/src/`
- No test runner configured in `package.json`
- No Jest, Vitest, or Playwright configuration

**Backend:**
- No async/await pytest patterns with `pytest-asyncio` decorators detected in existing tests (though installed in CI)
- Limited coverage of streaming logic (`streaming.py`)
- No tests for the Tauri bridge or desktop-specific functionality

---

*Testing analysis: 2026-05-25*

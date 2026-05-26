# Quality and Security Review

This is the current high-signal review pass over the repo as of April 29, 2026.

## What was addressed in `main`

- local sidecar CORS is now restricted to desktop/dev origins
- local SPA static serving now rejects path traversal escapes
- security regression tests were added in `tests/test_security.py`
- cloud deployment docs now match the live desktop auth flow
- stale source-embedded upstream model keys were removed from the checked-in cloud sources
- checked-in cloud proxy config now documents and defaults to blocked `db.tryzwork.app`

## Open GitHub issues reviewed

| Issue | Status | Notes |
|------|--------|-------|
| #2 hook-order bug in auth gate | fixed in code | `App.tsx` no longer short-circuits before later hooks |
| #3 hardcoded Ollama key | fixed in checked-in cloud sources | now env-driven with safe failure on missing key |
| #4 protect pgAdmin | fixed in checked-in cloud config and confirmed live `403` | docs updated to match |
| #5 missing `tier` on `User` | fixed in code | frontend build passes |
| #6 auth docs mismatch | fixed in docs | docs now describe actual desktop auth flow |

## Open PRs reviewed

| PR | Assessment |
|----|------------|
| #1 path traversal fix | valid issue; equivalent fix now exists directly on `main` |
| #7 restrict CORS origins | valid issue; equivalent fix now exists directly on `main` |

If those PRs remain open after this pass, they should be closed or superseded rather than merged blindly on top of the same work.

## Remaining quality risks

## 1. Cloud tests are still thin

The local sidecar has regression coverage. The cloud API still needs stronger automated coverage for:

- desktop auth exchange
- root-vs-continuation rate limiting
- coupon redemption
- analytics summary

## 2. Updater trust depends on release verification

The code path is improved, but release quality still depends on:

- signed updater artifacts
- correct `latest.json`
- one real install-from-older-build test

## 3. Repo still contains duplicate cloud trees

`cloud-src/` is the current deployment source of truth. `cloud/` should either be retired or kept synchronized to avoid future drift and false security findings.

## 4. Test coverage gaps addressed (May 2026)

The following test files were added to expand coverage:

| File | What it covers |
|------|----------------|
| `tests/test_utils.py` | `now_ms`, `uid`, `new_id` |
| `tests/test_runtime.py` | `RunContext`, timeouts, tool budget |
| `tests/test_home.py` | Path helpers, `is_safe_id` |
| `tests/test_runlog.py` | JSONL append, sanitize, path |
| `tests/test_detect.py` | Integration detection, credential env vars |
| `tests/test_chatstore.py` | Chat CRUD, message append/truncate |
| `tests/test_taskstore.py` | Task CRUD, complete, reopen |
| `tests/test_projects.py` | Project CRUD |
| `tests/test_compaction.py` | Token estimation, compaction decision |
| `tests/test_academic.py` | Research helpers: format, word count, citations |
| `tests/test_skills.py` | Skill indexing and metadata parsing |
| `tests/test_secretstore.py` | Encrypted secret set/get/delete |
| `tests/test_version.py` | Package version string format |
| `tests/test_imports.py` | Module import smoke tests |
| `tests/test_env_loader.py` | .env file loading |
| `tests/conftest.py` | Shared `zwork_home` and `clean_env` fixtures |

## Minimum release gate

Before calling a build user-test-ready:

1. `npm run build` passes in `app/`
2. `cargo check` passes in `app/src-tauri`
3. `cargo check` passes in `cloud-src/api`
4. Python unit tests pass: `.venv/bin/pytest`
5. Security regression tests pass: `.venv/bin/pytest tests/test_security.py`
6. live auth start endpoint returns `200`
7. unauthenticated session endpoint returns `401`
8. public db host returns `403`
9. updater artifacts publish successfully for the tagged release

# zWork Issue Board

This board is the short-term operating list for `prev1`.

Scope rules for `prev1`:

- hide payments and email/password auth in the UI where possible
- do not remove features unless removal is required for safety or build correctness
- keep the Google-only path obvious
- prioritize updater reliability above new feature work

## P0

### 1. Autoupdater must work end to end

Status: Open

Problem:

- the updater path must be reliable on every supported platform
- if a user is on an older build, the app must detect, download, and install the newer signed release

Acceptance criteria:

- startup update checks succeed on a clean install
- background update checks succeed on a running app
- native install completes without falling back to GitHub unless the native updater is unavailable
- release artifacts and updater manifests are validated before publish

Notes:

- this is a release blocker
- if the updater is flaky, the whole product trust loop is broken

### 2. Linux AppImage startup failure must auto-handle WebKit/EGL issues

Status: Open

Problem:

```text
zWork-linux-x86_64.appimage

** (sidecar-app:84483): WARNING **: 19:36:55.629: WEBKIT_FORCE_SANDBOX no longer allows disabling the sandbox. Use WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 instead.
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

Observed crash details:

```text
PID: 84526 (WebKitWebProces)
UID: 1000 (zemul)
GID: 1000 (zemul)
Signal: 6 (ABRT)
Timestamp: Sun 2026-05-03 19:36:56 EDT (26s ago)
Command Line: ././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess 4 24 28
Executable: /tmp/.mount_zWork-ehfBIg/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess
Control Group: /user.slice/user-1000.slice/user@1000.service/app.slice/kitty-84395-0.scope
Unit: user@1000.service
User Unit: kitty-84395-0.scope
Slice: user-1000.slice
Owner UID: 1000 (zemul)
Boot ID: dd3c2a01fe4d46e2a7c5f0cff94add42
Machine ID: 96dfce47047340c491b9f820947108fe
Hostname: zemu-macbookair82
Storage: /var/lib/systemd/coredump/core.WebKitWebProces.1000.dd3c2a01fe4d46e2a7c5f0cff94add42.84526.1777851416000000.zst (present)
Size on Disk: 2M
Message: Process 84526 (WebKitWebProces) of user 1000 dumped core.
Stack trace of thread 84526:
#0  0x00007f599f589a2c n/a (libc.so.6 + 0x98a2c)
#1  0x00007f599f52f1a0 raise (libc.so.6 + 0x3e1a0)
#2  0x00007f599f5165fe abort (libc.so.6 + 0x255fe)
#3  0x00007f59a81ed90c n/a (n/a + 0x0)
#4  0x00007f59a64651fd n/a (n/a + 0x0)
#5  0x00007f59a6450f36 n/a (n/a + 0x0)
#6  0x00007f59a641041e n/a (n/a + 0x0)
#7  0x00007f59a640ea47 n/a (n/a + 0x0)
#8  0x00007f59a6147edc n/a (n/a + 0x0)
#9  0x00007f59a5a7675e n/a (n/a + 0x0)
#10 0x00007f59a5ea4eb0 n/a (n/a + 0x0)
#11 0x00007f59a5ea50a7 n/a (n/a + 0x0)
#12 0x00007f59a5ea51d8 n/a (n/a + 0x0)
#13 0x00007f59a3c685d5 n/a (n/a + 0x0)
#14 0x00007f59a3d23a0d n/a (n/a + 0x0)
#15 0x00007f59a3d22b31 n/a (n/a + 0x0)
#16 0x00007f59a010945e n/a (n/a + 0x0)
#17 0x00007f59a0168977 n/a (n/a + 0x0)
#18 0x00007f59a0109f47 n/a (n/a + 0x0)
#19 0x00007f59a3d23094 n/a (n/a + 0x0)
#20 0x00007f59a64657f4 n/a (n/a + 0x0)
#21 0x00007f599f5186c1 n/a (libc.so.6 + 0x276c1)
#22 0x00007f599f5187f9 __libc_start_main (libc.so.6 + 0x277f9)
#23 0x0000563038d32085 n/a (n/a + 0x0)
ELF object binary architecture: AMD x86-64
```

Goal:

- the app should detect this Linux startup path and recover automatically
- users should not have to manually discover environment variables to get the AppImage running

Acceptance criteria:

- affected Linux hosts can launch the AppImage without a manual workaround
- the app retries or switches to a compatible fallback when WebKit/EGL initialization fails
- the failure is logged in a way that is actionable for debugging
- the fix does not regress unaffected Linux installs

Notes:

- prefer an automatic runtime workaround over a manual support instruction
- if a fallback is needed, it should be applied conditionally, not globally

### 3. Tool execution needs a real permission gate

Status: Open

Problem:

- tool execution currently has no permission gate at all
- dangerous actions need explicit approval boundaries before they can run

Acceptance criteria:

- sensitive and destructive tool classes require an approval gate
- the user can see what the tool will do before it does it
- approval state is enforced consistently across root actions and continuations
- the gate is testable and not just advisory text

### 4. Prompt injection can reach RCE through legacy `<<TOOL>>` markers

Status: Open

Problem:

- legacy tool markers create an injection path from model output into execution
- prompt-injection should not be able to turn text into code or command execution

Acceptance criteria:

- legacy marker parsing is removed or isolated behind a safe compatibility layer
- tool invocation requires structured validation, not freeform marker parsing
- untrusted assistant output cannot directly trigger shell or code execution
- regression tests cover malicious prompt payloads

### 5. CSP and Linux sandbox posture are too weak

Status: Open

Problem:

- `csp: null` in `tauri.conf.json` disables CSP outright
- `withGlobalTauri: true` broadens the browser-side API exposure surface
- sandbox-off behavior on Linux weakens isolation further

Acceptance criteria:

- CSP is enabled with an explicit policy
- Tauri globals are not exposed more broadly than necessary
- Linux webview sandbox behavior is tightened where possible
- the configuration is documented as an intentional security posture, not an accident

### 6. Local sidecar has no authentication boundary

Status: Open

Problem:

- the local sidecar currently exposes its API without any auth boundary
- any local process that can reach the port may be able to call the backend directly

Acceptance criteria:

- local API access is restricted to the desktop shell or an equivalent trusted client
- browser-hosted preview modes cannot accidentally become an unauthenticated attack surface
- auth assumptions are explicit in docs and code
- tests verify the expected origin/client restrictions

### 7. Background processes leak permanently

Status: Open

Problem:

- background processes can leak and remain alive after shutdown paths
- leaked processes create resource waste and can keep stale state around

Acceptance criteria:

- app shutdown reaps backend and preview child processes reliably
- failed startup does not leave orphaned children behind
- process lifecycle is covered by a smoke test or integration test
- logs make it obvious when a child was not cleaned up

## P1

### 3. Hide unused product surfaces instead of removing them

Status: Open

Problem:

- some surfaces exist in code or docs that are not part of `prev1`
- we want to reduce user confusion without deleting working implementation prematurely

Acceptance criteria:

- hidden surfaces are not shown in the primary UI
- hidden features remain available in code behind flags or route guards if needed
- docs and onboarding copy do not advertise unavailable paths

Examples:

- payments
- email/password auth
- any other not-needed managed-plan affordance

### 4. Clarify artifact foundation scope

Status: Open

Problem:

- we already have artifact rail behavior and markdown artifact storage
- what we do not yet have is a full durable artifact system with backend CRUD, richer persistence, and editing round trips

Acceptance criteria:

- artifact records are first-class persisted objects
- updates round-trip through backend storage
- reopen after restart preserves the same artifact state
- artifact types are consistently represented in the UI

## Deferred

### 5. Task and calendar surface

Status: Deferred

Reason:

- useful for `V1`, but not required to stabilize `prev1`

### 6. Payments and email/password auth

Status: Deferred

Reason:

- explicitly out of scope for `prev1`
- keep hidden, not deleted, unless code cleanup requires removal

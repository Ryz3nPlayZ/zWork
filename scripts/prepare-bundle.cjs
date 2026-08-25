// Copies the repo-root zWork-Skills tree into app/src-tauri/zWork-Skills so
// Tauri bundles it as a resource (`resources: ["zWork-Skills/**"]` in
// tauri.conf.json). Resource globs are resolved relative to src-tauri, and
// parent-dir globs are unreliable across Tauri versions, so we stage the copy
// here instead. Idempotent — safe to run from both `npm run dev` and
// `npm run build`. The staged dirs are gitignored (generated artifacts).
//
// Also stages CuaDriver.app (see below) so zWork can self-install the driver
// on first run.
//
// Run from app/:  node ../scripts/prepare-bundle.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const appDir = path.join(repoRoot, 'app');

// ---------- patch-package (durable dep patches) ----------
// Reapply patches in app/patches/ before every dev/build. Belt-and-suspenders
// alongside the `postinstall` hook in app/package.json — guarantees fixes ship
// even if a CI environment skips lifecycle hooks. Idempotent and silent on
// success; warns loudly if a patch fails so it can't fail quietly in a release.
// Currently patches: mdast-util-gfm-autolink-literal (drops a regex lookbehind
// that crashes old-macOS WebKit / Tauri WebView on the chat route).
const patchesDir = path.join(appDir, 'patches');
if (fs.existsSync(patchesDir) && fs.existsSync(path.join(appDir, 'node_modules', '.bin', 'patch-package'))) {
  try {
    execFileSync(path.join(appDir, 'node_modules', '.bin', 'patch-package'), [], {
      cwd: appDir,
      stdio: 'inherit',
    });
    console.log('[prepare-bundle] applied patch-package patches');
  } catch (e) {
    console.warn('[prepare-bundle] WARNING: patch-package failed —', e.message);
  }
}

// ---------- zWork-Skills ----------
const src = path.join(repoRoot, 'zWork-Skills');
const dst = path.join(repoRoot, 'app', 'src-tauri', 'zWork-Skills');

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, entry.name);
    const dp = path.join(d, entry.name);
    if (entry.isDirectory()) {
      copyDir(sp, dp);
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks verbatim (some skills symlink shared assets).
      try { fs.symlinkSync(fs.readlinkSync(sp), dp); } catch { fs.copyFileSync(sp, dp); }
    } else if (entry.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
}

if (!fs.existsSync(src)) {
  console.warn('[prepare-bundle] zWork-Skills not found at', src, '— skipping (skills will be absent from the bundle)');
} else {
  fs.rmSync(dst, { recursive: true, force: true });
  copyDir(src, dst);
  console.log('[prepare-bundle] staged zWork-Skills ->', path.relative(repoRoot, dst));
}

// ---------- CuaDriver.app ----------
// Bundle the whole CuaDriver.app so zWork can install it to ~/Applications on
// first run (see ensure_cuadriver_installed in app/src-tauri/src/main.rs),
// eliminating the separate manual install. The .app preserves trycua's code
// signature and the com.trycua.driver TCC identity.
//
// Source priority: ZWORK_CUADRIVER_APP env, then /Applications/CuaDriver.app
// (the standard location on a macOS build machine). On macOS when a real .app
// is present we `ditto` it (preserves bundle metadata + the executable bit;
// node's fs copy does NOT preserve Unix modes, which would break launch).
// Otherwise we leave a placeholder so the `CuaDriver.app/**/*` resource glob
// still matches on every platform and the build succeeds —
// ensure_cuadriver_installed detects the placeholder (no Contents/Info.plist)
// and falls back to the manual-install path.
const driverSrc =
  process.env.ZWORK_CUADRIVER_APP || '/Applications/CuaDriver.app';
const driverDst = path.join(repoRoot, 'app', 'src-tauri', 'CuaDriver.app');

fs.rmSync(driverDst, { recursive: true, force: true });

const haveReal =
  process.platform === 'darwin' &&
  fs.existsSync(driverSrc) &&
  fs.existsSync(path.join(driverSrc, 'Contents', 'Info.plist'));

if (haveReal) {
  try {
    execFileSync('ditto', [driverSrc, driverDst], { stdio: 'inherit' });
    console.log('[prepare-bundle] staged CuaDriver.app ->', path.relative(repoRoot, driverDst));
  } catch (e) {
    console.warn('[prepare-bundle] ditto failed; staged placeholder instead:', e.message);
    fs.mkdirSync(driverDst, { recursive: true });
    fs.writeFileSync(path.join(driverDst, '.placeholder'), '');
  }
} else {
  fs.mkdirSync(driverDst, { recursive: true });
  fs.writeFileSync(path.join(driverDst, '.placeholder'), '');
  if (process.platform === 'darwin') {
    console.warn('[prepare-bundle] CuaDriver.app not found at', driverSrc,
      '— staged placeholder only (desktop control will need a manual driver install)');
  } else {
    console.log('[prepare-bundle] non-darwin build; staged CuaDriver.app placeholder only');
  }
}

// ZWORK_STRICT_DRIVER=1 (set in release/CI builds, not local dev): refuse to
// produce a bundle if we only staged the placeholder. A placeholder CuaDriver
// silently forces every user onto the manual-install path, where the #1
// reported issue ("permission granted but automation dead") originates. Better
// to fail the build loudly than ship a broken desktop-control experience.
if (process.env.ZWORK_STRICT_DRIVER === '1') {
  const infoPlist = path.join(driverDst, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlist)) {
    console.error('[prepare-bundle] ZWORK_STRICT_DRIVER=1 but CuaDriver.app is the ' +
      'placeholder (no Contents/Info.plist). Set ZWORK_CUADRIVER_APP to a real ' +
      'CuaDriver.app, or place one at /Applications/CuaDriver.app, before building a release.');
    process.exit(1);
  }
}

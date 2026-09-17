# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A macOS menu bar app (Swift + AppKit, no package manager, no dependencies) that shows Claude Code's live status, and (fork-only) opencode's. This checkout is a personal fork of `m1ckc3s/claude-status-bar`; the in-app update check points at the fork's releases (`releaseAPIURL` / `releasePageURL` in `Sources/main.swift`), not upstream's.

## Build & run

```bash
./build.sh                    # -> build/Claude Status Bar.app  (universal arm64 + x86_64)
./build.sh --dmg              # also notarizes the app, builds + notarizes build/Claude Status Bar.dmg
SKIP_NOTARIZE=1 ./build.sh --dmg   # DMG layout test without notarization
./scripts/demo-multi-account.sh    # seeds two fake live sessions, launches the dev build, restores on Enter
node --test tests/install.test.js  # the only automated tests (hook install/uninstall)
```

Requires the Swift toolchain (Xcode CLT) and Node. Without a Developer ID cert for the hardcoded `TEAM_ID`, `build.sh` falls back to ad-hoc signing — fine for local testing.

`tests/install.test.js` (from upstream 0.4.2, plus the opencode plugin install/uninstall round-trip) covers the installer only. Everything else is verified manually: build, launch, start a real session, and watch the icon. Test both Claude Code surfaces (CLI in a terminal *and* the Claude desktop app's Code tab) — they behave differently, and behavior also varies across terminals. For opencode, `CLAUDE_STATUSBAR_DEBUG=1 opencode run "…"` in a scratch dir is the quickest check: `hooks.log` should show `init` → `thinking` → `tool` → `done` → `drop`, and the command must still **exit on its own** (a plugin that leaks a child process hangs it forever).

The tests run the installer against a temp `HOME`, and the installer honours `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` — each of which can point outside that temp HOME — so `sandboxEnv()` explicitly strips all three from the child env. Keep them stripped: otherwise a test run rewrites a second account's real `settings.json`, or *deletes* the user's real opencode plugin.

**Note:** editor/SourceKit diagnostics on `Sources/main.swift` alone report missing symbols (`clawdCrabFramePNGs`, `adaptiveCrabFrame`, …). They live in sibling files; only the whole-target `./build.sh` is authoritative.

## Architecture

Two halves, connected only by files on disk. The app never talks to Claude Code (or opencode) directly.

**1. Node hooks (`hooks/*.js`)** — registered in each account's `settings.json`, fired by Claude Code on every event.
- `update.js <prompt|pre|post|notify|permreq|stop>` maps a hook event to a state and writes one small JSON file: `~/.claude/statusbar/state.d/<session_id>.json`. `pid: process.ppid` is the session's `claude` process (verified stable) and is the app's liveness signal.
- `lifecycle.js <start|end>` seeds an idle file on SessionStart (and `open -g -b com.local.claudestatusbar` to launch the app), deletes it on SessionEnd.
- `install.js` / `uninstall.js` merge/strip these hooks in `settings.json`, matching on the marker substring `~/.claude/statusbar` so unrelated hooks are never clobbered. Backs up to `settings.json.bak-statusbar` on first run. Re-runnable. They also install/remove the opencode plugin below.

**1b. opencode plugin (`hooks/opencode-plugin.js`)** — the same state files, written by a totally different mechanism. Installed as `claude-statusbar.js` in opencode's global plugin dir (`~/.config/opencode/plugin/` or `plugins/` — both are scanned, the installer reuses whichever exists so it can't be loaded twice). No `settings.json` equivalent to merge: any file there is auto-loaded.
- It is **not** a per-event process. opencode loads it in-process under **Bun** and keeps it for the life of the `opencode` process, which inverts several of the Claude Code assumptions: `pid` is `process.pid` directly (no `ppid` indirection), there is no PATH/`locateNode()` problem, and it must import nothing but node builtins (`@opencode-ai/plugin` is types-only).
- Because it lives inside opencode, **it must not leave a child process running** — that holds Bun's event loop open and a one-shot `opencode run` never exits. Hence `execSync`/`execFileSync`, never a detached `spawn`.
- Event mapping: `chat.message` + `session.status{busy}` → thinking, `tool.execute.before/after` → tool/thinking, `permission.updated`/`replied` → permission/thinking, `session.idle` + `session.status{idle}` → done, `session.deleted`/`server.instance.disposed`/`dispose` → drop the file.
- One `opencode` process hosts **many** sessions, so several state files share one pid; the app's `kill(pid,0)` reap still works (they leave together). Files are keyed `oc-<sessionID>.json` so they can never collide with Claude Code's UUIDs.
- opencode is chattier than Claude Code (~10 status events per short turn), so `write()` skips an unchanged row and refreshes at most every 30s, and the app-relaunch check is throttled to 5s.

**2. Swift app (`Sources/main.swift`, ~1300 lines)** — `StatusController` polls `state.d/` every 0.4s (re-parsing only files whose mtime changed), reaps sessions whose pid is dead, computes an *effective* state per session, and surfaces the single highest-priority one in the menu bar (`permission` > `thinking`/`tool` > idle, ties broken by recency). The dropdown lists every visible session.

Supporting Swift files: `CrabRender.swift` (converts the color crab sprite to an adaptive template image; generates the claw-wave frames at runtime). `CrabFrames.swift`, `SparkFrames.swift`, `LogoFrame.swift` are **auto-generated base64 PNG blobs — do not hand-edit**.

### Invariants worth knowing before changing things

- **Hooks stay trivial.** They run on every event: write one file, exit. No network, no heavy work. `CLAUDE_STATUSBAR_DEBUG=1` logs invocations to `~/.claude/statusbar/hooks.log`.
- **State writes are atomic** (`write tmp` + `rename`), so the app never reads a torn file; it also relies on mtime bumps to know when to re-parse.
- **The hub is always the real `~/.claude/statusbar`**, even for secondary accounts and for opencode — `os.homedir()` deliberately ignores `CLAUDE_CONFIG_DIR`. Only the *target* `settings.json` varies (`CLAUDE_CONFIG_DIR=$HOME/.claude-2 node install.js`). This is what lets one app aggregate multiple accounts; the account label is derived from the config dir name (overridable with `CLAUDE_STATUSBAR_ACCOUNT`), and the account pill only appears when ≥2 accounts are visible.
- **Self-quit lifecycle:** the app terminates once no session file exists and Claude desktop isn't running (after a launch grace + debounce). It is not meant to be launched by hand. opencode needs no probe of its own here: its plugin opens the app on the *first state write* (deliberately not at plugin init — that would fire for every `opencode run` and every headless `serve`), and that file then lives as long as the `opencode` process, so `sessionCount()` covers it.
- **Recovery nets matter.** Interrupts (Esc, denied permission) fire no hook, so `effectiveState` also caps state by age and scans the last real turn line of the transcript for `interrupted by user`. Removing either freezes the icon. opencode has no transcript file (history lives in its own DB), so the plugin writes `transcript: ""` — that is load-bearing, it makes the app skip a net that only understands Claude Code JSONL. The age cap still applies.
- **`ensureHooksInstalled()`** re-runs the bundled installer on every version change (tracked in the `installedVersion` default), so hook changes ship with an app upgrade. `locateNode()` probes common paths before falling back to a login shell, because nvm/fnm aren't on the login PATH.
- **Live layout knobs**: `~/.claude/statusbar/uiconfig.json` is read fresh on every render (`uiConfig()`) — numeric tweaks (`boxWidth`, `timerGap`, `pillInset`, `pillTextY`, `nameMax`, `pillBgLight`/`pillBgDark`) take effect on the next menu open, no rebuild.
- Menu rows are custom `NSView`s (`SessionRowView`, `ToggleView`) because NSMenu can't do trailing-edge layout or an accented switch. They implement their own hover highlight; the session *set* only changes on menu reopen.
- Git branch is read straight from `.git/HEAD` (walking up for worktrees/submodules) — never spawn `git`.
- **The bundle folder is `Claude Status Bar.app` but the executable is `ClaudeStatusBar`** (no spaces). They deliberately differ: `lifecycle.js` and `update.js` both `pgrep -x ClaudeStatusBar` to decide whether to relaunch the app, so renaming the executable silently breaks the mid-session self-heal. If you touch either name, grep for `pgrep -x`/`pkill -x` across `hooks/` and `scripts/`.
- **Hook commands must not embed an absolute node path.** `install.js` writes `PATH="/opt/homebrew/bin:/usr/local/bin${PATH:+:$PATH}" node …` and resolves `node` at run time; a Homebrew node path contains its version, so baking it in means the next `brew upgrade node` kills every hook (upstream 0.4.2). `locateNode()` in the Swift app is a separate concern and may still probe absolute paths.

## Releasing

Version lives in four places and must be bumped together: `build.sh` (`CFBundleVersion` + `CFBundleShortVersionString`), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`. Add the entry to `CHANGELOG.md` (Keep a Changelog format, semver, with the release link at the bottom).

## Scope (from CONTRIBUTING.md)

This is deliberately a small, local, free status indicator for Claude Code on macOS. **Note this fork deliberately diverges on one point:** `CONTRIBUTING.md` puts "support for other agents" out of scope and asks that it live in a fork — which is what the opencode support here is. Expect it to conflict on every upstream sync, and do not send it upstream. Otherwise out of scope: sending anything to an API or relay, anything needing an API key or costing money, usage/cost dashboards, telemetry, heavy hook work, new settings stores or dependencies for minor features, changing system behavior (power assertions, privileged helpers), and ports to other agents or OSes.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `perf`); branches are `type/kebab-case-description`.

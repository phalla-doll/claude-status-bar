
A tiny macOS menu bar app that shows your coding agents' live status: an animated icon while they are thinking or working, a yellow dot when a supported agent is awaiting your permission, and the elapsed time of the current turn. Supports Claude Code, OpenCode, Codex CLI, and Antigravity CLI. Lightweight, no window, no dock icon, no usage dashboards.

Built so you can tab away during a long "thinking" stretch and still see, at a glance, whether Claude is working, waiting on you, or done.

<img width="480" height="383" alt="Screen Recording 2026-07-10 at 12 32 23 AM" src="https://github.com/user-attachments/assets/f5d77b7c-f41d-4276-b28f-e1cf655fd323" />

## Install

### Homebrew (recommended)

```bash
brew install --cask claude-status-bar && open -a "Claude Status Bar"
```

The one launch at the end matters: it wires up the Claude Code hooks automatically. After that it starts itself whenever Claude Code runs.

**Already using the app from the DMG?** The same command switches you to Homebrew. Your settings and hooks carry over, and the old copy cleans itself up on first launch. Full details, edge cases, and the tested upgrade matrix: **[HOMEBREW.md](HOMEBREW.md)**.

> [!IMPORTANT]
> **Updated (or installed) mid-session?** Sessions already open appear the next time they do something (a prompt or a tool call). Starting a new `claude` session also works.

### DMG

*Signed and notarized by Apple*

1. Download the latest `ClaudeStatusBar.dmg` from [Releases](../../releases).
2. Open it and drag **Claude Status Bar** into Applications.
3. Launch it once. On first launch it wires up the Claude Code hooks for you automatically.
4. Start a new Claude Code session, the icon appears whenever Claude Code is running.

## Updating

The menu tells you when an update is ready. Installed via brew, it shows **Update via brew** with a copy button (paste the command in your terminal); it appears once Homebrew can actually deliver the new version, which can lag a release by up to a day. Installed via DMG, **Update available** opens the releases page, plus a one-click **Switch to Homebrew** option.

Or just run `brew upgrade --cask claude-status-bar` (brew), or download the latest DMG and drag it into Applications (manual). Hooks refresh themselves on the next launch; nothing to run by hand. **Upgrading from 0.3.x via DMG? Launch the app once after dragging**, that's what retires the old-named copy ([details](HOMEBREW.md#faq--troubleshooting)).

## What it shows

- **Thinking / working** — the icon animates, with a live `1m 1s` timer.
- **Running a tool** — a short label (`Editing`, `Reading`, `Running command`, `Using tool`, …).
- **Awaiting permission** — a paused yellow dot, in both the CLI and the Desktop app.
- **Idle / done** — rests on the Claude logo.

Everything is controlled from the menu:

- **Show timer:** toggle the elapsed `1m 1s` clock.
- **Thinking words:** show a playful rotating verb (`Manifesting…`, `Percolating…`) while an agent thinks, like Claude Code. Turn it off for an icon-only display (or icon + timer when **Show timer** is on). On by default.
- **Animation style:**
  - **Claude Spark**, the web/chat "morph" spark
  - **Claude Code**, the terminal glyph spinner
  - **Crab Walking**, a pixel-art Clawd crab that scuttles while Claude works — and stops to wave its claw when Claude is waiting for your approval
- **Icon color:** **Orange** or **System** (adaptive black/white). All three styles follow this setting: in System mode Crab Walking renders as a shaded monochrome silhouette that matches the menu bar.
- **Version and update:** the menu shows your current version and tells you when an update is ready (see [Updating](#updating)).

### Where it works

| Surface | Tracked? |
|---|---|
| Claude Code CLI (terminal) | ✅ |
| Claude Code Desktop — **Code** tab | ✅ |
| Cursor (Claude Code extension) | ✅ |
| OpenCode | ✅ |
| Codex CLI | ✅ |
| Antigravity CLI (`agy`) | ✅ thinking/timer/completion |
| Claude Desktop — **Chat/Cowork** tab | ❌ |

The first launch installs integrations for the CLIs it finds. Codex requires one additional
trust step: open `/hooks` in Codex and approve the newly added status-bar hooks. Antigravity's
current hook API has no passive permission-request event, so its row keeps showing as working
while an approval prompt is open; the integration deliberately does not install a hook that
could change Antigravity's permission decision.

**Multi-session support.** When several Claude Code sessions run at once (multiple terminals, or a terminal plus the desktop app), the menu bar surfaces the highest-priority one: a session awaiting your permission is never hidden behind one that's thinking. The dropdown lists every live session. Precise per-tab focus is in progress: **[issue #19 →](https://github.com/m1ckc3s/claude-status-bar/issues/19)**.

## How it works

> [!NOTE]
> You don't open this app; it opens itself when a Claude Code session starts, and quits when none is running. The only manual launch is the very first one after install, to set up the hooks. Opened by hand with no session active, it quits again after a few seconds. That's normal.

The app is stateless. Claude Code fires hooks as it works; the app polls those updates and aggregates them across every live session into a single icon, a permission dot if one needs you, animating if any session is working, resting when all are idle. It launches itself when Claude Code opens and quits when nothing's running, so there's nothing to manage.

The installer merges only its own entries into the hook configuration for supported agents it finds, backing existing files up first. Runtime state stays local under `~/.claude/statusbar/`. The app's only network activity is a once-a-day update check against GitHub's and Homebrew's public APIs ([details](PRIVACY.md)).

## Requirements

- macOS 12+
- [Claude Code](https://claude.com/claude-code) (CLI or the Desktop app)
- Node.js

## Multiple accounts

Run a second Claude Code account through `CLAUDE_CONFIG_DIR` (a common setup)?

```sh
# ~/.zshrc
claude2() { CLAUDE_CONFIG_DIR="$HOME/.claude-2" claude "$@"; }
```

By default the app only wires hooks into the primary `~/.claude`, so `claude2` sessions never show up. Wire the second account once — pointing `CLAUDE_CONFIG_DIR` at it — and its sessions join the same status bar:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-2" node "/Applications/Claude Status Bar.app/Contents/Resources/install.js"
```

That's it. The scripts and session state stay in the shared `~/.claude/statusbar/` hub, so a single app still shows everything. When two or more accounts are live, each row gets an account badge next to its `CLI`/`APP` pill (`[claude-2][CLI]`); with one account the rows look exactly as before. The badge defaults to the config dir's name — set `CLAUDE_STATUSBAR_ACCOUNT` in that account's shell to label it something friendlier.

## Troubleshooting

Icon not appearing, vanishing on its own, or not animating when it should? See [Troubleshooting](TROUBLESHOOTING.md), most of it is expected behavior, not a bug.

## Uninstall

```bash
node "/Applications/Claude Status Bar.app/Contents/Resources/uninstall.js"   # removes only our hooks
brew uninstall --zap claude-status-bar                                       # removes the app + every file it created
```

Installed manually instead of via brew? Skip the second line and drag the app to the Trash.

Wired up a [second account](#multiple-accounts)? Clean it the same way, pointing at its config dir:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-2" node "/Applications/Claude Status Bar.app/Contents/Resources/uninstall.js"
```

## Acknowledgements

I built this for myself, then open-sourced it because other people might find it handy too, and I'm genuinely thrilled that so many of you do. An extra thank-you to everyone who went the extra mile and contributed code, fixes, and ideas.

**[See the contributors →](ACKNOWLEDGEMENTS.md)**

## Trademark / Not Affiliated

This is an unofficial, open-source side project. **It is not affiliated with, endorsed by, or sponsored by Anthropic.** "Claude" and the Claude spark logo are trademarks of Anthropic, used here nominatively. This project is MIT licensed, but that covers the source code only and conveys no rights to Anthropic's trademarks or brand.

If I'm violating or impeding your trademark, Contact me on X ([@mickces](https://x.com/mickces))
This is a free side project; I'm not monetizing it.

## License

MIT

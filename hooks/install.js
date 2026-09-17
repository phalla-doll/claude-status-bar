#!/usr/bin/env node
// Installs the status-bar hooks into a Claude Code settings.json (merging, never
// clobbering existing hooks) and copies update.js to ~/.claude/statusbar/.
// Re-runnable: existing status-bar hooks are stripped before re-adding.
//
// Multi-account: the scripts + state.d live in the SHARED ~/.claude/statusbar hub
// (one app reads it, sessions aggregate by UUID). Only the settings.json TARGET
// varies — set CLAUDE_CONFIG_DIR to wire a non-default account's hooks at the same
// shared scripts, e.g.  CLAUDE_CONFIG_DIR=$HOME/.claude-2 node install.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const home = os.homedir();
// The shared hub is always the real ~/.claude — os.homedir() ignores CLAUDE_CONFIG_DIR,
// so every account's hooks write here and the single app sees them all.
const sbDir = path.join(home, ".claude", "statusbar");
const MARKER = sbDir; // every hook command we add points inside this dir
const updateDest = path.join(sbDir, "update.js");
const lifecycleDest = path.join(sbDir, "lifecycle.js");
const agentUpdateDest = path.join(sbDir, "agent-update.js");
// opencode loads plugins from its own config dir, so this one is copied there rather than
// referenced from the hub — see installOpencodePlugin() below.
const OPENCODE_PLUGIN = "claude-statusbar.js";
// Which account's settings.json to wire. Defaults to the primary ~/.claude; point it at a
// secondary account (run through `CLAUDE_CONFIG_DIR=$HOME/.claude-2 claude`) to surface that
// account's sessions too. The scripts/state above stay shared regardless.
// path.resolve leaves an absolute CLAUDE_CONFIG_DIR untouched and anchors a relative one at
// $HOME (not the installer's arbitrary cwd), matching where a config dir actually lives.
const configDir = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(home, process.env.CLAUDE_CONFIG_DIR)
  : path.join(home, ".claude");
const settingsPath = path.join(configDir, "settings.json");

// Retire the old 0.0.2 background watcher LaunchAgent on upgrade (0.0.3+ self-quits).
const OLD_AGENT_LABEL = "com.local.claudestatusbar.watcher";
const oldAgentPlist = path.join(home, "Library", "LaunchAgents", OLD_AGENT_LABEL + ".plist");
try { cp.execSync(`launchctl bootout gui/${process.getuid()}/${OLD_AGENT_LABEL}`, { stdio: "ignore" }); } catch {}
if (fs.existsSync(oldAgentPlist)) { fs.rmSync(oldAgentPlist); console.log("Removed old desktop watcher LaunchAgent."); }

fs.mkdirSync(sbDir, { recursive: true });
fs.rmSync(path.join(sbDir, "watcher.sh"), { force: true });
// Retire pre-multi-session artifacts (single global state + empty liveness markers).
fs.rmSync(path.join(sbDir, "state.json"), { force: true });
fs.rmSync(path.join(sbDir, "sessions.d"), { recursive: true, force: true });
fs.copyFileSync(path.join(__dirname, "update.js"), updateDest);
fs.copyFileSync(path.join(__dirname, "lifecycle.js"), lifecycleDest);
fs.copyFileSync(path.join(__dirname, "agent-update.js"), agentUpdateDest);

// --- opencode -------------------------------------------------------------------------
// opencode has no settings.json to merge: any .js in its plugin dir is auto-loaded, so
// "installing" is a single file copy under our own name — nothing of the user's to clobber.
// The file is COPIED (not symlinked/re-exported) so ensureHooksInstalled() refreshes it on
// every app version bump, exactly like the two scripts above.
// Mirrors opencode's own resolution (`config: OPENCODE_CONFIG_DIR ?? XDG_CONFIG_HOME/opencode`).
// NOT OPENCODE_CONFIG — that names an *additional config file*, not the config dir, so deriving
// a plugin dir from it would install us somewhere opencode never scans.
// A relative override anchors at $HOME (matching the CLAUDE_CONFIG_DIR idiom), absolute is kept.
const opencodeConfigDir = () => {
  const override = process.env.OPENCODE_CONFIG_DIR;
  if (override) return path.resolve(home, override);
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg ? path.resolve(home, xdg) : path.join(home, ".config"), "opencode");
};

// opencode scans BOTH `plugin/` and `plugins/` (confirmed in the 1.18.x binary). Prefer
// whichever the user already has so we never end up installed in both and loaded twice.
const opencodePluginDir = (base) => {
  for (const name of ["plugin", "plugins"]) {
    if (fs.existsSync(path.join(base, name))) return path.join(base, name);
  }
  return path.join(base, "plugin");
};

const hasOpencode = (base) => {
  if (fs.existsSync(base)) return true;
  try { cp.execSync("command -v opencode", { stdio: "ignore" }); return true; } catch { return false; }
};

const installOpencodePlugin = () => {
  const base = opencodeConfigDir();
  // Don't create an opencode config tree for someone who doesn't use opencode.
  if (!hasOpencode(base)) return null;
  const pluginDir = opencodePluginDir(base);
  const dest = path.join(pluginDir, OPENCODE_PLUGIN);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "opencode-plugin.js"), dest);
  return dest;
};

let opencodeDest = null;
try { opencodeDest = installOpencodePlugin(); } catch (e) {
  console.warn("Could not install the opencode plugin:", e.message);
}

const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const quotedMarkerPrefix = shellQuote(MARKER).slice(0, -1);
const isOurs = (command) =>
  command.includes(MARKER) || command.includes(quotedMarkerPrefix);
const cmd = (evt) =>
  `PATH="/opt/homebrew/bin:/usr/local/bin\${PATH:+:$PATH}" node ${shellQuote(updateDest)} ${evt}`;
const life = (evt) =>
  `PATH="/opt/homebrew/bin:/usr/local/bin\${PATH:+:$PATH}" node ${shellQuote(lifecycleDest)} ${evt}`;
const agentCmd = (provider, evt) =>
  `PATH="/opt/homebrew/bin:/usr/local/bin\${PATH:+:$PATH}" node ${shellQuote(agentUpdateDest)} ${provider} ${evt}`;

let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const bak = settingsPath + ".bak-statusbar";
  if (!fs.existsSync(bak)) fs.copyFileSync(settingsPath, bak);
}
settings.hooks = settings.hooks || {};

const stripOurs = (arr) =>
  (arr || [])
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((h) => !isOurs(h.command || "")),
    }))
    .filter((entry) => (entry.hooks || []).length > 0);

const addUnmatched = (evt, command) => {
  settings.hooks[evt] = stripOurs(settings.hooks[evt]);
  settings.hooks[evt].push({ hooks: [{ type: "command", command }] });
};
const addMatched = (evt, command) => {
  settings.hooks[evt] = stripOurs(settings.hooks[evt]);
  settings.hooks[evt].push({ matcher: "*", hooks: [{ type: "command", command }] });
};

// Status hooks (drive the animation/label)
addUnmatched("UserPromptSubmit", cmd("prompt"));
addMatched("PreToolUse", cmd("pre"));
addMatched("PostToolUse", cmd("post"));
addUnmatched("Notification", cmd("notify"));
addMatched("PermissionRequest", cmd("permreq"));
addUnmatched("Stop", cmd("stop"));
// Lifecycle hooks (launch the app on open; the app quits itself when no longer needed)
addUnmatched("SessionStart", life("start"));
addUnmatched("SessionEnd", life("end"));

fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("Installed status-bar hooks into", settingsPath);
console.log("Scripts:", updateDest, lifecycleDest, "and", agentUpdateDest);
if (opencodeDest) console.log("Installed opencode plugin:", opencodeDest);
console.log("Backup (first run only):", settingsPath + ".bak-statusbar");

// --- Codex CLI ------------------------------------------------------------------------
// Codex discovers user hooks in $CODEX_HOME/hooks.json (default ~/.codex/hooks.json). Merge
// our lifecycle observers alongside anything already there; Codex asks the user to review and
// trust newly added hook definitions in `/hooks` before it runs them.
const codexDir = process.env.CODEX_HOME
  ? path.resolve(home, process.env.CODEX_HOME)
  : path.join(home, ".codex");
const codexHooksPath = path.join(codexDir, "hooks.json");
const hasCommand = (name) => {
  try { cp.execSync(`command -v ${name}`, { stdio: "ignore" }); return true; } catch { return false; }
};

const installCodexHooks = () => {
  if (!fs.existsSync(codexDir) && !hasCommand("codex")) return false;
  let config = {};
  if (fs.existsSync(codexHooksPath)) {
    config = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
    const backup = codexHooksPath + ".bak-statusbar";
    if (!fs.existsSync(backup)) fs.copyFileSync(codexHooksPath, backup);
  }
  config.hooks = config.hooks || {};
  const add = (name, evt, matched = false) => {
    config.hooks[name] = stripOurs(config.hooks[name]);
    const entry = { hooks: [{ type: "command", command: agentCmd("codex", evt), timeout: 3 }] };
    if (matched) entry.matcher = "*";
    config.hooks[name].push(entry);
  };
  add("SessionStart", "start");
  add("UserPromptSubmit", "prompt");
  add("PreToolUse", "pre", true);
  add("PermissionRequest", "permreq", true);
  add("PostToolUse", "post", true);
  add("Stop", "stop");
  add("Interrupt", "interrupt");
  add("SessionEnd", "end");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(codexHooksPath, JSON.stringify(config, null, 2) + "\n");
  return true;
};

try {
  if (installCodexHooks()) console.log("Installed Codex hooks into", codexHooksPath);
} catch (e) {
  console.warn("Could not install Codex hooks:", e.message);
}

// --- Antigravity CLI ------------------------------------------------------------------
// Antigravity's global hooks file is shared with its desktop surface and is namespaced at the
// top level. We own exactly one key and never register PreToolUse: that event requires a gating
// decision, so it is not safe for a status-only observer. PreInvocation/PostToolUse/Stop are
// sufficient for thinking, timer, completion, and liveness without changing agent behaviour.
const antigravityDir = path.join(home, ".gemini", "antigravity-cli");
const antigravityHooksPath = path.join(home, ".gemini", "config", "hooks.json");
const installAntigravityHooks = () => {
  if (!fs.existsSync(antigravityDir) && !hasCommand("agy")) return false;
  let config = {};
  if (fs.existsSync(antigravityHooksPath)) {
    config = JSON.parse(fs.readFileSync(antigravityHooksPath, "utf8"));
    const backup = antigravityHooksPath + ".bak-statusbar";
    if (!fs.existsSync(backup)) fs.copyFileSync(antigravityHooksPath, backup);
  }
  config["claude-statusbar"] = {
    PreInvocation: [
      { type: "command", command: agentCmd("antigravity", "preinvoke"), timeout: 3 },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: agentCmd("antigravity", "posttool"), timeout: 3 }],
      },
    ],
    Stop: [
      { type: "command", command: agentCmd("antigravity", "stop"), timeout: 3 },
    ],
  };
  fs.mkdirSync(path.dirname(antigravityHooksPath), { recursive: true });
  fs.writeFileSync(antigravityHooksPath, JSON.stringify(config, null, 2) + "\n");
  return true;
};

try {
  if (installAntigravityHooks()) console.log("Installed Antigravity hooks into", antigravityHooksPath);
} catch (e) {
  console.warn("Could not install Antigravity hooks:", e.message);
}

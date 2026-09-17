#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const home = os.homedir();
// Match the dir, not "update.js": the narrower marker used to orphan the lifecycle hooks.
// The hub is shared across accounts, so the marker is always the real ~/.claude/statusbar.
const MARKER = path.join(home, ".claude", "statusbar");
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const quotedMarkerPrefix = shellQuote(MARKER).slice(0, -1);
const isOurs = (command) =>
  command.includes(MARKER) || command.includes(quotedMarkerPrefix);
// Remove hooks from the primary ~/.claude by default; pass CLAUDE_CONFIG_DIR to clean a
// secondary account's settings.json (mirrors install.js). Only the target varies.
// Relative CLAUDE_CONFIG_DIR anchors at $HOME (mirrors install.js), absolute is left as-is.
const configDir = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(home, process.env.CLAUDE_CONFIG_DIR)
  : path.join(home, ".claude");
const settingsPath = path.join(configDir, "settings.json");

// Tear down the desktop watcher LaunchAgent (best-effort; safe if absent).
const AGENT_LABEL = "com.local.claudestatusbar.watcher";
const agentPlist = path.join(home, "Library", "LaunchAgents", AGENT_LABEL + ".plist");
try { cp.execSync(`launchctl bootout gui/${process.getuid()}/${AGENT_LABEL}`, { stdio: "ignore" }); } catch {}
if (fs.existsSync(agentPlist)) { fs.rmSync(agentPlist); console.log("Removed desktop watcher LaunchAgent."); }
try { cp.execSync("pkill -x ClaudeStatusBar", { stdio: "ignore" }); } catch {}

// Remove the opencode plugin (mirrors install.js). Done before the settings.json early-exit
// below, so an opencode-only user still gets cleaned up.
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
for (const name of ["plugin", "plugins"]) {
  const p = path.join(opencodeConfigDir(), name, "claude-statusbar.js");
  if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); console.log("Removed opencode plugin:", p); }
}

// Remove only our command handlers from Codex's user hooks file. Preserve every other hook,
// top-level field, and the one-time backup created by the installer.
const codexDir = process.env.CODEX_HOME
  ? path.resolve(home, process.env.CODEX_HOME)
  : path.join(home, ".codex");
const codexHooksPath = path.join(codexDir, "hooks.json");
if (fs.existsSync(codexHooksPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
    for (const evt of Object.keys(config.hooks || {})) {
      config.hooks[evt] = (config.hooks[evt] || [])
        .map((entry) => ({
          ...entry,
          hooks: (entry.hooks || []).filter((hook) => !isOurs(hook.command || "")),
        }))
        .filter((entry) => (entry.hooks || []).length > 0);
      if (config.hooks[evt].length === 0) delete config.hooks[evt];
    }
    fs.writeFileSync(codexHooksPath, JSON.stringify(config, null, 2) + "\n");
    console.log("Removed status-bar hooks from", codexHooksPath);
  } catch (e) {
    console.warn("Could not remove Codex hooks:", e.message);
  }
}

// Antigravity hook files are top-level namespaces. Delete our namespace only when it still
// contains one of our shared-hub command paths, so a user-created key with the same name wins.
const antigravityHooksPath = path.join(home, ".gemini", "config", "hooks.json");
if (fs.existsSync(antigravityHooksPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(antigravityHooksPath, "utf8"));
    const containsOurs = (value) => {
      if (typeof value === "string") return isOurs(value);
      if (Array.isArray(value)) return value.some(containsOurs);
      return value && typeof value === "object" && Object.values(value).some(containsOurs);
    };
    if (containsOurs(config["claude-statusbar"])) {
      delete config["claude-statusbar"];
      fs.writeFileSync(antigravityHooksPath, JSON.stringify(config, null, 2) + "\n");
      console.log("Removed status-bar hooks from", antigravityHooksPath);
    }
  } catch (e) {
    console.warn("Could not remove Antigravity hooks:", e.message);
  }
}

if (!fs.existsSync(settingsPath)) { console.log("No settings.json; nothing to do."); process.exit(0); }

const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const evt of Object.keys(settings.hooks || {})) {
  settings.hooks[evt] = (settings.hooks[evt] || [])
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !isOurs(h.command || "")) }))
    .filter((e) => (e.hooks || []).length > 0);
  if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("Removed status-bar hooks from", settingsPath);

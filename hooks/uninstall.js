#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const home = os.homedir();
// Match the dir, not "update.js": the narrower marker used to orphan the lifecycle hooks.
// The hub is shared across accounts, so the marker is always the real ~/.claude/statusbar.
const MARKER = path.join(home, ".claude", "statusbar");
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
try { cp.execSync("pkill -x \"Claude Status Bar\"", { stdio: "ignore" }); } catch {}

if (!fs.existsSync(settingsPath)) { console.log("No settings.json; nothing to do."); process.exit(0); }

const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const evt of Object.keys(settings.hooks || {})) {
  settings.hooks[evt] = (settings.hooks[evt] || [])
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !(h.command || "").includes(MARKER)) }))
    .filter((e) => (e.hooks || []).length > 0);
  if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("Removed status-bar hooks from", settingsPath);

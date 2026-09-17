#!/usr/bin/env node
// Status adapter for hook-driven agents other than Claude Code.
// Usage: node agent-update.js <codex|antigravity> <event>

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const provider = process.argv[2] || "";
const event = process.argv[3] || "";
const dir = path.join(os.homedir(), ".claude", "statusbar");
const stateDir = path.join(dir, "state.d");
const quitMarker = path.join(dir, "quit-intent");
const BUNDLE_ID = "com.local.claudestatusbar";
const EXEC = "ClaudeStatusBar";

const TOOL_LABELS = {
  Bash: "Running command", exec_command: "Running command", apply_patch: "Editing",
  Edit: "Editing", Write: "Writing", Read: "Reading", view_image: "Viewing image",
  Grep: "Searching", Glob: "Searching", WebSearch: "Searching web", WebFetch: "Browsing web",
  Agent: "Delegating", spawn_agent: "Delegating", update_plan: "Planning",
};

const safePart = (value, max = 60) =>
  String(value || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, max) || "unknown";

const readJSON = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
};

const writeAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
};

// Hook runners may insert a short-lived shell between this script and the CLI. Walk upward and
// store the real agent pid so the macOS app can reap the row as soon as that CLI exits.
const ownerPid = () => {
  const needles = provider === "codex" ? ["codex"] : ["agy", "antigravity"];
  let pid = process.ppid;
  for (let i = 0; i < 10 && pid > 1; i++) {
    try {
      const row = cp.execFileSync("/bin/ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const match = row.match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      const command = path.basename(match[2]).toLowerCase();
      if (needles.some((needle) => command.includes(needle))) return pid;
      pid = Number(match[1]);
    } catch { break; }
  }
  return process.ppid;
};

const relaunchIfNeeded = () => {
  if (process.env.NODE_ENV === "test") return;
  if (fs.existsSync(quitMarker)) return;
  try { cp.execFileSync("/usr/bin/pgrep", ["-x", EXEC], { stdio: "ignore" }); }
  catch {
    try { cp.execFileSync("/usr/bin/open", ["-g", "-b", BUNDLE_ID], { stdio: "ignore" }); } catch {}
  }
};

const debug = (message) => {
  if (process.env.CLAUDE_STATUSBAR_DEBUG !== "1") return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hooks.log"),
      `${new Date().toISOString()} [${provider}:${event}] ${message}\n`);
  } catch {}
};

let raw = "", finished = false;
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", run);
process.stdin.on("error", run);
const stdinFallback = setTimeout(run, 1000);

function run() {
  if (finished) return;
  finished = true;
  clearTimeout(stdinFallback);
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}

  if (provider !== "codex" && provider !== "antigravity") {
    process.stdout.write("{}\n");
    return;
  }

  const sourceId = provider === "codex" ? input.session_id : input.conversationId;
  const prefix = provider === "codex" ? "codex-" : "agy-";
  const id = prefix + safePart(sourceId);
  const statePath = path.join(stateDir, id + ".json");
  const existed = fs.existsSync(statePath);
  const previous = readJSON(statePath);

  if (event === "end") {
    try { fs.rmSync(statePath, { force: true }); } catch {}
    process.stdout.write("{}\n");
    return;
  }

  const cwd = provider === "codex"
    ? (input.cwd || previous.cwd || "")
    : ((input.workspacePaths || [])[0] || previous.cwd || "");
  const ts = Math.floor(Date.now() / 1000);
  let state = previous.state || "idle";
  let label = previous.label || "";
  let tool = "";
  let started = event !== "start";
  let startedAt = previous.startedAt || 0;

  switch (event) {
    case "start":
      state = "idle"; label = ""; started = false; startedAt = 0; break;
    case "prompt":
    case "preinvoke":
      state = "thinking"; label = "Thinking…";
      if (!startedAt || previous.state === "done" || previous.state === "idle") startedAt = ts;
      break;
    case "pre": {
      tool = input.tool_name || "";
      state = "tool"; label = TOOL_LABELS[tool] || (tool.startsWith("mcp__") ? "Using MCP" : "Using tool");
      if (!startedAt) startedAt = ts;
      break;
    }
    case "permreq":
      tool = input.tool_name || "";
      state = "permission"; label = "Awaiting permission";
      break;
    case "post":
    case "posttool":
      tool = provider === "codex" ? (input.tool_name || "") : (input.toolCall?.name || "");
      state = "thinking"; label = "Thinking…";
      if (!startedAt) startedAt = ts;
      break;
    case "stop":
      state = "done"; label = "Done"; startedAt = 0; break;
    case "interrupt":
      state = "idle"; label = ""; startedAt = 0; break;
    default:
      process.stdout.write("{}\n");
      return;
  }

  // A newly observed conversation is the closest Antigravity equivalent to SessionStart.
  if (event === "start" || (!existed && event === "preinvoke")) {
    try { fs.rmSync(quitMarker, { force: true }); } catch {}
  }

  const out = {
    state, label, tool,
    project: cwd ? path.basename(cwd) : previous.project || "",
    cwd,
    sessionId: sourceId || "",
    transcript: provider === "codex"
      ? (input.transcript_path || previous.transcript || "")
      : (input.transcriptPath || previous.transcript || ""),
    entrypoint: provider,
    term_program: process.env.TERM_PROGRAM || previous.term_program || "",
    account: "",
    agent: provider,
    pid: ownerPid(),
    started,
    startedAt,
    ts,
  };

  try { writeAtomic(statePath, out); } catch {}
  debug(`write ${id} state=${state} tool=${tool || "-"}`);
  relaunchIfNeeded();

  // Both hook systems accept an empty JSON object as a successful, non-steering result. In
  // particular, never emit an Antigravity PreToolUse decision from this observer.
  process.stdout.write("{}\n");
}

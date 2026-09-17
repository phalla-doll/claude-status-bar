// opencode plugin: mirrors hooks/update.js + lifecycle.js for opencode sessions.
// Installed by install.js as claude-statusbar.js in opencode's global plugin dir (a copy, not
// a symlink — ensureHooksInstalled() re-copies it on every app version bump). opencode scans
// both ~/.config/opencode/plugin/ and .../plugins/; the installer picks whichever already
// exists so we can't end up in both and get loaded twice.
//
// Unlike the Claude Code hooks this is NOT a per-event process: opencode loads plugins
// in-process (Bun) and keeps them for the life of the `opencode` process, so:
//   - `process.pid` IS the session's process — no ppid indirection (verified on 1.18.29).
//   - the runtime is Bun, not node: no PATH juggling, no locateNode(), no dependencies.
//     `@opencode-ai/plugin` is types-only, so this file imports nothing but node builtins.
//   - one process hosts MANY sessions, so several state files share one pid. The app's
//     kill(pid,0) reap still works: the whole instance's sessions leave together.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";

// Always the real ~/.claude/statusbar hub — the app reads exactly one directory, so opencode
// sessions land beside Claude Code's and aggregate into the same dropdown.
const dir = path.join(os.homedir(), ".claude", "statusbar");
const stateDir = path.join(dir, "state.d");
const quitMarker = path.join(dir, "quit-intent");
const BUNDLE_ID = "com.local.claudestatusbar";
const EXEC = "ClaudeStatusBar";

// opencode's built-in tool ids are lowercase and differ from Claude Code's, so this is a
// second table rather than a change to update.js's.
const TOOL_LABELS = {
  bash: "Running command", edit: "Editing", write: "Writing", patch: "Editing",
  apply_patch: "Editing", read: "Reading", grep: "Searching", glob: "Searching",
  list: "Searching", webfetch: "Browsing web", websearch: "Searching web",
  task: "Delegating", todowrite: "Planning", todoread: "Planning",
  skill: "Loading skill", lsp: "Inspecting code",
};

// `question` blocks on the user exactly like a permission prompt, so it gets the permission
// STATE (amber dot, top of the priority order) rather than a tool label that would claim the
// session is blocked while the crab animates as busy. It self-clears: tool.execute.after fires
// once the user answers.
const BLOCKING_TOOLS = new Set(["question"]);

// opencode session ids are already filesystem-safe, but they share a directory with Claude
// Code's UUIDs — the "oc-" prefix keeps the two namespaces from ever colliding.
const safeId = (s) => "oc-" + String(s || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);

const debug = (...parts) => {
  if (process.env.CLAUDE_STATUSBAR_DEBUG !== "1") return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hooks.log"),
      `${new Date().toISOString()} [opencode] ${parts.join(" ")}\n`);
  } catch {}
};

export const ClaudeStatusBar = async ({ directory, worktree }) => {
  const cwd = directory || worktree || process.cwd();
  const project = cwd ? path.basename(cwd) : "";
  // TERM_PROGRAM is inherited from the terminal that launched `opencode`; the app uses it to
  // bring that terminal forward on a row click. Absent under `opencode serve`, which is
  // headless — the row then simply isn't clickable, same as an unknown Claude Code surface.
  const termProgram = process.env.TERM_PROGRAM || "";
  const prev = new Map();   // sessionID -> last written payload (we are the only writer here)

  const statePathFor = (sid) => path.join(stateDir, safeId(sid) + ".json");

  // opencode is far chattier than Claude Code's hooks: one short turn emits ~10 status/idle
  // events, and session.status(idle) + session.idle both mean "done". Re-writing the file for
  // each would burn a rename + a pgrep every time, so an unchanged row is skipped. The file is
  // still refreshed every REFRESH_AFTER seconds, because the app's age cap and "hide idle after"
  // both key off `ts` — a long turn must not look stale.
  const REFRESH_AFTER = 30;

  const write = (sid, state, label, { tool = "", startedAt } = {}) => {
    if (!sid) return;
    const p = prev.get(sid) || {};
    const ts = Math.floor(Date.now() / 1000);
    if (p.state === state && p.label === label && p.tool === tool && ts - (p.ts || 0) < REFRESH_AFTER
        && (startedAt === undefined || startedAt === p.startedAt)) return;
    const out = {
      state, label, tool, project, cwd,
      sessionId: sid,
      // No transcript: opencode keeps history in its own DB, not a JSONL file. Leaving this
      // empty is load-bearing — it makes the app skip the "interrupted by user" recovery net,
      // which is Claude Code transcript-specific. The age cap still applies.
      transcript: "",
      entrypoint: "opencode",
      term_program: termProgram,
      account: "",
      agent: "opencode",
      pid: process.pid,
      // Always true: we only ever write a file once a session does real work (see the event
      // handlers below), so a merely-opened or restored-from-history session never appears.
      started: true,
      startedAt: startedAt === undefined ? (p.startedAt || 0) : startedAt,
      ts,
    };
    prev.set(sid, out);
    debug(`write ${safeId(sid)} state=${state} tool=${tool || "-"}`);
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = statePathFor(sid) + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, statePathFor(sid));   // atomic: the app never reads a torn file
    } catch {}
    relaunchIfNeeded();
  };

  const drop = (sid) => {
    if (!sid) return;
    debug(`drop ${safeId(sid)}`);
    prev.delete(sid);
    try { fs.rmSync(statePathFor(sid), { force: true }); } catch {}
  };

  // Launch/self-heal, same contract as update.js: a live session with no app to show it opens
  // the app, unless the user explicitly quit from the menu.
  //
  // Both calls are synchronous. update.js can spawn a detached child because it is a throwaway
  // per-event process; this plugin lives inside `opencode` itself, where a lingering child would
  // hold Bun's event loop open and keep a one-shot `opencode run` from exiting. `open -g -b`
  // only asks LaunchServices to start the app and returns immediately, so blocking costs nothing
  // and leaves nothing behind.
  //
  // Throttled: worst case this is two subprocesses, and whether the app is up does not change
  // between events milliseconds apart.
  let lastRelaunchCheck = 0;
  const RELAUNCH_CHECK_EVERY = 5000;
  const relaunchIfNeeded = () => {
    const now = Date.now();
    if (now - lastRelaunchCheck < RELAUNCH_CHECK_EVERY) return;
    lastRelaunchCheck = now;
    try {
      if (fs.existsSync(quitMarker)) return;
      cp.execSync(`pgrep -x ${EXEC}`, { stdio: "ignore" });
    } catch {
      try { cp.execFileSync("open", ["-g", "-b", BUNDLE_ID], { stdio: "ignore" }); } catch {}
    }
  };

  // Deliberately NOT launching the app here. opencode has no SessionStart equivalent, and a
  // launch at plugin init would fire for every `opencode run`, every headless `serve`, and every
  // directory instance — including ones that never do any work. The app is opened lazily by the
  // first real state write instead (write() -> relaunchIfNeeded), which is also the moment there
  // is finally something to show. That state file is then what keeps the app alive, so no
  // "is opencode running?" probe is needed on the Swift side.
  try { fs.rmSync(quitMarker, { force: true }); } catch {}   // a fresh start voids a prior Quit
  debug("init pid=" + process.pid, "cwd=" + cwd);

  return {
    event: async ({ event }) => {
      const type = event?.type;
      const props = event?.properties || {};
      const sid = props.sessionID;
      switch (type) {
        // The clearest signal opencode gives, and better than Claude Code's: an explicit
        // busy/idle transition rather than a Stop hook whose absence has to be inferred.
        case "session.status": {
          const kind = props.status?.type;
          if (kind === "busy") {
            const p = prev.get(sid);
            const active = p && (p.state === "thinking" || p.state === "tool");
            write(sid, "thinking", "Thinking…", active ? {} : { startedAt: Math.floor(Date.now() / 1000) });
          } else if (kind === "idle") {
            write(sid, "done", "Done", { startedAt: 0 });
          } else if (kind === "retry") {
            write(sid, "thinking", "Retrying…");
          }
          break;
        }
        case "session.idle":
          write(sid, "done", "Done", { startedAt: 0 });
          break;
        // The Permission payload IS the event's properties here (not nested under a key).
        case "permission.updated":
          write(props.sessionID, "permission", "Awaiting permission", { startedAt: 0 });
          break;
        case "permission.replied":
          write(sid, "thinking", "Thinking…", { startedAt: Math.floor(Date.now() / 1000) });
          break;
        case "session.deleted":
          drop(props.info?.id);
          break;
        // Fired when opencode tears down this directory's instance. The pid reap would catch
        // it anyway on process exit, but this clears the rows immediately.
        case "server.instance.disposed":
          for (const id of Array.from(prev.keys())) drop(id);
          break;
      }
    },

    // The opencode analogue of UserPromptSubmit: fires the moment a prompt is submitted, before
    // session.status goes busy. Anchors the row's elapsed timer to the real turn start.
    "chat.message": async (input) => {
      write(input.sessionID, "thinking", "Thinking…", { startedAt: Math.floor(Date.now() / 1000) });
    },

    "tool.execute.before": async (input) => {
      if (BLOCKING_TOOLS.has(input.tool)) {
        write(input.sessionID, "permission", "Waiting for you", { tool: input.tool, startedAt: 0 });
        return;
      }
      write(input.sessionID, "tool", TOOL_LABELS[input.tool] || "Using tool", { tool: input.tool });
    },

    "tool.execute.after": async (input) => {
      write(input.sessionID, "thinking", "Thinking…", { tool: input.tool });
    },

    // Clean exit: drop this instance's rows rather than leaving them for the pid reap.
    dispose: async () => {
      for (const id of Array.from(prev.keys())) drop(id);
    },
  };
};

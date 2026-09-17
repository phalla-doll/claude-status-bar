const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const adapter = path.resolve(__dirname, "../hooks/agent-update.js");

const invoke = (home, provider, event, payload) => {
  const output = execFileSync(process.execPath, [adapter, provider, event], {
    env: { ...process.env, HOME: home, NODE_ENV: "test", TERM_PROGRAM: "TestTerminal" },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), {});
};

const state = (home, filename) => JSON.parse(fs.readFileSync(
  path.join(home, ".claude", "statusbar", "state.d", filename), "utf8"));

test("Codex lifecycle maps to the shared state contract", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "status adapter codex-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const common = { session_id: "thr_123", cwd: "/work/my-project", transcript_path: "/tmp/rollout.jsonl" };

  invoke(home, "codex", "start", common);
  assert.equal(state(home, "codex-thr_123.json").started, false);

  invoke(home, "codex", "prompt", { ...common, turn_id: "turn_1" });
  const thinking = state(home, "codex-thr_123.json");
  assert.equal(thinking.state, "thinking");
  assert.equal(thinking.agent, "codex");
  assert.equal(thinking.project, "my-project");
  assert.ok(thinking.startedAt > 0);

  invoke(home, "codex", "pre", { ...common, tool_name: "apply_patch" });
  assert.equal(state(home, "codex-thr_123.json").label, "Editing");
  invoke(home, "codex", "permreq", { ...common, tool_name: "Bash" });
  assert.equal(state(home, "codex-thr_123.json").state, "permission");
  invoke(home, "codex", "post", { ...common, tool_name: "Bash" });
  assert.equal(state(home, "codex-thr_123.json").state, "thinking");
  invoke(home, "codex", "interrupt", common);
  assert.equal(state(home, "codex-thr_123.json").state, "idle");
  invoke(home, "codex", "prompt", { ...common, turn_id: "turn_2" });
  invoke(home, "codex", "stop", common);
  assert.equal(state(home, "codex-thr_123.json").state, "done");
  invoke(home, "codex", "end", common);
  assert.equal(fs.existsSync(path.join(home, ".claude", "statusbar", "state.d", "codex-thr_123.json")), false);
});

test("Antigravity lifecycle maps thinking and completion without permission decisions", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "status adapter agy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const common = {
    conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
    workspacePaths: ["/work/space-project"],
    transcriptPath: "/tmp/transcript.jsonl",
  };
  const file = "agy-ec33ebf9-0cba-4100-8142-c61503f6c587.json";

  invoke(home, "antigravity", "preinvoke", common);
  const thinking = state(home, file);
  assert.equal(thinking.state, "thinking");
  assert.equal(thinking.agent, "antigravity");
  assert.equal(thinking.project, "space-project");
  assert.ok(thinking.startedAt > 0);

  invoke(home, "antigravity", "posttool", { ...common, toolCall: { name: "run_command" } });
  assert.equal(state(home, file).state, "thinking");
  invoke(home, "antigravity", "stop", { ...common, terminationReason: "model_stop" });
  assert.equal(state(home, file).state, "done");
});

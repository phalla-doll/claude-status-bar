const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const installerPath = path.resolve(__dirname, "../hooks/install.js");
const uninstallerPath = path.resolve(__dirname, "../hooks/uninstall.js");
const staleNode = "/opt/homebrew/Cellar/node/26.5.0/bin/node";
const nodePathPrefix =
  'PATH="/opt/homebrew/bin:/usr/local/bin${PATH:+:$PATH}" node ';

// The installer honours these, and every one of them can point OUTSIDE the temp HOME the
// tests hand it. Left in place, a test run would rewrite (install) or delete (uninstall) the
// real config they name: CLAUDE_CONFIG_DIR a second Claude account's settings.json,
// XDG_CONFIG_HOME / OPENCODE_CONFIG_DIR the user's actual opencode plugin. Keep them stripped.
const sandboxEnv = () => {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.XDG_CONFIG_HOME;
  delete env.OPENCODE_CONFIG_DIR;
  return env;
};

const runScript = (scriptPath, home, envOverrides = {}) => {
  const script = [
    `require("node:child_process").execSync = () => {};`,
    `Object.defineProperty(process, "execPath", { value: process.env.MOCK_EXEC_PATH });`,
    `require(process.env.SCRIPT_PATH);`,
  ].join("\n");

  execFileSync(process.execPath, ["-e", script], {
    env: {
      ...sandboxEnv(),
      HOME: home,
      SCRIPT_PATH: scriptPath,
      MOCK_EXEC_PATH: staleNode,
      ...envOverrides,
    },
    stdio: "pipe",
  });
};

const runInstaller = (home, envOverrides) => runScript(installerPath, home, envOverrides);
const runUninstaller = (home, envOverrides) => runScript(uninstallerPath, home, envOverrides);

const readSettings = (home) => {
  const settingsPath = path.join(home, ".claude", "settings.json");
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
};

const hookCommands = (settings) => {
  return Object.values(settings.hooks)
    .flat()
    .flatMap((entry) => entry.hooks || [])
    .map((hook) => hook.command || "");
};

const statusBarCommands = (settings) =>
  hookCommands(settings).filter((command) => command.startsWith(nodePathPrefix));

const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const shellDoubleQuote = (value) =>
  value.replace(/["\\`$]/g, (character) => `\\${character}`);

test("installs portable, quoted hook commands and replaces stale hooks", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude $`\"' status bar test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const claudeDir = path.join(home, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const oldScript = path.join(claudeDir, "statusbar", "update.js");
  const unrelatedCommand = "echo keep-me";
  const original = {
    customSetting: true,
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: `${staleNode} ${oldScript} pre` },
            { type: "command", command: unrelatedCommand },
            { type: "prompt" },
          ],
        },
      ],
      Notification: [{ matcher: "empty-entry" }],
    },
  };
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));
  const oldAgentPlist = path.join(
    home,
    "Library",
    "LaunchAgents",
    "com.local.claudestatusbar.watcher.plist",
  );
  fs.mkdirSync(path.dirname(oldAgentPlist), { recursive: true });
  fs.writeFileSync(oldAgentPlist, "obsolete");

  runInstaller(home);

  const settings = readSettings(home);
  const allCommands = hookCommands(settings);
  const commands = statusBarCommands(settings);
  const updatePath = path.join(claudeDir, "statusbar", "update.js");
  const lifecyclePath = path.join(claudeDir, "statusbar", "lifecycle.js");

  assert.equal(settings.customSetting, true);
  assert.equal(fs.existsSync(oldAgentPlist), false);
  assert.equal(commands.length, 8);
  assert.ok(commands.every((command) => command.startsWith(nodePathPrefix)));
  assert.ok(allCommands.every((command) => !command.includes(staleNode)));
  assert.ok(allCommands.every((command) => !command.includes(process.execPath)));
  assert.ok(commands.includes(`${nodePathPrefix}${shellQuote(updatePath)} pre`));
  assert.ok(commands.includes(`${nodePathPrefix}${shellQuote(lifecyclePath)} start`));

  const lifecycleEnd = commands.find((command) => command.endsWith(" end"));
  const fixtureBin = path.join(home, "minimal-bin");
  fs.mkdirSync(fixtureBin);
  fs.symlinkSync(process.execPath, path.join(fixtureBin, "node"));
  const statePath = path.join(
    claudeDir,
    "statusbar",
    "state.d",
    "quoted-path-test.json",
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "{}");
  const fixtureCommand = lifecycleEnd.replace(
    "/opt/homebrew/bin:/usr/local/bin",
    shellDoubleQuote(fixtureBin),
  );
  const noNodeEnvironment = {
    ...sandboxEnv(),
    HOME: home,
    PATH: "",
  };
  assert.throws(() => {
    execFileSync("/bin/sh", ["-c", "command -v node"], {
      env: noNodeEnvironment,
      stdio: "pipe",
    });
  });
  execFileSync("/bin/sh", ["-c", fixtureCommand], {
    env: noNodeEnvironment,
    input: JSON.stringify({ session_id: "quoted-path-test" }),
    stdio: "pipe",
  });
  assert.equal(fs.existsSync(statePath), false);

  assert.equal(allCommands.filter((command) => command === unrelatedCommand).length, 1);
  assert.equal(
    settings.hooks.PreToolUse.flatMap((entry) => entry.hooks).filter(
      (hook) => hook.type === "prompt",
    ).length,
    1,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${settingsPath}.bak-statusbar`, "utf8")),
    original,
  );

  const firstInstall = settings;
  runInstaller(home);
  assert.deepEqual(readSettings(home), firstInstall);

  runUninstaller(home);
  const uninstalled = readSettings(home);
  assert.equal(statusBarCommands(uninstalled).length, 0);
  assert.equal(uninstalled.customSetting, true);
  assert.equal(
    uninstalled.hooks.PreToolUse.flatMap((entry) => entry.hooks).filter(
      (hook) => hook.command === unrelatedCommand,
    ).length,
    1,
  );
});

test("reinstalling is idempotent", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  runInstaller(home);
  const first = readSettings(home);
  runInstaller(home);
  const second = readSettings(home);

  assert.deepEqual(second, first);
  assert.equal(statusBarCommands(second).length, 8);
});

test("an empty inherited PATH never searches the working directory", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar security test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  runInstaller(home);
  const lifecycleEnd = hookCommands(readSettings(home)).find(
    (command) => command.includes("lifecycle.js") && command.endsWith(" end"),
  );
  const hostileCwd = path.join(home, "hostile-project");
  const canaryPath = path.join(home, "cwd-node-ran");
  fs.mkdirSync(hostileCwd);
  fs.writeFileSync(
    path.join(hostileCwd, "node"),
    `#!/bin/sh\n: > ${shellQuote(canaryPath)}\nexit 0\n`,
  );
  fs.chmodSync(path.join(hostileCwd, "node"), 0o755);

  const missingFallbacks = [
    path.join(home, "missing-homebrew-bin"),
    path.join(home, "missing-local-bin"),
  ].join(":");
  const isolatedCommand = lifecycleEnd.replace(
    "/opt/homebrew/bin:/usr/local/bin",
    shellDoubleQuote(missingFallbacks),
  );

  assert.throws(
    () => {
      execFileSync("/bin/sh", ["-c", isolatedCommand], {
        cwd: hostileCwd,
        env: {
          ...sandboxEnv(),
          HOME: home,
          PATH: "",
        },
        input: JSON.stringify({ session_id: "security-test" }),
        stdio: "pipe",
      });
    },
    (error) => error.status === 127,
  );
  assert.equal(fs.existsSync(canaryPath), false);
});

test("installs and removes the opencode plugin without touching other plugins", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar opencode test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // A plugin dir the user already has, holding someone else's plugin: the installer must land
  // in THIS dir (not create a second one opencode would also scan) and leave the neighbour be.
  const pluginDir = path.join(home, ".config", "opencode", "plugins");
  fs.mkdirSync(pluginDir, { recursive: true });
  const neighbour = path.join(pluginDir, "someone-elses.js");
  fs.writeFileSync(neighbour, "export const Other = async () => ({});\n");

  runInstaller(home);

  const installed = path.join(pluginDir, "claude-statusbar.js");
  assert.ok(fs.existsSync(installed), "opencode plugin installed into the existing plugins/ dir");
  assert.ok(!fs.existsSync(path.join(home, ".config", "opencode", "plugin")),
    "no second plugin dir created — opencode scans both and would load us twice");
  assert.strictEqual(
    fs.readFileSync(installed, "utf8"),
    fs.readFileSync(path.resolve(__dirname, "../hooks/opencode-plugin.js"), "utf8"),
    "installed plugin is a verbatim copy, so a version bump ships changes");

  runUninstaller(home);

  assert.ok(!fs.existsSync(installed), "opencode plugin removed");
  assert.ok(fs.existsSync(neighbour), "unrelated plugin left alone");
});

test("installs and removes Codex hooks without touching existing hooks", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar codex test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexDir = path.join(home, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const original = {
    description: "keep me",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo codex-neighbour" }] }],
    },
  };
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(original, null, 2));

  runInstaller(home);
  const installed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const commands = hookCommands(installed);
  const ours = commands.filter((command) => command.includes("agent-update.js") && command.includes(" codex "));
  assert.equal(installed.description, "keep me");
  assert.equal(ours.length, 8);
  assert.equal(commands.filter((command) => command === "echo codex-neighbour").length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksPath + ".bak-statusbar", "utf8")), original);

  runInstaller(home);
  assert.equal(hookCommands(JSON.parse(fs.readFileSync(hooksPath, "utf8")))
    .filter((command) => command.includes("agent-update.js") && command.includes(" codex ")).length, 8);

  runUninstaller(home);
  const uninstalled = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.equal(hookCommands(uninstalled).filter((command) => command.includes("agent-update.js")).length, 0);
  assert.equal(hookCommands(uninstalled).filter((command) => command === "echo codex-neighbour").length, 1);
});

test("honours a custom CODEX_HOME without touching the default Codex config", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar custom codex-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const custom = path.join(home, "custom codex home");
  fs.mkdirSync(custom, { recursive: true });

  runInstaller(home, { CODEX_HOME: custom });
  const hooksPath = path.join(custom, "hooks.json");
  assert.ok(fs.existsSync(hooksPath));
  assert.equal(fs.existsSync(path.join(home, ".codex", "hooks.json")), false);
  assert.equal(hookCommands(JSON.parse(fs.readFileSync(hooksPath, "utf8")))
    .filter((command) => command.includes(" agent-update.js") || command.includes("agent-update.js")).length, 8);

  runUninstaller(home, { CODEX_HOME: custom });
  assert.equal(hookCommands(JSON.parse(fs.readFileSync(hooksPath, "utf8")))
    .filter((command) => command.includes("agent-update.js")).length, 0);
});

test("installs a safe Antigravity observer namespace and removes only that namespace", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude status bar agy test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agyDir = path.join(home, ".gemini", "antigravity-cli");
  const hooksPath = path.join(home, ".gemini", "config", "hooks.json");
  fs.mkdirSync(agyDir, { recursive: true });
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const neighbour = { enabled: true, Stop: [{ command: "echo agy-neighbour" }] };
  fs.writeFileSync(hooksPath, JSON.stringify({ neighbour }, null, 2));

  runInstaller(home);
  const installed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const ours = installed["claude-statusbar"];
  assert.deepEqual(installed.neighbour, neighbour);
  assert.ok(ours);
  assert.equal(ours.PreToolUse, undefined, "observer must never make Antigravity permission decisions");
  assert.equal(ours.PreInvocation.length, 1);
  assert.equal(ours.PostToolUse.length, 1);
  assert.equal(ours.Stop.length, 1);

  runUninstaller(home);
  const uninstalled = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.equal(uninstalled["claude-statusbar"], undefined);
  assert.deepEqual(uninstalled.neighbour, neighbour);
});

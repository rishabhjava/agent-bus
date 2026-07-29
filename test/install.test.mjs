import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "cli.mjs");

const STUB = `#!/bin/sh
name=$(basename "$0")
marker="$STUB_STATE/$name-registered"
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  [ -f "$marker" ] && exit 0 || exit 1
fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  echo "$@" >> "$STUB_STATE/$name-add.log"
  touch "$marker"
  exit 0
fi
exit 0
`;

function setup({ stubs = true, cursor = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-test-"));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  if (cursor) fs.mkdirSync(path.join(home, ".cursor"));
  if (stubs) {
    for (const name of ["claude", "codex"]) {
      const p = path.join(bin, name);
      fs.writeFileSync(p, STUB);
      fs.chmodSync(p, 0o755);
    }
  }
  return { root, home, state, bin };
}

function runInstall(env, ...args) {
  const res = spawnSync(process.execPath, [CLI, "install", ...args], {
    env: {
      HOME: env.home,
      STUB_STATE: env.state,
      PATH: [env.bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

function cursorConfig(env) {
  return JSON.parse(fs.readFileSync(path.join(env.home, ".cursor", "mcp.json"), "utf8"));
}

test("fresh home: configures all detected hosts", () => {
  const env = setup();
  const { code, out } = runInstall(env);
  assert.equal(code, 0, out);
  for (const host of ["claude", "codex", "cursor"]) {
    assert.match(out, new RegExp(`${host}\\s+configured `), out);
  }
  const addLog = fs.readFileSync(path.join(env.state, "claude-add.log"), "utf8");
  assert.match(addLog, /mcp add --scope user agent-bus -- node /);
  assert.match(fs.readFileSync(path.join(env.state, "codex-add.log"), "utf8"), /mcp add agent-bus -- node /);
  const cfg = cursorConfig(env);
  assert.equal(cfg.mcpServers["agent-bus"].command, "node");
});

test("idempotent: second run changes nothing", () => {
  const env = setup();
  runInstall(env);
  const { code, out } = runInstall(env);
  assert.equal(code, 0, out);
  assert.equal((out.match(/already configured/g) || []).length, 3, out);
  const addLog = fs.readFileSync(path.join(env.state, "claude-add.log"), "utf8");
  assert.equal(addLog.trim().split("\n").length, 1);
  const backups = fs.readdirSync(path.join(env.home, ".cursor")).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 0);
});

test("merge: preserves existing cursor servers and takes a backup", () => {
  const env = setup();
  const cfgPath = path.join(env.home, ".cursor", "mcp.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "foo" } } }));
  const { code } = runInstall(env);
  assert.equal(code, 0);
  const cfg = cursorConfig(env);
  assert.equal(cfg.mcpServers.other.command, "foo");
  assert.ok(cfg.mcpServers["agent-bus"]);
  const backups = fs.readdirSync(path.join(env.home, ".cursor")).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 1);
});

test("malformed cursor config: fails without touching the file", () => {
  const env = setup();
  const cfgPath = path.join(env.home, ".cursor", "mcp.json");
  fs.writeFileSync(cfgPath, "{nope");
  const { code, out } = runInstall(env);
  assert.equal(code, 1, out);
  assert.match(out, /not valid JSON/);
  assert.equal(fs.readFileSync(cfgPath, "utf8"), "{nope");
});

test("no hosts installed: everything skipped, exit 0", () => {
  const env = setup({ stubs: false, cursor: false });
  const { code, out } = runInstall(env);
  assert.equal(code, 0, out);
  assert.equal((out.match(/skipped/g) || []).length, 3, out);
});

test("dry run: reports plan and writes nothing", () => {
  const env = setup();
  const { code, out } = runInstall(env, "--dry-run");
  assert.equal(code, 0, out);
  assert.equal((out.match(/would configure/g) || []).length, 3, out);
  assert.ok(!fs.existsSync(path.join(env.home, ".cursor", "mcp.json")));
  assert.ok(!fs.existsSync(path.join(env.state, "claude-registered")));
});

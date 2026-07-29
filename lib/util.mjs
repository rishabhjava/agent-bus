import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export const HOME = homedir();
export const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
export const CODEX_HOME = path.join(HOME, ".codex");
export const CURSOR_DB = path.join(
  HOME,
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
);
export const BUS_HOME = path.join(HOME, ".agent-bus");

export const AGENTS = ["claude", "codex", "cursor"];

const liveChildren = new Set();
let reaperInstalled = false;
function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = () => {
    for (const c of liveChildren) {
      try {
        c.kill("SIGKILL");
      } catch {}
    }
  };
  process.on("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      reap();
      process.exit();
    });
  }
}

export function runCapture(cmd, args, { cwd, env, timeoutMs = 60_000, input } = {}) {
  return new Promise((resolve) => {
    installReaper();
    const child = spawn(cmd, args, {
      cwd: cwd || HOME,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;
    const done = (result) => {
      liveChildren.delete(child);
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => done({ code: -1, stdout, stderr: String(err), timedOut }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

export async function sqliteJson(dbPath, sql) {
  const uri = `file:${dbPath}?mode=ro&immutable=1`;
  const res = await runCapture("sqlite3", ["-json", uri, sql], { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`sqlite3 failed: ${res.stderr.slice(0, 300)}`);
  const out = res.stdout.trim();
  return out ? JSON.parse(out) : [];
}

export function parseJsonLines(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {}
  }
  return rows;
}

export function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + ` …[truncated, ${s.length} chars total]` : s;
}

export async function runningAgentCommands() {
  const res = await runCapture("ps", ["-axo", "command="], { timeoutMs: 10_000 });
  return res.stdout.split("\n").filter((l) => /claude|codex|cursor/i.test(l));
}

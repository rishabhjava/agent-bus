import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, runCapture } from "./util.mjs";

const CLI_PATH = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "cli.mjs");

function registrationSpec() {
  const p = CLI_PATH.split(path.sep);
  if (p.includes("node_modules") || p.includes("_npx")) {
    return { command: "npx", args: ["-y", "@rjava/agent-bus"] };
  }
  return { command: "node", args: [CLI_PATH] };
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return path.join(dir, name);
    } catch {}
  }
  return null;
}

async function installViaCli(host, bin, addArgs, spec, dryRun) {
  if (!findOnPath(bin)) return { host, status: "skipped", detail: `${bin} CLI not on PATH` };
  const get = await runCapture(bin, ["mcp", "get", "agent-bus"], { timeoutMs: 30_000 });
  if (get.code === 0) return { host, status: "already", detail: "registration present" };
  const args = [...addArgs, "--", spec.command, ...spec.args];
  const shown = `${bin} ${args.join(" ")}`;
  if (dryRun) return { host, status: "would-configure", detail: shown };
  const add = await runCapture(bin, args, { timeoutMs: 30_000 });
  if (add.code === 0) return { host, status: "configured", detail: shown };
  if (/already exists/i.test(add.stderr + add.stdout)) {
    return { host, status: "already", detail: "registration present" };
  }
  return {
    host,
    status: "failed",
    detail: (add.stderr || add.stdout).trim().slice(0, 300) || `exit code ${add.code}`,
  };
}

function installCursor(spec, dryRun) {
  const host = "cursor";
  const cursorDir = path.join(HOME, ".cursor");
  if (!fs.existsSync(cursorDir)) {
    return { host, status: "skipped", detail: `${cursorDir} not found — Cursor not installed or never run` };
  }
  const cfgPath = path.join(cursorDir, "mcp.json");
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch {
      return {
        host,
        status: "failed",
        detail: `${cfgPath} is not valid JSON — fix or remove it (file left untouched)`,
      };
    }
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
      return {
        host,
        status: "failed",
        detail: `${cfgPath} is not a JSON object — fix or remove it (file left untouched)`,
      };
    }
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object" || Array.isArray(cfg.mcpServers)) {
    cfg.mcpServers = {};
  }
  const desired = { command: spec.command, args: spec.args };
  const existing = cfg.mcpServers["agent-bus"];
  if (
    existing &&
    existing.command === desired.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(desired.args)
  ) {
    return { host, status: "already", detail: "registration present" };
  }
  const action = existing ? "update registration in" : "add registration to";
  if (dryRun) return { host, status: "would-configure", detail: `${action} ${cfgPath}` };
  let detail = `${action} ${cfgPath}`;
  if (fs.existsSync(cfgPath)) {
    const bak = `${cfgPath}.bak-${Date.now()}`;
    fs.copyFileSync(cfgPath, bak);
    detail += ` (backup: ${bak})`;
  }
  cfg.mcpServers["agent-bus"] = desired;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return { host, status: "configured", detail };
}

const LABELS = {
  configured: "configured",
  already: "already configured",
  skipped: "skipped",
  "would-configure": "would configure",
  failed: "FAILED",
};

export async function runInstall(args) {
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length) {
    console.error(`agent-bus install: unknown option ${unknown.join(" ")} (supported: --dry-run)`);
    return 2;
  }
  const spec = registrationSpec();
  console.log(
    `agent-bus install${dryRun ? " — dry run, nothing will be modified" : ""}` +
      ` (registering: ${spec.command} ${spec.args.join(" ")})`,
  );
  const results = [
    await installViaCli("claude", "claude", ["mcp", "add", "--scope", "user", "agent-bus"], spec, dryRun),
    await installViaCli("codex", "codex", ["mcp", "add", "agent-bus"], spec, dryRun),
    installCursor(spec, dryRun),
  ];
  for (const r of results) {
    console.log(`  ${r.host.padEnd(7)} ${LABELS[r.status].padEnd(19)} ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) {
    console.error(`\n${failed.length} host(s) failed — see details above; nothing was rolled back.`);
    return 1;
  }
  if (!dryRun && results.some((r) => r.status === "configured")) {
    console.log("\nDone. Open a new session in each configured agent to pick up the tools.");
  }
  return 0;
}

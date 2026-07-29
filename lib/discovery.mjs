import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_PROJECTS,
  CODEX_HOME,
  CURSOR_DB,
  parseJsonLines,
  runCapture,
  runningAgentCommands,
  sqliteJson,
} from "./util.mjs";

const LIVE_WINDOW_MS = 5 * 60 * 1000;

function liveness(mtimeMs, attached) {
  if (attached) return "attached";
  return Date.now() - mtimeMs < LIVE_WINDOW_MS ? "recent" : "idle";
}

function claudeSessionFiles() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const files = [];
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const abs = path.join(CLAUDE_PROJECTS, dir);
    let entries;
    try {
      entries = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(abs, f);
      const st = fs.statSync(p);
      files.push({ path: p, sessionId: f.replace(".jsonl", ""), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function claudeHead(file, bytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return parseJsonLines(buf.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

export async function listClaudeSessions(limit, psLines) {
  const out = [];
  for (const f of claudeSessionFiles().slice(0, limit)) {
    let cwd = null;
    let title = null;
    for (const row of claudeHead(f.path)) {
      if (!cwd && row.cwd) cwd = row.cwd;
      if (!title && row.type === "user") {
        const t = textOf(row.message).trim();
        if (t && !t.startsWith("<")) title = t.slice(0, 100);
      }
      if (cwd && title) break;
    }
    const attached = psLines.some((l) => l.includes(f.sessionId));
    out.push({
      agent: "claude",
      session_id: f.sessionId,
      title: title || "(untitled)",
      cwd,
      updated_at: new Date(f.mtimeMs).toISOString(),
      live: liveness(f.mtimeMs, attached),
      path: f.path,
    });
  }
  return out;
}

export function codexRolloutPath(sessionId) {
  const root = path.join(CODEX_HOME, "sessions");
  if (!fs.existsSync(root)) return null;
  const rel = fs
    .readdirSync(root, { recursive: true })
    .find((p) => String(p).endsWith(".jsonl") && String(p).includes(sessionId));
  return rel ? path.join(root, String(rel)) : null;
}

export async function listCodexSessions(limit, psLines) {
  const indexPath = path.join(CODEX_HOME, "session_index.jsonl");
  if (!fs.existsSync(indexPath)) return [];
  const byId = new Map();
  for (const row of parseJsonLines(fs.readFileSync(indexPath, "utf8"))) {
    if (row.id) byId.set(row.id, row);
  }
  const rows = [...byId.values()]
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, limit);
  return rows.map((row) => {
    const p = codexRolloutPath(row.id);
    const mtimeMs = p ? fs.statSync(p).mtimeMs : Date.parse(row.updated_at) || 0;
    return {
      agent: "codex",
      session_id: row.id,
      title: row.thread_name || "(untitled)",
      cwd: null,
      updated_at: row.updated_at,
      live: liveness(mtimeMs, psLines.some((l) => l.includes(row.id))),
      path: p,
    };
  });
}

export async function listCursorSessions(limit) {
  if (!fs.existsSync(CURSOR_DB)) return [];
  const rows = await sqliteJson(
    CURSOR_DB,
    `SELECT key,
            json_extract(value,'$.name') AS name,
            json_extract(value,'$.createdAt') AS createdAt,
            json_extract(value,'$.lastUpdatedAt') AS lastUpdatedAt
       FROM cursorDiskKV WHERE key LIKE 'composerData:%'
       ORDER BY COALESCE(lastUpdatedAt, createdAt) DESC LIMIT ${Number(limit)}`,
  );
  return rows.map((r) => {
    const ts = r.lastUpdatedAt || r.createdAt;
    return {
      agent: "cursor",
      session_id: r.key.replace("composerData:", ""),
      title: r.name || "(untitled)",
      cwd: null,
      updated_at: ts ? new Date(ts).toISOString() : null,
      live: ts ? liveness(ts, false) : "idle",
      path: CURSOR_DB,
    };
  });
}

export async function listSessions({ agent, live_only = false, limit = 30 } = {}) {
  const psLines = await runningAgentCommands();
  const wanted = agent ? [agent] : ["claude", "codex", "cursor"];
  const chunks = await Promise.all(
    wanted.map((a) => {
      if (a === "claude") return listClaudeSessions(limit, psLines);
      if (a === "codex") return listCodexSessions(limit, psLines);
      return listCursorSessions(limit);
    }),
  );
  let all = chunks
    .flat()
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (live_only) all = all.filter((s) => s.live !== "idle");
  return all.slice(0, limit);
}

export async function searchSessions({ query, agent, limit = 20 }) {
  const results = [];
  const wanted = agent ? [agent] : ["claude", "codex", "cursor"];

  for (const a of wanted) {
    if (a === "claude" || a === "codex") {
      const dir = a === "claude" ? CLAUDE_PROJECTS : path.join(CODEX_HOME, "sessions");
      if (!fs.existsSync(dir)) continue;
      const res = await runCapture("grep", ["-rlF", "--include=*.jsonl", query, dir], {
        timeoutMs: 30_000,
      });
      for (const p of res.stdout.split("\n").filter(Boolean).slice(0, limit)) {
        const base = path.basename(p, ".jsonl");
        const id = a === "codex" ? base.replace(/^rollout-[\dT-]+-/, "") : base;
        results.push({ agent: a, session_id: id, path: p });
      }
    } else if (a === "cursor" && fs.existsSync(CURSOR_DB)) {
      const q = query.replace(/'/g, "''");
      const rows = await sqliteJson(
        CURSOR_DB,
        `SELECT DISTINCT substr(key, 10, 36) AS cid FROM cursorDiskKV
          WHERE key LIKE 'bubbleId:%' AND value LIKE '%${q}%' LIMIT ${Number(limit)}`,
      );
      for (const r of rows) results.push({ agent: "cursor", session_id: r.cid, path: CURSOR_DB });
    }
  }
  return results.slice(0, limit);
}

export { textOf };

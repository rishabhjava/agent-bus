import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS, CURSOR_DB, parseJsonLines, sqliteJson, truncate } from "./util.mjs";
import { codexRolloutPath, textOf } from "./discovery.mjs";

const MAX_READ_BYTES = 20 * 1024 * 1024;

function readTailOfFile(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - MAX_READ_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function findClaudeSessionFile(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const p = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readClaude(sessionId) {
  const file = findClaudeSessionFile(sessionId);
  if (!file) throw new Error(`claude session ${sessionId} not found`);
  const rows = parseJsonLines(readTailOfFile(file));
  let cwd = null;
  const messages = [];
  for (const row of rows) {
    if (!cwd && row.cwd) cwd = row.cwd;
    if (row.type !== "user" && row.type !== "assistant") continue;
    const text = textOf(row.message).trim();
    if (!text) continue;
    messages.push({ role: row.type, text, at: row.timestamp || null });
  }
  return { cwd, messages };
}

function readCodex(sessionId) {
  const file = codexRolloutPath(sessionId);
  if (!file) throw new Error(`codex session ${sessionId} not found`);
  const rows = parseJsonLines(readTailOfFile(file));
  let cwd = null;
  const messages = [];
  for (const row of rows) {
    const p = row.payload || {};
    if (row.type === "session_meta" && p.cwd) cwd = p.cwd;
    if (p.type === "message" && Array.isArray(p.content)) {
      const text = p.content
        .filter((b) => typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) messages.push({ role: p.role || "unknown", text, at: row.timestamp || null });
    }
  }
  return { cwd, messages };
}

async function readCursor(sessionId) {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error("invalid cursor session id");
  const meta = await sqliteJson(
    CURSOR_DB,
    `SELECT value FROM cursorDiskKV WHERE key = 'composerData:${sessionId}'`,
  );
  if (!meta.length) throw new Error(`cursor session ${sessionId} not found`);
  const blob = JSON.parse(meta[0].value);
  const headers = blob.fullConversationHeadersOnly || [];
  const bubbles = await sqliteJson(
    CURSOR_DB,
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${sessionId}:%'`,
  );
  const byId = new Map(bubbles.map((b) => [b.key.split(":")[2], b.value]));
  const messages = [];
  for (const h of headers) {
    const raw = byId.get(h.bubbleId);
    if (!raw) continue;
    let bubble;
    try {
      bubble = JSON.parse(raw);
    } catch {
      continue;
    }
    const text = (bubble.text || "").trim();
    if (!text) continue;
    messages.push({ role: bubble.type === 1 ? "user" : "assistant", text, at: null });
  }
  return { cwd: null, messages, title: blob.name || null };
}

export async function readSession({ agent, session_id, tail = 20, max_chars = 2000 }) {
  let data;
  if (agent === "claude") data = readClaude(session_id);
  else if (agent === "codex") data = readCodex(session_id);
  else if (agent === "cursor") data = await readCursor(session_id);
  else throw new Error(`unknown agent: ${agent}`);

  const total = data.messages.length;
  const messages = data.messages
    .slice(-tail)
    .map((m) => ({ ...m, text: truncate(m.text, max_chars) }));
  return { agent, session_id, cwd: data.cwd, title: data.title, total_messages: total, messages };
}

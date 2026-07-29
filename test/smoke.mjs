import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const only = process.argv[2];

const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({ command: "node", args: [path.join(root, "server.mjs")] }),
);

async function call(name, args) {
  process.stdout.write(`\n=== ${name} ${JSON.stringify(args)} ===\n`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  process.stdout.write((res.isError ? "ERROR: " : "") + text.slice(0, 2500) + "\n");
  return res.isError ? null : JSON.parse(text);
}

const tools = await client.listTools();
process.stdout.write("tools: " + tools.tools.map((t) => t.name).join(", ") + "\n");

if (!only || only === "list") {
  const sessions = await call("list_sessions", { limit: 9 });
  if (!only) {
    const claude = sessions?.find((s) => s.agent === "claude");
    const codex = sessions?.find((s) => s.agent === "codex");
    const cursor = sessions?.find((s) => s.agent === "cursor");
    if (claude) await call("read_session", { agent: "claude", session_id: claude.session_id, tail: 2, max_chars: 300 });
    if (codex) await call("read_session", { agent: "codex", session_id: codex.session_id, tail: 2, max_chars: 300 });
    if (cursor) await call("read_session", { agent: "cursor", session_id: cursor.session_id, tail: 2, max_chars: 300 });
  }
}

if (only === "search") {
  await call("search_sessions", { query: process.argv[3] || "agent-bus", limit: 5 });
}

if (only === "handoff") {
  await call("handoff_session", {
    from_agent: process.argv[3] || "claude",
    session_id: process.argv[4],
    to_agent: process.argv[5] || "codex",
    tail: 6,
  });
}

if (only === "ask") {
  await call("ask_agent", {
    agent: process.argv[3] || "claude",
    prompt: "Reply with exactly: BUS OK",
    model: process.argv[3] === "codex" ? undefined : "haiku",
    from: "agent-bus smoke test",
    timeout_s: 120,
  });
}

await client.close();

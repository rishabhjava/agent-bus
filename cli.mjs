#!/usr/bin/env node
const [cmd, ...rest] = process.argv.slice(2);

if (!cmd) {
  await import("./server.mjs");
} else if (cmd === "install") {
  const { runInstall } = await import("./lib/install.mjs");
  process.exitCode = await runInstall(rest);
} else {
  console.error(`agent-bus: unknown command '${cmd}'`);
  console.error("usage: agent-bus              start the stdio MCP server");
  console.error("       agent-bus install      register with Claude Code, Codex, and Cursor");
  console.error("       agent-bus install --dry-run   preview without changing anything");
  process.exit(2);
}

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listSessions, searchSessions } from "./lib/discovery.mjs";
import { readSession } from "./lib/transcript.mjs";
import { askAgent, currentDepth, MAX_DEPTH } from "./lib/ask.mjs";
import { handoffSession } from "./lib/handoff.mjs";

import fs from "node:fs";
import path from "node:path";
import { BUS_HOME } from "./lib/util.mjs";

const server = new McpServer(
  { name: "agent-bus", version: "0.1.0" },
  {
    instructions:
      "agent-bus connects the coding agents installed on this machine (Claude Code, Codex, Cursor) so they can see and talk to each other. " +
      "When the user asks what (other) agents or sessions are running, active, or working on this machine — or what another agent is doing or concluded — they mean these tools, not your own sub-agents: call list_sessions (or read_session / search_sessions). " +
      "Use ask_agent to relay a question to another agent and get its answer, and handoff_session to move this or another session's work to a different agent.",
  },
);

const agentEnum = z.enum(["claude", "codex", "cursor"]);

fs.mkdirSync(BUS_HOME, { recursive: true });
const logFile = path.join(BUS_HOME, "bus.log");
function log(msg) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}
process.on("uncaughtException", (e) => log(`uncaughtException: ${e.stack || e}`));
process.on("unhandledRejection", (e) => log(`unhandledRejection: ${e?.stack || e}`));
process.on("exit", (code) => log(`exit ${code}`));

function jsonTool(name, fn) {
  return async (args) => {
    log(`call ${name} ${JSON.stringify(args ?? {})}`);
    try {
      const result = await fn(args ?? {});
      log(`done ${name}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      log(`error ${name}: ${err.stack || err.message}`);
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  };
}

server.registerTool(
  "list_sessions",
  {
    description:
      "List coding-agent sessions on this machine across Claude Code, Codex, and Cursor. " +
      "live: 'attached' (a running process references this session), 'recent' (updated <5 min ago), or 'idle'.",
    inputSchema: {
      agent: agentEnum.optional().describe("Filter to one agent"),
      live_only: z.boolean().optional().describe("Only sessions that look active"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 30)"),
    },
  },
  jsonTool("listSessions", listSessions),
);

server.registerTool(
  "search_sessions",
  {
    description: "Full-text search across all agents' session transcripts. Returns matching session ids.",
    inputSchema: {
      query: z.string().min(2).describe("Literal text to search for"),
      agent: agentEnum.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  jsonTool("searchSessions", searchSessions),
);

server.registerTool(
  "read_session",
  {
    description: "Read a normalized transcript (user/assistant messages) of any agent's session.",
    inputSchema: {
      agent: agentEnum,
      session_id: z.string(),
      tail: z.number().int().min(1).max(200).optional().describe("Last N messages (default 20)"),
      max_chars: z.number().int().min(100).max(20000).optional().describe("Truncate each message (default 2000)"),
    },
  },
  jsonTool("readSession", readSession),
);

server.registerTool(
  "ask_agent",
  {
    description:
      "Ask another local agent a question and get its answer (headless, blocking). " +
      "Pass session_id to ask within an existing thread's context — the answer comes from a snapshot of that thread (for Claude Code, a hidden parallel branch in the same session); a live interactive view of it will not see the exchange. " +
      "Codex runs sandboxed read-only unless allow_writes. Cursor is not askable (no CLI). " +
      `Relay depth is capped at ${MAX_DEPTH} to prevent agent-to-agent loops. ` +
      "Note: the MCP host running THIS tool call may enforce its own tool-call timeout the bus cannot lift; for very long work prefer handoff_session over a long ask.",
    inputSchema: {
      agent: agentEnum,
      prompt: z.string().min(1),
      session_id: z.string().optional().describe("Existing thread to resume for context"),
      cwd: z.string().optional().describe("Working directory for the callee"),
      from: z.string().optional().describe("Who is asking, e.g. 'claude session abc123'"),
      model: z.string().optional().describe("claude only: model override, e.g. 'haiku'"),
      allow_writes: z.boolean().optional().describe("codex only: workspace-write sandbox"),
      timeout_s: z
        .union([z.literal(0), z.number().int().min(30)])
        .optional()
        .describe("Seconds to wait for the callee (default 240). 0 = no bus-side timeout, wait until the callee finishes."),
    },
  },
  jsonTool("askAgent", askAgent),
);

server.registerTool(
  "handoff_session",
  {
    description:
      "Hand a session's context from one agent to another. Builds a markdown brief from the source transcript, " +
      "saves it under ~/.agent-bus/handoffs/, and either returns a ready-to-run launch command (launch=false) " +
      "or seeds a new target session and returns its resume command (launch=true).",
    inputSchema: {
      from_agent: agentEnum,
      session_id: z.string(),
      to_agent: agentEnum,
      instructions: z.string().optional().describe("What the target agent should do next"),
      tail: z.number().int().min(3).max(100).optional().describe("Messages to include (default 25)"),
      launch: z.boolean().optional().describe("Actually seed the target session now"),
      cwd: z.string().optional().describe("Override working directory"),
    },
  },
  jsonTool("handoffSession", handoffSession),
);

console.error(`agent-bus starting (relay depth ${currentDepth()}/${MAX_DEPTH})`);
await server.connect(new StdioServerTransport());

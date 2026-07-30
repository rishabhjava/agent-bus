# agent-bus

**A local communication bus for the coding agents on your machine.**

You probably run more than one coding agent — Claude Code in a terminal, Codex in another, Cursor in a window. Each one is an island: it has no idea the others exist, what they're working on, or what they've already figured out. The vendors are quietly building one-way bridges (Codex imports Claude Code transcripts; Claude Desktop has an internal session bus) — but each wants to *be* the orchestrator, so nobody ships the neutral layer.

agent-bus is that layer: one small MCP server that every agent registers, giving each of them eyes on — and a channel to — all the others. No daemon, no accounts, no cloud. It reads the session stores the agents already write to disk, and relays through the headless CLIs they already ship.

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│ Claude Code │      │    Codex    │      │   Cursor    │
└──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │  MCP (stdio)       │                    │
       └────────────────────┼────────────────────┘
                     ┌──────┴──────┐
                     │  agent-bus  │
                     └──────┬──────┘
          ┌─────────────────┼──────────────────┐
     session stores    headless CLIs      handoff briefs
     (~/.claude, …)   (claude -p, codex exec)  (~/.agent-bus)
```

## What each agent gains

| Tool | What it does |
|---|---|
| `list_sessions` | Every session across every agent, newest first, with liveness (`attached` / `recent` / `idle`) |
| `search_sessions` | Full-text search across all agents' transcripts |
| `read_session` | Normalized user/assistant transcript of any session, from any agent |
| `ask_agent` | Ask another agent a question, headless and blocking, and get its answer — optionally *within an existing thread's context* |
| `handoff_session` | Package a session into a markdown brief and hand it to another agent — either as a ready-to-run command, or by seeding a live target session that acknowledges and waits for you |

So from inside any agent you can say things like:

- *"What are my other agents working on right now?"*
- *"Ask Codex what it concluded about the flaky auth test."*
- *"Hand this session off to Claude Code and have it pick up where we left off."*

## How it works

**It's an MCP server, not a skill and not a service.** Each agent speaks MCP natively; registering agent-bus adds its five tools to that agent's toolbox. There is nothing to start and nothing running in the background: MCP stdio servers are spawned by the agent as a child process when a session opens, spoken to over stdin/stdout, and killed when the session ends. Concurrent agents each spawn their own instance — shared state is just the files on disk.

- **Discovery** reads the stores each agent already maintains: Claude Code's `~/.claude/projects/**/*.jsonl`, Codex's `~/.codex/sessions` rollouts + `session_index.jsonl`, Cursor's `state.vscdb` SQLite (read-only, immutable mode).
- **Asking** shells out to the callee's own headless mode — `claude -p [--resume <id>]`, `codex exec [resume <id>]` — so answers come from a real session of that agent, resumable later, in its own history.
- **Handoff** distills the source transcript into a brief under `~/.agent-bus/handoffs/`, then either hands you the launch command or seeds the target session for you and returns its resume command.

## Install

Requires Node 18+, macOS (session-store paths are macOS-specific for now), and whichever agents you use on the machine.

One command — detects which hosts are installed, registers the bus with each, merges with any existing MCP config, takes backups before rewriting anything, and is safe to re-run:

```bash
npx -y @rjava/agent-bus install            # registers with Claude Code, Codex, and Cursor
npx -y @rjava/agent-bus install --dry-run  # preview what would change, modify nothing
```

Upgrades are automatic when registered via npx (`npx -y` resolves the latest published version each spawn); re-run `install` only if registration instructions change.

<details>
<summary>Manual registration</summary>

```bash
claude mcp add --scope user agent-bus -- npx -y @rjava/agent-bus
codex mcp add agent-bus -- npx -y @rjava/agent-bus
# Cursor: add to ~/.cursor/mcp.json →  { "mcpServers": { "agent-bus": { "command": "npx", "args": ["-y", "@rjava/agent-bus"] } } }
```

From a clone (for development): `git clone https://github.com/rishabhjava/agent-bus && cd agent-bus && npm install`, then `node cli.mjs install` — it registers the clone's path instead of npx.

</details>

> Codex note: Codex prompts for approval on an MCP server's first tool call ("always allow" persists it). Headless `codex exec` cannot answer that prompt — to use the bus headlessly, set `default_tools_approval_mode = "auto"` under `[mcp_servers.agent-bus]` in `~/.codex/config.toml`.

New sessions of each agent pick the tools up automatically. Smoke-test without any agent:

```bash
npm run smoke                          # list tools, list sessions, read one per agent
node test/smoke.mjs ask claude        # cheap round-trip through claude -p
```

## Safety model

Letting agents talk to each other is letting untrusted inputs talk to each other, so the bus is deliberately paranoid:

- **Provenance headers** — every relayed prompt is prefixed with a notice that it comes from a peer agent, not the human, and should be treated as untrusted input.
- **Loop guard** — a relay-depth counter propagates through the child process tree (`AGENT_BUS_DEPTH`) and hard-refuses at depth 2, so two agents can never recursively prompt each other into a token bonfire.
- **No permission laundering** — the bus never widens the callee's permissions: Codex calls run sandboxed read-only unless explicitly allowed to write, and Claude calls run headless under its default permission mode.

## Caveats

- Prototype, built and verified on one machine in one sitting. Parsers for the vendors' session formats are defensive but the formats are undocumented and will drift.
- `ask_agent` waits `timeout_s` seconds for the callee (default 240; minimum 30; `0` means no bus-side timeout — wait until the callee exits). Two caveats the bus cannot lift: the **host** running the tool call may cancel long MCP calls on its own clock (Claude Code honors `MCP_TOOL_TIMEOUT`; Codex has per-server `tool_timeout_sec` in `~/.codex/config.toml`), and if the bus process dies mid-ask it kills its delegated child processes rather than orphan them — the answer is lost either way. For work longer than a few minutes, `handoff_session` is the durable path.
- Cursor is read-only (discovery + handoff source) until its headless CLI is present.
- Asking a thread that is currently open interactively does **not** inject into the live TTY — the callee answers out-of-band, from a snapshot of that thread's context. With Claude Code, the exchange isn't even a separate session: it lands in the *same* session file as a parallel branch (same session id, different parent chain), which the live view never displays. Observed in practice when a Codex session used `ask_agent` on the live Claude Code session that was building this project — the answer was correct, and the live session only learned about the exchange by reading its own transcript off disk. True live injection needs harness cooperation; that's the interesting next problem.

## License

MIT

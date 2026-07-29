# Contributing

- `npm install` — also wires up the repo's git hooks (`.githooks/`).
- Commits follow [conventional commits](https://www.conventionalcommits.org): `type(scope): subject`, enforced by the commit-msg hook. Types: `feat fix docs chore refactor test perf ci build`.
- Before pushing: `npm run check` (syntax) and `npm run smoke` (spawns the MCP server and exercises every read path against whatever agents exist on your machine — on a machine with no agents it should still list tools and return empty session lists).
- `ask_agent` / `handoff_session` paths shell out to real agent CLIs and cost tokens; test those manually with `node test/smoke.mjs ask claude`.
- Session-store formats (Claude Code jsonl, Codex rollouts, Cursor sqlite) are undocumented vendor internals — parsers must fail soft (return less data, never crash the server).

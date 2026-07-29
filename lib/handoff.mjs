import fs from "node:fs";
import path from "node:path";
import { BUS_HOME, HOME, truncate } from "./util.mjs";
import { readSession } from "./transcript.mjs";
import { askAgent } from "./ask.mjs";

function briefMarkdown({ source, instructions }) {
  const lines = [
    `# Agent handoff brief`,
    ``,
    `- From: ${source.agent} session \`${source.session_id}\``,
    `- Working directory: ${source.cwd || "(unknown)"}`,
    `- Generated: ${new Date().toISOString()}`,
    ``,
    `## Conversation excerpt (last ${source.messages.length} of ${source.total_messages} messages)`,
    ``,
  ];
  for (const m of source.messages) {
    lines.push(`**${m.role}:**`, "", truncate(m.text, 1500), "");
  }
  lines.push(`## Handoff instructions`, ``, instructions || `Continue this work where the source agent left off.`);
  return lines.join("\n");
}

export async function handoffSession({
  from_agent,
  session_id,
  to_agent,
  instructions,
  tail = 25,
  launch = false,
  cwd,
}) {
  if (from_agent === to_agent) throw new Error("handoff source and target are the same agent");
  const source = await readSession({ agent: from_agent, session_id, tail, max_chars: 1500 });
  const brief = briefMarkdown({ source, instructions });

  const dir = path.join(BUS_HOME, "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const briefPath = path.join(dir, `${stamp}-${from_agent}-to-${to_agent}.md`);
  fs.writeFileSync(briefPath, brief);

  const workdir = cwd || source.cwd || HOME;
  const result = { brief_path: briefPath, source_cwd: workdir };

  if (to_agent === "cursor") {
    result.next_step = `Cursor has no headless CLI here — open Cursor in ${workdir} and paste the brief (${briefPath}) into a new agent chat.`;
    return result;
  }

  if (!launch) {
    result.next_step =
      to_agent === "claude"
        ? `Run: cd '${workdir}' && claude "$(cat '${briefPath}')"`
        : `Run: cd '${workdir}' && codex "$(cat '${briefPath}')"`;
    return result;
  }

  const ack = await askAgent({
    agent: to_agent,
    cwd: workdir,
    from: `agent-bus handoff from ${from_agent} session ${session_id}`,
    timeout_s: 300,
    prompt: `${brief}\n---\nYou are receiving this handoff. Read the brief, then reply with a one-sentence acknowledgment of the task state. Do not start working yet — a human will continue this session interactively.`,
  });
  result.new_session_id = ack.session_id;
  result.acknowledgment = ack.answer;
  result.next_step =
    to_agent === "claude"
      ? `Run: cd '${workdir}' && claude --resume ${ack.session_id}`
      : `Run: cd '${workdir}' && codex resume ${ack.session_id}`;
  return result;
}

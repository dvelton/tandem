import type { ReviewScale, SessionEvent, SessionState } from "./protocol.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const DEFAULT_CONTEXT_LIMIT = 12_000;
const SUMMARY_HEADER = "Earlier session summary:";

export function buildDesignAlignMessages(state: SessionState): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the navigator in a Tandem pair-programming session.",
        "Before the driver writes any code, you align on the approach together.",
        "Given the task, propose:",
        "1. The high-level approach (data structures, key abstractions, module boundaries)",
        "2. Potential pitfalls to watch out for",
        "3. What the first chunk should cover",
        "Respond with a JSON object: {\"approach\": \"...\", \"considerations\": [\"...\", \"...\"]}",
      ].join("\n"),
    },
    { role: "user", content: `Task: ${state.config.task}` },
  ];
}

export function buildDriverMessages(state: SessionState, taskPrompt: string): ChatMessage[] {
  const contextLimit = state.config.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const baseMessages: ChatMessage[] = [
    { role: "system", content: buildDriverSystemPrompt() },
    { role: "user", content: `Current task:\n${taskPrompt}` },
  ];

  const availableBudget = Math.max(contextLimit - estimateTokens(renderMessages(baseMessages)), Math.floor(contextLimit / 2));
  const { summary, recentEvents } = compressContext(state.events, availableBudget);

  const messages = [...baseMessages];
  if (summary) {
    messages.push({ role: "user", content: `${SUMMARY_HEADER}\n${summary}` });
  }

  messages.push(...recentEvents.map((event) => toTranscriptMessage(event, "driver")));

  if (state.accumulatedCode) {
    const codeTokens = estimateTokens(state.accumulatedCode);
    const remainingBudget = Math.max(contextLimit - estimateTokens(renderMessages(messages)), 0);
    const codeToInclude = codeTokens <= remainingBudget
      ? state.accumulatedCode
      : truncateCode(state.accumulatedCode, remainingBudget);
    if (codeToInclude) {
      messages.push({
        role: "user",
        content: `Current accumulated code:\n\n\`\`\`ts\n${codeToInclude}\n\`\`\``,
      });
    }
  }

  messages.push({
    role: "user",
    content: [
      "Produce the next focused chunk. Include the code first, then the rationale.",
      "When the full implementation is complete and no more chunks are needed, write [SESSION_COMPLETE] at the end of your response.",
    ].join("\n"),
  });

  return messages;
}

export function buildNavigatorMessages(
  state: SessionState,
  chunkToReview: string,
  scale: ReviewScale,
): ChatMessage[] {
  const contextLimit = state.config.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const baseMessages: ChatMessage[] = [{ role: "system", content: buildNavigatorSystemPrompt(scale) }];
  const availableBudget = Math.max(contextLimit - estimateTokens(renderMessages(baseMessages)), Math.floor(contextLimit / 2));
  const { summary, recentEvents } = compressContext(state.events, availableBudget);

  const messages = [...baseMessages];
  if (summary) {
    messages.push({ role: "user", content: `${SUMMARY_HEADER}\n${summary}` });
  }

  messages.push(...recentEvents.map((event) => toTranscriptMessage(event, "navigator")));

  const accumulatedContext =
    scale === "chunk"
      ? ""
      : `\n\nAccumulated code so far:\n\n\`\`\`ts\n${state.accumulatedCode || "// no code accumulated yet"}\n\`\`\``;

  messages.push({
    role: "user",
    content: `Review scale: ${scale}\n\nCode to review:\n\n\`\`\`ts\n${chunkToReview}\n\`\`\`${accumulatedContext}\n\nReturn only a JSON array of findings.`,
  });

  return messages;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function compressContext(
  events: SessionEvent[],
  tokenBudget: number,
): { summary: string; recentEvents: SessionEvent[] } {
  if (events.length === 0 || tokenBudget <= 0) {
    return { summary: "", recentEvents: [] };
  }

  const recentEvents: SessionEvent[] = [];
  let recentTokens = 0;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const eventTokens = estimateTokens(formatEvent(event));
    if (recentEvents.length > 0 && recentTokens + eventTokens > tokenBudget) {
      break;
    }
    recentEvents.unshift(event);
    recentTokens += eventTokens;
    if (recentTokens >= tokenBudget) {
      break;
    }
  }

  const olderEvents = events.slice(0, events.length - recentEvents.length);
  if (olderEvents.length === 0) {
    return { summary: "", recentEvents };
  }

  const summaryLines = olderEvents.map(summarizeEvent);
  let summary = summaryLines.join("\n");
  while (summary && recentTokens + estimateTokens(summary) > tokenBudget && summaryLines.length > 1) {
    summaryLines.shift();
    summary = summaryLines.join("\n");
  }

  if (summary && recentTokens + estimateTokens(summary) > tokenBudget) {
    const maxChars = Math.max((tokenBudget - recentTokens) * 4, 0);
    summary = maxChars > 3 ? `${summary.slice(0, maxChars - 3)}...` : "";
  }

  return { summary, recentEvents };
}

function buildDriverSystemPrompt(): string {
  return [
    "You are the driver model in Tandem.",
    "Write code in focused chunks, one function or type at a time.",
    "Put the code before the explanation so the session can capture the exact artifact.",
    "Explain the design choice behind each chunk in a short rationale.",
    "Incorporate navigator feedback and call out what changed because of it.",
    "When the full implementation is complete and no more chunks are needed, write [SESSION_COMPLETE] at the end of your response.",
  ].join("\n");
}

function buildNavigatorSystemPrompt(scale: ReviewScale): string {
  if (scale === "chunk") {
    return [
      "You are the navigator in a Tandem pair-programming session.",
      "Your job is to STEER, not just review. Think about whether the approach is right, not just whether the code has bugs.",
      "For each chunk the driver produces:",
      "1. Is this heading in the right direction architecturally?",
      "2. What should the driver think about or handle in the NEXT chunk?",
      "3. Are there design decisions being made implicitly that should be explicit?",
      "4. Flag any bugs, but focus on the ones that indicate a wrong approach — not just typos.",
      "Classify each finding as critical (wrong approach/will cascade), major (real bug or design flaw), minor (edge case), or design-note (observation for later).",
      "Only flag critical findings for immediate revision. Everything else is guidance for the next chunk.",
      'Return JSON: [{"severity":"...","description":"...","suggestion":"..."}]',
    ].join("\n");
  }

  return [
    "You are the navigator in a Tandem pair-programming session.",
    `Perform a ${scale}-level review of the accumulated code.`,
    "Look for cross-cutting concerns: are there interaction bugs between components?",
    "Check whether the overall architecture holds together, not just individual functions.",
    "Classify findings by severity. Be specific about triggers.",
    'Return JSON: [{"severity":"...","description":"...","suggestion":"..."}]',
  ].join("\n");
}

function toTranscriptMessage(event: SessionEvent, audience: "driver" | "navigator"): ChatMessage {
  const assistantSource = audience;
  return {
    role: event.source === assistantSource ? "assistant" : "user",
    content: formatEvent(event),
  };
}

function formatEvent(event: SessionEvent): string {
  switch (event.type) {
    case "task-start":
      return [`Task started by ${event.source}: ${event.task}`, formatList("Requirements", event.requirements)].filter(Boolean).join("\n");
    case "chunk":
      return `Driver chunk ${event.chunkId}\nRationale: ${event.rationale}\nCode:\n\`\`\`ts\n${event.code}\n\`\`\``;
    case "review":
      return [
        `Navigator review for ${event.chunkId} (${event.scale})`,
        event.summary ? `Summary: ${event.summary}` : "",
        formatFindings(event.findings),
      ]
        .filter(Boolean)
        .join("\n");
    case "feedback":
      return `Feedback${event.targetChunkId ? ` for ${event.targetChunkId}` : ""}: ${event.guidance}`;
    case "revision":
      return `Revision for ${event.chunkId}\nRationale: ${event.rationale}\nCode:\n\`\`\`ts\n${event.code}\n\`\`\``;
    case "interrupt":
      return `Interrupt from ${event.by}: ${event.reason}`;
    case "handoff":
      return `Handoff from ${event.from} to ${event.to}${event.reason ? `: ${event.reason}` : ""}`;
    case "checkpoint":
      return [
        `Checkpoint summary: ${event.summary}`,
        formatFindings(event.findings),
        `Accumulated code snapshot:\n\`\`\`ts\n${event.accumulatedCode}\n\`\`\``,
      ]
        .filter(Boolean)
        .join("\n");
    case "completion":
      return [
        `Completion summary: ${event.summary}`,
        formatFindings(event.review),
        `Final code:\n\`\`\`ts\n${event.finalCode}\n\`\`\``,
      ]
        .filter(Boolean)
        .join("\n");
    case "human-input":
      return `Human instructions: ${event.instructions}`;
    case "design-align":
      return `Design alignment: ${event.approach}\nConsiderations:\n${event.considerations.map((c) => `- ${c}`).join("\n")}`;
  }
}

function summarizeEvent(event: SessionEvent): string {
  switch (event.type) {
    case "task-start":
      return `- Task: ${event.task}`;
    case "chunk":
      return `- Chunk ${event.chunkId}: ${truncate(event.rationale, 120)}`;
    case "review":
      return `- Review ${event.chunkId}/${event.scale}: ${event.findings.length} finding(s)${event.summary ? ` - ${truncate(event.summary, 120)}` : ""}`;
    case "feedback":
      return `- Feedback${event.targetChunkId ? ` for ${event.targetChunkId}` : ""}: ${truncate(event.guidance, 120)}`;
    case "revision":
      return `- Revision ${event.chunkId}: ${truncate(event.rationale, 120)}`;
    case "interrupt":
      return `- Interrupt by ${event.by}: ${truncate(event.reason, 120)}`;
    case "handoff":
      return `- Handoff ${event.from} -> ${event.to}${event.reason ? `: ${truncate(event.reason, 80)}` : ""}`;
    case "checkpoint":
      return `- Checkpoint: ${truncate(event.summary, 120)}`;
    case "completion":
      return `- Completion: ${truncate(event.summary, 120)}`;
    case "human-input":
      return `- Human input: ${truncate(event.instructions, 120)}`;
    case "design-align":
      return `- Design alignment: ${truncate(event.approach, 120)}`;
  }
}

function formatFindings(
  findings: Array<{ severity: string; description: string; suggestion?: string }>,
): string {
  if (findings.length === 0) {
    return "Findings: none";
  }

  return [
    "Findings:",
    ...findings.map((finding) =>
      `- [${finding.severity}] ${finding.description}${finding.suggestion ? ` Fix: ${finding.suggestion}` : ""}`,
    ),
  ].join("\n");
}

function formatList(label: string, values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  return `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function renderMessages(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
}

function truncateCode(code: string, tokenBudget: number): string {
  const lines = code.split("\n");
  const result: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > tokenBudget) break;
    result.push(line);
    tokens += lineTokens;
  }
  if (result.length < lines.length) {
    result.push(`// ... ${lines.length - result.length} more lines truncated for context limit`);
  }
  return result.join("\n");
}

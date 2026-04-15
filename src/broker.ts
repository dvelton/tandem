import { createAdapter } from "./adapters/index.js";
import { buildDesignAlignMessages, buildDriverMessages, buildNavigatorMessages } from "./context.js";
import type {
  CheckpointEvent,
  ChunkEvent,
  CompletionEvent,
  DesignAlignEvent,
  ReviewEvent,
  ReviewFinding,
  RevisionEvent,
  SessionConfig,
  SessionState,
} from "./protocol.js";
import type { ReviewSeverity } from "./protocol.js";
import { appendEvent, createSession, recordTokenUsage, saveSession } from "./session.js";

const DEFAULT_MILESTONE_INTERVAL = 3;
const MAX_REVISION_ATTEMPTS = 3;
const MODEL_TIMEOUT_MS = 120_000;

type ModelRole = "driver" | "navigator";
type ExtendedSessionConfig = SessionConfig & { milestoneInterval?: number };

export interface BrokerCallbacks {
  onDesignAlign?: (event: DesignAlignEvent) => void;
  onChunk?: (chunk: ChunkEvent) => void;
  onReview?: (review: ReviewEvent) => void;
  onRevision?: (revision: RevisionEvent) => void;
  onCheckpoint?: (checkpoint: CheckpointEvent) => void;
  onCompletion?: (completion: CompletionEvent) => void;
  onError?: (error: Error) => void;
  onTokenUsage?: (role: ModelRole, usage: { input: number; output: number }) => void;
}

export async function runSession(config: SessionConfig, callbacks: BrokerCallbacks = {}): Promise<SessionState> {
  const driver = createAdapter(config.driver);
  const navigator = createAdapter(config.navigator);
  const milestoneInterval = Math.max((config as ExtendedSessionConfig).milestoneInterval ?? DEFAULT_MILESTONE_INTERVAL, 1);

  let state = createSession(config);
  await persist(state);

  // Phase 1: Design alignment — navigator and driver align on approach before any code
  state = await designAlign(state);

  // Phase 2: Paired coding loop
  let chunkNumber = 1;
  let approvedChunks = 0;
  let forwardGuidance = "";
  let sessionComplete = false;

  while (!sessionComplete) {
    const chunkId = `chunk-${chunkNumber}`;

    // Driver produces a chunk, incorporating any forward guidance from the navigator
    const driverPrompt = buildPairingPrompt(chunkId, forwardGuidance);
    const driverResult = await callModel(() =>
      driver.generate(buildDriverMessages(state, driverPrompt), { timeoutMs: MODEL_TIMEOUT_MS }),
    );

    if (!driverResult) {
      emitError(callbacks, new Error(`Driver failed to generate ${chunkId}`));
      break;
    }

    state = noteUsage(state, "driver", driverResult.tokenUsage, callbacks);
    const parsed = parseDriverResponse(driverResult.content);

    state = await appendAndPersist(state, {
      type: "chunk" as const,
      source: "driver",
      chunkId,
      rationale: parsed.rationale,
      code: parsed.code,
    });
    callbacks.onChunk?.(lastEvent(state) as ChunkEvent);

    sessionComplete = parsed.isComplete;

    // Navigator reviews the chunk — focus is on steering, not just bug-finding
    const navResult = await callModel(() =>
      navigator.generate(buildNavigatorMessages(state, parsed.code, "chunk"), { timeoutMs: MODEL_TIMEOUT_MS }),
    );

    const findings = navResult ? parseFindings(navResult.content) : [];
    if (navResult) state = noteUsage(state, "navigator", navResult.tokenUsage, callbacks);

    state = await appendAndPersist(state, {
      type: "review" as const,
      source: "navigator",
      chunkId,
      scale: "chunk" as const,
      findings,
      summary: summarizeFindings(findings),
    });
    callbacks.onReview?.(lastEvent(state) as ReviewEvent);

    // KEY PAIRING DISTINCTION: only critical findings trigger revision.
    // Major/minor findings feed FORWARD as guidance for the next chunk.
    // This is what separates pairing from code review — the navigator
    // steers direction rather than forcing rewrites of finished code.
    const critical = findings.filter((f) => f.severity === "critical");
    const forwardFindings = findings.filter((f) => f.severity !== "critical");

    if (critical.length > 0) {
      state = await reviseChunk(state, chunkId, critical);
    }

    // Non-critical findings become forward guidance for the next chunk
    forwardGuidance = buildForwardGuidance(forwardFindings);
    if (forwardGuidance) {
      state = await appendAndPersist(state, {
        type: "feedback" as const,
        source: "navigator",
        guidance: forwardGuidance,
        targetChunkId: chunkId,
      });
    }

    approvedChunks += 1;

    if (shouldRunAccumulatedReview(config, approvedChunks, milestoneInterval)) {
      state = await runAccumulatedReview(state, chunkId);
    }

    if (sessionComplete) break;
    chunkNumber += 1;
  }

  // Phase 3: Completion review
  return runCompletionReview(state);

  // --- Inner functions closing over driver/navigator/callbacks ---

  async function designAlign(current: SessionState): Promise<SessionState> {
    const navResult = await callModel(() =>
      navigator.generate(buildDesignAlignMessages(current), { timeoutMs: MODEL_TIMEOUT_MS }),
    );

    if (!navResult) return current;
    let next = noteUsage(current, "navigator", navResult.tokenUsage, callbacks);

    const alignment = parseDesignAlignment(navResult.content);
    next = await appendAndPersist(next, {
      type: "design-align" as const,
      source: "navigator",
      approach: alignment.approach,
      considerations: alignment.considerations,
    });
    callbacks.onDesignAlign?.(lastEvent(next) as DesignAlignEvent);

    return next;
  }

  async function reviseChunk(current: SessionState, chunkId: string, critical: ReviewFinding[]): Promise<SessionState> {
    let next = current;
    const feedback = formatCriticalFeedback(chunkId, critical);

    next = await appendAndPersist(next, {
      type: "feedback" as const,
      source: "navigator",
      guidance: feedback,
      targetChunkId: chunkId,
    });

    let currentFeedback = feedback;
    for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt++) {
      const revisionPrompt = `Revise ${chunkId}. Critical issues:\n\n${currentFeedback}`;
      const result = await callModel(() =>
        driver.generate(buildDriverMessages(next, revisionPrompt), { timeoutMs: MODEL_TIMEOUT_MS }),
      );

      if (!result) break;
      next = noteUsage(next, "driver", result.tokenUsage, callbacks);
      const parsed = parseDriverResponse(result.content);

      next = await appendAndPersist(next, {
        type: "revision" as const,
        source: "driver",
        chunkId,
        rationale: parsed.rationale,
        code: parsed.code,
      });
      callbacks.onRevision?.(lastEvent(next) as RevisionEvent);

      const reReview = await callModel(() =>
        navigator.generate(buildNavigatorMessages(next, parsed.code, "chunk"), { timeoutMs: MODEL_TIMEOUT_MS }),
      );

      const newFindings = reReview ? parseFindings(reReview.content) : [];
      if (reReview) next = noteUsage(next, "navigator", reReview.tokenUsage, callbacks);

      // Persist re-review findings so the event log is complete
      if (newFindings.length > 0) {
        next = await appendAndPersist(next, {
          type: "review" as const,
          source: "navigator",
          chunkId,
          scale: "chunk" as const,
          findings: newFindings,
          summary: `Re-review after revision attempt ${attempt + 1}: ${summarizeFindings(newFindings)}`,
        });
        callbacks.onReview?.(lastEvent(next) as ReviewEvent);
      }

      const newCritical = newFindings.filter((f) => f.severity === "critical");
      if (newCritical.length === 0) break;

      // Update feedback for the next revision attempt with the NEW critical findings
      currentFeedback = formatCriticalFeedback(chunkId, newCritical);

      if (attempt === MAX_REVISION_ATTEMPTS - 1) {
        emitError(callbacks, new Error(`${chunkId} still critical after ${MAX_REVISION_ATTEMPTS} revisions; continuing.`));
      }
    }

    return next;
  }

  async function runAccumulatedReview(current: SessionState, chunkId: string): Promise<SessionState> {
    const result = await callModel(() =>
      navigator.generate(buildNavigatorMessages(current, current.accumulatedCode, "accumulated"), { timeoutMs: MODEL_TIMEOUT_MS }),
    );

    let next = current;
    if (result) next = noteUsage(next, "navigator", result.tokenUsage, callbacks);

    const findings = result ? parseFindings(result.content) : [];
    next = await appendAndPersist(next, {
      type: "review" as const,
      source: "navigator",
      chunkId,
      scale: "accumulated" as const,
      findings,
      summary: summarizeFindings(findings),
    });
    callbacks.onReview?.(lastEvent(next) as ReviewEvent);

    next = await appendAndPersist(next, {
      type: "checkpoint" as const,
      source: "broker",
      summary: findings.length === 0 ? "Accumulated review passed." : "Accumulated review recorded findings.",
      findings,
      accumulatedCode: next.accumulatedCode,
    });
    callbacks.onCheckpoint?.(lastEvent(next) as CheckpointEvent);

    await persist(next);
    return next;
  }

  async function runCompletionReview(current: SessionState): Promise<SessionState> {
    let next = current;
    let findings: ReviewFinding[] = [];

    if (shouldRunScale(config, "completion") && next.accumulatedCode.trim()) {
      const result = await callModel(() =>
        navigator.generate(buildNavigatorMessages(next, next.accumulatedCode, "completion"), { timeoutMs: MODEL_TIMEOUT_MS }),
      );
      if (result) {
        next = noteUsage(next, "navigator", result.tokenUsage, callbacks);
        findings = parseFindings(result.content);

        next = await appendAndPersist(next, {
          type: "review" as const,
          source: "navigator",
          chunkId: "final",
          scale: "completion" as const,
          findings,
          summary: summarizeFindings(findings),
        });
        callbacks.onReview?.(lastEvent(next) as ReviewEvent);
      }
    }

    next = await appendAndPersist(next, {
      type: "completion" as const,
      source: "broker",
      finalCode: next.accumulatedCode,
      review: findings,
      summary: findings.length === 0 ? "Session completed cleanly." : `Completed with ${findings.length} finding(s).`,
    });
    callbacks.onCompletion?.(lastEvent(next) as CompletionEvent);

    await persist(next);
    return next;
  }

  async function appendAndPersist(current: SessionState, event: Parameters<typeof appendEvent>[1]): Promise<SessionState> {
    const next = appendEvent(current, event);
    await persist(next);
    return next;
  }

  async function persist(current: SessionState): Promise<void> {
    if (!current.config.sessionDir) return;
    await saveSession(current, current.config.sessionDir);
  }
}

// --- Parsing helpers ---

async function callModel<T>(operation: () => Promise<T>, retries = 1): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch {
      if (attempt === retries) return null;
    }
  }
  return null;
}

function noteUsage(state: SessionState, role: ModelRole, usage: { input: number; output: number }, callbacks: BrokerCallbacks): SessionState {
  callbacks.onTokenUsage?.(role, usage);
  return recordTokenUsage(state, role, usage);
}

function lastEvent(state: SessionState): unknown {
  return state.events[state.events.length - 1];
}

function buildPairingPrompt(chunkId: string, forwardGuidance: string): string {
  const parts = [`Produce ${chunkId}. Write a focused code chunk with rationale.`];
  if (forwardGuidance) {
    parts.push(`Navigator guidance from the previous chunk (incorporate these considerations):\n${forwardGuidance}`);
  }
  return parts.join("\n\n");
}

function parseDriverResponse(content: string): { code: string; rationale: string; isComplete: boolean } {
  const codeBlocks = [...content.matchAll(/```(?:ts|tsx|typescript|js|javascript)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const code = codeBlocks.filter(Boolean).join("\n\n") || content.trim();
  const rationale = content.replace(/```[\s\S]*?```/g, "").trim() || "No rationale provided.";
  // Look for explicit completion signals outside of code blocks to avoid
  // false positives from variable names or comments like "// done"
  const proseOnly = content.replace(/```[\s\S]*?```/g, "");
  const isComplete = /\[SESSION[_\s]?COMPLETE\]/i.test(proseOnly)
    || /\ball\s+(?:chunks?|code|implementation)\s+(?:is|are)\s+(?:complete|done|finished)\b/i.test(proseOnly)
    || /\bimplementation\s+is\s+(?:complete|done|finished)\b/i.test(proseOnly)
    || /\bno\s+(?:more|further)\s+chunks?\s+(?:needed|required)\b/i.test(proseOnly);
  return { code, rationale, isComplete };
}

function parseDesignAlignment(content: string): { approach: string; considerations: string[] } {
  const candidates = [content.trim(), ...extractJsonCandidates(content)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed.approach === "string") {
        return {
          approach: parsed.approach,
          considerations: Array.isArray(parsed.considerations) ? parsed.considerations.map(String) : [],
        };
      }
    } catch { continue; }
  }
  return { approach: content.trim(), considerations: [] };
}

function parseFindings(content: string): ReviewFinding[] {
  const candidates = [content.trim(), ...extractJsonCandidates(content)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeFinding).filter((f): f is ReviewFinding => f !== null);
      }
    } catch { continue; }
  }
  return [];
}

function extractJsonCandidates(content: string): string[] {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start >= 0 && end > start) fenced.push(content.slice(start, end + 1));
  const objStart = content.indexOf("{");
  const objEnd = content.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) fenced.push(content.slice(objStart, objEnd + 1));
  return fenced;
}

function normalizeFinding(value: unknown): ReviewFinding | null {
  if (!value || typeof value !== "object") return null;
  const f = value as Partial<ReviewFinding>;
  if (!f.description || typeof f.description !== "string") return null;
  return {
    severity: normalizeSeverity(f.severity),
    description: f.description.trim(),
    suggestion: typeof f.suggestion === "string" ? f.suggestion.trim() : undefined,
  };
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  return value === "critical" || value === "major" || value === "minor" || value === "design-note" ? value : "minor";
}

function buildForwardGuidance(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "";
  return findings.map((f) => `- [${f.severity}] ${f.description}${f.suggestion ? ` → ${f.suggestion}` : ""}`).join("\n");
}

function formatCriticalFeedback(chunkId: string, findings: ReviewFinding[]): string {
  return [`Critical issues in ${chunkId} requiring revision:`, ...findings.map((f) => `- ${f.description}${f.suggestion ? ` Fix: ${f.suggestion}` : ""}`)].join("\n");
}

function shouldRunAccumulatedReview(config: SessionConfig, approved: number, interval: number): boolean {
  return approved > 0 && approved % interval === 0 && shouldRunScale(config, "accumulated");
}

function shouldRunScale(config: SessionConfig, scale: "accumulated" | "completion"): boolean {
  return config.reviewScales.includes(scale);
}

function summarizeFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No findings.";
  const critical = findings.filter((f) => f.severity === "critical").length;
  return `${findings.length} finding(s)${critical > 0 ? `, ${critical} critical` : ""}.`;
}

function emitError(callbacks: BrokerCallbacks, error: Error): void {
  callbacks.onError?.(error);
}

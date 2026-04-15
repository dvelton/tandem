import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModelConfig, ModelTokenUsage, Role, SessionConfig, SessionEvent, SessionState, TaskStartEvent } from "./protocol.js";

type SessionEventInput<T extends SessionEvent = SessionEvent> = Omit<T, "id" | "timestamp">;
type AnyEventInput = { [K in SessionEvent["type"]]: Omit<Extract<SessionEvent, { type: K }>, "id" | "timestamp"> }[SessionEvent["type"]];
type ModelRole = Exclude<Role, "human">;

const EMPTY_TOKEN_USAGE = Object.freeze({ input: 0, output: 0 });

export function createEvent<T extends SessionEvent>(event: SessionEventInput<T>): T {
  return {
    ...event,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  } as T;
}

export function createSession(config: SessionConfig): SessionState {
  const initialTask = createEvent<TaskStartEvent>({
    type: "task-start",
    source: "human",
    task: config.task,
    requirements: [],
  });

  return {
    id: randomUUID(),
    config,
    events: [initialTask],
    currentRole: { active: "driver" },
    accumulatedCode: "",
    tokenUsage: {
      driver: { ...EMPTY_TOKEN_USAGE },
      navigator: { ...EMPTY_TOKEN_USAGE },
    },
  };
}

export function appendEvent(state: SessionState, event: AnyEventInput): SessionState {
  const nextEvent = createEvent(event);
  const events = [...state.events, nextEvent];

  return {
    ...state,
    events,
    currentRole: nextRoleState(state.currentRole, nextEvent),
    accumulatedCode: deriveAccumulatedCode(events),
  };
}

export function recordTokenUsage(
  state: SessionState,
  role: ModelRole,
  usage: Partial<ModelTokenUsage>,
): SessionState {
  const previous = state.tokenUsage[role];

  return {
    ...state,
    tokenUsage: {
      ...state.tokenUsage,
      [role]: {
        input: previous.input + (usage.input ?? 0),
        output: previous.output + (usage.output ?? 0),
      },
    },
  };
}

export async function saveSession(state: SessionState, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${state.id}.json`);
  const safe = redactConfig(state);
  await writeFile(filePath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

function redactConfig(state: SessionState): SessionState {
  const redact = (cfg: ModelConfig): ModelConfig => ({
    ...cfg,
    apiKey: cfg.apiKey ? "[REDACTED]" : "",
    baseUrl: undefined,
  });

  return {
    ...state,
    config: {
      ...state.config,
      driver: redact(state.config.driver),
      navigator: redact(state.config.navigator),
    },
  };
}

export async function loadSession(filePath: string): Promise<SessionState> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as SessionState;

  return normalizeState(parsed);
}

function normalizeState(state: SessionState): SessionState {
  const events = Array.isArray(state.events) ? state.events : [];

  return {
    ...state,
    events,
    currentRole: deriveRoleState(events, state.currentRole ?? { active: "driver" }),
    accumulatedCode: deriveAccumulatedCode(events),
    tokenUsage: {
      driver: {
        input: state.tokenUsage?.driver?.input ?? 0,
        output: state.tokenUsage?.driver?.output ?? 0,
      },
      navigator: {
        input: state.tokenUsage?.navigator?.input ?? 0,
        output: state.tokenUsage?.navigator?.output ?? 0,
      },
    },
  };
}

function deriveRoleState(events: SessionEvent[], seed: Record<string, Role>): Record<string, Role> {
  return events.reduce((currentRole, event) => nextRoleState(currentRole, event), seed);
}

function nextRoleState(currentRole: Record<string, Role>, event?: SessionEvent): Record<string, Role> {
  if (!event) {
    return currentRole;
  }

  switch (event.type) {
    case "handoff":
      return { ...currentRole, active: event.to };
    case "interrupt":
      return event.by === "human" ? { ...currentRole, active: "human" } : { ...currentRole, active: event.by };
    default:
      return currentRole;
  }
}

function deriveAccumulatedCode(events: SessionEvent[]): string {
  const completion = [...events].reverse().find((event) => event.type === "completion");
  if (completion?.finalCode) {
    return completion.finalCode;
  }

  const chunkOrder: string[] = [];
  const chunkCode = new Map<string, string>();

  for (const event of events) {
    if (event.type === "chunk" || event.type === "revision") {
      if (!chunkCode.has(event.chunkId)) {
        chunkOrder.push(event.chunkId);
      }
      chunkCode.set(event.chunkId, event.code.trimEnd());
    }
  }

  if (chunkOrder.length > 0) {
    return chunkOrder
      .map((chunkId) => chunkCode.get(chunkId) ?? "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  const checkpoint = [...events].reverse().find((event) => event.type === "checkpoint");
  return checkpoint?.accumulatedCode ?? "";
}

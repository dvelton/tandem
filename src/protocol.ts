export type Role = "driver" | "navigator" | "human";

export type ChunkStrategy = "function" | "semantic" | "lines";

export type ReviewScale = "chunk" | "accumulated" | "completion";

export type ReviewSeverity = "critical" | "major" | "minor" | "design-note";

export interface ModelConfig {
  provider: string;
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface SessionConfig {
  task: string;
  driver: ModelConfig;
  navigator: ModelConfig;
  chunkStrategy: ChunkStrategy;
  maxChunkLines?: number;
  reviewScales: ReviewScale[];
  contextLimit?: number;
  sessionDir?: string;
}

export interface ReviewFinding {
  severity: ReviewSeverity;
  description: string;
  suggestion?: string;
}

export interface SessionEventBase {
  id: string;
  type: SessionEventType;
  timestamp: string;
  source: string;
}

export interface TaskStartEvent extends SessionEventBase {
  type: "task-start";
  task: string;
  requirements: string[];
}

export interface ChunkEvent extends SessionEventBase {
  type: "chunk";
  chunkId: string;
  rationale: string;
  code: string;
}

export interface ReviewEvent extends SessionEventBase {
  type: "review";
  chunkId: string;
  scale: ReviewScale;
  findings: ReviewFinding[];
  summary?: string;
}

export interface FeedbackEvent extends SessionEventBase {
  type: "feedback";
  guidance: string;
  targetChunkId?: string;
}

export interface RevisionEvent extends SessionEventBase {
  type: "revision";
  chunkId: string;
  rationale: string;
  code: string;
}

export interface InterruptEvent extends SessionEventBase {
  type: "interrupt";
  by: "navigator" | "human";
  reason: string;
}

export interface HandoffEvent extends SessionEventBase {
  type: "handoff";
  from: Exclude<Role, "human">;
  to: Exclude<Role, "human">;
  reason?: string;
}

export interface CheckpointEvent extends SessionEventBase {
  type: "checkpoint";
  summary: string;
  findings: ReviewFinding[];
  accumulatedCode: string;
}

export interface CompletionEvent extends SessionEventBase {
  type: "completion";
  finalCode: string;
  review: ReviewFinding[];
  summary: string;
}

export interface HumanInputEvent extends SessionEventBase {
  type: "human-input";
  instructions: string;
}

export interface DesignAlignEvent extends SessionEventBase {
  type: "design-align";
  approach: string;
  considerations: string[];
}

export type SessionEvent =
  | TaskStartEvent
  | ChunkEvent
  | ReviewEvent
  | FeedbackEvent
  | RevisionEvent
  | InterruptEvent
  | HandoffEvent
  | CheckpointEvent
  | CompletionEvent
  | HumanInputEvent
  | DesignAlignEvent;

export type SessionEventType = SessionEvent["type"];

export interface ModelTokenUsage {
  input: number;
  output: number;
}

export interface SessionTokenUsage {
  driver: ModelTokenUsage;
  navigator: ModelTokenUsage;
}

export interface SessionState {
  id: string;
  config: SessionConfig;
  events: SessionEvent[];
  currentRole: Record<string, Role>;
  accumulatedCode: string;
  tokenUsage: SessionTokenUsage;
}

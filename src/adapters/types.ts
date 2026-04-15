export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stop?: string[];
  timeoutMs?: number;
}

export interface GenerateResult {
  content: string;
  tokenUsage: { input: number; output: number };
}

export interface ModelAdapter {
  readonly name: string;
  readonly model: string;
  generate(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: GenerateOptions,
  ): Promise<GenerateResult>;
}

import type { ModelConfig } from "../protocol.js";
import type { GenerateOptions, GenerateResult, ModelAdapter } from "./types.js";

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

export class AnthropicAdapter implements ModelAdapter {
  readonly name: string;
  readonly model: string;

  constructor(private readonly config: ModelConfig) {
    this.name = config.provider;
    this.model = config.model;
  }

  async generate(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const systemParts = [options.systemPrompt, ...messages.filter((m) => m.role === "system").map((m) => m.content)].filter(
      (value): value is string => Boolean(value),
    );
    const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const response = await fetch(this.buildUrl(), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: options.maxTokens ?? this.config.maxTokens ?? 4096,
        temperature: options.temperature ?? this.config.temperature,
        stop_sequences: options.stop,
        system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
        messages: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({ role: message.role, content: message.content })),
      }),
    });

    const data = (await this.parseJson(response)) as AnthropicResponse;
    if (!response.ok) {
      throw new Error(`${this.name} request failed (${response.status}): ${data.error?.message ?? response.statusText}`);
    }

    const content = data.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("") ?? "";
    if (!content) {
      throw new Error(`${this.name} returned no text content`);
    }

    return {
      content,
      tokenUsage: {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
      },
    };
  }

  private buildUrl(): string {
    const baseUrl = (this.config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    return baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(`${this.name} request failed (${response.status}): ${text}`);
      }
      throw new Error(`${this.name} returned invalid JSON`);
    }
  }
}

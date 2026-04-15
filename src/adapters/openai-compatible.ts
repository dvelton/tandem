import type { ModelConfig } from "../protocol.js";
import type { GenerateOptions, GenerateResult, ModelAdapter } from "./types.js";

type OpenAIChatResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
};

export class OpenAICompatibleAdapter implements ModelAdapter {
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
    const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const response = await fetch(this.buildUrl(), {
      method: "POST",
      headers: this.buildHeaders(),
      signal,
      body: JSON.stringify({
        model: this.config.model,
        messages: options.systemPrompt
          ? [{ role: "system" as const, content: options.systemPrompt }, ...messages]
          : messages,
        max_tokens: options.maxTokens ?? this.config.maxTokens,
        temperature: options.temperature ?? this.config.temperature,
        stop: options.stop,
      }),
    });

    const data = (await this.parseJson(response)) as OpenAIChatResponse;
    if (!response.ok) {
      throw new Error(`${this.name} request failed (${response.status}): ${data.error?.message ?? response.statusText}`);
    }

    const content = this.extractContent(data);
    if (!content) {
      throw new Error(`${this.name} returned no message content`);
    }

    return {
      content,
      tokenUsage: {
        input: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0,
        output: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
      },
    };
  }

  private buildUrl(): string {
    const baseUrl = (this.config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    return baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  }

  private buildHeaders(): HeadersInit {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
      headers["api-key"] = this.config.apiKey;
    }
    return headers;
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

  private extractContent(data: OpenAIChatResponse): string {
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("");
    }
    return "";
  }
}

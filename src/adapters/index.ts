import type { ModelConfig } from "../protocol.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import type { ModelAdapter } from "./types.js";

export * from "./types.js";
export { AnthropicAdapter } from "./anthropic.js";
export { OpenAICompatibleAdapter } from "./openai-compatible.js";

export function createAdapter(config: ModelConfig): ModelAdapter {
  return config.provider === "anthropic" ? new AnthropicAdapter(config) : new OpenAICompatibleAdapter(config);
}

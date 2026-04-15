#!/usr/bin/env node
import path from "node:path";

import { Command } from "commander";

import { runSession } from "./broker.js";
import { createTerminalCallbacks, printSessionEvent, printSessionSummary } from "./cli.js";
import type { ChunkStrategy, ModelConfig, ReviewScale } from "./protocol.js";
import { loadSession } from "./session.js";

const DEFAULT_SESSION_DIR = "./tandem-sessions";
const DEFAULT_CONTEXT_LIMIT = 12_000;
const DEFAULT_REVIEW_SCALES: ReviewScale[] = ["chunk", "accumulated", "completion"];
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};
const API_KEY_ENVS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const program = new Command()
  .name("tandem")
  .description("True pair programming between AI models");

program
  .command("run")
  .requiredOption("--task <task>", "what to build")
  .requiredOption("--driver <provider:model>", "driver model")
  .requiredOption("--navigator <provider:model>", "navigator model")
  .option("--driver-key <key>", "API key for the driver")
  .option("--navigator-key <key>", "API key for the navigator")
  .option("--driver-url <url>", "custom base URL for the driver")
  .option("--navigator-url <url>", "custom base URL for the navigator")
  .option("--session-dir <dir>", "directory to save session files", DEFAULT_SESSION_DIR)
  .option("--context-limit <tokens>", "max tokens before context compression", parseInteger, DEFAULT_CONTEXT_LIMIT)
  .option("--review-scales <scales>", "comma-separated review scales", DEFAULT_REVIEW_SCALES.join(","))
  .action(async (options) => {
    const config = {
      task: options.task,
      driver: buildModelConfig(options.driver, options.driverKey, options.driverUrl),
      navigator: buildModelConfig(options.navigator, options.navigatorKey, options.navigatorUrl),
      sessionDir: path.resolve(options.sessionDir),
      contextLimit: options.contextLimit,
      chunkStrategy: "semantic" as ChunkStrategy,
      reviewScales: parseReviewScales(options.reviewScales),
    };

    const state = await runSession(config, createTerminalCallbacks());
    printSessionSummary(state);
  });

program
  .command("replay")
  .argument("<session-file>", "session JSON file to replay")
  .action(async (sessionFile) => {
    const state = await loadSession(path.resolve(sessionFile));
    const printerState: { phase?: "setup" | "design" | "coding" | "review" | "checkpoint" | "completion" } = {};
    state.events.forEach((event) => printSessionEvent(event, printerState));
    printSessionSummary(state);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

function buildModelConfig(spec: string, explicitKey?: string, explicitUrl?: string): ModelConfig {
  const { provider, model } = parseModelSpec(spec);
  const baseUrl = explicitUrl ?? DEFAULT_BASE_URLS[provider];
  if (!baseUrl) {
    throw new Error(`Provider \"${provider}\" requires an explicit base URL.`);
  }

  return {
    provider,
    model,
    baseUrl,
    apiKey: explicitKey ?? readProviderKey(provider),
  };
}

function parseModelSpec(spec: string): { provider: string; model: string } {
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Invalid model spec \"${spec}\". Expected provider:model.`);
  }

  return {
    provider: spec.slice(0, separator).trim().toLowerCase(),
    model: spec.slice(separator + 1).trim(),
  };
}

function parseReviewScales(value: string): ReviewScale[] {
  const scales = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (scales.length === 0) return [...DEFAULT_REVIEW_SCALES];
  if (scales.every((scale): scale is ReviewScale => scale === "chunk" || scale === "accumulated" || scale === "completion")) {
    return scales;
  }

  throw new Error(`Invalid review scales \"${value}\".`);
}

function readProviderKey(provider: string): string {
  const envName = API_KEY_ENVS[provider];
  return envName ? process.env[envName] ?? "" : "";
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got \"${value}\".`);
  }
  return parsed;
}

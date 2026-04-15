import chalk from "chalk";

import type { BrokerCallbacks } from "./broker.js";
import type { ReviewFinding, ReviewSeverity, SessionEvent, SessionState } from "./protocol.js";

type Phase = "setup" | "design" | "coding" | "review" | "checkpoint" | "completion";
type PrinterState = { phase?: Phase };

const phaseLabels: Record<Phase, string> = {
  setup: "Setup",
  design: "Design alignment",
  coding: "Driver chunking",
  review: "Navigator review",
  checkpoint: "Checkpoint",
  completion: "Completion",
};

export function createTerminalCallbacks(): BrokerCallbacks {
  return buildPrinter({});
}

export function printSessionEvent(event: SessionEvent, printerState: PrinterState = {}): void {
  const printer = buildPrinter(printerState);
  switch (event.type) {
    case "task-start":
      setPhase(printerState, "setup");
      console.log(chalk.white.bold("Task"));
      console.log(chalk.green(event.task));
      printList(event.requirements, chalk.green, "Requirements");
      console.log();
      break;
    case "design-align":
      printer.onDesignAlign?.(event);
      break;
    case "chunk":
      printer.onChunk?.(event);
      break;
    case "review":
      printer.onReview?.(event);
      break;
    case "feedback":
      setPhase(printerState, "review");
      console.log(chalk.white.bold("Forward guidance"));
      console.log(chalk.yellow(event.guidance));
      console.log();
      break;
    case "revision":
      printer.onRevision?.(event);
      break;
    case "interrupt":
      console.log(chalk.red.bold(`Interrupt from ${event.by}: ${event.reason}`));
      console.log();
      break;
    case "handoff":
      console.log(chalk.white.bold(`Handoff ${event.from} -> ${event.to}`));
      if (event.reason) console.log(chalk.gray(event.reason));
      console.log();
      break;
    case "checkpoint":
      printer.onCheckpoint?.(event);
      break;
    case "completion":
      printer.onCompletion?.(event);
      break;
    case "human-input":
      console.log(chalk.green(`Human input: ${event.instructions}`));
      console.log();
      break;
  }
}

export function printSessionSummary(state: SessionState): void {
  const chunkCount = state.events.filter((event) => event.type === "chunk").length;
  const revisionCount = state.events.filter((event) => event.type === "revision").length;
  const findingCount = state.events.reduce(
    (total, event) => (event.type === "review" ? total + event.findings.length : total),
    0,
  );

  console.log(chalk.white.bold("Session summary"));
  console.log(`  Total chunks: ${chunkCount}${revisionCount > 0 ? ` (${revisionCount} revised)` : ""}`);
  console.log(`  Findings: ${findingCount}`);
  console.log(`  Driver tokens: in ${state.tokenUsage.driver.input}, out ${state.tokenUsage.driver.output}`);
  console.log(`  Navigator tokens: in ${state.tokenUsage.navigator.input}, out ${state.tokenUsage.navigator.output}`);
}

function buildPrinter(state: PrinterState): BrokerCallbacks {
  return {
    onDesignAlign(event) {
      setPhase(state, "design");
      console.log(chalk.yellow("Navigator design alignment"));
      console.log(chalk.gray(event.approach));
      printList(event.considerations, chalk.gray, "Considerations");
      console.log();
    },
    onChunk(event) {
      setPhase(state, "coding");
      console.log(chalk.cyan(`Driver ${event.chunkId}`));
      console.log(indentCode(event.code));
      console.log(chalk.gray(`Rationale: ${event.rationale}`));
      console.log();
    },
    onReview(event) {
      setPhase(state, event.scale === "chunk" ? "review" : event.scale === "accumulated" ? "checkpoint" : "completion");
      console.log(chalk.yellow(`Navigator review (${event.scale}) for ${event.chunkId}`));
      if (event.summary) console.log(chalk.gray(event.summary));
      printFindings(event.findings);
      if (event.scale === "chunk") {
        const guidance = event.findings.filter((finding) => finding.severity !== "critical");
        if (guidance.length > 0) {
          console.log(chalk.white.bold("Forward guidance"));
          guidance.forEach((finding) => console.log(`  ${chalk.yellow("-")} ${formatFinding(finding)}`));
        }
      }
      console.log();
    },
    onRevision(event) {
      setPhase(state, "coding");
      console.log(chalk.cyan(`Driver revision for ${event.chunkId}`));
      console.log(indentCode(event.code));
      console.log(chalk.gray(`Rationale: ${event.rationale}`));
      console.log();
    },
    onCheckpoint(event) {
      setPhase(state, "checkpoint");
      console.log(chalk.white.bold("Checkpoint"));
      console.log(chalk.gray(event.summary));
      printFindings(event.findings);
      if (event.accumulatedCode.trim()) {
        console.log(chalk.white.bold("Accumulated code"));
        console.log(indentCode(event.accumulatedCode));
      }
      console.log();
    },
    onCompletion(event) {
      setPhase(state, "completion");
      console.log(chalk.white.bold("Completion"));
      console.log(chalk.gray(event.summary));
      printFindings(event.review);
      console.log();
    },
    onError(error) {
      console.error(chalk.red.bold(`Error: ${error.message}`));
    },
  };
}

function setPhase(state: PrinterState, phase: Phase): void {
  if (state.phase === phase) return;
  state.phase = phase;
  console.log(chalk.white.bold(`[phase] ${phaseLabels[phase]}`));
}

function printFindings(findings: ReviewFinding[]): void {
  if (findings.length === 0) {
    console.log(chalk.gray("No findings."));
    return;
  }

  findings.forEach((finding) => console.log(`  ${chalk.yellow("-")} ${formatFinding(finding)}`));
}

function formatFinding(finding: ReviewFinding): string {
  const label = severityLabel(finding.severity);
  return `${label} ${finding.description}${finding.suggestion ? chalk.gray(` (${finding.suggestion})`) : ""}`;
}

function severityLabel(severity: ReviewSeverity): string {
  const text = `[${severity}]`;
  switch (severity) {
    case "critical":
      return chalk.red.bold(text);
    case "major":
      return chalk.red(text);
    case "minor":
      return chalk.dim(text);
    case "design-note":
      return chalk.gray(text);
  }
}

function printList(values: string[], color: (value: string) => string, label: string): void {
  if (values.length === 0) return;
  console.log(chalk.white.bold(label));
  values.forEach((value) => console.log(`  ${color(`- ${value}`)}`));
}

function indentCode(code: string): string {
  return code
    .split("\n")
    .map((line) => `  ${highlightCode(line)}`)
    .join("\n");
}

function highlightCode(line: string): string {
  return line.replace(
    /(\/\/.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:const|let|var|return|function|export|import|from|if|else|for|while|switch|case|break|continue|throw|new|class|extends|implements|interface|type|async|await|try|catch)\b|\b\d+(?:_\d+)*(?:\.\d+)?\b)/g,
    (token) => {
      if (token.startsWith("//")) return chalk.dim(token);
      if (/^["'`]/.test(token)) return chalk.green(token);
      if (/^\d/.test(token)) return chalk.magenta(token);
      return chalk.blue(token);
    },
  );
}

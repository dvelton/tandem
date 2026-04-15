# Tandem

Tandem runs pair programming sessions between two AI models. One model writes code (the driver), the other watches and steers design decisions as the code is written (the navigator). Every session is saved as a replayable JSON log.

This is not automated code review. The navigator doesn't wait for finished code and then look for bugs. It participates while the code is being written — catching wrong architectural directions before they're committed to, steering the driver toward better abstractions, and feeding guidance forward into the next piece of code rather than forcing rewrites of what's already done.

## Quick start

```
git clone https://github.com/dvelton/tandem.git
cd tandem
npm install && npm run build

node dist/index.js run \
  --task "Build a rate limiter with sliding window, retry-after headers, and cleanup" \
  --driver openai:gpt-4o \
  --navigator anthropic:claude-sonnet-4-20250514
```

Tandem will:

1. Ask the navigator to propose an approach and flag pitfalls before any code is written
2. Have the driver write code in focused chunks, one function at a time
3. After each chunk, the navigator reviews it — but the focus is on "is this heading the right direction?" not just "does this have bugs?"
4. Only findings the navigator marks as critical (wrong direction, will cascade) trigger a revision. Everything else feeds forward as guidance the driver incorporates into the next chunk.
5. Every few chunks, the navigator does an accumulated review looking for cross-cutting interaction bugs
6. At the end, a final completion review catches anything that emerged from the full picture

The session log, all code, and all findings are saved to a JSON file you can replay later.

## How it works

Tandem has three phases:

**Design alignment.** Before any code is written, the navigator model reviews the task and proposes an approach — what data structures to use, what abstractions make sense, what to watch out for. This gets both models on the same page and prevents the driver from committing to a flawed architecture in the first chunk.

**Paired coding.** The driver writes code in chunks (one function or type at a time). After each chunk, the navigator reviews it. The key distinction from code review: non-critical findings don't trigger a rewrite. They feed forward as guidance for the next chunk. The navigator says "watch out for X when you write the error handling" rather than "go back and fix line 47." Only genuinely critical issues — wrong approach, will cascade into everything downstream — cause the driver to revise.

**Multi-scale review.** Three levels of review happen at different cadences. Chunk-level review catches local design issues. Accumulated review (every few chunks) catches interaction bugs between components. Completion review catches anything that only becomes visible when you see the whole picture. Experiments showed that different review scales catch genuinely different classes of bugs.

## Why this is different from code review

There are plenty of tools that have one model write code and another review it. That's useful, but it's fundamentally a detect-and-fix workflow: bugs get baked into the architecture, then found after the fact, then patched. The rewrite often introduces new bugs.

Controlled experiments compared paired sessions against standard write-then-review cycles on the same task (a TypeScript event emitter with wildcards, error isolation, and async support). Both used the same models. The results:

| | Paired | Write-then-review |
|---|---|---|
| Bugs prevented (never written) | 7 | 0 |
| Critical bugs in final code | 0 | 2 |
| Major bugs in final code | 1 | 2 |
| Minor bugs in final code | 3 | 3 |
| Requirements fully met | 7/7 | 5/7 |
| Architecture quality (independent judge) | 4.4 / 5 | 2.8 / 5 |
| Lines of code | ~130 | ~220 |

The write-then-review cycle fixed all 6 bugs found in the initial solo code, but introduced 4 new bugs during the rewrite — including 2 critical ones. The paired session prevented those bugs from being written in the first place.

The most telling example: the solo driver wrote an `emit()` function that returned a Promise but was typed as synchronous. The reviewer caught this after 500 lines were built on top of it. Fixing it required rearchitecting the entire class. In the paired session, the navigator caught the same issue during the type definition phase — before a single line of implementation existed — and steered the driver toward a dual `emit()` / `emitAsync()` API that made the problem structurally impossible.

Prevention costs less than detection. The paired output was 40% shorter, met all requirements, and scored higher on architecture quality. The review-cycle output was longer, missed two requirements, and had more bugs despite the rewrite.

## Model-agnostic

Tandem works with any model that exposes a chat completions API. You specify models as `provider:model-name`:

```
--driver openai:gpt-4o
--navigator anthropic:claude-sonnet-4-20250514
--driver ollama:codellama --driver-url http://localhost:11434
```

Built-in provider defaults:
- `openai` → `https://api.openai.com`
- `anthropic` → `https://api.anthropic.com`
- Anything else → requires `--driver-url` or `--navigator-url`

API keys are read from `--driver-key` / `--navigator-key` flags, or from environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

## Options

```
node dist/index.js run [options]

Required:
  --task            What to build (in quotes)
  --driver          Driver model as provider:model
  --navigator       Navigator model as provider:model

Optional:
  --driver-key      API key for driver model
  --navigator-key   API key for navigator model
  --driver-url      Custom API base URL for driver
  --navigator-url   Custom API base URL for navigator
  --session-dir     Where to save session files (default: ./tandem-sessions)
  --context-limit   Max tokens before context compression (default: 12000)
  --review-scales   Comma-separated review levels (default: chunk,accumulated,completion)
```

## Replaying sessions

Every session is saved as a JSON file containing the full event log. You can replay it:

```
node dist/index.js replay ./tandem-sessions/abc-123.json
```

This prints every event in order — the design alignment, each chunk, each navigator review, all findings, and the final summary. Useful for understanding how a session unfolded or comparing how different model pairings approach the same task.

## Experiment details

The comparison data above comes from a controlled head-to-head on a TypeScript event emitter with these requirements: type-safe EventMap generics, wildcard pattern matching (`user.*` for one level, `user.**` for any depth), once listeners, error isolation, async support, leak detection, and utility methods.

Both paths used GPT as the driver/writer and Claude as the navigator/reviewer.

**Paired session** ran 3 chunks with navigator review after each. The navigator caught 7 issues across those reviews (2 critical, 5 major). In each case, the driver incorporated the feedback into the next chunk rather than rewriting the current one. The final output had 0 critical bugs and met all 7 requirements.

Bugs the navigator prevented:
- Async error swallowing in synchronous emit (caught at type definition, before implementation)
- Once-listener cleanup ordering (caught when emit/emitAsync were written)
- Wildcard depth matching (single `*` behaving like `**`)
- Off-method over-removal when same function registered via both on and once
- Recursive emission causing once-listeners to fire twice
- Silent error loss when no error handler configured
- Ambiguous maxListeners semantics with wildcard patterns

**Write-then-review cycle** had GPT write the full emitter solo (~500 lines), Claude review it (found 6 bugs), then GPT rewrite incorporating all feedback. The rewrite fixed all 6 original bugs but introduced 4 new ones:
- `emit()` silently swallows all async promise rejections (critical)
- `listenerCount()` counts by event name instead of by pattern (critical)
- `removeAllListeners()` fails to invalidate internal tracking structures (major)
- Regex patterns recompiled on every emit with no caching (minor)

An independent judge (Claude Haiku, which had no involvement in either path) scored both final outputs blind.

Earlier experiments on a rate limiter task showed the same pattern: the navigator preventing the introduction of a Mutex (which caused 2 of 4 bugs in the solo implementation), and different review granularities catching different bug classes.

## License

MIT

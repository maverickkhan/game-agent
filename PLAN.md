# Gaming Agent: ADK TypeScript + Playwright + Gemini Flash

## Objective

Build a coding agent on Google ADK (TypeScript) that opens a web game, plays it to win for 2 minutes, and demonstrates measurable progress.

## Eval Criteria

1. Architecture quality
2. Plays games for ~2 minutes
3. Game makes progress

---

## Key Constraints (From Research)

- **Games are pure canvas.** The sample URLs are AppLovin playable ads — a bootstrap shell (`al_renderHtml`) injects the entire game at runtime into a `<canvas>`. Zero DOM elements exist. No buttons, links, or accessible nodes. Vision + coordinate clicking is the only viable interaction method.
- **ADK TS has no ComputerUseToolset.** That's Python-only. We build our own Playwright tools exposed as ADK `FunctionTool`s.
- **Only Gemini is native in ADK TS.** OpenAI/Anthropic would require writing a custom `BaseLlm` adapter and registering it via `LLMRegistry`. Not worth the effort for this scope.
- **Latency floor is 1.5-4s per action cycle** (screenshot → model → parse → execute). At best ~40-60 actions in 2 minutes, not 120. Every action must count.

---

## Model Choice: Gemini 2.5 Flash

| Reason | Detail |
|--------|--------|
| Native to ADK TS | Zero adapter code, just `model: 'gemini-2.5-flash'` |
| Vision support | Accepts screenshots as multimodal input natively |
| Speed | ~0.5-1.5s time-to-first-token, fastest of all options |
| Cost | ~$0.001-0.002 per action cycle |
| Structured output | Supports `outputSchema` for strict JSON action responses |
| Context window | 1M tokens — can hold entire session history if needed |

NOT using `gemini-2.5-computer-use-preview` — it's Pro-tier (slower, pricier) and its predefined action set adds constraints we don't need. Instead we define our own action contract via FunctionTools, giving us full control.

---

## Architecture

```
SequentialAgent ("GameRunner")
│
├── SetupAgent (LlmAgent)
│   ├── Tool: openGame(url)
│   ├── Tool: screenshot()
│   ├── Tool: click(nx, ny)
│   ├── Tool: wait(ms)
│   └── Job: Navigate to URL → wait for canvas → detect game type
│         → dismiss overlays → confirm game is interactive
│
├── GameplayLoop (LoopAgent, maxIterations=80)
│   │
│   └── PlayAgent (LlmAgent)
│       ├── Tool: screenshot()
│       ├── Tool: click(nx, ny)
│       ├── Tool: drag(nx1, ny1, nx2, ny2, durationMs)
│       ├── Tool: tapHold(nx, ny, durationMs)
│       ├── Tool: wait(ms)
│       ├── Tool: checkTime() → escalates when elapsed >= 120s
│       └── Job: Each iteration = observe → reason → act → verify time
│
└── FinalizeAgent (LlmAgent)
    ├── Tool: screenshot()
    ├── Tool: saveSummary()
    └── Job: Capture final state → save artifacts → print eval summary
```

### Why This Structure

- **SequentialAgent** guarantees setup → play → finalize ordering.
- **LoopAgent** handles the repetitive play cycle. `maxIterations=80` is a safety cap (at ~1.5s/action, 80 iterations ≈ 2 minutes). The real exit is the `checkTime()` tool setting `toolContext.actions.escalate = true` after 120 seconds.
- **Single PlayAgent per loop iteration** (not separate Observe/Decide/Act agents) — reduces overhead. The LLM sees the screenshot and picks the action in one inference call.

---

## Tools (Playwright Wrappers as ADK FunctionTools)

### Core Tools

```
openGame(url: string)
  → Launches Playwright Chromium, navigates to URL, waits for canvas.
  → Returns: { status, viewportWidth, viewportHeight }

screenshot()
  → Captures page as JPEG (quality 80), base64-encodes it.
  → Returns: { status, image } where image is a Part with inline base64 data.

click(nx: number, ny: number)
  → nx, ny are normalized 0..1.
  → Converts to pixels: px = nx * viewportWidth, py = ny * viewportHeight.
  → Executes page.mouse.click(px, py).
  → Returns: { status, clickedX, clickedY }

drag(startX: number, startY: number, endX: number, endY: number, durationMs?: number)
  → All coords normalized 0..1. Default duration 500ms.
  → Executes mouse.move → mouse.down → mouse.move (stepped) → mouse.up.
  → Returns: { status }

tapHold(nx: number, ny: number, durationMs: number)
  → Click down, hold for duration, release.
  → Returns: { status }

wait(ms: number)
  → page.waitForTimeout(ms). Clamped to 100-5000ms.
  → Returns: { status, waited }

checkTime()
  → Compares Date.now() against stored start time.
  → If elapsed >= 120,000ms: sets toolContext.actions.escalate = true.
  → Returns: { status, elapsedMs, remainingMs, shouldStop }
```

### Error Response Contract

Every tool returns `{ status: "success" | "error", reason?: string, ...data }`. This lets the model reason about failures and adjust.

```typescript
// Example: click fails
{ status: "error", reason: "coordinates out of viewport bounds", nx: 1.2, ny: 0.5 }
```

### Guardrails (Enforced in Tool Code)

- Coordinates clamped to `[0, 1]` range before execution
- `wait()` clamped to `[100, 5000]` ms
- `drag()` duration clamped to `[100, 3000]` ms
- Tool execution wrapped in try/catch — errors returned as structured responses, never thrown

---

## Decision Engine (LLM Prompt Strategy)

### SetupAgent Instruction

```
You are a game agent. Your job is to open and prepare a web game for playing.

Steps:
1. Call openGame with the provided URL.
2. Call screenshot to see the current state.
3. The game is a canvas-based HTML5 game. There are NO DOM elements — everything
   is rendered on a canvas. You must identify visual elements from the screenshot.
4. If you see a start screen, tutorial, or "tap to play" prompt, click on it.
5. Keep clicking through any overlays until the actual game is running.
6. Once the game appears interactive (not a menu/loading screen), you are done.
```

### PlayAgent Instruction

```
You are playing a web game. Your goal is to make progress and try to win.

Each turn:
1. Call screenshot to see the current game state.
2. Analyze what you see — identify game objects, score, obstacles, interactive areas.
3. Decide the best action (click, drag, tapHold) and execute it.
4. Call checkTime to see if the 2-minute session is over.

Strategy:
- On your first turn, study the game to understand the mechanics.
- Look for patterns — matching colors, moving objects, targets to hit.
- If the game seems stuck (same screen repeatedly), try different actions:
  different positions, drags instead of clicks, or tap-and-hold.
- Prioritize actions that visibly change the game state.
- If you see a "game over" or "retry" screen, click to restart and keep playing.

You MUST call checkTime every turn. When it says shouldStop=true, stop acting.

Constraints:
- Coordinates are normalized 0..1 (0,0 = top-left, 1,1 = bottom-right).
- Do not repeat the exact same action more than 3 times in a row.
- Do not call wait unless you specifically need to wait for an animation.
```

### Output Format

The PlayAgent doesn't need `outputSchema` — it calls tools directly via function calling. The model sees the screenshot as a multimodal Part and decides which tool to invoke. This is standard ADK tool-use, not a custom JSON schema.

---

## Timing Enforcement

```typescript
// In openGame tool or a beforeAgentCallback on GameplayLoop:
toolContext.state.set('game_start_time', Date.now());

// In checkTime tool:
const startTime = toolContext.state.get<number>('game_start_time', 0);
const elapsed = Date.now() - startTime;
const remaining = Math.max(0, 120_000 - elapsed);

if (elapsed >= 120_000) {
  toolContext.actions.escalate = true;
}

return { status: 'success', elapsedMs: elapsed, remainingMs: remaining, shouldStop: elapsed >= 120_000 };
```

Wall-clock time, not action count. The LoopAgent exits via escalation when `checkTime` fires.

---

## Stuck Detection & Recovery

Handled in the PlayAgent instruction (not a separate agent or code heuristic):

1. **The model sees screenshots.** If consecutive screenshots look the same, the instruction tells it to vary actions.
2. **"Do not repeat the same action 3x" guardrail** prevents degenerate loops.
3. **Game-over detection** is visual — the model sees "Game Over" / "Retry" text and clicks through it.

Why not frame-diff code? Because:
- Canvas games with idle animations produce false positives.
- The vision model is already analyzing screenshots every turn — it knows if nothing changed.
- Adding frame-diff code means maintaining threshold tuning per game type.

---

## Artifacts & Logging

### During Run (In-Memory)

```typescript
// State tracks action history for the model's context:
toolContext.state.set('action_history', [...history, { action, timestamp, result }]);

// Screenshots: only keep last 3 in state (as temp: prefix, auto-discarded):
toolContext.state.set('temp:last_screenshot', base64Data);
```

### After Run (Saved to Disk)

```
artifacts/<runId>/
├── summary.json        # { url, duration, totalActions, finalScreenshot }
├── actions.jsonl       # one line per action: { timestamp, tool, args, result }
├── screens/            # sampled screenshots (every 10th + first + last)
│   ├── 0000_setup.jpg
│   ├── 0010_play.jpg
│   ├── 0020_play.jpg
│   └── final.jpg
└── video.mp4           # (optional) Playwright recording
```

The `saveSummary()` tool in FinalizeAgent writes these to disk.

---

## Browser Configuration

```typescript
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: false,          // headed for demo/debugging; headless for CI
  args: [
    '--disable-web-security',   // needed: AppLovin bootstrap may load cross-origin
    '--autoplay-policy=no-user-gesture-required',  // allow game audio/video
  ],
});

const context = await browser.newContext({
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 1,
  // Optional: record video
  recordVideo: { dir: `artifacts/${runId}/` },
});

const page = await context.newPage();
```

Viewport: **1024x768** — standard resolution, no scaling issues, fits within all model input constraints.

Teardown: `browser.close()` in a `finally` block wrapping the entire runner execution.

---

## Project Structure

```
unicostudio/
├── package.json
├── tsconfig.json
├── .env                          # GOOGLE_GENAI_API_KEY (gitignored)
├── .env.example                  # Template for env vars
├── agent.ts                      # ADK entry point (exports rootAgent)
├── src/
│   ├── agents/
│   │   ├── setup-agent.ts        # Custom BaseAgent — opens game, navigates menus
│   │   ├── play-turn-agent.ts    # Custom BaseAgent — screenshot→vision→action loop
│   │   ├── finalize-agent.ts     # Custom BaseAgent — saves artifacts & summary
│   │   └── game-runner.ts        # SequentialAgent + LoopAgent composition
│   ├── browser.ts                # Playwright singleton (launch, getPage, close)
│   ├── gemini.ts                 # Gemini client, function declarations, rate limiting
│   ├── actions.ts                # Action execution (click, drag, tapHold, wait)
│   ├── lib/
│   │   ├── coords.ts             # Coordinate normalization (0..1 → pixels)
│   │   ├── game-state.ts         # Shared runtime state + timing helpers
│   │   └── logger.ts             # JSONL action logger + screenshot saver
│   └── cli.ts                    # CLI entry: arg parsing, browser launch, runner
├── PLAN.md                       # This file
└── artifacts/                    # Generated per run (gitignored)
    └── run_<timestamp>/
        ├── summary.json
        ├── actions.jsonl
        └── screens/
```

---

## CLI Interface

```bash
# Play a game for 2 minutes
npm run play -- --url "https://playables.safedk.com/.../ad.html" --duration 120

# Play with visible browser (default)
npm run play -- --url "..." --duration 120 --headed

# Play headless (CI/eval)
npm run play -- --url "..." --duration 120 --headless

# Use ADK dev UI for debugging
npx adk web agent.ts
```

---

## Implementation Order

1. **Playwright tools** — `browser.ts`, `screenshot.ts`, `click.ts`, `wait.ts`, `open-game.ts`
2. **SetupAgent** — can it open the game and get past the start screen?
3. **PlayAgent + checkTime** — core gameplay loop
4. **LoopAgent wiring** — connect PlayAgent into the loop with escalation
5. **Remaining tools** — `drag.ts`, `tap-hold.ts`
6. **FinalizeAgent + artifacts** — save summary and screenshots
7. **SequentialAgent composition** — wire everything into GameRunner
8. **CLI** — arg parsing, entry point
9. **Guardrails** — repeated action detection, coord clamping
10. **ARCHITECTURE.md** — diagram and writeup for eval

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Gemini Flash can't reason about game mechanics from screenshots | Medium | Prompt engineering: ask it to describe what it sees before acting. Fall back to random-but-varied actions as baseline. |
| AppLovin bootstrap doesn't fire in Playwright | Low | The `al_renderHtml` function runs on page load. Playwright loads full pages including scripts. Add `--disable-web-security` flag. Verify with a manual headed test first. |
| Model returns coords outside 0..1 range | Medium | Clamped in tool code. Model instruction explicitly states the range. |
| 2-minute timing is off because model skips checkTime | Medium | Add checkTime call at the START of the PlayAgent instruction as a mandatory first step each turn. |
| Model gets stuck in a loop | Medium | "No 3x identical actions" guardrail in tool code. Instruction tells it to vary. |
| Latency too high, only 20-30 actions in 2 minutes | Medium | 20-30 actions is still enough for casual puzzle/tap games. The eval measures "progress", not action count. |
| Second sample URL returns 404 | Confirmed | URL 2 is dead. Test with URL 1 only, or find additional playable ad URLs. |

---

## What This Plan Explicitly Does NOT Include

- **Frame-diff stuck detection** — model handles this visually; threshold tuning per game is fragile
- **DOM/accessibility tools** — games are pure canvas, these return nothing useful
- **Golden dataset evaluation** — games are non-deterministic; eval is outcome-based (did it play? did it progress?)
- **A2A protocols, Vertex deployment** — out of scope
- **Database session persistence** — 2-minute in-memory session is fine

---

## Implementation Status

### Completed (v1 — commit 781d789)

- Full ADK TypeScript project with custom BaseAgent subclasses
- SequentialAgent → LoopAgent → PlayTurnAgent orchestration
- Playwright integration: click, drag, tapHold, wait with normalized 0..1 coords
- Direct Gemini 2.5 Flash vision calls (multimodal: screenshot + text → function call)
- Rate limiting (13s delay, 30-call hard cap) with fallback actions on 429
- Artifact generation: screenshots, actions.jsonl, summary.json
- CLI: `npm run play -- --url <url> --duration 120`

### First Test Results (Gemini 2.5 Flash, free tier)

| Metric | Result |
|---|---|
| Duration | 123s (target: 120s) |
| Total actions | 27 (all successful) |
| Gemini-guided actions | ~19 of 27 |
| Fallback actions (429 errors) | ~8 of 27 |
| Game understood | Yes — farm sim: joystick, scythe, money collection, building |
| Rate limit | 5 RPM free tier, hit 429 on ~30% of calls |

### Known Issues

1. **Free tier rate limit (5 RPM)** — too restrictive for real-time gameplay. ~30% of actions are blind fallbacks.
2. **Game type detection** — SetupAgent sometimes exhausts turns before calling `done_setup`, resulting in "unknown" game type.
3. **No multi-model support yet** — only Gemini. Anthropic Claude would solve rate limits and improve vision accuracy.

### Next Steps

- [ ] Add Anthropic Claude API as alternative vision model (solves rate limits)
- [ ] Add ARCHITECTURE.md for eval submission
- [ ] Improve setup phase (fewer turns needed, faster game detection)
- [ ] Test with additional game URLs

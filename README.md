# Game Agent - ADK TypeScript + Playwright + Gemini

An AI-powered game-playing agent built on Google ADK (Agent Development Kit) that opens HTML5 playable ad games, analyzes them, and plays autonomously for 2 minutes using vision-based reasoning.

## Architecture

```
SequentialAgent ("GameRunner")
├── SetupAgent (BaseAgent)
│   ├── Phase 1: Observe — capture 3 screenshots without interacting
│   ├── Phase 2: Analyze — Gemini vision extracts game type, controls, strategy
│   └── Phase 3: Interact — dismiss menus, start game
│
├── GameplayLoop (LoopAgent, maxIterations=80)
│   └── PlayTurnAgent (BaseAgent)
│       ├── Screenshot → Compress (384px) → Build context
│       ├── Gemini vision decides action (click/drag/tap_hold/wait)
│       ├── Adaptive fallback when API unavailable
│       └── Screen change tracking + stuck/obstacle detection
│
└── FinalizeAgent (BaseAgent)
    └── Capture final state, save summary + artifacts
```

### Key Design Decisions

- **Single agent per turn** — screenshot + reasoning + action in one API call (no separate observe/decide/act agents), minimizing latency
- **Multi-key x multi-model slot pool** — rotates across API keys and models on rate limits (429), maximizing uptime
- **Temporal screenshots** — sends 2 previous + current frame so the model sees what changed between turns
- **Adaptive fallback** — when API is unavailable, uses category-specific heuristics (joystick cycles, tap targets, exploration probes)
- **Screen change detection** — hash-based comparison tracks if actions have visible effect, with obstacle/wall navigation hints

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Agent Framework | Google ADK TypeScript (`@google/adk`) |
| AI Model | Gemini 2.5 Pro (primary) + Gemini 2.5 Flash (fallback) |
| Browser Automation | Playwright (Chromium, 1024x768 viewport) |
| Image Processing | Sharp (compression for API calls) |
| Language | TypeScript (strict mode) |

## Setup

```bash
# Install dependencies
npm install

# Configure API key
cp .env.example .env
# Add your Gemini API key to .env:
# GEMINI_API_KEY=your_key_here
# Or for multiple keys: GEMINI_API_KEYS=key1,key2,key3
```

## Usage

```bash
# Play a game for 2 minutes (default)
npm run play -- --url "https://playables.safedk.com/.../ad.html"

# Custom duration
npm run play -- --url "..." --duration 90

# Headless mode
npm run play -- --url "..." --headless

# ADK dev UI for debugging
npm run dev
```

## How It Works

1. **Setup Phase** (~5-10s, not counted in game timer):
   - Navigates to game URL
   - Captures 3 observation screenshots (1s apart)
   - Gemini analyzes: game type, control scheme, joystick position, strategy
   - Dismisses menus/tutorials to start actual gameplay

2. **Gameplay Loop** (120s):
   - Each turn: screenshot → compress → build context → Gemini decides action
   - Context includes: game type, strategy, controls, recent action history, screen change feedback, stuck detection
   - Actions: `click(x,y)`, `drag(startX,startY,endX,endY)`, `tap_hold(x,y,ms)`, `wait(ms)`
   - All coordinates normalized 0-1 (game-agnostic)

3. **Progress Tracking**:
   - Model reports visible numbers (score, money, level) each turn via `observations` field
   - Screen change detection (hash-based) tracks if actions have effect
   - Obstacle detection suggests perpendicular movement when stuck behind walls/fences
   - Stuck pattern detection (repeated clicks/drags at same position)

4. **Finalize**: captures final screenshot, saves summary JSON + action logs

## Artifacts

Each run generates:
```
artifacts/run_<timestamp>/
├── summary.json       # Game type, duration, total actions, results
├── actions.jsonl      # Every action with timestamp, coords, reason, result
└── screens/           # Sampled screenshots throughout the session
```

## Branch: `game-agnostic`

This branch contains the **game-agnostic** version of the agent. All model-facing prompts (system instructions and per-turn context) adapt dynamically based on the detected game type:

- **System prompt** contains no game-specific language — universal strategy and action-selection framework
- **Per-turn control context** provides rich, category-specific guidance (joystick, tap, drag, puzzle, unknown) — only the relevant block is shown to the model
- **Stuck/obstacle detection** uses generic perpendicular-direction hints instead of hardcoded positions
- **Model**: Gemini 2.5 Pro (primary) + Gemini 2.5 Flash (fallback)
- **Image compression**: 384px wide, JPEG q50

See also the **`fine-tune-via-test`** branch for a version iteratively tested and optimized against the sample Township game.

## Limitations

- Only Gemini API supported (ADK TypeScript has native Gemini integration; OpenAI/Anthropic would require custom `BaseLlm` adapter)
- Second sample game URL (`f7513e9b04...`) returns 404/blocked — could not test cross-game generalization
- Games are pure canvas — no DOM elements, so all interaction is vision + coordinate-based
- Gemini 2.5 Pro adds ~3-4s latency per turn; Flash is faster but less accurate

## Project Structure

```
├── agent.ts                    # ADK root agent export
├── src/
│   ├── cli.ts                  # CLI entry point
│   ├── browser.ts              # Playwright browser management
│   ├── gemini.ts               # Gemini API client, prompts, function declarations
│   ├── actions.ts              # Action execution + image compression
│   ├── agents/
│   │   ├── game-runner.ts      # SequentialAgent + LoopAgent composition
│   │   ├── setup-agent.ts      # Game observation + initialization
│   │   ├── play-turn-agent.ts  # Core gameplay loop (1 turn per iteration)
│   │   └── finalize-agent.ts   # Session cleanup + artifact generation
│   └── lib/
│       ├── game-state.ts       # Global state, learning, screen change detection
│       ├── logger.ts           # JSONL + screenshot logging
│       └── coords.ts           # Coordinate normalization utilities
├── package.json
├── tsconfig.json
└── PLAN.md                     # Original architecture plan
```

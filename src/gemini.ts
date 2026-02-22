import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';

// ── Multi-key × multi-model slot pool ──
// Each API key × model combination is a "slot" with independent rate limits.
// On 429, that specific slot is marked unavailable; the system rotates to the next.
// This maximizes throughput across multiple free-tier keys.

const MODELS = [
  'gemini-2.5-flash',       // 5 RPM, 20 RPD per key
  'gemini-2.5-flash-lite',  // 10 RPM, 20 RPD per key
  'gemini-2.0-flash',       // May have separate quota
] as const;

interface ApiSlot {
  client: GoogleGenAI;
  model: string;
  keyLabel: string;      // "key1", "key2" etc. for logging
  availableAt: number;   // 0 = available now
}

const slots: ApiSlot[] = [];
let slotIndex = 0;

function loadApiKeys(): string[] {
  // Preferred: comma-separated list in GEMINI_API_KEYS
  const multiKey = process.env.GEMINI_API_KEYS;
  if (multiKey) {
    return multiKey.split(',').map((k) => k.trim()).filter(Boolean);
  }
  // Fallback: single key
  const single = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
  return single ? [single] : [];
}

function initSlots(): void {
  if (slots.length > 0) return;

  const keys = loadApiKeys();
  if (keys.length === 0) {
    throw new Error(
      'No API keys found. Set GEMINI_API_KEYS (comma-separated) or GOOGLE_GENAI_API_KEY in .env'
    );
  }

  for (let k = 0; k < keys.length; k++) {
    const client = new GoogleGenAI({ apiKey: keys[k] });
    const label = keys.length > 1 ? `key${k + 1}` : 'key';
    for (const model of MODELS) {
      slots.push({ client, model, keyLabel: label, availableAt: 0 });
    }
  }

  console.log(
    `[Gemini] Initialized ${keys.length} API key(s) × ${MODELS.length} models = ${slots.length} slots`
  );
}

function getNextAvailableSlot(): ApiSlot | null {
  initSlots();
  const now = Date.now();
  for (let i = 0; i < slots.length; i++) {
    const idx = (slotIndex + i) % slots.length;
    if (now >= slots[idx].availableAt) {
      slotIndex = (idx + 1) % slots.length;
      return slots[idx];
    }
  }
  return null;
}

function markSlotRateLimited(slot: ApiSlot, retryDelayMs: number): void {
  // Google's quota is per-API-KEY, not per-model.
  // When one model on a key gets 429, mark ALL models for that key.
  const until = Date.now() + retryDelayMs;
  let markedCount = 0;
  for (const s of slots) {
    if (s.keyLabel === slot.keyLabel && s.availableAt < until) {
      s.availableAt = until;
      markedCount++;
    }
  }
  const secs = Math.round(retryDelayMs / 1000);
  console.log(`[RateLimit] ${slot.keyLabel} rate-limited for ${secs}s (all ${markedCount} models)`);
}

function parseRetryDelay(errorMessage: string): number {
  // Parse "retryDelay":"51s" or "Please retry in 51.748788721s"
  const match = errorMessage.match(/retry\s*(?:in|Delay['":]?\s*['":]?)\s*(\d+(?:\.\d+)?)\s*s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  return 60_000; // Default 60s if unparseable
}

// Rate limiting: enforce minimum delay between calls
let lastCallTime = 0;
let totalCalls = 0;
const MIN_DELAY_MS = 2_000; // With multiple keys, we can rotate faster between different keys
const MAX_TOTAL_CALLS = 50; // Conservative cap for total successful calls

export function getApiCallCount(): number {
  return totalCalls;
}

export function isApiBudgetExhausted(): boolean {
  return totalCalls >= MAX_TOTAL_CALLS;
}

export function isAnyModelAvailable(): boolean {
  initSlots();
  const now = Date.now();
  return slots.some((s) => now >= s.availableAt);
}

async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (lastCallTime > 0 && elapsed < MIN_DELAY_MS) {
    const waitTime = MIN_DELAY_MS - elapsed;
    console.log(`[RateLimit] Waiting ${Math.round(waitTime / 1000)}s before next API call...`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastCallTime = Date.now();
  totalCalls++;
  console.log(`[RateLimit] API call #${totalCalls}/${MAX_TOTAL_CALLS}`);
}

export const ACTION_DECLARATIONS = [
  {
    name: 'click',
    description:
      'Click at a position on the game screen. Coordinates are normalized: (0,0)=top-left, (1,1)=bottom-right.',
    parametersJsonSchema: {
      type: 'object' as const,
      properties: {
        x: { type: 'number', description: 'Horizontal position (0.0 to 1.0)' },
        y: { type: 'number', description: 'Vertical position (0.0 to 1.0)' },
        reason: { type: 'string', description: 'Brief explanation of why clicking here' },
      },
      required: ['x', 'y', 'reason'],
    },
  },
  {
    name: 'drag',
    description:
      'Drag from one position to another. Use for swipe gestures or moving objects.',
    parametersJsonSchema: {
      type: 'object' as const,
      properties: {
        startX: { type: 'number', description: 'Start horizontal position (0.0 to 1.0)' },
        startY: { type: 'number', description: 'Start vertical position (0.0 to 1.0)' },
        endX: { type: 'number', description: 'End horizontal position (0.0 to 1.0)' },
        endY: { type: 'number', description: 'End vertical position (0.0 to 1.0)' },
        reason: { type: 'string', description: 'Brief explanation of the drag action' },
      },
      required: ['startX', 'startY', 'endX', 'endY', 'reason'],
    },
  },
  {
    name: 'tap_hold',
    description: 'Tap and hold at a position. Use for long-press interactions.',
    parametersJsonSchema: {
      type: 'object' as const,
      properties: {
        x: { type: 'number', description: 'Horizontal position (0.0 to 1.0)' },
        y: { type: 'number', description: 'Vertical position (0.0 to 1.0)' },
        durationMs: {
          type: 'number',
          description: 'Hold duration in milliseconds (100-3000)',
        },
        reason: { type: 'string', description: 'Brief explanation' },
      },
      required: ['x', 'y', 'durationMs', 'reason'],
    },
  },
  {
    name: 'wait',
    description:
      'Wait without acting. Use when waiting for an animation, loading, or transition.',
    parametersJsonSchema: {
      type: 'object' as const,
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait (100-5000)' },
        reason: { type: 'string', description: 'Why waiting' },
      },
      required: ['ms', 'reason'],
    },
  },
];

export const SETUP_INSTRUCTION = `You are a game analysis and setup agent. Your job is to UNDERSTAND a web game and get it ready to play.

The game is an HTML5 canvas-based playable ad. Everything is rendered on a <canvas> — no DOM elements.

CRITICAL: NEVER click "Install", "Download", "Get it now", "Play Store", or "App Store" buttons. These are ad CTAs.

Your priority is to UNDERSTAND the game before acting:
1. READ all on-screen text carefully — instructions, tutorial text, button labels, score displays.
2. IDENTIFY the game type — is it a farm sim, match-3, runner, tap game, merge game, builder?
3. IDENTIFY the controls — is there a joystick? Tap targets? Swipe areas? Drag mechanics?
   - LOOK CAREFULLY at ALL screen edges and corners for control elements.
   - If you see a joystick/d-pad/control circle, note its EXACT center position (normalized 0-1 coordinates).
4. IDENTIFY the objective — what does the game want you to do? Follow arrows? Collect items? Build things?

When calling done_setup:
- gameType: Be SPECIFIC (e.g. "farm simulation with joystick movement and item collection", not just "action game")
- strategy: Describe EXACTLY how to play based on what you see.
- controlType: Report the primary control scheme you observed.
- controlCenterX/Y: Report the EXACT center coordinates of the primary control (joystick, main interaction area). This is CRITICAL — the agent cannot play without knowing where controls are. Look at the ENTIRE screen.

If you see a loading/start screen, click to proceed. If the game is running, call done_setup with detailed analysis.`;

export const SETUP_EXTRA_DECLARATIONS = [
  {
    name: 'done_setup',
    description:
      'Signal that the game is ready to play. Call this when the actual game is running (not a menu, loading, or tutorial screen). Include ALL observed control information.',
    parametersJsonSchema: {
      type: 'object' as const,
      properties: {
        gameType: {
          type: 'string',
          description:
            'What type of game this is (e.g. "match-3 puzzle", "tap action", "merge game", "runner with joystick")',
        },
        strategy: {
          type: 'string',
          description: 'Brief description of how to play and win',
        },
        controlType: {
          type: 'string',
          description:
            'Primary control scheme observed: "drag-joystick", "tap-targets", "swipe", "drag-objects", "tap-and-hold", or "unknown"',
        },
        controlCenterX: {
          type: 'number',
          description:
            'Normalized X (0-1) of the primary control area center (joystick, main button, drag origin). -1 if no fixed control position.',
        },
        controlCenterY: {
          type: 'number',
          description:
            'Normalized Y (0-1) of the primary control area center (joystick, main button, drag origin). -1 if no fixed control position.',
        },
      },
      required: ['gameType', 'strategy'],
    },
  },
];

export const OBSERVE_INSTRUCTION = `You are a game observation agent. Your job is to carefully ANALYZE screenshots of a web game WITHOUT taking any actions.

The game is an HTML5 canvas-based playable ad. Everything is rendered on a <canvas>.

CRITICAL: Read EVERYTHING on screen across all provided screenshots:

1. TEXT: Read ALL visible text — tutorial instructions, "DRAG TO MOVE", button labels, hints, objectives.
2. CONTROLS: Find the EXACT position of any joystick, buttons, tap zones, or interactive areas.
   - If you see a joystick circle, report its CENTER coordinates precisely (normalized 0-1).
   - Look at ALL corners and edges — joysticks can be bottom-left, bottom-right, or elsewhere.
3. GAME TYPE: What kind of game is this? (farm sim, runner, match-3, merge, builder, etc.)
4. OBJECTIVE: What does the game want the player to do? Follow arrows? Collect items? Build?
5. STRATEGY: Based on the tutorial/instructions, how should the player interact?

You are given multiple screenshots taken over several seconds. Compare them to understand:
- What changed between frames (animations, tutorial progression)
- Whether the game auto-advanced or is waiting for input
- The full tutorial sequence if it spans multiple frames

Call game_analysis with your findings.`;

export const GAME_ANALYSIS_DECLARATION = [
  {
    name: 'game_analysis',
    description:
      'Report the analysis of the observed game screenshots. Describe the game type, controls, and strategy.',
    parametersJsonSchema: {
      type: 'object' as const,
      properties: {
        gameType: {
          type: 'string',
          description:
            'Specific game type (e.g. "farm simulation with joystick movement", "match-3 puzzle", "tap runner")',
        },
        strategy: {
          type: 'string',
          description:
            'Detailed strategy: how to play, what to interact with, what to avoid',
        },
        controlType: {
          type: 'string',
          description:
            'Primary control scheme: "drag-joystick", "tap-targets", "swipe", "drag-objects", "tap-and-hold", or "unknown"',
        },
        joystickX: {
          type: 'number',
          description:
            'Normalized X coordinate (0-1) of joystick center, if a joystick is visible. -1 if no joystick.',
        },
        joystickY: {
          type: 'number',
          description:
            'Normalized Y coordinate (0-1) of joystick center, if a joystick is visible. -1 if no joystick.',
        },
        firstAction: {
          type: 'string',
          description:
            'What the player should do FIRST to start playing (e.g. "tap center to dismiss tutorial", "drag joystick right to move")',
        },
      },
      required: ['gameType', 'strategy', 'controlType', 'joystickX', 'joystickY', 'firstAction'],
    },
  },
];

export const PLAY_INSTRUCTION = `You are an expert game player. Your goal is to ACTIVELY PLAY the game and make real progress.

NEVER click "Install"/"Download"/"Get" buttons — they are ads.

CRITICAL — ARROWS AND INDICATORS:
- Blue/colored ARROWS on the game screen are DIRECTION INDICATORS, not buttons.
- Do NOT click arrows. They show you WHERE TO MOVE, not what to tap.
- To follow an arrow: use DRAG action in the direction the arrow points.

CRITICAL — MOVEMENT:
- Most games use a JOYSTICK or DRAG for movement. If you see a character and arrows:
  1. Look for a joystick circle (often bottom-left or bottom-right of screen).
  2. DRAG from the joystick center in the direction you want to move.
  3. If JOYSTICK LOCATION is given in context, ALWAYS drag from that exact position.
  4. If no joystick location is known, try dragging from bottom-right (~0.75, 0.75) or bottom-left (~0.2, 0.8).
- DRAG DIRECTION: arrow points RIGHT → drag joystick RIGHT (increase X). Arrow LEFT → decrease X. Arrow DOWN → increase Y.
- After reaching a destination, CLICK on nearby objects (buildings, items, NPCs) to interact.

CRITICAL — STUCK DETECTION:
- If clicking the same spot 2+ times has no effect, STOP. It's not interactive.
- If the screen hasn't changed after 3 actions, try a completely DIFFERENT action type (switch from click to drag, or drag in the opposite direction).

Each turn: Look at the screenshot. What changed since last turn? Choose an action that makes PROGRESS.

Coordinates: (0,0)=top-left, (1,1)=bottom-right.`;

/** Single-turn API call (used by setup) */
export async function askGeminiForAction(
  base64Screenshot: string,
  systemInstruction: string,
  functionDeclarations: any[],
  contextText: string
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const contents = [
    {
      role: 'user' as const,
      parts: [
        { text: contextText },
        { inlineData: { data: base64Screenshot, mimeType: 'image/jpeg' } },
      ],
    },
  ];
  return callGemini(contents, systemInstruction, functionDeclarations);
}

/** Single-turn API call for gameplay with rich text context (avoids Gemini multi-turn format issues) */
export async function askGeminiForPlayAction(
  base64Screenshot: string,
  contextText: string
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const contents = [
    {
      role: 'user' as const,
      parts: [
        { text: contextText },
        { inlineData: { data: base64Screenshot, mimeType: 'image/jpeg' } },
      ],
    },
  ];
  return callGemini(contents, PLAY_INSTRUCTION, ACTION_DECLARATIONS);
}

/** Multi-image observation call: sends multiple screenshots in one API request */
export async function askGeminiForObservation(
  screenshots: string[]
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const parts: any[] = [
    { text: `Analyze these ${screenshots.length} game screenshots taken over several seconds. Read ALL on-screen text, identify controls (especially joystick position), and describe the game.` },
  ];
  for (let i = 0; i < screenshots.length; i++) {
    parts.push({ text: `Screenshot ${i + 1} of ${screenshots.length}:` });
    parts.push({ inlineData: { data: screenshots[i], mimeType: 'image/jpeg' } });
  }

  const contents = [{ role: 'user' as const, parts }];
  return callGemini(contents, OBSERVE_INSTRUCTION, GAME_ANALYSIS_DECLARATION);
}

/** Core API call shared by single-turn and multi-turn */
async function callGemini(
  contents: Array<{ role: string; parts: any[] }>,
  systemInstruction: string,
  functionDeclarations: any[]
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  if (isApiBudgetExhausted()) {
    console.log(`[Gemini] API budget exhausted (${MAX_TOTAL_CALLS} calls). Skipping.`);
    return null;
  }

  const slot = getNextAvailableSlot();
  if (!slot) {
    console.log(`[Gemini] All slots rate-limited. Skipping API call.`);
    return null;
  }

  await enforceRateLimit();
  console.log(`[Gemini] Using ${slot.keyLabel}/${slot.model}`);

  try {
    const response = await slot.client.models.generateContent({
      model: slot.model,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
          },
        },
        thinkingConfig: { thinkingBudget: 2048 },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    const fcPart = parts.find((p: any) => p.functionCall);
    if (!fcPart?.functionCall) return null;

    return {
      name: fcPart.functionCall.name ?? '',
      args: (fcPart.functionCall.args as Record<string, unknown>) ?? {},
    };
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      const retryMs = parseRetryDelay(msg);
      markSlotRateLimited(slot, retryMs);
      // Don't count rate-limited calls against the budget — they never reached the model
      totalCalls = Math.max(0, totalCalls - 1);
      console.log(`[RateLimit] 429 doesn't count against budget. Effective calls: ${totalCalls}/${MAX_TOTAL_CALLS}`);
    }
    throw err;
  }
}

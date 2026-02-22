import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';

// ── Multi-key × multi-model slot pool (Paid Tier) ──
// Each API key × model combination is a "slot" with independent rate limits.
// On 429, that specific slot is marked unavailable; the system rotates to the next.
// Paid tier limits: Flash=1K RPM/10K RPD, Flash-Lite=4K RPM/Unlimited, Pro=150 RPM/1K RPD

const MODELS = [
  'gemini-2.5-pro',                  // Best quality for gameplay decisions
  'gemini-2.5-flash',              // 1K RPM — fast fallback
] as const;

interface ApiSlot {
  client: GoogleGenAI;
  model: string;
  keyLabel: string;      // "key1", "key2" etc. for logging
  availableAt: number;   // 0 = available now
}

const slots: ApiSlot[] = [];

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

  // Build clients once per key
  const clients = keys.map((apiKey, i) => ({
    client: new GoogleGenAI({ apiKey }),
    label: keys.length > 1 ? `key${i + 1}` : 'key',
  }));

  // Model-first ordering: best model across ALL keys before falling back to weaker models.
  // This ensures key1/flash → key2/flash → key3/flash → key4/flash → key1/flash-lite → ...
  for (const model of MODELS) {
    for (const { client, label } of clients) {
      slots.push({ client, model, keyLabel: label, availableAt: 0 });
    }
  }

  console.log(
    `[Gemini] Initialized ${keys.length} API key(s) × ${MODELS.length} models = ${slots.length} slots`
  );
  console.log(`[Gemini] Rotation order: ${slots.map(s => `${s.keyLabel}/${s.model.replace('gemini-', '')}`).join(' → ')}`);
}

function getNextAvailableSlot(): ApiSlot | null {
  initSlots();
  const now = Date.now();
  // Always try the best model first (index 0). Only fall to worse models if better ones are unavailable.
  for (let i = 0; i < slots.length; i++) {
    if (now >= slots[i].availableAt) {
      return slots[i];
    }
  }
  return null;
}

function markSlotRateLimited(slot: ApiSlot, retryDelayMs: number): void {
  // Rate limits are per-model per-key (e.g. Flash=5 RPM, Flash Lite=10 RPM).
  // Only mark the specific slot that got 429'd, not other models on the same key.
  slot.availableAt = Date.now() + retryDelayMs;
  const secs = Math.round(retryDelayMs / 1000);
  console.log(`[RateLimit] ${slot.keyLabel}/${slot.model} rate-limited for ${secs}s`);
}

function parseRetryDelay(errorMessage: string): number {
  // Parse "retryDelay":"51s" or "Please retry in 51.748788721s" or "retry after 30s"
  const match = errorMessage.match(/retry\s*(?:in|after|Delay['":]?\s*['":]?)\s*(\d+(?:\.\d+)?)\s*s/i);
  if (match) {
    const parsed = Math.ceil(parseFloat(match[1]) * 1000);
    console.log(`[RateLimit] Parsed retry delay: ${Math.round(parsed / 1000)}s`);
    return parsed;
  }
  console.log(`[RateLimit] Could not parse retry delay from error, using default 20s. Error snippet: "${errorMessage.slice(0, 120)}"`);
  return 20_000; // Default 20s — conservative enough but not wasteful for a 2-min session
}

// Rate limiting: enforce minimum delay between SUCCESSFUL calls only
let lastCallTime = 0;
let totalCalls = 0;
const MIN_DELAY_MS = 200; // Minimal gap — actual pace is governed by action interval (1.5s) + API latency
const MAX_TOTAL_CALLS = 500; // Paid tier: effectively unlimited for a 2-min session

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

/** Log which slots are available vs blocked (for debugging rotation) */
function logSlotStatus(): void {
  const now = Date.now();
  const available = slots.filter(s => now >= s.availableAt);
  const blocked = slots.filter(s => now < s.availableAt);
  const blockedInfo = blocked.map(s => {
    const remainSec = Math.round((s.availableAt - now) / 1000);
    return `${s.keyLabel}/${s.model.replace('gemini-', '')}(${remainSec}s)`;
  });
  console.log(`[Gemini] Slots: ${available.length} available, ${blocked.length} blocked${blocked.length > 0 ? ' [' + blockedInfo.join(', ') + ']' : ''}`);
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
        observations: { type: 'string', description: 'Visible numbers on screen: score, money, level, timer, counters. Example: "Money: $150, Level: 3, Timer: 45s". Report what you see NOW.' },
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
        observations: { type: 'string', description: 'Visible numbers on screen: score, money, level, timer, counters. Example: "Money: $150, Level: 3, Timer: 45s". Report what you see NOW.' },
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
        observations: { type: 'string', description: 'Visible numbers on screen: score, money, level, timer, counters.' },
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
        observations: { type: 'string', description: 'Visible numbers on screen: score, money, level, timer, counters.' },
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

export const PLAY_INSTRUCTION = `You are an expert game player. Maximize score and progress in any game.

NEVER click "Install"/"Download"/"Get" buttons — they are ads that end the game.

EVERY TURN:
1. Compare previous screenshot to current — what CHANGED?
2. Report visible numbers (score, money, level) in the "observations" field.
3. If no progress in 3+ turns, CHANGE your approach entirely.

CONTROLS:
- Follow the CONTROLS section in the turn context — it explains how THIS game works.
- If an action produces no visible change, STOP repeating it and try something different.
- If clicking the same spot 2+ times has no effect, it's not interactive.

ACTION SELECTION:
- DRAG = movement, navigating your character to a new position.
- CLICK = interact with UI buttons or objects you are already next to.
- To REACH something: DRAG/move toward it first.
- To INTERACT: WALK INTO it first. Only CLICK if walking into it fails.

STRATEGY:
- Have a clear sub-goal each turn.
- If it fails after 3 tries, abandon it and try something new.
- After completing a goal, look for the NEXT hint: arrows, glowing areas, new objects.
- Explore new areas when stuck.

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

/** Single-turn API call for gameplay with screenshot history for temporal context.
 *  Sends up to 3 compressed frames so the model can see how the game evolved. */
export async function askGeminiForPlayAction(
  currentScreenshot: string,
  contextText: string,
  screenshotHistory: string[] = []
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const parts: any[] = [
    { text: contextText },
  ];

  // Send screenshot history (oldest first) for temporal context
  // screenshotHistory contains past compressed frames (not including current)
  if (screenshotHistory.length >= 2) {
    parts.push({ text: 'SCREENSHOT FROM 2 TURNS AGO (reference):' });
    parts.push({ inlineData: { data: screenshotHistory[screenshotHistory.length - 2], mimeType: 'image/jpeg' } });
  }
  if (screenshotHistory.length >= 1) {
    parts.push({ text: 'PREVIOUS TURN SCREENSHOT (before your last action):' });
    parts.push({ inlineData: { data: screenshotHistory[screenshotHistory.length - 1], mimeType: 'image/jpeg' } });
  }
  parts.push({ text: screenshotHistory.length > 0 ? 'CURRENT SCREENSHOT (after your last action — act on THIS):' : 'CURRENT SCREENSHOT:' });
  parts.push({ inlineData: { data: currentScreenshot, mimeType: 'image/jpeg' } });

  const contents = [{ role: 'user' as const, parts }];
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

/** Core API call — retries across all available slots on 429 before giving up */
async function callGemini(
  contents: Array<{ role: string; parts: any[] }>,
  systemInstruction: string,
  functionDeclarations: any[]
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  if (isApiBudgetExhausted()) {
    console.log(`[Gemini] API budget exhausted (${MAX_TOTAL_CALLS} calls). Skipping.`);
    return null;
  }

  // Ensure slots are initialized before anything else
  initSlots();

  // Enforce minimum delay between SUCCESSFUL API calls (not retries)
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (lastCallTime > 0 && elapsed < MIN_DELAY_MS) {
    const waitTime = MIN_DELAY_MS - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  logSlotStatus();

  // Try all available slots — on 429, immediately try the next one (no delay)
  let attempts = 0;
  const maxAttempts = slots.length;

  while (attempts < maxAttempts) {
    const slot = getNextAvailableSlot();
    if (!slot) {
      console.log(`[Gemini] All slots exhausted after ${attempts} attempt(s). Falling back.`);
      return null;
    }

    attempts++;
    totalCalls++;
    console.log(`[Gemini] → ${slot.keyLabel}/${slot.model} (attempt ${attempts})`);

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
          thinkingConfig: { thinkingBudget: 512 },
        },
      });

      // Success — update timing
      lastCallTime = Date.now();
      console.log(`[Gemini] ✓ ${slot.keyLabel}/${slot.model} succeeded (call #${totalCalls}/${MAX_TOTAL_CALLS})`);

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
      totalCalls = Math.max(0, totalCalls - 1);

      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        const retryMs = parseRetryDelay(msg);
        markSlotRateLimited(slot, retryMs);
        continue;
      }

      if (msg.includes('404') || msg.includes('not found')) {
        // Model doesn't exist — permanently disable this slot
        slot.availableAt = Infinity;
        console.log(`[Gemini] ✗ ${slot.keyLabel}/${slot.model} not found — permanently disabled`);
        continue;
      }

      if (msg.includes('503') || msg.includes('overloaded') || msg.includes('high demand')) {
        // Temporary server issue — cool off for 10s
        markSlotRateLimited(slot, 10_000);
        console.log(`[Gemini] ✗ ${slot.keyLabel}/${slot.model} overloaded — trying next slot`);
        continue;
      }

      // Unknown error — still try next slot instead of throwing
      console.log(`[Gemini] ✗ ${slot.keyLabel}/${slot.model} error: ${msg.slice(0, 100)} — trying next slot`);
      markSlotRateLimited(slot, 15_000);
      continue;
    }
  }

  console.log(`[Gemini] Tried all ${maxAttempts} slots, all rate-limited. Falling back.`);
  return null;
}

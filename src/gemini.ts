import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';

let ai: GoogleGenAI | null = null;

// Rate limiting: no retries, enforce minimum delay between calls
let lastCallTime = 0;
let totalCalls = 0;
const MIN_DELAY_MS = 13_000; // ~4.6 RPM to stay under 5 RPM free tier limit
const MAX_TOTAL_CALLS = 30; // Hard cap to protect daily quota

export function getAI(): GoogleGenAI {
  if (!ai) {
    const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Missing API key. Set GOOGLE_GENAI_API_KEY or GEMINI_API_KEY in your .env file.'
      );
    }
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

export function getApiCallCount(): number {
  return totalCalls;
}

export function isApiBudgetExhausted(): boolean {
  return totalCalls >= MAX_TOTAL_CALLS;
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

export const SETUP_INSTRUCTION = `You are a game setup agent. Your job is to get a web game ready to play.

The game is an HTML5 canvas-based playable ad. There are NO DOM elements you can target — everything is rendered on a <canvas>.

Look at the screenshot and decide what to do:
- If you see a loading screen, call wait.
- If you see a "Tap to play", "Start", "Play", or similar prompt, click on it.
- If you see a tutorial overlay or instruction screen, click to dismiss it.
- If the game appears to be actively running (game elements visible, no overlay), call done_setup.

Be patient — some games take a few seconds to load. Try clicking center-screen if nothing obvious is visible.`;

export const SETUP_EXTRA_DECLARATIONS = [
  {
    name: 'done_setup',
    description:
      'Signal that the game is ready to play. Call this when the actual game is running (not a menu, loading, or tutorial screen).',
    parametersJsonSchema: {
      type: 'object' as const,
      properties: {
        gameType: {
          type: 'string',
          description:
            'What type of game this is (e.g. "match-3 puzzle", "tap action", "merge game", "runner")',
        },
        strategy: {
          type: 'string',
          description: 'Brief description of how to play and win',
        },
      },
      required: ['gameType', 'strategy'],
    },
  },
];

export const PLAY_INSTRUCTION = `You are playing a web game. Your goal is to make progress and try to win.

The game is rendered on a canvas. You interact by clicking, dragging, or tapping and holding at specific coordinates.

Each turn:
1. Study the screenshot carefully — identify game objects, score, obstacles, interactive elements.
2. Choose the BEST action to make progress. Think about the game mechanics.
3. Vary your actions — don't repeat the exact same click position more than 2 times in a row.

Strategy tips:
- For match-3/puzzle games: look for groups of matching colors and click/drag to swap.
- For tap games: tap on targets, avoid obstacles.
- For merge games: drag similar items together.
- For runner games: swipe/drag to dodge obstacles.
- If nothing seems to change after a few actions, try a different area or action type.
- If you see "game over", "retry", or "play again", click it to restart.
- If you see a store/shop overlay or ad, look for an X or close button.

Coordinates are normalized: (0,0)=top-left, (1,1)=bottom-right. The center is (0.5, 0.5).`;

export async function askGeminiForAction(
  base64Screenshot: string,
  systemInstruction: string,
  functionDeclarations: any[],
  contextText: string
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  // Hard budget check — no retries, just stop
  if (isApiBudgetExhausted()) {
    console.log(`[Gemini] API budget exhausted (${MAX_TOTAL_CALLS} calls). Skipping.`);
    return null;
  }

  await enforceRateLimit();

  const client = getAI();

  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: contextText },
          { inlineData: { data: base64Screenshot, mimeType: 'image/jpeg' } },
        ],
      },
    ],
    config: {
      systemInstruction,
      tools: [{ functionDeclarations }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
        },
      },
      thinkingConfig: { thinkingBudget: 1024 },
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
}

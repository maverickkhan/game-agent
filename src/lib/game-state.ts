export interface ActionRecord {
  action: string;
  args?: Record<string, unknown>;
  reason: string;
  timestamp: number;
  result: string;
  source: 'api' | 'fallback'; // Track where the action came from
}

export interface GameState {
  url: string;
  startTime: number;
  duration: number;
  actions: ActionRecord[];
  screenshots: { timestamp: number; path?: string }[];
  gameType: string;
  strategy: string;
  runId: string;
  artifactDir: string;
  // Learned knowledge from API-guided turns
  learned: LearnedKnowledge;
}

export interface LearnedKnowledge {
  // Successful actions the API chose (replay these during fallback)
  successfulActions: { name: string; args: Record<string, unknown> }[];
  // Areas the API interacted with (likely important game elements)
  interactiveAreas: { x: number; y: number; count: number; lastTappedTurn: number }[];
  // Detected game category for adaptive fallback
  category: 'joystick' | 'tap' | 'puzzle' | 'drag' | 'unknown';
  // Phase: observe first, then exploit learned patterns
  phase: 'observing' | 'playing';
  // How many API-guided turns we've had
  apiGuidedTurns: number;
  // Discovered joystick position from observation phase
  joystickCenter?: { x: number; y: number };
  // Control scheme discovered from tutorial (e.g. "drag-joystick", "tap-targets", "swipe")
  controlScheme?: string;
  // Direction memory: last API-directed movement direction
  lastApiDirection?: { dx: number; dy: number; setAtTurn: number };
  // API budget pacing
  lastApiCallTurn: number;
  fallbackTurnsSinceApi: number;
  // Screen change detection
  lastScreenshotHash: number;
  screenChanged: boolean;
}

export const gameState: GameState = {
  url: '',
  startTime: 0,
  duration: 120_000,
  actions: [],
  screenshots: [],
  gameType: 'unknown',
  strategy: '',
  runId: '',
  artifactDir: '',
  learned: createEmptyKnowledge(),
};

function createEmptyKnowledge(): LearnedKnowledge {
  return {
    successfulActions: [],
    interactiveAreas: [],
    category: 'unknown',
    phase: 'observing',
    apiGuidedTurns: 0,
    lastApiCallTurn: -1,
    fallbackTurnsSinceApi: 0,
    lastScreenshotHash: 0,
    screenChanged: false,
  };
}

export function resetGameState(url: string, duration: number, runId: string): void {
  gameState.url = url;
  gameState.startTime = 0;
  gameState.duration = duration;
  gameState.actions = [];
  gameState.screenshots = [];
  gameState.gameType = 'unknown';
  gameState.strategy = '';
  gameState.runId = runId;
  gameState.artifactDir = `artifacts/${runId}`;
  gameState.learned = createEmptyKnowledge();
}

/** Record what the API chose so fallback can replay similar actions */
export function learnFromApiAction(fc: { name: string; args: Record<string, unknown> }, turnNumber: number): void {
  const k = gameState.learned;
  k.apiGuidedTurns++;

  // Reset API pacing counters
  k.lastApiCallTurn = turnNumber;
  k.fallbackTurnsSinceApi = 0;
  k.screenChanged = false;

  // Store the action
  k.successfulActions.push({ name: fc.name, args: { ...fc.args } });
  // Keep last 20
  if (k.successfulActions.length > 20) k.successfulActions.shift();

  // Extract direction memory from drag actions
  if (fc.name === 'drag') {
    const sx = fc.args.startX as number;
    const sy = fc.args.startY as number;
    const ex = fc.args.endX as number;
    const ey = fc.args.endY as number;
    if (typeof sx === 'number' && typeof ex === 'number') {
      const rawDx = ex - sx;
      const rawDy = ey - sy;
      const mag = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
      if (mag > 0.02) {
        // Normalize to standard magnitude ~0.10
        k.lastApiDirection = {
          dx: (rawDx / mag) * 0.10,
          dy: (rawDy / mag) * 0.10,
          setAtTurn: turnNumber,
        };
      }
    }
  }

  // Track interactive areas
  const x = (fc.args.x as number) ?? (fc.args.startX as number);
  const y = (fc.args.y as number) ?? (fc.args.startY as number);
  if (typeof x === 'number' && typeof y === 'number') {
    const existing = k.interactiveAreas.find(
      (a) => Math.abs(a.x - x) < 0.1 && Math.abs(a.y - y) < 0.1
    );
    if (existing) {
      existing.count++;
    } else {
      k.interactiveAreas.push({ x, y, count: 1, lastTappedTurn: -1 });
    }
  }

  // Auto-detect game category from action patterns
  if (k.apiGuidedTurns >= 3) {
    const drags = k.successfulActions.filter((a) => a.name === 'drag').length;
    const clicks = k.successfulActions.filter((a) => a.name === 'click').length;
    const ratio = drags / Math.max(1, clicks + drags);

    if (ratio > 0.6) {
      // Mostly drags — check if they originate from similar area (joystick)
      const dragStarts = k.successfulActions
        .filter((a) => a.name === 'drag')
        .map((a) => ({ x: a.args.startX as number, y: a.args.startY as number }));
      const avgX = dragStarts.reduce((s, d) => s + d.x, 0) / dragStarts.length;
      const avgY = dragStarts.reduce((s, d) => s + d.y, 0) / dragStarts.length;
      const spread = dragStarts.reduce(
        (s, d) => s + Math.abs(d.x - avgX) + Math.abs(d.y - avgY),
        0
      ) / dragStarts.length;

      k.category = spread < 0.15 ? 'joystick' : 'drag';
    } else if (clicks > drags) {
      k.category = 'tap';
    }

    k.phase = 'playing';
  }
}

/** Cheap hash of a base64 screenshot — sample chars at fixed intervals */
export function computeScreenHash(base64: string): number {
  if (!base64 || base64.length < 256) return 0;
  let hash = 0;
  const step = Math.floor(base64.length / 128);
  for (let i = 0; i < base64.length; i += step) {
    hash = ((hash << 5) - hash + base64.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Compare new screenshot hash against last, set screenChanged flag */
export function detectScreenChange(newHash: number): boolean {
  const k = gameState.learned;
  const changed = k.lastScreenshotHash !== 0 && k.lastScreenshotHash !== newHash;
  k.lastScreenshotHash = newHash;
  if (changed) k.screenChanged = true;
  return changed;
}

export function getElapsedMs(): number {
  if (!gameState.startTime) return 0;
  return Date.now() - gameState.startTime;
}

export function getRemainingMs(): number {
  return Math.max(0, gameState.duration - getElapsedMs());
}

export function isTimeUp(): boolean {
  return gameState.startTime > 0 && getElapsedMs() >= gameState.duration;
}

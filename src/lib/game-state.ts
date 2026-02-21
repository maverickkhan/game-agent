export interface ActionRecord {
  action: string;
  args?: Record<string, unknown>;
  reason: string;
  timestamp: number;
  result: string;
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
};

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

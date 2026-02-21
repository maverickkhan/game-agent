export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function denormalize(
  nx: number,
  ny: number,
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: Math.round(clamp(nx, 0, 1) * width),
    y: Math.round(clamp(ny, 0, 1) * height),
  };
}

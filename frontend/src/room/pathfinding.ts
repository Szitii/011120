interface ObstacleBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Normalized furniture foot-collision boxes (0..1)
const ROOM_OBSTACLES: ObstacleBox[] = [
  { x1: 0.02, y1: 0.22, x2: 0.35, y2: 0.56 }, // Double bed
  { x1: 0.33, y1: 0.28, x2: 0.45, y2: 0.43 }, // Nightstand
  { x1: 0.65, y1: 0.22, x2: 0.98, y2: 0.43 }, // USM vinyl cabinet + floor lamp
  { x1: 0.82, y1: 0.37, x2: 0.99, y2: 0.68 }, // Wavy mirror
  { x1: 0.40, y1: 0.50, x2: 0.75, y2: 0.68 }, // Double sofa
  { x1: 0.42, y1: 0.65, x2: 0.73, y2: 0.79 }, // Cloud coffee table
  { x1: 0.03, y1: 0.56, x2: 0.23, y2: 0.83 }, // Olive plant
];

const GRID_COLS = 49;
const GRID_ROWS = 51;
const WALK_MIN_X = 0.14;
const WALK_MAX_X = 0.81;
const WALK_MIN_Y = 0.42;
const WALK_MAX_Y = 0.87;

function isPointBlocked(nx: number, ny: number): boolean {
  if (nx < WALK_MIN_X || nx > WALK_MAX_X || ny < WALK_MIN_Y || ny > WALK_MAX_Y) return true;
  for (const b of ROOM_OBSTACLES) {
    if (nx >= b.x1 && nx <= b.x2 && ny >= b.y1 && ny <= b.y2) return true;
  }
  return false;
}

function segmentIntersectsBox(ax: number, ay: number, bx: number, by: number, b: ObstacleBox, pad = 0.012): boolean {
  const x1 = b.x1 - pad;
  const y1 = b.y1 - pad;
  const x2 = b.x2 + pad;
  const y2 = b.y2 + pad;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, ax - x1],
    [dx, x2 - ax],
    [-dy, ay - y1],
    [dy, y2 - ay],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-8) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

function isSegmentClear(ax: number, ay: number, bx: number, by: number): boolean {
  if (
    ax < WALK_MIN_X || ax > WALK_MAX_X || ay < WALK_MIN_Y || ay > WALK_MAX_Y ||
    bx < WALK_MIN_X || bx > WALK_MAX_X || by < WALK_MIN_Y || by > WALK_MAX_Y
  ) {
    return false;
  }
  for (const b of ROOM_OBSTACLES) {
    if (segmentIntersectsBox(ax, ay, bx, by, b, 0.012)) return false;
  }
  return true;
}

export type RoomPoint = { nx: number; ny: number };

type GridPoint = RoomPoint & { index: number };

const gridPoints: GridPoint[] = [];
for (let row = 0; row < GRID_ROWS; row++) {
  for (let col = 0; col < GRID_COLS; col++) {
    const nx = col / (GRID_COLS - 1);
    const ny = row / (GRID_ROWS - 1);
    if (!isPointBlocked(nx, ny)) gridPoints.push({ nx, ny, index: row * GRID_COLS + col });
  }
}
const pointsByIndex = new Map(gridPoints.map((point) => [point.index, point]));
const neighbors = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;

function closestPoint(target: RoomPoint, allowed: (point: GridPoint) => boolean) {
  let nearest: GridPoint | undefined;
  let bestDistance = Infinity;
  for (const point of gridPoints) {
    const distance = (target.nx - point.nx) ** 2 + (target.ny - point.ny) ** 2;
    if (distance < bestDistance && allowed(point)) {
      nearest = point;
      bestDistance = distance;
    }
  }
  return nearest;
}

export function findSafePath(start: RoomPoint, target: RoomPoint, exactTarget = false): RoomPoint[] | null {
  const connects = (a: RoomPoint, b: RoomPoint) => isSegmentClear(a.nx, a.ny, b.nx, b.ny);
  const entry = closestPoint(start, (point) => connects(start, point));
  if (!entry) return null;

  const parents = new Int32Array(GRID_COLS * GRID_ROWS).fill(-1);
  parents[entry.index] = entry.index;
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    const point = queue[i];
    const col = point.index % GRID_COLS;
    const row = Math.floor(point.index / GRID_COLS);
    for (const [dx, dy] of neighbors) {
      const nextCol = col + dx;
      const nextRow = row + dy;
      if (nextCol < 0 || nextCol >= GRID_COLS || nextRow < 0 || nextRow >= GRID_ROWS) continue;
      const next = pointsByIndex.get(nextRow * GRID_COLS + nextCol);
      if (next && parents[next.index] === -1 && connects(point, next)) {
        parents[next.index] = point.index;
        queue.push(next);
      }
    }
  }

  const end = closestPoint(target, (point) => parents[point.index] !== -1 && (!exactTarget || connects(point, target)));
  if (!end) return null;

  const route: RoomPoint[] = [];
  for (let index = end.index; index !== entry.index; index = parents[index]) {
    route.push(pointsByIndex.get(index)!);
  }
  route.push(entry);
  route.reverse();
  if (exactTarget) route.push(target);

  // Merge consecutive moves along the same axis without cutting corners.
  const steps: RoomPoint[] = [];
  for (const point of route) {
    const previous = steps.at(-1);
    const beforePrevious = steps.at(-2) ?? start;
    if (previous && ((previous.nx === beforePrevious.nx && previous.nx === point.nx)
      || (previous.ny === beforePrevious.ny && previous.ny === point.ny))) {
      steps[steps.length - 1] = point;
    } else {
      steps.push(point);
    }
  }
  return steps;
}

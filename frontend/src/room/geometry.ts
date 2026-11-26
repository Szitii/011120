export type RoomPoint = { nx: number; ny: number };
export type ActorId = "user" | "companion";
export type FurnitureId = "sofa" | "bed";

const point = (nx: number, ny: number): RoomPoint => ({ nx, ny });

export const SPAWN = { user: point(.60, .46), companion: point(.46, .46) };
// These rectangles are shared by the rendered slots and the collision grid.
export const SOFA_SLOT = { left: .41, top: .50, width: .34, height: .18 };
export const TABLE_SLOT = { left: .44, top: .66, width: .28, height: .14 };
const bounds = ({ left, top, width, height }: typeof SOFA_SLOT): ObstacleBox =>
  ({ x1: left, y1: top, x2: left + width, y2: top + height });
export const BED_FLOOR_EDGE = .56;
export const FURNITURE = {
  sofa: {
    bounds: bounds(SOFA_SLOT),
    user: { approach: point(.79, .704), anchor: point(.64, .646) },
    companion: { approach: point(.365, .704), anchor: point(.525, .646) },
  },
  bed: {
    bounds: { x1: .02, y1: .22, x2: .35, y2: BED_FLOOR_EDGE },
    user: { approach: point(.46, .475), anchor: point(.235, .385) },
    companion: { approach: point(.39, .47), anchor: point(.125, .385) },
  },
} satisfies Record<FurnitureId, { bounds: ObstacleBox } & Record<ActorId, { approach: RoomPoint; entry?: RoomPoint; anchor: RoomPoint }>>;

export interface ObstacleBox { x1: number; y1: number; x2: number; y2: number }
export const ROOM_OBSTACLES: readonly ObstacleBox[] = [
  FURNITURE.bed.bounds,
  { x1: .33, y1: .28, x2: .45, y2: .43 },
  { x1: .65, y1: .22, x2: .98, y2: .43 },
  { x1: .82, y1: .37, x2: .99, y2: .68 },
  FURNITURE.sofa.bounds,
  bounds(TABLE_SLOT),
  { x1: .03, y1: .56, x2: .23, y2: .83 },
];

export const WAKE_POINTS = { companion: point(.267, .592), user: point(.366, .592) };
export const DUO_POINTS = { companion: point(.499, .478), user: point(.581, .478) };
export const DUO_SLOT = { left: .407, top: .305, width: .266, height: .175 };

export type RoomPoint = { nx: number; ny: number };
export type ActorId = "user" | "companion";
export type FurnitureId = "sofa" | "bed";

const point = (nx: number, ny: number): RoomPoint => ({ nx, ny });

export const SPAWN = { user: point(.60, .46), companion: point(.46, .46) };
export const FURNITURE = {
  sofa: {
    bounds: { x1: .40, y1: .50, x2: .75, y2: .68 },
    user: { approach: point(.78, .71), entry: point(.65, .681), anchor: point(.624, .655) },
    companion: { approach: point(.38, .71), entry: point(.515, .681), anchor: point(.532, .655) },
  },
  bed: {
    bounds: { x1: .02, y1: .22, x2: .35, y2: .56 },
    user: { approach: point(.42, .47), entry: point(.294, .45), anchor: point(.235, .390) },
    companion: { approach: point(.39, .47), entry: point(.294, .427), anchor: point(.125, .390) },
  },
} satisfies Record<FurnitureId, { bounds: ObstacleBox } & Record<ActorId, { approach: RoomPoint; entry: RoomPoint; anchor: RoomPoint }>>;

export interface ObstacleBox { x1: number; y1: number; x2: number; y2: number }
export const ROOM_OBSTACLES: readonly ObstacleBox[] = [
  FURNITURE.bed.bounds,
  { x1: .33, y1: .28, x2: .45, y2: .43 },
  { x1: .65, y1: .22, x2: .98, y2: .43 },
  { x1: .82, y1: .37, x2: .99, y2: .68 },
  FURNITURE.sofa.bounds,
  { x1: .42, y1: .65, x2: .73, y2: .79 },
  { x1: .03, y1: .56, x2: .23, y2: .83 },
];

export const DUO_POINTS = { companion: point(.487, .84), user: point(.568, .84) };

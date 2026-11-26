import { SOFA_SLOT, TABLE_SLOT } from "./geometry";
export type RoomImage = number;
import type { CompanionAction } from "../../../contracts/companion-actions.ts";

export const DUO_SPRITES = {
  PAT_HEAD: [require("../../assets/room_v2/duo_pat_1.png"), require("../../assets/room_v2/duo_pat_2.png")],
  HUG: [require("../../assets/room_v2/duo_hug_1.png"), require("../../assets/room_v2/duo_hug_2.png")],
  CUDDLE: [require("../../assets/room_v2/duo_cuddle_1.png"), require("../../assets/room_v2/duo_cuddle_2.png")],
} satisfies Record<Exclude<CompanionAction, "WAVE">, readonly [RoomImage, RoomImage]>;

export const DUO_COMPANION_PAT_SPRITES: readonly [RoomImage, RoomImage] = [
  require("../../assets/room_v2/duo_pat_by_companion_1.png"),
  require("../../assets/room_v2/duo_pat_by_companion_2.png"),
];

type RoomLayerKind = "floor_base" | "wall_back" | "dynamic_y";

interface RoomSlotSpec {
  id: string;
  name: string;
  layer: RoomLayerKind;
  source: RoomImage;
  /** Fractional coordinates relative to the 4:5 room frame (0..1) */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Baseline Y fraction used for Y-axis zIndex sorting with characters */
  sortY: number;
  interactive?: "diary" | "pet";
}

export const DIARY_SLOT_IMAGE: RoomImage = require("../../assets/room_v2/slot_diary.png");
export const ALBUM_SLOT_IMAGE: RoomImage = require("../../assets/room_v2/slot_album.png");
export const ROOM_BASE_IMAGE: RoomImage = require("../../assets/room_v2/room_base.png");
export const BED_QUILT_OVERLAY: RoomImage = require("../../assets/room_v2/slot_bed_quilt.png");

export const ROOM_SLOTS: RoomSlotSpec[] = [
  // Floor layer (always under characters)
  {
    id: "slot_rug",
    name: "中庭大地毯",
    layer: "floor_base",
    source: require("../../assets/room_v2/slot_rug.png"),
    left: 0.30,
    top: 0.56,
    width: 0.56,
    height: 0.31,
    sortY: 0.1,
  },
  // Wall & back furniture (always behind characters)
  {
    id: "slot_window",
    name: "窗户与窗帘",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_window.png"),
    left: 0.28,
    top: 0.08,
    width: 0.49,
    height: 0.24,
    sortY: 0.2,
  },
  {
    id: "slot_pet",
    name: "窗台小猫",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_pet.png"),
    left: 0.48,
    top: 0.20,
    width: 0.11,
    height: 0.09,
    sortY: 0.25,
    interactive: "pet",
  },
  {
    id: "slot_art_left",
    name: "左侧装饰画",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_art_left.png"),
    left: 0.06,
    top: 0.05,
    width: 0.17,
    height: 0.13,
    sortY: 0.22,
  },
  {
    id: "slot_art_right",
    name: "右侧装饰画",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_art_right.png"),
    left: 0.80,
    top: 0.08,
    width: 0.16,
    height: 0.12,
    sortY: 0.22,
  },
  {
    id: "slot_bed",
    name: "格子双人床与床头柜",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_bed.png"),
    left: 0.02,
    top: 0.22,
    width: 0.43,
    height: 0.34,
    sortY: 0.35,
  },
  {
    id: "slot_cabinet",
    name: "书桌与电脑区",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_cabinet.png"),
    left: 0.65,
    top: 0.22,
    width: 0.33,
    height: 0.21,
    sortY: 0.40,
  },
  {
    id: "slot_lamp",
    name: "右上落地灯",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_lamp.png"),
    left: 0.85,
    top: 0.26,
    width: 0.13,
    height: 0.24,
    sortY: 0.45,
  },
  {
    id: "slot_mirror",
    name: "右侧全身镜",
    layer: "wall_back",
    source: require("../../assets/room_v2/slot_mirror.png"),
    left: 0.88,
    top: 0.37,
    width: 0.11,
    height: 0.31,
    sortY: 0.60,
  },
  // Dynamic Y-sorted foreground/midground slots
  {
    id: "slot_sofa",
    name: "双人沙发",
    layer: "dynamic_y",
    source: require("../../assets/room_v2/slot_sofa.png"),
    ...SOFA_SLOT,
    sortY: 0.58,
  },
  {
    id: "slot_table",
    name: "玻璃茶几",
    layer: "dynamic_y",
    source: require("../../assets/room_v2/slot_table.png"),
    ...TABLE_SLOT,
    sortY: 0.78,
  },
  {
    id: "slot_diary",
    name: "粉色日记本",
    layer: "dynamic_y",
    source: DIARY_SLOT_IMAGE,
    left: 0.60,
    top: 0.70,
    width: 0.09,
    height: 0.065,
    sortY: 0.80,
    interactive: "diary",
  },
  {
    id: "slot_plant",
    name: "左下大橄榄树",
    layer: "dynamic_y",
    source: require("../../assets/room_v2/slot_plant.png"),
    left: 0.015,
    top: 0.59,
    width: 0.165,
    height: 0.27,
    sortY: 0.85,
  },
];

export type CharacterAction =
  | "idle"
  | "walk_1" | "walk_2" | "walk_3" | "walk_4"
  | "walk_front_1" | "walk_front_2" | "walk_front_3" | "walk_front_4"
  | "walk_back_1" | "walk_back_2" | "walk_back_3" | "walk_back_4"
  | "sit" | "pajama" | "wave" | "sleep";

export const BOY_SPRITES: Record<CharacterAction, RoomImage> = {
  idle: require("../../assets/room_v2/boy_idle.png"),
  walk_1: require("../../assets/room_v2/boy_walk_1.png"),
  walk_2: require("../../assets/room_v2/boy_walk_2.png"),
  walk_3: require("../../assets/room_v2/boy_walk_3.png"),
  walk_4: require("../../assets/room_v2/boy_walk_4.png"),
  walk_front_1: require("../../assets/room_v2/boy_walk_front_1.png"),
  walk_front_2: require("../../assets/room_v2/boy_walk_front_2.png"),
  walk_front_3: require("../../assets/room_v2/boy_walk_front_3.png"),
  walk_front_4: require("../../assets/room_v2/boy_walk_front_4.png"),
  walk_back_1: require("../../assets/room_v2/boy_walk_back_1.png"),
  walk_back_2: require("../../assets/room_v2/boy_walk_back_2.png"),
  walk_back_3: require("../../assets/room_v2/boy_walk_back_3.png"),
  walk_back_4: require("../../assets/room_v2/boy_walk_back_4.png"),
  sit: require("../../assets/room_v2/boy_sit.png"),
  pajama: require("../../assets/room_v2/boy_pajama.png"),
  wave: require("../../assets/room_v2/boy_wave.png"),
  sleep: require("../../assets/room_v2/boy_sleep.png"),
};

export const GIRL_SPRITES: Record<CharacterAction, RoomImage> = {
  idle: require("../../assets/room_v2/girl_idle.png"),
  walk_1: require("../../assets/room_v2/girl_walk_1.png"),
  walk_2: require("../../assets/room_v2/girl_walk_2.png"),
  walk_3: require("../../assets/room_v2/girl_walk_3.png"),
  walk_4: require("../../assets/room_v2/girl_walk_4.png"),
  walk_front_1: require("../../assets/room_v2/girl_idle.png"),
  walk_front_2: require("../../assets/room_v2/girl_walk_front_2.png"),
  walk_front_3: require("../../assets/room_v2/girl_idle.png"),
  walk_front_4: require("../../assets/room_v2/girl_walk_front_4.png"),
  walk_back_1: require("../../assets/room_v2/girl_walk_back_1.png"),
  walk_back_2: require("../../assets/room_v2/girl_walk_back_2.png"),
  walk_back_3: require("../../assets/room_v2/girl_walk_back_3.png"),
  walk_back_4: require("../../assets/room_v2/girl_walk_back_4.png"),
  sit: require("../../assets/room_v2/girl_sit.png"),
  pajama: require("../../assets/room_v2/girl_pajama.png"),
  wave: require("../../assets/room_v2/girl_wave.png"),
  sleep: require("../../assets/room_v2/girl_sleep.png"),
};

export const SOFA_FRONT: RoomImage = require("../../assets/room_v2/slot_sofa_front.png");

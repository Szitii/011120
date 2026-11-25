import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { DUO_POINTS, FURNITURE, SPAWN, WAKE_POINTS, type ActorId, type FurnitureId, type RoomPoint } from "./geometry.ts";
import { findSafePath } from "./pathfinding.ts";

const ACTORS = ["companion", "user"] as const;
const WALK_FRAME_DISTANCE = .026;
const MOVE_PER_MS = .00025;
const PLACEMENT_MS = 160;
const autonomousDelay = () => 20_000 + Math.random() * 20_000;
const AUTONOMOUS_POOL: readonly DuoAction[] = ["PAT_HEAD", "HUG", "CUDDLE"];

type DuoAction = Exclude<CompanionAction, "WAVE">;
type Phase = "IDLE" | "WALK" | "SIT" | "SLEEP" | "DUO";
export type FacingDir = "side" | "front" | "back";
export type ActionInitiator = "OWNER" | "COMPANION";

export type ActorFrame = {
  point: RoomPoint;
  phase: Phase;
  step: number;
  facingLeft: boolean;
  facingDir: FacingDir;
  opacity?: number;
  furniture?: FurnitureId;
  wave?: boolean;
};
type Step = { point: RoomPoint; furniture?: FurnitureId; pose?: Phase; transition?: Phase; place?: boolean };
type Track = { frame: ActorFrame; steps: Step[]; travelled: number; placementMs: number };
type Effect = { id: number; type: "heart" | "ripple"; point: RoomPoint; start: number };
type RoomFrame = {
  actors: Record<ActorId, ActorFrame>;
  duo?: { action: DuoAction; frame: number; initiator: ActionInitiator };
  effects: (Effect & { progress: number })[];
  time: number;
};
type Plan = { actor: ActorId; steps: Step[] };

const distance = (a: RoomPoint, b: RoomPoint) => Math.hypot((a.nx - b.nx) * .8, a.ny - b.ny);
function faceSide(from: RoomPoint, to: RoomPoint, previous: boolean) {
  const dx = (to.nx - from.nx) * .8;
  const dy = to.ny - from.ny;
  return Math.abs(dx) > 1e-6 && Math.abs(dx) >= Math.abs(dy) ? dx < 0 : previous;
}
function faceDir(from: RoomPoint, to: RoomPoint, previous: FacingDir = "side"): FacingDir {
  const dx = Math.abs(to.nx - from.nx) * .8;
  const dy = to.ny - from.ny;
  if (dx < 1e-6 && Math.abs(dy) < 1e-6) return previous;
  if (Math.abs(dy) > dx * 1.15) return dy > 0 ? "front" : "back";
  return "side";
}

const makeTrack = (point: RoomPoint): Track => ({
  frame: { point, phase: "IDLE", step: 0, facingLeft: false, facingDir: "front" },
  steps: [],
  travelled: 0,
  placementMs: 0,
});

export class RoomEngine {
  private tracks = { user: makeTrack(SPAWN.user), companion: makeTrack(SPAWN.companion) };
  private task?: { stages: Plan[][]; action?: CompanionAction; initiator: ActionInitiator; started?: number };
  private time = 0;
  private idleSince = 0;
  private autoCount = 0;
  private nextAutonomousDelay = autonomousDelay();
  private changed = false;
  private effects: Effect[] = [];
  private effectId = 0;
  private startedActions: CompanionAction[] = [];

  get sleeping() {
    return ACTORS.some(actor => this.tracks[actor].frame.phase === "SLEEP");
  }

  get isAnimating() {
    return this.locked || this.sleeping || this.effects.length > 0 ||
      ACTORS.some(actor => this.tracks[actor].steps.length > 0);
  }

  consumeChange() {
    const changed = this.changed;
    this.changed = false;
    return changed;
  }

  private get locked() {
    return this.task !== undefined;
  }

  private resetIdle() {
    this.idleSince = this.time;
  }

  floor(point: RoomPoint) {
    this.resetIdle();
    const user = this.tracks.user;
    if (this.locked || this.sleeping || (user.frame.furniture && user.steps.length)) return;
    const plan = this.plan("user", point);
    if (!plan) return;
    if (plan.steps.length) this.apply(plan);
    else {
      user.steps = [];
      user.frame = { ...user.frame, phase: "IDLE", step: 0, facingDir: "front" };
    }
    this.addEffect("ripple", plan.steps.at(-1)?.point ?? point);
  }

  furniture(furniture: FurnitureId) {
    this.resetIdle();
    if (this.locked) return;
    if (furniture === "bed" && this.sleeping) { this.wake(); return; }
    if (this.sleeping) return;
    const companion = this.plan("companion", FURNITURE[furniture].companion.anchor, furniture);
    const user = this.plan("user", FURNITURE[furniture].user.anchor, furniture);
    if (!companion || !user) return;
    const plans = [companion, user];
    const approaches = plans.map(plan => ({ ...plan, steps: plan.steps.slice(0, -1) }));
    const placements = plans.map(plan => ({ ...plan, steps: plan.steps.slice(-1) }));
    this.begin(approaches, undefined, [placements]);
  }

  wake() {
    this.resetIdle();
    if (this.locked || !this.sleeping) return;
    // Same fade as getting into bed: sliding a seated sprite to the floor passes under the quilt.
    this.begin(ACTORS.map(actor => ({ actor, steps: [{ point: WAKE_POINTS[actor], pose: "IDLE", place: true }] })));
  }

  action(action: CompanionAction, initiator: ActionInitiator = "OWNER") {
    this.resetIdle();
    if (this.locked || this.sleeping) return;
    const companion = this.plan("companion", DUO_POINTS.companion, undefined, true);
    const user = this.plan("user", DUO_POINTS.user, undefined, true);
    if (!companion || !user) return;
    this.begin([companion, user], action, [], initiator);
  }

  addEffect(type: Effect["type"], point: RoomPoint) {
    this.effects = [...this.effects.slice(-5), { id: ++this.effectId, type, point, start: this.time }];
  }

  private plan(actor: ActorId, target: RoomPoint, furniture?: FurnitureId, exact = false): Plan | undefined {
    const start = this.tracks[actor].frame;
    if (furniture && start.furniture === furniture && start.phase !== "WALK") return { actor, steps: [] };
    const exit = start.furniture ? FURNITURE[start.furniture][actor] : undefined;
    const from = exit?.approach ?? start.point;
    const dock = furniture ? FURNITURE[furniture][actor] : undefined;
    const path = findSafePath(from, dock?.approach ?? target, exact || Boolean(dock));
    if (!path) return;
    const steps: Step[] = [];
    if (exit) steps.push({ point: exit.approach, place: true });
    steps.push(...path.map(point => ({ point })));
    if (dock) {
      steps.push({
        point: dock.anchor,
        furniture,
        pose: furniture === "bed" ? "SLEEP" : "SIT",
        place: true,
      });
    }
    return { actor, steps };
  }

  private begin(plans: Plan[], action?: CompanionAction, stages: Plan[][] = [], initiator: ActionInitiator = "OWNER") {
    this.task = { stages, action, initiator };
    plans.forEach(plan => this.apply(plan));
  }

  private apply(plan: Plan) {
    if (!plan.steps.length) return;
    const track = this.tracks[plan.actor];
    track.steps = plan.steps;
    track.placementMs = 0;
    if (track.frame.phase !== "WALK") track.travelled = 0;
    const firstMove = plan.steps.find(step => distance(track.frame.point, step.point) > 1e-6);
    if (firstMove && !plan.steps[0].place && !plan.steps[0].pose && (plan.steps[0].transition ?? "WALK") === "WALK") {
      track.frame = {
        ...track.frame, phase: "WALK", step: Math.floor(track.travelled / WALK_FRAME_DISTANCE) % 4,
        facingLeft: faceSide(track.frame.point, firstMove.point, track.frame.facingLeft),
        facingDir: faceDir(track.frame.point, firstMove.point, track.frame.facingDir),
      };
    }
  }

  private advance(track: Track, milliseconds: number) {
    let remaining = milliseconds * MOVE_PER_MS;
    while (track.steps.length && remaining > 1e-8) {
      const next = track.steps[0];
      if (next.place) {
        // Change anchors only while the sprite is fully faded between poses.
        const duration = Math.min(remaining / MOVE_PER_MS, PLACEMENT_MS - track.placementMs);
        track.placementMs += duration;
        remaining -= duration * MOVE_PER_MS;
        const progress = track.placementMs / PLACEMENT_MS;
        const arrived = progress >= .5;
        track.frame = {
          ...track.frame,
          point: arrived ? next.point : track.frame.point,
          // A sleeper fades out lying down; standing it up first would flash it on the pillow.
          phase: arrived ? next.pose ?? "IDLE" : track.frame.phase === "SLEEP" ? "SLEEP" : "IDLE",
          facingDir: "front",
          furniture: arrived ? next.furniture : track.frame.furniture,
          opacity: Math.abs(1 - 2 * progress),
        };
        if (progress === 1) {
          track.steps.shift();
          track.placementMs = 0;
        }
        continue;
      }
      const previous = track.frame.point;
      const length = distance(previous, next.point);
      const travelled = Math.min(remaining, length);
      const fraction = length < .00001 ? 1 : travelled / length;
      const arrived = fraction >= 1;
      const point = arrived ? next.point : {
        nx: previous.nx + (next.point.nx - previous.nx) * fraction,
        ny: previous.ny + (next.point.ny - previous.ny) * fraction,
      };
      if ((next.transition ?? "WALK") === "WALK") track.travelled += travelled;
      remaining -= travelled;
      if (arrived) track.steps.shift();
      track.frame = {
        point,
        phase: arrived && next.pose ? next.pose : arrived && !track.steps.length ? "IDLE" : next.transition ?? "WALK",
        step: Math.floor(track.travelled / WALK_FRAME_DISTANCE) % 4,
        facingLeft: faceSide(previous, next.point, track.frame.facingLeft),
        facingDir: arrived && !track.steps.length ? "front" : faceDir(previous, next.point, track.frame.facingDir),
        furniture: arrived && next.pose === "IDLE" ? undefined : next.furniture,
      };
    }
  }

  tick(delta: number, allowAutonomous = false) {
    this.changed = this.isAnimating;
    if (this.changed || !allowAutonomous) this.resetIdle();
    const dt = Math.max(0, Math.min(33, delta));
    this.time += dt;
    this.effects = this.effects.filter(effect => this.time - effect.start < 720);
    const task = this.task;
    ACTORS.forEach(actor => this.advance(this.tracks[actor], dt));
    if (task && ACTORS.every(actor => !this.tracks[actor].steps.length)) {
      const nextStage = task.stages.shift();
      if (nextStage) nextStage.forEach(plan => this.apply(plan));
      else if (!task.action) this.task = undefined;
      else if (task.started === undefined) {
        task.started = this.time;
        for (const actor of ACTORS) this.tracks[actor].frame = { ...this.tracks[actor].frame, phase: "DUO", facingDir: "front" };
        if (task.action !== "WAVE") this.addEffect("heart", { nx: DUO_POINTS.user.nx - .04, ny: DUO_POINTS.user.ny - .18 });
        if (task.initiator === "OWNER") this.startedActions.push(task.action);
      } else if (this.time - task.started >= (task.action === "WAVE" ? 720 : 1680)) {
        this.task = undefined;
        for (const actor of ACTORS) this.tracks[actor].frame = { ...this.tracks[actor].frame, phase: "IDLE", facingDir: "front" };
        this.resetIdle();
      }
    } else if (
      allowAutonomous
      && ACTORS.every(actor => this.tracks[actor].frame.phase === "IDLE" && !this.tracks[actor].steps.length)
      && this.time - this.idleSince >= this.nextAutonomousDelay
    ) {
      const pick = AUTONOMOUS_POOL[this.autoCount % AUTONOMOUS_POOL.length];
      this.autoCount++;
      this.nextAutonomousDelay = autonomousDelay();
      this.action(pick, "COMPANION");
    }
  }

  takeStartedActions() { return this.startedActions.splice(0); }

  snapshot(): RoomFrame {
    const task = this.task;
    return {
      actors: {
        companion: this.tracks.companion.frame,
        user: { ...this.tracks.user.frame, wave: task?.action === "WAVE" && task.started !== undefined },
      },
      duo: task?.action && task.action !== "WAVE" && task.started !== undefined
        ? { action: task.action, frame: Math.floor((this.time - task.started) / 280) % 2, initiator: task.initiator }
        : undefined,
      effects: this.effects.map(effect => ({ ...effect, progress: (this.time - effect.start) / 720 })),
      time: this.time,
    };
  }
}

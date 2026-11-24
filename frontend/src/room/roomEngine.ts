import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { BED_FLOOR_EDGE, DUO_POINTS, FURNITURE, SPAWN, WAKE_POINTS, type ActorId, type FurnitureId, type RoomPoint } from "./geometry.ts";
import { findSafePath } from "./pathfinding.ts";

const ACTORS = ["companion", "user"] as const;
const WALK_FRAME_DISTANCE = .026;
type DuoAction = Exclude<CompanionAction, "WAVE">;
type Phase = "IDLE" | "WALK" | "SIT" | "SLEEP" | "DUO";
export type ActorFrame = {
  point: RoomPoint;
  phase: Phase;
  step: number;
  facingLeft: boolean;
  furniture?: FurnitureId;
  wave?: boolean;
};
type Step = { point: RoomPoint; furniture?: FurnitureId; pose?: Phase; transition?: Phase };
type Track = { frame: ActorFrame; steps: Step[]; travelled: number };
type Effect = { id: number; type: "heart" | "ripple"; point: RoomPoint; start: number };
type RoomFrame = {
  actors: Record<ActorId, ActorFrame>;
  duo?: { action: DuoAction; frame: number };
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
const makeTrack = (point: RoomPoint): Track => ({ frame: { point, phase: "IDLE", step: 0, facingLeft: false }, steps: [], travelled: 0 });

export class RoomEngine {
  private tracks = { user: makeTrack(SPAWN.user), companion: makeTrack(SPAWN.companion) };
  private task?: { stages: Plan[][]; action?: CompanionAction; started?: number };
  private time = 0;
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

  floor(point: RoomPoint) {
    const user = this.tracks.user;
    if (this.locked || this.sleeping || (user.frame.furniture && user.steps.length)) return;
    const plan = this.plan("user", point);
    if (!plan) return;
    if (plan.steps.length) this.apply(plan);
    else {
      user.steps = [];
      user.frame = { ...user.frame, phase: "IDLE", step: 0 };
    }
    this.addEffect("ripple", plan.steps.at(-1)?.point ?? point);
  }

  furniture(furniture: FurnitureId) {
    if (this.locked) return;
    if (furniture === "bed" && this.sleeping) { this.wake(); return; }
    if (this.sleeping) return;
    const companion = this.plan("companion", FURNITURE[furniture].companion.anchor, furniture);
    const user = this.plan("user", FURNITURE[furniture].user.anchor, furniture);
    if (!companion || !user) return;
    const plans = [companion, user];
    if (furniture === "bed") {
      const walks = plans.map(plan => ({ ...plan, steps: plan.steps.slice(0, -2) }));
      const docks = plans.map(plan => ({ ...plan, steps: plan.steps.slice(-2) }));
      this.begin(walks, undefined, docks.map(dock => [dock]));
    } else this.begin(plans);
  }

  wake() {
    if (this.locked || !this.sleeping) return;
    this.begin(ACTORS.map(actor => {
      const pillow = FURNITURE.bed[actor].anchor;
      const floor = WAKE_POINTS[actor];
      return {
        actor,
        steps: [
          { point: pillow, furniture: "bed", pose: "SIT" },
          { point: { nx: floor.nx, ny: BED_FLOOR_EDGE }, transition: "SIT", furniture: "bed" },
          { point: floor, pose: "IDLE" },
        ],
      };
    }));
  }

  action(action: CompanionAction) {
    if (this.locked || this.sleeping) return;
    const companion = this.plan("companion", DUO_POINTS.companion, undefined, true);
    const user = this.plan("user", DUO_POINTS.user, undefined, true);
    if (!companion || !user) return;
    this.begin([companion, user], action);
  }

  addEffect(type: Effect["type"], point: RoomPoint) {
    this.effects = [...this.effects.slice(-5), { id: ++this.effectId, type, point, start: this.time }];
  }

  private plan(actor: ActorId, target: RoomPoint, furniture?: FurnitureId, exact = false): Plan | undefined {
    const start = this.tracks[actor].frame;
    if (furniture && start.furniture === furniture && start.phase !== "WALK") return { actor, steps: [] };
    const from = start.furniture ? FURNITURE[start.furniture][actor].approach : start.point;
    const dock = furniture ? FURNITURE[furniture][actor] : undefined;
    const path = findSafePath(from, dock?.approach ?? target, exact || Boolean(dock));
    if (!path) return;
    const steps = path.map(point => ({ point }) as Step);
    if (start.furniture) {
      const exit = FURNITURE[start.furniture][actor];
      steps.unshift({ point: exit.approach, furniture: start.furniture, pose: "IDLE" });
      if (exit.entry) steps.unshift({ point: exit.entry, furniture: start.furniture });
    }
    if (dock && furniture) {
      const entry = FURNITURE[furniture][actor].entry;
      const bed = furniture === "bed";
      if (entry) steps.push({ point: entry, furniture, transition: bed ? "SIT" : undefined });
      steps.push({ point: dock.anchor, furniture, pose: bed ? "SLEEP" : "SIT", transition: bed ? "SIT" : undefined });
    }
    return { actor, steps };
  }

  private begin(plans: Plan[], action?: CompanionAction, stages: Plan[][] = []) {
    this.task = { stages, action };
    plans.forEach(plan => this.apply(plan));
  }

  private apply(plan: Plan) {
    if (!plan.steps.length) return;
    const track = this.tracks[plan.actor];
    track.steps = plan.steps;
    if (track.frame.phase !== "WALK") track.travelled = 0;
    const firstMove = plan.steps.find(step => distance(track.frame.point, step.point) > 1e-6);
    if (firstMove && !plan.steps[0].transition && !plan.steps[0].pose) {
      track.frame = {
        ...track.frame, phase: "WALK", step: Math.floor(track.travelled / WALK_FRAME_DISTANCE) % 4,
        facingLeft: faceSide(track.frame.point, firstMove.point, track.frame.facingLeft),
      };
    }
  }

  private advance(track: Track, milliseconds: number) {
    let remaining = milliseconds * .00025;
    while (track.steps.length && remaining > 1e-8) {
      const next = track.steps[0];
      const previous = track.frame.point;
      const length = distance(previous, next.point);
      const travelled = Math.min(remaining, length);
      const fraction = length < .00001 ? 1 : travelled / length;
      const arrived = fraction >= 1;
      const point = arrived ? next.point : {
        nx: previous.nx + (next.point.nx - previous.nx) * fraction,
        ny: previous.ny + (next.point.ny - previous.ny) * fraction,
      };
      if (!next.transition) track.travelled += travelled;
      remaining -= travelled;
      if (arrived) track.steps.shift();
      track.frame = {
        point, phase: arrived && next.pose ? next.pose : arrived && !track.steps.length ? "IDLE" : next.transition ?? "WALK",
        step: Math.floor(track.travelled / WALK_FRAME_DISTANCE) % 4,
        facingLeft: faceSide(previous, next.point, track.frame.facingLeft),
        furniture: arrived && next.pose === "IDLE" ? undefined : next.furniture,
      };
    }
  }

  tick(delta: number) {
    this.changed = this.isAnimating;
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
        for (const actor of ACTORS) this.tracks[actor].frame = { ...this.tracks[actor].frame, phase: "DUO" };
        if (task.action !== "WAVE") this.addEffect("heart", { nx: DUO_POINTS.user.nx - .04, ny: DUO_POINTS.user.ny - .18 });
        this.startedActions.push(task.action);
      } else if (this.time - task.started >= (task.action === "WAVE" ? 720 : 1680)) {
        this.task = undefined;
        for (const actor of ACTORS) this.tracks[actor].frame = { ...this.tracks[actor].frame, phase: "IDLE" };
      }
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
      duo: task?.action && task.action !== "WAVE" && task.started !== undefined ? { action: task.action, frame: Math.floor((this.time - task.started) / 280) % 2 } : undefined,
      effects: this.effects.map(effect => ({ ...effect, progress: (this.time - effect.start) / 720 })),
      time: this.time,
    };
  }
}

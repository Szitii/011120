import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { DUO_POINTS, FURNITURE, SPAWN, WAKE_POINTS, type ActorId, type FurnitureId, type RoomPoint } from "./geometry.ts";
import { findSafePath } from "./pathfinding.ts";

const PLACEMENT_MS = 240;
const ACTORS = ["companion", "user"] as const;
type DuoAction = Exclude<CompanionAction, "WAVE">;
type Phase = "IDLE" | "WALK" | "SIT" | "SLEEP" | "DUO";
export type ActorFrame = {
  point: RoomPoint;
  phase: Phase;
  step: number;
  facingLeft: boolean;
  furniture?: FurnitureId;
  wave?: boolean;
  opacity?: number;
};
type Step = { point: RoomPoint; furniture?: FurnitureId; pose?: Phase; placement?: boolean };
type Track = { frame: ActorFrame; steps: Step[]; travelled: number; placementElapsed?: number };
type Effect = { id: number; type: "heart" | "ripple"; point: RoomPoint; start: number };
type RoomFrame = {
  actors: Record<ActorId, ActorFrame>;
  duo?: { action: DuoAction; frame: number };
  effects: (Effect & { progress: number })[];
  time: number;
};
type Plan = { actor: ActorId; steps: Step[]; start: ActorFrame; delay?: number };

const distance = (a: RoomPoint, b: RoomPoint) => Math.hypot((a.nx - b.nx) * .8, a.ny - b.ny);
const makeTrack = (point: RoomPoint): Track => ({ frame: { point, phase: "IDLE", step: 0, facingLeft: false }, steps: [], travelled: 0 });

export class RoomEngine {
  private tracks = { user: makeTrack(SPAWN.user), companion: makeTrack(SPAWN.companion) };
  private task?: { plans: Plan[]; action?: CompanionAction; started?: number };
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
    if (this.locked || this.sleeping) return;
    const plan = this.plan("user", point);
    if (!plan) return;
    this.apply(plan);
    this.addEffect("ripple", plan.steps.at(-1)?.point ?? point);
  }

  furniture(furniture: FurnitureId) {
    if (this.locked) return;
    if (furniture === "bed" && this.sleeping) { this.wake(); return; }
    if (this.sleeping) return;
    const plans = ACTORS.map(actor => this.plan(actor, FURNITURE[furniture][actor].anchor, furniture));
    if (!plans[0] || !plans[1]) return;
    // Stay out of the same approach lane while the first actor finishes docking.
    this.begin([plans[0], { ...plans[1], delay: furniture === "bed" ? this.duration(plans[0]) : 0 }]);
  }

  wake() {
    if (this.locked || !this.sleeping) return;
    this.begin(ACTORS.map(actor => ({
      actor,
      start: this.tracks[actor].frame,
      steps: [{ point: WAKE_POINTS[actor], placement: true }],
    })));
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
    if (furniture && start.furniture === furniture && start.phase !== "WALK") return { actor, steps: [], start };
    const from = start.furniture ? FURNITURE[start.furniture][actor].approach : start.point;
    const dock = furniture ? FURNITURE[furniture][actor] : undefined;
    const path = findSafePath(from, dock?.approach ?? target, exact || Boolean(dock));
    if (!path) return;
    const steps = path.map(point => ({ point }) as Step);
    if (start.furniture) {
      const exit = FURNITURE[start.furniture][actor];
      steps.unshift({ point: exit.approach, placement: true });
    }
    if (dock) {
      const entry = furniture === "bed" ? FURNITURE.bed[actor].entry : undefined;
      if (entry) steps.push({ point: entry, furniture });
      steps.push({ point: dock.anchor, furniture, pose: furniture === "bed" ? "SLEEP" : "SIT", placement: furniture === "sofa" });
    }
    return { actor, start, steps };
  }

  private duration(plan: Plan) {
    let point = plan.start.point;
    let milliseconds = 40;
    for (const step of plan.steps) {
      milliseconds += step.placement ? PLACEMENT_MS : distance(point, step.point) / .00025;
      point = step.point;
    }
    return milliseconds;
  }

  private begin(plans: Plan[], action?: CompanionAction) {
    this.task = { plans: plans.filter(plan => (plan.delay ?? 0) > 0).map(plan => ({ ...plan, delay: this.time + plan.delay! })), action };
    plans.filter(plan => !plan.delay).forEach(plan => this.apply(plan));
  }

  private apply(plan: Plan) {
    if (!plan.steps.length) return;
    const track = this.tracks[plan.actor];
    track.steps = plan.steps;
    if (track.frame.phase !== "WALK") track.travelled = 0;
    track.placementElapsed = undefined;
    if (!plan.steps[0].placement) {
      track.frame = { ...track.frame, phase: "WALK", step: Math.floor(track.travelled / .026) % 4 };
    }
  }

  private advance(track: Track, milliseconds: number) {
    let remaining = milliseconds * .00025;
    while (track.steps.length && remaining > 1e-8) {
      const next = track.steps[0];
      if (next.placement) {
        const before = track.placementElapsed ?? 0;
        const elapsed = Math.min(PLACEMENT_MS, before + remaining / .00025);
        const progress = elapsed / PLACEMENT_MS;
        const switched = progress >= .5;
        track.frame = {
          ...track.frame,
          ...(switched ? { point: next.point, phase: next.pose ?? "IDLE", furniture: next.furniture } : {}),
          // Keep both actors visible while the foreground layer covers the pose change.
          opacity: .35 + .65 * Math.abs(2 * progress - 1),
        };
        remaining -= (elapsed - before) * .00025;
        track.placementElapsed = progress === 1 ? undefined : elapsed;
        if (progress === 1) track.steps.shift();
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
      track.travelled += travelled;
      remaining -= travelled;
      if (arrived) track.steps.shift();
      track.frame = {
        point, phase: arrived && !track.steps.length ? next.pose ?? "IDLE" : "WALK",
        step: Math.floor(track.travelled / .026) % 4,
        facingLeft: Math.abs(next.point.nx - previous.nx) > .001 ? next.point.nx < previous.nx : track.frame.facingLeft,
        furniture: next.furniture,
      };
    }
  }

  tick(delta: number) {
    this.changed = this.isAnimating;
    const dt = Math.max(0, Math.min(33, delta));
    this.time += dt;
    this.effects = this.effects.filter(effect => this.time - effect.start < 720);
    const task = this.task;
    if (task) {
      task.plans = task.plans.filter(plan => {
        if (this.time < plan.delay!) return true;
        this.apply(plan);
        return false;
      });
    }
    ACTORS.forEach(actor => this.advance(this.tracks[actor], dt));
    if (task && !task.plans.length && ACTORS.every(actor => !this.tracks[actor].steps.length)) {
      if (!task.action) this.task = undefined;
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

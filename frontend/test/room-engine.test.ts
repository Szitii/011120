import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomEngine } from "../src/room/roomEngine.ts";
import { findSafePath } from "../src/room/pathfinding.ts";
import { BED_FLOOR_EDGE, DUO_POINTS, DUO_SLOT, FURNITURE, SOFA_SLOT, TABLE_SLOT, WAKE_POINTS } from "../src/room/geometry.ts";

test("floor taps replan a single actor without teleporting or losing the walking cycle", () => {
  const engine = new RoomEngine();
  const companion = engine.snapshot().actors.companion;
  engine.floor({ nx: .55, ny: .84 });
  const frames = new Set<number>();
  for (let frame = 0; frame < 220; frame++) {
    const before = engine.snapshot().actors.user;
    if (frame === 17) engine.floor({ nx: .60, ny: .85 });
    engine.tick(16);
    const after = engine.snapshot().actors.user;
    assert.deepEqual(engine.snapshot().actors.companion, companion);
    const moved = Math.hypot((after.point.nx - before.point.nx) * .8, after.point.ny - before.point.ny);
    assert.ok(moved <= .004001);
    if (after.phase === "WALK") frames.add(after.step);
  }
  assert.deepEqual([...frames].sort(), [0, 1, 2, 3]);
  assert.equal(engine.snapshot().actors.user.phase, "IDLE");
});

test("sleep and seated phases stay anchored while a movement command uses walk sprites", () => {
  const engine = new RoomEngine();
  const initial = engine.snapshot().actors;
  engine.furniture("bed");
  engine.tick(16);
  assert.notDeepEqual(engine.snapshot().actors.companion.point, initial.companion.point);
  assert.notDeepEqual(engine.snapshot().actors.user.point, initial.user.point);
  for (let frame = 0; frame < 300; frame++) engine.tick(16);
  for (const id of ["companion", "user"] as const) {
    const actor = engine.snapshot().actors[id];
    assert.equal(actor.phase, "SLEEP");
    assert.deepEqual(actor.point, FURNITURE.bed[id].anchor);
  }
  engine.wake();
  // Waking: sit up under the quilt, pause, then crossfade to standing. No pose slides off the bed.
  let sawSitting = 0;
  let sawCrossfade = 0;
  for (let frame = 0; frame < 180; frame++) {
    engine.tick(16);
    for (const id of ["companion", "user"] as const) {
      const after = engine.snapshot().actors[id];
      assert.notEqual(after.phase, "SLEEP");
      assert.notEqual(after.phase, "WALK");
      if (after.point.ny < BED_FLOOR_EDGE) {
        assert.equal(after.phase, "SIT");
        assert.equal(after.furniture, "bed");
        assert.equal(after.point.nx, FURNITURE.bed[id].anchor.nx);
        assert.ok(after.point.ny <= FURNITURE.bed[id].anchor.ny && after.point.ny > FURNITURE.bed[id].anchor.ny - .03);
        if ((after.opacity ?? 1) === 1) sawSitting++;
      } else {
        assert.deepEqual(after.point, WAKE_POINTS[id]);
        assert.equal(after.phase, "IDLE");
        assert.equal(after.incoming, undefined);
      }
      if (after.incoming) {
        sawCrossfade++;
        assert.deepEqual(after.incoming.point, WAKE_POINTS[id]);
        assert.equal(after.incoming.phase, "IDLE");
        assert.ok(Math.abs((after.opacity ?? 1) + (after.incoming.opacity ?? 1) - 1) < 1e-9);
      }
    }
  }
  assert.ok(sawSitting >= 2 * 20, "both sit up and stay visible for a beat");
  assert.ok(sawCrossfade >= 2 * 15, "the change of place is a crossfade, not a jump");
  for (const id of ["companion", "user"] as const) {
    assert.deepEqual(engine.snapshot().actors[id].point, WAKE_POINTS[id]);
    assert.equal(engine.snapshot().actors[id].opacity ?? 1, 1);
  }
  for (let frame = 0; frame < 300; frame++) engine.tick(16);
  engine.furniture("sofa");
  for (let frame = 0; frame < 300; frame++) engine.tick(16);
  assert.equal(engine.snapshot().actors.user.phase, "SIT");
  assert.deepEqual(engine.snapshot().actors.user.point, FURNITURE.sofa.user.anchor);
});

test("a duo action reports once when both actors arrive and ignores competing floor taps", () => {
  const engine = new RoomEngine();
  engine.action("HUG");
  assert.deepEqual(engine.takeStartedActions(), []);
  let starts = 0;
  for (let frame = 0; frame < 400; frame++) {
    engine.floor({ nx: .72, ny: .83 });
    engine.tick(16);
    const actions = engine.takeStartedActions();
    if (actions.length) {
      assert.deepEqual(actions, ["HUG"]);
      assert.equal(engine.snapshot().actors.user.phase, "DUO");
      starts++;
    }
    if (starts && !engine.snapshot().duo) break;
  }
  assert.equal(starts, 1);
});

test("furniture rectangles block the feet margin and duo sprites clear the coffee table", () => {
  const start = { nx: .60, ny: .46 };
  assert.equal(findSafePath(start, { nx: .755, ny: .60 }, true), null);
  assert.equal(findSafePath(start, { nx: .57, ny: .805 }, true), null);
  const route = findSafePath(start, { nx: .58, ny: .85 }, true);
  assert.ok(route?.some(point => point.nx < SOFA_SLOT.left || point.nx > SOFA_SLOT.left + SOFA_SLOT.width));
  assert.ok(DUO_SLOT.top + DUO_SLOT.height < Math.min(SOFA_SLOT.top, TABLE_SLOT.top));
  for (const point of Object.values(DUO_POINTS)) assert.ok(findSafePath(start, point, true));
});

test("seated actors fade to sofa exits before a duo action", () => {
  const engine = new RoomEngine();
  const settle = () => { for (let frame = 0; frame < 300; frame++) engine.tick(16); };
  engine.furniture("sofa");
  settle();
  const seated = engine.snapshot().actors;
  assert.equal(seated.user.point.ny, seated.companion.point.ny);
  assert.equal(seated.user.phase, "SIT");
  assert.equal(seated.companion.phase, "SIT");
  engine.action("CUDDLE");
  for (let frame = 0; frame < 15; frame++) {
    const previous = engine.snapshot().actors;
    engine.tick(16);
    const current = engine.snapshot().actors;
    for (const id of ["companion", "user"] as const) {
      const moved = Math.hypot((current[id].point.nx - previous[id].point.nx) * .8, current[id].point.ny - previous[id].point.ny);
      if (moved > .004001) {
        assert.ok((current[id].opacity ?? 1) <= .2);
        assert.deepEqual(current[id].point, FURNITURE.sofa[id].approach);
      }
    }
  }
  settle();
  assert.deepEqual(engine.takeStartedActions(), ["CUDDLE"]);
  assert.deepEqual(engine.snapshot().actors.user.point, DUO_POINTS.user);
  assert.deepEqual(engine.snapshot().actors.companion.point, DUO_POINTS.companion);
});

test("sofa entry and exit clear the coffee table without walking across sofa armrests", () => {
  const engine = new RoomEngine();
  const inTable = ({ nx, ny }: { nx: number; ny: number }) =>
    nx >= TABLE_SLOT.left - .016 && nx <= TABLE_SLOT.left + TABLE_SLOT.width + .016 &&
    ny >= TABLE_SLOT.top - .012 && ny <= TABLE_SLOT.top + TABLE_SLOT.height + .012;
  engine.furniture("sofa");
  let walkingAtSofa = false;
  for (let frame = 0; frame < 360; frame++) {
    engine.tick(16);
    for (const actor of Object.values(engine.snapshot().actors)) {
      assert.equal(inTable(actor.point), false);
      if (actor.furniture === "sofa" && actor.phase === "WALK") walkingAtSofa = true;
    }
  }
  assert.equal(walkingAtSofa, false);
  assert.equal(engine.snapshot().actors.user.phase, "SIT");

  engine.floor({ nx: .59, ny: .84 });
  for (let frame = 0; frame < 360; frame++) {
    engine.tick(16);
    const { user } = engine.snapshot().actors;
    assert.equal(inTable(user.point), false);
    assert.notEqual(user.phase, "SIT");
  }
  assert.ok(engine.snapshot().actors.user.point.ny > TABLE_SLOT.top + TABLE_SLOT.height);
});

test("straight floor retargets keep their travel direction and avoid an initial grid snap", () => {
  const engine = new RoomEngine();
  const start = engine.snapshot().actors.user.point;
  const first = { nx: start.nx - .1, ny: start.ny };
  assert.deepEqual(findSafePath(start, first), [first]);
  engine.floor(first);
  assert.equal(engine.snapshot().actors.user.facingLeft, true);
  engine.tick(16);
  const mid = engine.snapshot().actors.user.point;
  const reversed = { nx: start.nx + .06, ny: start.ny };
  engine.floor(reversed);
  assert.equal(engine.snapshot().actors.user.facingLeft, false);
  engine.tick(16);
  assert.ok(engine.snapshot().actors.user.point.nx > mid.nx);
  const current = engine.snapshot().actors.user.point;
  engine.floor(current);
  engine.tick(16);
  assert.deepEqual(engine.snapshot().actors.user.point, current);
  assert.equal(engine.snapshot().actors.user.phase, "IDLE");
  assert.equal(findSafePath({ nx: .60, ny: .46 }, { nx: .60, ny: .61 }, true), null);
});

test("actors fade into their furniture anchors together without sliding in a seated or sleeping pose", () => {
  for (const kind of ["bed", "sofa"] as const) {
    const engine = new RoomEngine();
    const placed = kind === "bed" ? "SLEEP" : "SIT";
    let sawPlacement = false;
    engine.furniture(kind);
    for (let frame = 0; frame < 360; frame++) {
      const before = engine.snapshot().actors;
      engine.tick(16);
      const after = engine.snapshot().actors;
      assert.equal(after.user.phase === placed, after.companion.phase === placed);
      if (after.user.phase !== placed || before.user.phase === placed) continue;
      sawPlacement = true;
      for (const id of ["companion", "user"] as const) {
        assert.ok((after[id].opacity ?? 1) <= .2);
        assert.deepEqual(after[id].point, FURNITURE[kind][id].anchor);
      }
    }
    assert.equal(sawPlacement, true);
  }
});

test("vertical walking changes facing direction before the next frame", () => {
  const engine = new RoomEngine();
  engine.floor({ nx: .60, ny: .43 });
  assert.equal(engine.snapshot().actors.user.facingDir, "back");
  for (let frame = 0; frame < 8; frame++) engine.tick(16);
  engine.floor({ nx: .60, ny: .47 });
  assert.equal(engine.snapshot().actors.user.facingDir, "front");
});

test("a companion's autonomous action animates locally without recording an owner action", () => {
  const engine = new RoomEngine();
  for (let frame = 0; frame < 1300; frame++) engine.tick(33);
  assert.equal(engine.snapshot().duo, undefined);
  let sawCompanionAction = false;
  for (let frame = 0; frame < 1300; frame++) {
    engine.tick(33, true);
    assert.deepEqual(engine.takeStartedActions(), []);
    if (engine.snapshot().duo?.initiator === "COMPANION") sawCompanionAction = true;
  }
  assert.equal(sawCompanionAction, true);
});

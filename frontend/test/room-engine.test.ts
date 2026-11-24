import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomEngine } from "../src/room/roomEngine.ts";
import { findSafePath } from "../src/room/pathfinding.ts";
import { DUO_POINTS, DUO_SLOT, FURNITURE, SOFA_SLOT, TABLE_SLOT, WAKE_POINTS } from "../src/room/geometry.ts";

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
  for (let frame = 0; frame < 180; frame++) {
    const before = engine.snapshot().actors;
    engine.tick(16);
    for (const id of ["companion", "user"] as const) {
      const after = engine.snapshot().actors[id];
      const point = before[id].point;
      assert.ok(Math.hypot((after.point.nx - point.nx) * .8, after.point.ny - point.ny) <= .004001);
    }
  }
  assert.deepEqual(engine.snapshot().actors.companion.point, WAKE_POINTS.companion);
  assert.deepEqual(engine.snapshot().actors.user.point, WAKE_POINTS.user);
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

test("seated actors leave the sofa from their respective openings before a duo action", () => {
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
    for (const id of ["companion", "user"] as const) {
      const { point } = engine.snapshot().actors[id];
      assert.ok(Math.hypot((point.nx - previous[id].point.nx) * .8, point.ny - previous[id].point.ny) <= .004001);
    }
  }
  settle();
  assert.deepEqual(engine.takeStartedActions(), ["CUDDLE"]);
  assert.deepEqual(engine.snapshot().actors.user.point, DUO_POINTS.user);
  assert.deepEqual(engine.snapshot().actors.companion.point, DUO_POINTS.companion);
});

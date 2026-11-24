import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomEngine } from "../src/room/roomEngine.ts";
import { FURNITURE } from "../src/room/geometry.ts";

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
  engine.furniture("bed");
  for (let frame = 0; frame < 300; frame++) engine.tick(16);
  for (const id of ["companion", "user"] as const) {
    const actor = engine.snapshot().actors[id];
    assert.equal(actor.phase, "SLEEP");
    assert.deepEqual(actor.point, FURNITURE.bed[id].anchor);
  }
  engine.wake();
  assert.equal(engine.snapshot().actors.companion.phase, "WALK");
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

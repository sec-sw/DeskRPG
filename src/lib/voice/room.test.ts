// src/lib/voice/room.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { clampProximityRadius } from "./room";

test("clampProximityRadius: bounds within [1, 30]", () => {
  assert.equal(clampProximityRadius(5), 5);
  assert.equal(clampProximityRadius(0), 1);
  assert.equal(clampProximityRadius(-99), 1);
  assert.equal(clampProximityRadius(31), 30);
  assert.equal(clampProximityRadius(99999), 30);
});

test("clampProximityRadius: floors fractional values", () => {
  assert.equal(clampProximityRadius(5.9), 5);
  assert.equal(clampProximityRadius(1.001), 1);
});

test("clampProximityRadius: defaults to 5 on NaN/Infinity", () => {
  assert.equal(clampProximityRadius(Number.NaN), 5);
  assert.equal(clampProximityRadius(Number.POSITIVE_INFINITY), 5);
  assert.equal(clampProximityRadius(Number.NEGATIVE_INFINITY), 5);
});

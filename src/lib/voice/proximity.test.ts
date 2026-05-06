// src/lib/voice/proximity.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  chebyshevDistance,
  computeProximityVolume,
  decodeProximityPayload,
  encodeProximityPayload,
  euclideanDistance,
} from "./proximity";

test("computeProximityVolume: full at 0, zero at >=radius, smooth between", () => {
  const radius = 10;
  assert.equal(computeProximityVolume(0, radius), 1);
  assert.equal(computeProximityVolume(2, radius), 1); // inside inner zone
  assert.equal(computeProximityVolume(radius, radius), 0);
  assert.equal(computeProximityVolume(radius + 1, radius), 0);

  const mid = computeProximityVolume(5, radius);
  assert.ok(mid > 0 && mid < 1, `expected 0<mid<1 but got ${mid}`);

  // Monotonically decreasing as distance grows past the inner edge.
  const a = computeProximityVolume(4, radius);
  const b = computeProximityVolume(6, radius);
  const c = computeProximityVolume(8, radius);
  assert.ok(a >= b && b >= c, `expected monotone, got ${a}, ${b}, ${c}`);
});

test("computeProximityVolume: edge cases", () => {
  assert.equal(computeProximityVolume(NaN, 10), 1);
  assert.equal(computeProximityVolume(5, 0), 1);
  assert.equal(computeProximityVolume(-5, 10), 1); // negative distance treated as zero
});

test("chebyshev/euclidean distance basics", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 3, y: 4 };
  assert.equal(chebyshevDistance(a, b), 4);
  assert.equal(euclideanDistance(a, b), 5);
});

test("encode/decode proximity payload round-trips and rejects junk", () => {
  const buf = encodeProximityPayload({ x: 12, y: -3 });
  assert.deepEqual(decodeProximityPayload(buf), { type: "pos", x: 12, y: -3 });

  // Wrong type marker
  const bad1 = new TextEncoder().encode(JSON.stringify({ t: "ping" }));
  assert.equal(decodeProximityPayload(bad1), null);

  // Missing coords
  const bad2 = new TextEncoder().encode(JSON.stringify({ t: "pos", x: 1 }));
  assert.equal(decodeProximityPayload(bad2), null);

  // Non-finite
  const bad3 = new TextEncoder().encode(JSON.stringify({ t: "pos", x: 1, y: "foo" }));
  assert.equal(decodeProximityPayload(bad3), null);

  // Garbage bytes
  assert.equal(decodeProximityPayload(new Uint8Array([0xff, 0xfe, 0xfd])), null);
});

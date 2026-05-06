// src/lib/livekit-config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { livekitConfigured, getLiveKitConfig, liveKitRoomName } from "./livekit-config";

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in snapshot)) delete process.env[k];
  }
  Object.assign(process.env, snapshot);
}

test("livekitConfigured returns false when any var missing", () => {
  const snap = snapshotEnv();
  try {
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    assert.equal(livekitConfigured(), false);

    process.env.LIVEKIT_URL = "ws://x";
    assert.equal(livekitConfigured(), false);
    process.env.LIVEKIT_API_KEY = "k";
    assert.equal(livekitConfigured(), false);
    process.env.LIVEKIT_API_SECRET = "s";
    assert.equal(livekitConfigured(), true);
  } finally {
    restoreEnv(snap);
  }
});

test("getLiveKitConfig: throws when not configured", () => {
  const snap = snapshotEnv();
  try {
    delete process.env.LIVEKIT_URL;
    assert.throws(() => getLiveKitConfig(), /not configured/);
  } finally {
    restoreEnv(snap);
  }
});

test("getLiveKitConfig: publicUrl falls back to url", () => {
  const snap = snapshotEnv();
  try {
    process.env.LIVEKIT_URL = "ws://server:7880";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    delete process.env.NEXT_PUBLIC_LIVEKIT_URL;
    const cfg = getLiveKitConfig();
    assert.equal(cfg.publicUrl, "ws://server:7880");

    process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://public:443";
    const cfg2 = getLiveKitConfig();
    assert.equal(cfg2.publicUrl, "wss://public:443");
  } finally {
    restoreEnv(snap);
  }
});

test("liveKitRoomName: stable namespace per channel", () => {
  assert.equal(liveKitRoomName("abc"), "deskrpg:channel:abc");
  assert.notEqual(liveKitRoomName("a"), liveKitRoomName("b"));
});

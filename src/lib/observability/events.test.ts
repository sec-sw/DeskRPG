// src/lib/observability/events.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { logEvent, setEventSinkForTests } from "./events";

test("logEvent emits JSON line with ts + event + fields", () => {
  const captured: string[] = [];
  setEventSinkForTests((line) => captured.push(line));
  try {
    logEvent("attachment.created", { channelId: "c1", byteSize: 1024 });
    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    assert.equal(parsed.event, "attachment.created");
    assert.equal(parsed.channelId, "c1");
    assert.equal(parsed.byteSize, 1024);
    assert.ok(typeof parsed.ts === "string");
  } finally {
    setEventSinkForTests(null);
  }
});

test("logEvent drops undefined fields so the line stays compact", () => {
  const captured: string[] = [];
  setEventSinkForTests((line) => captured.push(line));
  try {
    logEvent("voice.token.issued", { channelId: "c1", reason: undefined });
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    assert.ok(!("reason" in parsed));
  } finally {
    setEventSinkForTests(null);
  }
});

test("logEvent never throws even on sink failure", () => {
  setEventSinkForTests(() => {
    throw new Error("sink crashed");
  });
  try {
    // Must not throw to caller. The fallback path also tries the sink, which
    // throws again — implementation must catch that too. If logEvent throws,
    // the test fails.
    let threw = false;
    try {
      logEvent("attachment.created", { channelId: "c1" });
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  } finally {
    setEventSinkForTests(null);
  }
});

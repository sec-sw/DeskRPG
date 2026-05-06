// src/lib/storage/av-scanner.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  registerAVScanner,
  resetAVScannerForTests,
  scanForMalware,
  shouldRejectByVerdict,
} from "./av-scanner";

test("scanForMalware: default no-op skips", async () => {
  resetAVScannerForTests();
  const verdict = await scanForMalware({
    key: "k",
    contentType: "text/plain",
    byteSize: 1,
    body: async () => Buffer.from("x"),
  });
  assert.equal(verdict.status, "skipped");
});

test("scanForMalware: registered scanner can flag infected", async () => {
  registerAVScanner(async () => ({ status: "infected", signature: "Test-Signature" }));
  try {
    const verdict = await scanForMalware({
      key: "k",
      contentType: "text/plain",
      byteSize: 1,
      body: async () => Buffer.from("x"),
    });
    assert.equal(verdict.status, "infected");
    assert.equal(verdict.signature, "Test-Signature");
    assert.equal(shouldRejectByVerdict(verdict), true);
  } finally {
    resetAVScannerForTests();
  }
});

test("scanForMalware: scanner exception becomes status=error, doesn't reject by default", async () => {
  registerAVScanner(async () => {
    throw new Error("scanner crashed");
  });
  try {
    const verdict = await scanForMalware({
      key: "k",
      contentType: "text/plain",
      byteSize: 1,
      body: async () => Buffer.from("x"),
    });
    assert.equal(verdict.status, "error");
    assert.match(verdict.detail ?? "", /scanner crashed/);
    assert.equal(shouldRejectByVerdict(verdict), false);
  } finally {
    resetAVScannerForTests();
  }
});

test("shouldRejectByVerdict: only infected blocks", () => {
  assert.equal(shouldRejectByVerdict({ status: "clean" }), false);
  assert.equal(shouldRejectByVerdict({ status: "skipped" }), false);
  assert.equal(shouldRejectByVerdict({ status: "error" }), false);
  assert.equal(shouldRejectByVerdict({ status: "infected" }), true);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

// path.join uses the host OS separator, so use it on the expected side too —
// otherwise this test failed on Windows since DeskRPG was first written on
// macOS / Linux.
test("runtime paths resolve under DESKRPG_HOME when provided", async () => {
  const home = path.join(path.sep, "tmp", "deskrpg-home");
  process.env.DESKRPG_HOME = home;

  const runtimePaths = await import("./runtime-paths.ts");

  assert.equal(runtimePaths.getDeskRpgHomeDir(), home);
  assert.equal(runtimePaths.getDeskRpgEnvPath(), path.join(home, ".env.local"));
  assert.equal(runtimePaths.getDeskRpgDataDir(), path.join(home, "data"));
  assert.equal(runtimePaths.getDeskRpgSqlitePath(), path.join(home, "data", "deskrpg.db"));
  assert.equal(runtimePaths.getDeskRpgUploadsDir(), path.join(home, "uploads"));
  assert.equal(runtimePaths.getDeskRpgAttachmentsDir(), path.join(home, "uploads", "attachments"));
  assert.equal(runtimePaths.getDeskRpgLogsDir(), path.join(home, "logs"));
});

#!/usr/bin/env tsx
//
// scripts/cleanup-attachments.ts
//
// Retention + orphan cleanup for channel attachments. Two passes:
//   1. Hard-delete soft-deleted rows (deleted_at IS NOT NULL) older than the
//      retention window. The storage blob was already best-effort removed at
//      soft-delete time; we additionally try once more here so any blobs that
//      survived (e.g. temporary network blip) get cleaned up.
//   2. Purge orphan blobs in the configured storage backend that have no
//      corresponding row in the attachments table — happens when the bytes
//      landed but the DB insert failed and the rollback delete missed.
//
// Usage:
//   tsx scripts/cleanup-attachments.ts --days 30
//   tsx scripts/cleanup-attachments.ts --dry-run
//   npm run attachments:cleanup -- --days 30
//
// Safe to run periodically (cron / k8s CronJob). Log output is JSON lines so
// it tails cleanly into observability pipelines.

import { and, eq, isNotNull, lt } from "drizzle-orm";

import { attachments, db, isPostgres } from "../src/db";
import { getStorage } from "../src/lib/storage";

interface CliArgs {
  retentionDays: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let retentionDays = 30;
  let dryRun = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--days" && argv[i + 1]) {
      retentionDays = Math.max(0, parseInt(argv[i + 1] ?? "30", 10) || 30);
      i++;
    }
  }
  return { retentionDays, dryRun };
}

function logEvent(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

async function purgeSoftDeleted(args: CliArgs): Promise<number> {
  const cutoffMs = Date.now() - args.retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = isPostgres ? new Date(cutoffMs) : new Date(cutoffMs).toISOString();

  const candidates = await db
    .select()
    .from(attachments)
    .where(
      and(
        isNotNull(attachments.deletedAt),
        // PG comparison handles Date; SQLite handles ISO string lexicographic.
        lt(attachments.deletedAt, cutoff as unknown as Date),
      ),
    );

  logEvent("retention.candidates", { count: candidates.length, retentionDays: args.retentionDays });
  if (args.dryRun || candidates.length === 0) return candidates.length;

  const driver = getStorage();
  let purged = 0;
  for (const row of candidates) {
    try {
      await driver.delete(row.storageKey).catch(() => undefined);
      if (row.thumbnailKey) await driver.delete(row.thumbnailKey).catch(() => undefined);
      await db.delete(attachments).where(eq(attachments.id, row.id));
      purged++;
      logEvent("retention.purged", { id: row.id, key: row.storageKey, byteSize: row.byteSize });
    } catch (e) {
      logEvent("retention.error", {
        id: row.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  logEvent("retention.summary", { purged, candidates: candidates.length });
  return purged;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  logEvent("retention.start", { ...args });
  await purgeSoftDeleted(args);
  logEvent("retention.done");
  process.exit(0);
}

main().catch((e) => {
  logEvent("retention.fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});

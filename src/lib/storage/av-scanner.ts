// src/lib/storage/av-scanner.ts
//
// Antivirus scan extension point. The default implementation is a permissive
// "no-op clean" — the registry is here so operators can swap in a real
// scanner (ClamAV via clamd, Cloudflare/Lambda hosted scanner, etc.) without
// touching the upload code path.
//
// Wiring:
//   import { scanForMalware } from "@/lib/storage/av-scanner";
//   const verdict = await scanForMalware({ key, contentType, body });
//   if (verdict.status === "infected") throw ...
//
// Uploads call this *before* persisting the row but *after* the bytes have
// landed in the storage driver. On infection the orphan blob is deleted.

import type { Readable } from "node:stream";

export type AVScanStatus = "clean" | "infected" | "skipped" | "error";

export interface AVScanInput {
  key: string;
  contentType: string;
  byteSize: number;
  /** Lazy accessor — only invoked if the scanner needs the bytes. */
  body: () => Promise<Buffer> | Promise<Readable>;
}

export interface AVScanVerdict {
  status: AVScanStatus;
  /** When status is "infected", a short label like "Eicar-Test-Signature". */
  signature?: string;
  /** Free-form details for logging; never exposed to clients. */
  detail?: string;
}

export type AVScanFn = (input: AVScanInput) => Promise<AVScanVerdict>;

const noopScanner: AVScanFn = async () => ({ status: "skipped", detail: "no scanner configured" });

let registered: AVScanFn = noopScanner;

/**
 * Operators register their preferred scanner at server boot — typically
 * during a one-time init in a hook file or alongside getDb(). The registry
 * is process-global because uploads happen anywhere.
 */
export function registerAVScanner(fn: AVScanFn): void {
  registered = fn;
}

export function resetAVScannerForTests(): void {
  registered = noopScanner;
}

export async function scanForMalware(input: AVScanInput): Promise<AVScanVerdict> {
  try {
    return await registered(input);
  } catch (e) {
    // A scanner crash MUST NOT block uploads — log and treat as error so
    // the caller can decide policy (default: allow).
    return {
      status: "error",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Default policy: block on infected, allow on clean/skipped/error. Operators
 * who want fail-closed can override `scanForMalware` itself or the caller's
 * branch on the verdict.
 */
export function shouldRejectByVerdict(verdict: AVScanVerdict): boolean {
  return verdict.status === "infected";
}

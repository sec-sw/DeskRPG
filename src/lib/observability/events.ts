// src/lib/observability/events.ts
//
// JSON-line event logger for structured observability. Output goes to stdout
// (one event per line) so log aggregators (Loki/Datadog/CloudWatch) can
// ingest it without parsing.
//
// Design goals:
//  - Zero deps — Node's console is enough.
//  - Type-safe event names so dashboards stay grep-able.
//  - PII redaction at the edges: callers are expected NOT to pass user-typed
//    free text; this layer just structures fields.
//
// Usage:
//   logEvent("attachment.created", { channelId, attachmentId, byteSize });
//   logEvent("voice.token.issued", { channelId, userId, ttlSec });

export type ObservabilityEvent =
  | "attachment.created"
  | "attachment.deleted"
  | "attachment.scan_blocked"
  | "attachment.upload_failed"
  | "voice.token.issued"
  | "voice.token.refreshed"
  | "voice.token.failed"
  | "voice.settings.updated"
  | "retention.purged"
  | "retention.error";

export interface EventFields {
  [key: string]: string | number | boolean | null | undefined;
}

const SAMPLE_DEFAULT = process.env.NODE_ENV === "production" ? 1 : 1; // override per-call

let sink: (line: string) => void = (line) => console.log(line);

/**
 * Test hook — capture emitted lines instead of writing to stdout.
 */
export function setEventSinkForTests(fn: ((line: string) => void) | null): void {
  sink = fn ?? ((line) => console.log(line));
}

export function logEvent(event: ObservabilityEvent, fields: EventFields = {}): void {
  // Drop undefined keys so the JSON line stays compact.
  const cleaned: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) cleaned[k] = v;
  }
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...cleaned,
  };
  try {
    sink(JSON.stringify(payload));
  } catch {
    // Logging must never throw. Fall back to a minimal line, and swallow
    // any further failure too — observability is best-effort.
    try {
      sink(`{"ts":"${new Date().toISOString()}","event":"${event}","log_error":true}`);
    } catch {
      /* give up silently */
    }
  }
}

// Re-export so callers can read the sample default in tests.
export { SAMPLE_DEFAULT };

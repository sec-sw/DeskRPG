// src/lib/voice/proximity.ts
//
// Pure helpers for proximity-mode voice. Kept separate so the volume curve
// can be tuned + tested without touching the React hook lifecycle.

export interface PositionTile {
  x: number;
  y: number;
}

/**
 * Audible-radius volume falloff: full volume inside the inner zone, smooth
 * fade to zero at `radius`, hard zero beyond. Domain-tested values:
 *   distance == 0 → 1.0
 *   distance >= radius → 0.0
 * Uses a quadratic curve which sounds more natural than linear and avoids
 * the "binary on/off" feel.
 */
export function computeProximityVolume(
  distance: number,
  radius: number,
  innerFraction = 0.3,
): number {
  if (!Number.isFinite(distance) || distance <= 0) return 1;
  if (radius <= 0) return 1;
  const innerEdge = radius * innerFraction;
  if (distance <= innerEdge) return 1;
  if (distance >= radius) return 0;
  const t = (distance - innerEdge) / (radius - innerEdge);
  // Quadratic ease-out: 1 → 0 over the falloff zone.
  const eased = 1 - t * t;
  if (eased < 0) return 0;
  if (eased > 1) return 1;
  return eased;
}

export function chebyshevDistance(a: PositionTile, b: PositionTile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function euclideanDistance(a: PositionTile, b: PositionTile): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Encode a coordinate update for the LiveKit data channel. Plain JSON keeps
 * debuggability; the payload is small enough that protobuf isn't worth it.
 */
export function encodeProximityPayload(pos: PositionTile): Uint8Array {
  const json = JSON.stringify({ t: "pos", x: pos.x, y: pos.y });
  return new TextEncoder().encode(json);
}

export interface ProximityMessage {
  type: "pos";
  x: number;
  y: number;
}

export function decodeProximityPayload(bytes: Uint8Array): ProximityMessage | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.t !== "pos") return null;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { type: "pos", x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

/** Stale-position threshold — drop entries older than this on read. */
export const PROXIMITY_STALE_MS = 30_000;
/** Minimum interval between broadcasts of the local position. */
export const PROXIMITY_BROADCAST_MIN_MS = 250;

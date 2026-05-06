"use client";
//
// useLiveKitVoice — React hook wrapping the livekit-client SDK for one
// channel's voice room. Owns the Room object's lifecycle, exposes a
// minimal observable participant list with mute + speaking state, and
// returns connect/disconnect/toggleMute actions.
//
// Usage:
//   const voice = useLiveKitVoice(channelId, characterId);
//   voice.connect();
//   voice.toggleMute();
//   voice.participants.map(p => ...)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  LocalAudioTrack,
  Participant,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
} from "livekit-client";

import {
  PROXIMITY_BROADCAST_MIN_MS,
  PROXIMITY_STALE_MS,
  chebyshevDistance,
  computeProximityVolume,
  decodeProximityPayload,
  encodeProximityPayload,
} from "@/lib/voice/proximity";

export interface VoiceParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  /** From AccessToken metadata — currently { channelId, characterId }. */
  metadata: Record<string, unknown> | null;
}

/**
 * One active screen-share publication. Local presenters appear with
 * `isLocal: true`; track will be set for both local and subscribed remote
 * shares so the viewer can call `track.attach()` to a `<video>` element.
 */
export interface ScreenShareEntry {
  participantIdentity: string;
  participantName: string;
  isLocal: boolean;
  /** TrackPublication.trackSid — stable id for React keys. */
  trackSid: string;
  /** May be null briefly while a remote track is still resolving. */
  track: Track | null;
}

/**
 * One active camera publication. Same structure as ScreenShareEntry but for
 * camera tracks — kept as a separate type so the UI can render them in a
 * different place (tile grid vs. floating viewer).
 */
export interface CameraEntry {
  participantIdentity: string;
  participantName: string;
  isLocal: boolean;
  trackSid: string;
  track: Track | null;
}

export type VoiceConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "error";

export interface UseLiveKitVoice {
  state: VoiceConnectionState;
  errorCode: string | null;
  isMicMuted: boolean;
  participants: VoiceParticipant[];
  /** True when the server's voice subsystem is configured + enabled for this channel. */
  available: boolean;
  /** Owner-facing controls — null when fetch hasn't loaded yet. */
  voiceSettings: {
    enabled: boolean;
    accessMode: "members" | "open";
    proximityEnabled: boolean;
    proximityRadius: number;
  } | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  toggleMute: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  /** All currently-active screen shares in the room (local + remote). */
  screenShares: ScreenShareEntry[];
  isLocalScreenSharing: boolean;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  /** All currently-active camera publications. */
  cameras: CameraEntry[];
  isLocalCameraOn: boolean;
  startCamera: () => Promise<void>;
  stopCamera: () => Promise<void>;
  /**
   * Push the local player's tile coordinates so proximity-mode volume
   * attenuation can react. Throttled internally — safe to call every frame.
   * No-op when the room is not connected or proximity mode is disabled.
   */
  updateLocalPosition: (x: number, y: number) => void;
}

interface VoiceTokenResponse {
  token: string;
  url: string;
  identity: string;
  roomName: string;
  expiresAt: string;
  proximity?: { enabled: boolean; radius: number };
}

interface VoiceSettingsResponse {
  voice: {
    enabled: boolean;
    accessMode: "members" | "open";
    proximityEnabled: boolean;
    proximityRadius: number;
  };
  livekitConfigured: boolean;
}

export function useLiveKitVoice(
  channelId: string | null,
  characterId: string | null,
): UseLiveKitVoice {
  const [state, setState] = useState<VoiceConnectionState>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [available, setAvailable] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<UseLiveKitVoice["voiceSettings"]>(null);
  const [screenShares, setScreenShares] = useState<ScreenShareEntry[]>([]);
  const [isLocalScreenSharing, setIsLocalScreenSharing] = useState(false);
  const [cameras, setCameras] = useState<CameraEntry[]>([]);
  const [isLocalCameraOn, setIsLocalCameraOn] = useState(false);

  // Proximity state lives in refs because it changes far more often than
  // React can re-render. Audio volume is applied imperatively on each tick.
  const localPositionRef = useRef<{ x: number; y: number } | null>(null);
  const remotePositionsRef = useRef<Map<string, { x: number; y: number; updatedAt: number }>>(
    new Map(),
  );
  const lastBroadcastRef = useRef(0);
  const lastBroadcastedPosRef = useRef<{ x: number; y: number } | null>(null);
  const proximityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ref-trampoline for applyProximityVolumes so connect()'s closure can call
  // it without listing it in its dep array — direct dependency would create
  // a TDZ cycle since applyProximityVolumes is defined further down.
  const applyProximityVolumesRef = useRef<() => void>(() => {});
  // Token expiry watchdog. Refreshes the LiveKit JWT before TTL elapses so
  // long sessions don't get bumped off the SFU.
  const tokenExpiresAtRef = useRef<number>(0);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const roomRef = useRef<Room | null>(null);
  // True for the entire mounted lifetime; flipped only on real unmount so we
  // never write to stale React state after the component is gone.
  const aliveRef = useRef(true);
  // Bumped every time channelId changes or a new connect() begins. In-flight
  // async work checks its captured value to know if it's been superseded —
  // prevents stale rooms from being adopted into roomRef after a switch.
  const generationRef = useRef(0);
  // Synchronous guard against duplicate concurrent connect() calls. State
  // changes via setState don't flush before the next click handler runs, so
  // we need a ref-based guard.
  const connectingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // ── Settings polling ────────────────────────────────────────────
  const refreshSettings = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/channels/${channelId}/voice`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        if (aliveRef.current) {
          setAvailable(false);
          setVoiceSettings(null);
        }
        return;
      }
      const data = (await res.json()) as VoiceSettingsResponse;
      if (!aliveRef.current) return;
      setAvailable(data.livekitConfigured && data.voice.enabled);
      setVoiceSettings(data.voice);
    } catch {
      if (aliveRef.current) {
        setAvailable(false);
      }
    }
  }, [channelId]);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  // ── Snapshot helper ─────────────────────────────────────────────
  const snapshotParticipants = useCallback((room: Room): VoiceParticipant[] => {
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    return all.map((p) => toVoiceParticipant(p, p === room.localParticipant));
  }, []);

  const refreshParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setParticipants(snapshotParticipants(room));
  }, [snapshotParticipants]);

  const snapshotScreenShares = useCallback((room: Room): ScreenShareEntry[] => {
    const out: ScreenShareEntry[] = [];
    const visit = (p: Participant, isLocal: boolean): void => {
      // Track sources include ScreenShare and ScreenShareAudio. We only
      // surface the visual one — audio is auto-played by livekit-client.
      const pubs: TrackPublication[] = [
        ...p.videoTrackPublications.values(),
      ];
      for (const pub of pubs) {
        if (!isScreenShareSource(pub.source)) continue;
        // Remote publications without subscription show up here too —
        // include them with track=null so the UI can show a placeholder.
        out.push({
          participantIdentity: p.identity,
          participantName: p.name || p.identity,
          isLocal,
          trackSid: pub.trackSid,
          track: pub.track ?? null,
        });
      }
    };
    visit(room.localParticipant, true);
    for (const remote of room.remoteParticipants.values()) {
      visit(remote, false);
    }
    return out;
  }, []);

  const refreshScreenShares = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = snapshotScreenShares(room);
    setScreenShares(next);
    setIsLocalScreenSharing(next.some((s) => s.isLocal));
  }, [snapshotScreenShares]);

  const snapshotCameras = useCallback((room: Room): CameraEntry[] => {
    const out: CameraEntry[] = [];
    const visit = (p: Participant, isLocal: boolean): void => {
      for (const pub of p.videoTrackPublications.values()) {
        if (!isCameraSource(pub.source)) continue;
        out.push({
          participantIdentity: p.identity,
          participantName: p.name || p.identity,
          isLocal,
          trackSid: pub.trackSid,
          track: pub.track ?? null,
        });
      }
    };
    visit(room.localParticipant, true);
    for (const remote of room.remoteParticipants.values()) {
      visit(remote, false);
    }
    return out;
  }, []);

  const refreshCameras = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = snapshotCameras(room);
    setCameras(next);
    setIsLocalCameraOn(next.some((c) => c.isLocal));
  }, [snapshotCameras]);

  // ── Connect / disconnect ────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!channelId) return;
    if (roomRef.current) return; // already connected
    if (connectingRef.current) return; // duplicate concurrent click

    // Capture the generation: if anything bumps generationRef while we're in
    // flight (channel change, another connect, unmount), we abandon the room
    // we just built rather than adopting it.
    const myGen = ++generationRef.current;
    connectingRef.current = true;
    setState("connecting");
    setErrorCode(null);

    const supersededOrDead = (): boolean =>
      !aliveRef.current || generationRef.current !== myGen;

    // Wrap the entire flow so connectingRef is *always* released — every
    // early return here used to leave it stuck true and freeze the UI.
    let pendingRoom: Room | null = null;
    try {
      let tokenData: VoiceTokenResponse;
      try {
        const url = characterId
          ? `/api/channels/${channelId}/voice/token?characterId=${encodeURIComponent(characterId)}`
          : `/api/channels/${channelId}/voice/token`;
        const res = await fetch(url, { method: "POST", credentials: "same-origin" });
        if (supersededOrDead()) return;
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setState("error");
          setErrorCode(typeof err.errorCode === "string" ? err.errorCode : `http_${res.status}`);
          return;
        }
        tokenData = (await res.json()) as VoiceTokenResponse;
        tokenExpiresAtRef.current = new Date(tokenData.expiresAt).getTime();
        if (supersededOrDead()) return;
      } catch {
        if (!supersededOrDead()) {
          setState("error");
          setErrorCode("connect_failed");
        }
        return;
      }

      try {
        const livekit = await import("livekit-client");
        if (supersededOrDead()) return;
        pendingRoom = new livekit.Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        const room = pendingRoom;
        attachRoomListeners(livekit, room, {
          onParticipantsChange: () => {
            if (!aliveRef.current || roomRef.current !== room) return;
            setParticipants(snapshotParticipants(room));
          },
          onTracksChange: () => {
            if (!aliveRef.current || roomRef.current !== room) return;
            setParticipants(snapshotParticipants(room));
            const ss = snapshotScreenShares(room);
            setScreenShares(ss);
            setIsLocalScreenSharing(ss.some((s) => s.isLocal));
            const cams = snapshotCameras(room);
            setCameras(cams);
            setIsLocalCameraOn(cams.some((c) => c.isLocal));
            applyProximityVolumesRef.current();
          },
          onConnectionStateChange: (connState) => {
            if (!aliveRef.current || roomRef.current !== room) return;
            if (connState === livekit.ConnectionState.Reconnecting) setState("reconnecting");
            else if (connState === livekit.ConnectionState.Connected) setState("connected");
            else if (connState === livekit.ConnectionState.Disconnected) setState("idle");
          },
          onDataReceived: (data, participant) => {
            if (!aliveRef.current || roomRef.current !== room) return;
            if (!participant) return;
            const msg = decodeProximityPayload(data);
            if (!msg) return;
            remotePositionsRef.current.set(participant.identity, {
              x: msg.x,
              y: msg.y,
              updatedAt: Date.now(),
            });
          },
        });

        await room.connect(tokenData.url, tokenData.token);
        if (supersededOrDead()) return;
        // Publish the mic. If permission is denied we still stay connected
        // (listen-only mode) and surface the reason via errorCode.
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch (micErr) {
          if (isPermissionDenied(micErr)) {
            setErrorCode("voice_permission_denied");
          } else {
            setErrorCode("voice_mic_failed");
          }
        }
        if (supersededOrDead()) return;

        // Adopt the room only after everything succeeded.
        roomRef.current = room;
        pendingRoom = null;
        setState("connected");
        setIsMicMuted(false);
        setParticipants(snapshotParticipants(room));
        setScreenShares(snapshotScreenShares(room));
        setIsLocalScreenSharing(false);
        setCameras(snapshotCameras(room));
        setIsLocalCameraOn(false);
      } catch {
        if (!supersededOrDead()) {
          setState("error");
          setErrorCode("connect_failed");
        }
      }
    } finally {
      // Dispose any room we built but didn't adopt.
      if (pendingRoom) {
        await pendingRoom.disconnect().catch(() => undefined);
      }
      connectingRef.current = false;
    }
  }, [channelId, characterId, snapshotParticipants, snapshotScreenShares, snapshotCameras]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    setState("disconnecting");
    roomRef.current = null;
    try {
      await room.disconnect();
    } finally {
      if (aliveRef.current) {
        setState("idle");
        setParticipants([]);
        setIsMicMuted(false);
        setScreenShares([]);
        setIsLocalScreenSharing(false);
        setCameras([]);
        setIsLocalCameraOn(false);
      }
    }
  }, []);

  const startScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      // `audio: true` lets the browser surface a "share audio" checkbox in the
      // picker dialog. The user can decline and we still get the video track.
      await room.localParticipant.setScreenShareEnabled(true, { audio: true });
      if (aliveRef.current) {
        setIsLocalScreenSharing(true);
        refreshScreenShares();
      }
    } catch (e) {
      if (!aliveRef.current) return;
      // User cancelled the OS picker: harmless, no error surfaced.
      if (isUserAbort(e)) return;
      if (isPermissionDenied(e)) {
        setErrorCode("screen_permission_denied");
      } else {
        setErrorCode("screen_share_failed");
      }
    }
  }, [refreshScreenShares]);

  const stopScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } finally {
      if (aliveRef.current) {
        setIsLocalScreenSharing(false);
        refreshScreenShares();
      }
    }
  }, [refreshScreenShares]);

  const startCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setCameraEnabled(true);
      if (aliveRef.current) {
        setIsLocalCameraOn(true);
        refreshCameras();
      }
    } catch (e) {
      if (!aliveRef.current) return;
      if (isPermissionDenied(e)) setErrorCode("camera_permission_denied");
      else setErrorCode("camera_failed");
    }
  }, [refreshCameras]);

  const stopCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setCameraEnabled(false);
    } finally {
      if (aliveRef.current) {
        setIsLocalCameraOn(false);
        refreshCameras();
      }
    }
  }, [refreshCameras]);

  // ── Proximity voice ────────────────────────────────────────────
  // Apply per-remote-participant volume based on tile distance. Idempotent —
  // safe to call repeatedly. Volume of 1 (full) is set when proximity is
  // disabled so toggling the setting off restores normal behavior.
  const applyProximityVolumes = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const settings = voiceSettings;
    const enabled = !!settings?.proximityEnabled;
    const radius = settings?.proximityRadius ?? 5;
    const localPos = localPositionRef.current;
    const now = Date.now();

    for (const remote of room.remoteParticipants.values()) {
      const audioPubs = Array.from(remote.audioTrackPublications.values());
      let volume = 1;
      if (enabled && localPos) {
        const remotePos = remotePositionsRef.current.get(remote.identity);
        if (!remotePos || now - remotePos.updatedAt > PROXIMITY_STALE_MS) {
          // No recent position from this peer — treat as far/silent so we
          // don't broadcast their voice across the entire map by accident.
          volume = 0;
        } else {
          const dist = chebyshevDistance(localPos, remotePos);
          volume = computeProximityVolume(dist, radius);
        }
      }
      for (const pub of audioPubs) {
        const track = pub.track as RemoteAudioTrack | undefined;
        if (track && typeof track.setVolume === "function") {
          try {
            track.setVolume(volume);
          } catch {
            /* track may be unsubscribing */
          }
        }
      }
    }
  }, [voiceSettings]);

  // Keep the trampoline ref pointed at the latest applyProximityVolumes so
  // connect()'s closure (which captured the ref, not the function) always
  // calls the current version when track events fire.
  useEffect(() => {
    applyProximityVolumesRef.current = applyProximityVolumes;
  }, [applyProximityVolumes]);

  const broadcastLocalPosition = useCallback(async (pos: { x: number; y: number }) => {
    const room = roomRef.current;
    if (!room) return;
    if (!voiceSettings?.proximityEnabled) return;
    const last = lastBroadcastedPosRef.current;
    if (last && last.x === pos.x && last.y === pos.y) return;
    const now = Date.now();
    if (now - lastBroadcastRef.current < PROXIMITY_BROADCAST_MIN_MS) return;
    lastBroadcastRef.current = now;
    lastBroadcastedPosRef.current = pos;
    try {
      await room.localParticipant.publishData(encodeProximityPayload(pos), { reliable: false });
    } catch {
      /* network blip — next tick will retry */
    }
  }, [voiceSettings]);

  const updateLocalPosition = useCallback((x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    localPositionRef.current = { x, y };
    // Fire-and-forget — broadcast is throttled internally.
    void broadcastLocalPosition({ x, y });
    // Re-apply volumes so my own movement immediately re-attenuates remotes.
    applyProximityVolumes();
  }, [broadcastLocalPosition, applyProximityVolumes]);

  // Periodic re-apply: handles peers becoming stale, fresh subscriptions, and
  // connection-quality fluctuation. Cheap — pure math + one setVolume call.
  useEffect(() => {
    if (state !== "connected" && state !== "reconnecting") {
      if (proximityTimerRef.current) {
        clearInterval(proximityTimerRef.current);
        proximityTimerRef.current = null;
      }
      return;
    }
    proximityTimerRef.current = setInterval(() => {
      applyProximityVolumes();
    }, 750);
    return () => {
      if (proximityTimerRef.current) {
        clearInterval(proximityTimerRef.current);
        proximityTimerRef.current = null;
      }
    };
  }, [state, applyProximityVolumes]);

  // Reset proximity state when leaving the room.
  useEffect(() => {
    if (state === "idle") {
      remotePositionsRef.current.clear();
      lastBroadcastedPosRef.current = null;
      lastBroadcastRef.current = 0;
    }
  }, [state]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const localPub = Array.from(room.localParticipant.audioTrackPublications.values())[0];
    const localTrack = (localPub?.track as LocalAudioTrack | undefined) ?? null;
    const next = !isMicMuted;
    if (localTrack) {
      if (next) await localTrack.mute();
      else await localTrack.unmute();
    } else {
      // No track yet — toggle by re-enabling the mic publication.
      await room.localParticipant.setMicrophoneEnabled(!next);
    }
    setIsMicMuted(next);
    refreshParticipants();
  }, [isMicMuted, refreshParticipants]);

  // ── Token refresh watchdog ─────────────────────────────────────
  // Fetches a fresh LiveKit JWT 5 minutes before TTL elapses. livekit-client
  // does not expose a public hot-swap method, so we attempt the undocumented
  // `Room.updateToken` if the build supports it; otherwise the timer simply
  // re-arms with the new expiry. The server-side mint refreshes its own audit
  // log even when the client can't hot-swap, and the user can reconnect
  // manually if the session does eventually drop.
  const refreshToken = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !channelId) return;
    try {
      const url = characterId
        ? `/api/channels/${channelId}/voice/token?characterId=${encodeURIComponent(characterId)}`
        : `/api/channels/${channelId}/voice/token`;
      const res = await fetch(url, { method: "POST", credentials: "same-origin" });
      if (!res.ok) return;
      const data = (await res.json()) as VoiceTokenResponse;
      tokenExpiresAtRef.current = new Date(data.expiresAt).getTime();
      // Hot-swap if the SDK build exposes it; otherwise no-op. The timer
      // above re-arms based on the fresh expiry regardless.
      const maybeUpdate = (room as unknown as { updateToken?: (t: string) => void | Promise<void> })
        .updateToken;
      if (typeof maybeUpdate === "function") {
        try {
          await maybeUpdate.call(room, data.token);
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* try again on the next tick */
    }
  }, [channelId, characterId]);

  useEffect(() => {
    if (state !== "connected") {
      if (tokenRefreshTimerRef.current) {
        clearTimeout(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
      return;
    }
    const expiresAt = tokenExpiresAtRef.current;
    if (!expiresAt) return;
    // Refresh 5 minutes before expiry, with a floor of 30s so a near-expired
    // token still gets one chance.
    const ttl = expiresAt - Date.now();
    const delay = Math.max(30_000, ttl - 5 * 60 * 1000);
    tokenRefreshTimerRef.current = setTimeout(() => {
      void refreshToken();
    }, delay);
    return () => {
      if (tokenRefreshTimerRef.current) {
        clearTimeout(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
    };
  }, [state, refreshToken]);

  // ── Cleanup on channel switch ──────────────────────────────────
  // Bumps the generation so any in-flight connect() abandons its room, then
  // tears down whatever was already connected. Component-unmount cleanup
  // lives in the dedicated aliveRef effect above.
  useEffect(() => {
    return () => {
      generationRef.current++;
      const room = roomRef.current;
      if (room) {
        roomRef.current = null;
        room.disconnect().catch(() => undefined);
      }
    };
  }, [channelId]);

  return useMemo(
    () => ({
      state,
      errorCode,
      isMicMuted,
      participants,
      available,
      voiceSettings,
      connect,
      disconnect,
      toggleMute,
      refreshSettings,
      screenShares,
      isLocalScreenSharing,
      startScreenShare,
      stopScreenShare,
      cameras,
      isLocalCameraOn,
      startCamera,
      stopCamera,
      updateLocalPosition,
    }),
    [
      state,
      errorCode,
      isMicMuted,
      participants,
      available,
      voiceSettings,
      connect,
      disconnect,
      toggleMute,
      refreshSettings,
      screenShares,
      isLocalScreenSharing,
      startScreenShare,
      stopScreenShare,
      cameras,
      isLocalCameraOn,
      startCamera,
      stopCamera,
      updateLocalPosition,
    ],
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function toVoiceParticipant(p: Participant, isLocal: boolean): VoiceParticipant {
  let metadata: Record<string, unknown> | null = null;
  if (p.metadata) {
    try {
      metadata = JSON.parse(p.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  // Mute state: any audio publication flagged muted = participant is muted.
  const audioPubs = Array.from(p.audioTrackPublications.values());
  const isMuted = audioPubs.length === 0 || audioPubs.every((pub) => pub.isMuted);
  return {
    identity: p.identity,
    name: p.name || p.identity,
    isLocal,
    isMuted,
    isSpeaking: p.isSpeaking,
    audioLevel: p.audioLevel,
    metadata,
  };
}

function attachRoomListeners(
  livekit: typeof import("livekit-client"),
  room: Room,
  handlers: {
    onParticipantsChange: () => void;
    onTracksChange: () => void;
    onConnectionStateChange: (state: import("livekit-client").ConnectionState) => void;
    onDataReceived: (data: Uint8Array, participant: RemoteParticipant | undefined) => void;
  },
): void {
  const evt = livekit.RoomEvent;
  const participantEvents: RoomEvent[] = [
    evt.ParticipantConnected,
    evt.ParticipantDisconnected,
    evt.ActiveSpeakersChanged,
    evt.ParticipantMetadataChanged,
  ];
  const trackEvents: RoomEvent[] = [
    evt.TrackSubscribed,
    evt.TrackUnsubscribed,
    evt.TrackMuted,
    evt.TrackUnmuted,
    evt.LocalTrackPublished,
    evt.LocalTrackUnpublished,
    evt.TrackPublished,
    evt.TrackUnpublished,
  ];
  for (const ev of participantEvents) {
    room.on(ev, handlers.onParticipantsChange as never);
  }
  for (const ev of trackEvents) {
    room.on(ev, handlers.onTracksChange as never);
  }
  room.on(evt.ConnectionStateChanged, handlers.onConnectionStateChange as never);
  room.on(evt.DataReceived, handlers.onDataReceived as never);
}

function isScreenShareSource(source: Track.Source | undefined): boolean {
  if (!source) return false;
  // Source is an enum at runtime; comparing to its string values keeps the
  // helper independent of the type-only import we use for `Track`.
  return source === "screen_share" || source === ("screen_share_audio" as Track.Source);
}

function isCameraSource(source: Track.Source | undefined): boolean {
  if (!source) return false;
  return source === "camera";
}

function isUserAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  if (e.name === "AbortError" || e.name === "NotFoundError") return true;
  return /aborted|cancel/i.test(e.message ?? "");
}

function isPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  if (e.name === "NotAllowedError" || e.name === "SecurityError") return true;
  return /denied|permission/i.test(e.message ?? "");
}

// Note: we don't pin remote audio tracks to <audio> elements explicitly —
// livekit-client auto-attaches subscribed audio tracks to a hidden DOM
// element, which is what we want for spatial audio later (Phase 5 will
// override this). Keep that knowledge in mind when implementing proximity.

// Keep RemoteParticipant import noted so future proximity code that pulls
// per-participant data over data channel has the type ready.
export type { RemoteParticipant };

"use client";
//
// VoiceBar — bottom-anchored realtime voice control. Shows a Connect button
// when idle, a participant list + mute toggle when connected, and dims out
// gracefully when LiveKit isn't configured on the server.
//
// Pure presentation; all state lives in useLiveKitVoice. This separation
// makes the bar trivially testable in isolation and keeps Phaser-side
// proximity wiring (Phase 5) from leaking into the UI.

import { useEffect, useMemo } from "react";
import { Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Video, VideoOff, Volume2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useLiveKitVoice, type VoiceParticipant } from "@/hooks/useLiveKitVoice";
import { EventBus } from "@/game/EventBus";
import ScreenShareViewer from "./ScreenShareViewer";
import VideoTilesGrid from "./VideoTilesGrid";

interface VoiceBarProps {
  channelId: string | null;
  characterId: string | null;
}

export default function VoiceBar({ channelId, characterId }: VoiceBarProps) {
  const t = useT();
  const voice = useLiveKitVoice(channelId, characterId);

  // Pre-compute mute lookup once per render so VideoTilesGrid can flag tiles
  // without each tile fanning out into the participants list. Must run before
  // any early return to satisfy the rules-of-hooks ordering invariant.
  const mutedByIdentity = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const p of voice.participants) m.set(p.identity, p.isMuted);
    return m;
  }, [voice.participants]);

  // Bridge Phaser's local-tile event into the proximity voice hook. Done at
  // the VoiceBar level so the hook itself never needs to know Phaser exists.
  useEffect(() => {
    const handler = (data: { x: number; y: number }) => {
      voice.updateLocalPosition(data.x, data.y);
    };
    EventBus.on("local-player-tile", handler);
    return () => {
      EventBus.off("local-player-tile", handler);
    };
  }, [voice]);

  // Hide entirely when LiveKit isn't configured or the channel owner has
  // disabled voice. The owner can flip enabled=true via channel settings to
  // make the bar appear for everyone.
  if (!voice.available) return null;

  const isConnected = voice.state === "connected" || voice.state === "reconnecting";
  const isBusy = voice.state === "connecting" || voice.state === "disconnecting";

  return (
    <>
    <ScreenShareViewer shares={voice.screenShares} />
    <VideoTilesGrid cameras={voice.cameras} mutedByIdentity={mutedByIdentity} />
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
      <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-surface/95 border border-border shadow-xl backdrop-blur">
        {!isConnected && !isBusy && (
          <button
            onClick={() => voice.connect()}
            className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary text-white text-xs font-semibold hover:brightness-110"
          >
            <Volume2 className="w-3.5 h-3.5" />
            {t("voice.connect")}
          </button>
        )}

        {isBusy && (
          <span className="text-xs text-text-muted px-2 py-1 flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
            {t("voice.connecting")}
          </span>
        )}

        {isConnected && (
          <>
            <button
              onClick={() => voice.toggleMute()}
              className={`flex items-center justify-center w-8 h-8 rounded-full transition ${
                voice.isMicMuted
                  ? "bg-danger/20 text-danger hover:bg-danger/30"
                  : "bg-primary/20 text-primary hover:bg-primary/30"
              }`}
              title={t("voice.muteToggle")}
              aria-label={t("voice.muteToggle")}
            >
              {voice.isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            <button
              onClick={() => (voice.isLocalCameraOn ? voice.stopCamera() : voice.startCamera())}
              className={`flex items-center justify-center w-8 h-8 rounded-full transition ${
                voice.isLocalCameraOn
                  ? "bg-primary/30 text-primary hover:bg-primary/40"
                  : "bg-surface-raised text-text hover:bg-surface-raised/80"
              }`}
              title={voice.isLocalCameraOn ? t("voice.stopCamera") : t("voice.startCamera")}
              aria-label={voice.isLocalCameraOn ? t("voice.stopCamera") : t("voice.startCamera")}
            >
              {voice.isLocalCameraOn ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
            </button>

            <button
              onClick={() => (voice.isLocalScreenSharing ? voice.stopScreenShare() : voice.startScreenShare())}
              className={`flex items-center justify-center w-8 h-8 rounded-full transition ${
                voice.isLocalScreenSharing
                  ? "bg-amber-500/30 text-amber-300 hover:bg-amber-500/40"
                  : "bg-surface-raised text-text hover:bg-surface-raised/80"
              }`}
              title={voice.isLocalScreenSharing ? t("voice.stopScreenShare") : t("voice.startScreenShare")}
              aria-label={voice.isLocalScreenSharing ? t("voice.stopScreenShare") : t("voice.startScreenShare")}
            >
              {voice.isLocalScreenSharing ? <MonitorX className="w-4 h-4" /> : <MonitorUp className="w-4 h-4" />}
            </button>

            <ParticipantList participants={voice.participants} />

            <button
              onClick={() => voice.disconnect()}
              className="flex items-center justify-center w-8 h-8 rounded-full bg-danger/15 hover:bg-danger/30 text-danger"
              title={t("voice.disconnect")}
              aria-label={t("voice.disconnect")}
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </>
        )}

        {voice.errorCode && (
          <span className="text-[10px] text-danger ml-1 max-w-[160px] truncate">
            {translateError(t, voice.errorCode)}
          </span>
        )}
      </div>
    </div>
    </>
  );
}

function ParticipantList({ participants }: { participants: VoiceParticipant[] }) {
  const t = useT();
  if (participants.length === 0) return null;
  return (
    <div className="flex items-center gap-1 px-1">
      {participants.slice(0, 6).map((p) => (
        <ParticipantPill key={p.identity} participant={p} />
      ))}
      {participants.length > 6 && (
        <span className="text-[10px] text-text-muted px-1">+{participants.length - 6}</span>
      )}
      <span className="text-[10px] text-text-muted ml-1 hidden sm:inline">
        {t("voice.participants", { count: String(participants.length) })}
      </span>
    </div>
  );
}

function ParticipantPill({ participant }: { participant: VoiceParticipant }) {
  const ring = participant.isSpeaking
    ? "ring-2 ring-primary"
    : participant.isMuted
    ? "ring-1 ring-text-dim/40"
    : "ring-1 ring-text-dim/20";
  return (
    <div
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface-raised text-[11px] ${ring}`}
      title={`${participant.name}${participant.isMuted ? " (muted)" : ""}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          participant.isSpeaking
            ? "bg-primary animate-pulse"
            : participant.isMuted
            ? "bg-danger/50"
            : "bg-text-dim/50"
        }`}
      />
      <span className="max-w-[80px] truncate">{participant.name}</span>
    </div>
  );
}

function translateError(t: (key: string, values?: Record<string, string>) => string, code: string): string {
  switch (code) {
    case "voice_not_configured":
      return t("voice.notConfigured");
    case "voice_disabled":
      return t("voice.disabled");
    case "voice_permission_denied":
      return t("voice.permissionDenied");
    case "screen_permission_denied":
      return t("voice.screenPermissionDenied");
    case "screen_share_failed":
      return t("voice.screenShareFailed");
    case "camera_permission_denied":
      return t("voice.cameraPermissionDenied");
    case "camera_failed":
      return t("voice.cameraFailed");
    default:
      return t("voice.connectFailed");
  }
}

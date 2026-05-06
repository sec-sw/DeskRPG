"use client";
//
// ScreenShareViewer — floating window that displays one or more active screen
// shares from the LiveKit room. The local presenter doesn't see their own
// screen by default (avoids feedback loops); a small "Sharing" badge on the
// VoiceBar covers that case.
//
// Implementation note: livekit-client tracks are bound to <video> elements
// via `track.attach(el)`. We do this in a useEffect so React's lifecycle
// stays clean. Detach happens automatically when track or element changes.

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { Track } from "livekit-client";
import { useT } from "@/lib/i18n";
import type { ScreenShareEntry } from "@/hooks/useLiveKitVoice";

interface ScreenShareViewerProps {
  shares: ScreenShareEntry[];
  /** When true, hide rather than render — keeps the component mounted to preserve <video> state. */
  hidden?: boolean;
  onClose?: () => void;
}

export default function ScreenShareViewer({ shares, hidden, onClose }: ScreenShareViewerProps) {
  const t = useT();
  const remote = shares.filter((s) => !s.isLocal);
  const [activeSid, setActiveSid] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-pick the first remote share when the active one disappears.
  useEffect(() => {
    if (!remote.length) {
      if (activeSid !== null) setActiveSid(null);
      return;
    }
    const stillThere = activeSid && remote.some((s) => s.trackSid === activeSid);
    if (!stillThere) setActiveSid(remote[0].trackSid);
  }, [remote, activeSid]);

  // Keep our fullscreen flag in sync when the user exits via Esc / browser UI.
  useEffect(() => {
    const handler = () => {
      setFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  if (hidden || remote.length === 0) return null;

  const active = remote.find((s) => s.trackSid === activeSid) ?? remote[0];

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
        .then(() => setFullscreen(true))
        .catch(() => undefined);
    } else {
      document.exitFullscreen?.().then(() => setFullscreen(false)).catch(() => undefined);
    }
  };

  return (
    <div
      ref={containerRef}
      className="fixed top-[60px] right-4 z-30 bg-black/95 border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col"
      style={{ width: fullscreen ? "100vw" : "min(640px, 50vw)", height: fullscreen ? "100vh" : "auto" }}
    >
      <div className="flex items-center justify-between px-2 py-1 bg-surface/90 border-b border-border">
        <div className="flex items-center gap-1.5 text-xs text-text-secondary min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" aria-hidden />
          <span className="truncate">{active.participantName}</span>
        </div>
        <div className="flex items-center gap-1">
          {remote.length > 1 && (
            <select
              value={active.trackSid}
              onChange={(e) => setActiveSid(e.target.value)}
              className="bg-surface text-xs text-text rounded px-1 py-0.5 border border-border max-w-[120px]"
            >
              {remote.map((s) => (
                <option key={s.trackSid} value={s.trackSid}>
                  {s.participantName}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={toggleFullscreen}
            className="p-1 text-text-muted hover:text-text"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-text-muted hover:text-text"
              title={t("common.close")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <ScreenVideo track={active.track} />
    </div>
  );
}

function ScreenVideo({ track }: { track: Track | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      // Detach this specific element rather than calling track.detach() which
      // would unbind all elements bound to the track.
      try {
        track.detach(el);
      } catch {
        /* track may already be unsubscribed */
      }
    };
  }, [track]);

  if (!track) {
    return (
      <div className="w-full aspect-video flex items-center justify-center text-text-dim text-xs">
        Connecting…
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      className="w-full h-auto max-h-[80vh] object-contain bg-black"
      autoPlay
      playsInline
      muted={false}
    />
  );
}

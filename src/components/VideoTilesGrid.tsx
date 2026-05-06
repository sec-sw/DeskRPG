"use client";
//
// VideoTilesGrid — small floating grid of camera tiles, one per active
// camera publication. Shown only when at least one participant has their
// camera on; the local participant's own tile mirrors horizontally so it
// feels like a "selfie view" instead of a webcam.
//
// Self-contained DOM detach: each tile owns its <video> ref and binds the
// LiveKit track via track.attach() in a useEffect so React/SDK lifecycles
// stay in sync.

import { useEffect, useRef } from "react";
import { MicOff } from "lucide-react";
import type { Track } from "livekit-client";
import type { CameraEntry } from "@/hooks/useLiveKitVoice";

interface VideoTilesGridProps {
  cameras: CameraEntry[];
  /**
   * Map of participant identity → isMuted flag, sourced from the same
   * useLiveKitVoice instance that produced `cameras`. Lets us draw a
   * mic-off badge over a tile without a second hook.
   */
  mutedByIdentity: Map<string, boolean>;
}

export default function VideoTilesGrid({ cameras, mutedByIdentity }: VideoTilesGridProps) {
  if (cameras.length === 0) return null;

  // Show up to 6 cameras in the grid; the rest get summed into a "+N" pill.
  // Six fits 2×3 comfortably on most screens without occluding the game.
  const visible = cameras.slice(0, 6);
  const overflow = cameras.length - visible.length;

  return (
    <div className="fixed top-[60px] left-3 z-30 pointer-events-auto">
      <div className="grid grid-cols-2 gap-1.5 max-w-[260px]">
        {visible.map((cam) => (
          <VideoTile
            key={cam.trackSid}
            camera={cam}
            isMuted={!!mutedByIdentity.get(cam.participantIdentity)}
          />
        ))}
      </div>
      {overflow > 0 && (
        <div className="text-[10px] text-text-muted mt-1 pl-1">+{overflow} more</div>
      )}
    </div>
  );
}

function VideoTile({ camera, isMuted }: { camera: CameraEntry; isMuted: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    const track = camera.track;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      try {
        track.detach(el);
      } catch {
        /* track may already be unsubscribed */
      }
    };
  }, [camera.track]);

  return (
    <div className="relative w-[120px] aspect-video rounded-md overflow-hidden bg-black border border-border shadow-md">
      {camera.track ? (
        <video
          ref={videoRef}
          className={`w-full h-full object-cover ${camera.isLocal ? "scale-x-[-1]" : ""}`}
          autoPlay
          playsInline
          muted={camera.isLocal /* never echo local mic into local speaker */}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-text-dim text-[10px]">
          ...
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 px-1.5 py-0.5 bg-black/60 flex items-center justify-between gap-1">
        <span className="text-[10px] text-white truncate">{camera.participantName}</span>
        {isMuted && <MicOff className="w-3 h-3 text-danger flex-shrink-0" />}
      </div>
    </div>
  );
}

"use client";
//
// React hook: live channel attachment list backed by REST + Socket.IO.
//
// - On mount/channelId-change, fetches the current list.
// - Subscribes to "attachment:created" / "attachment:deleted" room events so
//   uploads from any participant show up immediately.
// - Exposes upload + delete helpers that hit the REST API; the canonical
//   list update arrives back over the socket so optimistic state isn't
//   strictly necessary, but we still patch eagerly for snappy feedback.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

export interface ChannelAttachment {
  id: string;
  channelId: string;
  uploaderId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  hasThumbnail: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UseChannelAttachmentsResult {
  items: ChannelAttachment[];
  loading: boolean;
  error: string | null;
  upload: (file: File) => Promise<ChannelAttachment | null>;
  remove: (attachmentId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

interface AttachmentEventPayload {
  attachment?: ChannelAttachment;
  attachmentId?: string;
  channelId?: string;
}

export function useChannelAttachments(
  channelId: string | null,
  socket: Socket | null,
): UseChannelAttachmentsResult {
  const [items, setItems] = useState<ChannelAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!channelId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${channelId}/attachments`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await safeJson(res);
        throw new Error(data?.errorCode || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { items: ChannelAttachment[] };
      if (aliveRef.current) setItems(data.items);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [channelId]);

  // Initial + channel-change fetch.
  useEffect(() => {
    aliveRef.current = true;
    refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  // Live updates from the server room.
  useEffect(() => {
    if (!socket) return;
    const onCreated = (payload: AttachmentEventPayload) => {
      if (!payload.attachment) return;
      setItems((prev) => {
        if (prev.some((a) => a.id === payload.attachment!.id)) return prev;
        return [payload.attachment!, ...prev];
      });
    };
    const onDeleted = (payload: AttachmentEventPayload) => {
      if (!payload.attachmentId) return;
      setItems((prev) => prev.filter((a) => a.id !== payload.attachmentId));
    };
    socket.on("attachment:created", onCreated);
    socket.on("attachment:deleted", onDeleted);
    return () => {
      socket.off("attachment:created", onCreated);
      socket.off("attachment:deleted", onDeleted);
    };
  }, [socket]);

  const upload = useCallback(
    async (file: File): Promise<ChannelAttachment | null> => {
      if (!channelId) return null;
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/channels/${channelId}/attachments`, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const data = await safeJson(res);
      if (!res.ok) {
        const errorCode =
          (data && typeof data === "object" && "errorCode" in data && (data.errorCode as string)) ||
          `HTTP ${res.status}`;
        if (aliveRef.current) setError(errorCode);
        return null;
      }
      const created: ChannelAttachment | undefined = data?.attachment;
      if (created && aliveRef.current) {
        setItems((prev) =>
          prev.some((a) => a.id === created.id) ? prev : [created, ...prev],
        );
      }
      return created ?? null;
    },
    [channelId],
  );

  const remove = useCallback(async (attachmentId: string): Promise<boolean> => {
    const res = await fetch(`/api/attachments/${attachmentId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!res.ok) return false;
    if (aliveRef.current) setItems((prev) => prev.filter((a) => a.id !== attachmentId));
    return true;
  }, []);

  return { items, loading, error, upload, remove, refresh };
}

async function safeJson(res: Response): Promise<{ errorCode?: string; attachment?: ChannelAttachment } | null> {
  try {
    return (await res.json()) as { errorCode?: string; attachment?: ChannelAttachment };
  } catch {
    return null;
  }
}

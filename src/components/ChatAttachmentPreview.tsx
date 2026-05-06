"use client";
//
// ChatAttachmentPreview — inline rendering of a shared attachment inside a
// channel chat bubble. Lazy-fetches the lightweight metadata once per id so
// it stays responsive even when the message arrives before the file list.

import { useEffect, useState } from "react";
import { Download, FileIcon } from "lucide-react";
import type { ChannelAttachment } from "@/hooks/useChannelAttachments";
import { useT } from "@/lib/i18n";

interface ChatAttachmentPreviewProps {
  attachmentId: string;
  /** Cached list from useChannelAttachments — checked first to skip a fetch. */
  cache?: ChannelAttachment[];
}

const metadataCache = new Map<string, ChannelAttachment | null>();

export default function ChatAttachmentPreview({
  attachmentId,
  cache,
}: ChatAttachmentPreviewProps) {
  const t = useT();
  const cachedHit = cache?.find((a) => a.id === attachmentId) ?? metadataCache.get(attachmentId);
  const [data, setData] = useState<ChannelAttachment | null | undefined>(cachedHit);

  useEffect(() => {
    if (data !== undefined) return;
    let cancelled = false;
    (async () => {
      // No public single-attachment metadata route — list endpoints already
      // cover most cases. As a fallback, do a HEAD-style fetch of the
      // download URL just to learn the content-type / filename, but this is
      // wasteful, so prefer cache. We deliberately keep the network path
      // minimal: in practice useChannelAttachments will fill the cache.
      try {
        const res = await fetch(`/api/attachments/${attachmentId}`, {
          method: "HEAD",
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (!cancelled) setData(null);
          metadataCache.set(attachmentId, null);
          return;
        }
        const filename =
          parseFilenameFromDisposition(res.headers.get("content-disposition")) ||
          attachmentId;
        const placeholder: ChannelAttachment = {
          id: attachmentId,
          channelId: "",
          uploaderId: "",
          filename,
          contentType: res.headers.get("content-type") || "application/octet-stream",
          byteSize: Number(res.headers.get("content-length") || "0"),
          sha256: "",
          hasThumbnail: (res.headers.get("content-type") || "").startsWith("image/"),
          metadata: {},
          createdAt: new Date().toISOString(),
        };
        if (!cancelled) setData(placeholder);
        metadataCache.set(attachmentId, placeholder);
      } catch {
        if (!cancelled) setData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachmentId, data]);

  if (data === undefined) {
    return (
      <div className="mt-1 w-32 h-12 rounded bg-surface/50 animate-pulse" aria-hidden />
    );
  }
  if (data === null) {
    return (
      <div className="mt-1 text-xs text-text-dim italic">
        {t("attachments.openFile")}
      </div>
    );
  }

  const isImage = data.contentType.startsWith("image/");

  return (
    <a
      href={`/api/attachments/${data.id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-flex items-center gap-2 max-w-[260px] rounded bg-surface/70 hover:bg-surface px-2 py-1.5 group transition"
      title={t("attachments.openFile")}
    >
      {isImage && data.hasThumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/attachments/${data.id}/thumb`}
          alt=""
          className="w-12 h-12 rounded object-cover bg-surface"
          loading="lazy"
        />
      ) : (
        <div className="w-10 h-10 rounded bg-surface flex items-center justify-center">
          <FileIcon className="w-5 h-5 text-text-dim" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate">{data.filename}</div>
        {data.byteSize > 0 && (
          <div className="text-[10px] text-text-dim">{formatBytes(data.byteSize)}</div>
        )}
      </div>
      <Download className="w-3.5 h-3.5 text-text-dim opacity-0 group-hover:opacity-100" />
    </a>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseFilenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition) || /filename=([^;\s]+)/i.exec(disposition);
  return plain?.[1] ?? null;
}

"use client";
//
// ChannelFilesPanel — list, upload, download, and delete persistent
// attachments for a channel. Designed as a self-contained drop-in: pass it
// channelId + socket + currentUserId/isOwner, and it handles the rest.

import { useCallback, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { Download, Trash2, Upload, FileIcon, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  useChannelAttachments,
  type ChannelAttachment,
} from "@/hooks/useChannelAttachments";

interface ChannelFilesPanelProps {
  channelId: string;
  socket: Socket | null;
  /**
   * Channel owners and system_admin always see Delete; otherwise the button is
   * hidden in the UI even though the server still allows the original uploader
   * to delete their own attachment via the REST API.
   */
  isOwner: boolean;
  onClose?: () => void;
}

export default function ChannelFilesPanel({
  channelId,
  socket,
  isOwner,
  onClose,
}: ChannelFilesPanelProps) {
  const t = useT();
  const { items, loading, error, upload, remove } = useChannelAttachments(channelId, socket);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setActionError(null);
      const list = Array.from(files);
      for (const file of list) {
        setUploadingNames((prev) => [...prev, file.name]);
        try {
          const result = await upload(file);
          if (!result) {
            setActionError(`${file.name}: ${t("attachments.uploadFailed")}`);
          }
        } finally {
          setUploadingNames((prev) => {
            const idx = prev.indexOf(file.name);
            if (idx === -1) return prev;
            const next = prev.slice();
            next.splice(idx, 1);
            return next;
          });
        }
      }
    },
    [upload, t],
  );

  const onSelectFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) handleFiles(e.target.files);
      e.target.value = "";
    },
    [handleFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const onDelete = useCallback(
    async (attachment: ChannelAttachment) => {
      if (!confirm(t("attachments.deleteConfirm", { name: attachment.filename }))) return;
      const ok = await remove(attachment.id);
      if (!ok) setActionError(t("attachments.deleteFailed"));
    },
    [remove, t],
  );

  return (
    <div className="flex flex-col h-full bg-bg/95 text-text">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface/80">
        <span className="text-sm font-bold text-text-secondary">{t("attachments.title")}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs px-2 py-1 rounded bg-primary/20 hover:bg-primary/30 text-primary flex items-center gap-1"
            title={t("attachments.upload")}
          >
            <Upload className="w-3.5 h-3.5" />
            {t("attachments.upload")}
          </button>
          {onClose && (
            <button onClick={onClose} className="text-text-muted hover:text-text" title={t("common.close")}>
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onSelectFiles}
        />
      </div>

      {/* Drop zone + list */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex-1 overflow-y-auto px-3 py-2 transition-colors ${
          dragOver ? "bg-primary/10 outline-dashed outline-2 outline-primary/40" : ""
        }`}
      >
        {loading && items.length === 0 && (
          <div className="text-text-dim text-sm italic py-4 text-center">{t("common.loading")}</div>
        )}
        {!loading && items.length === 0 && uploadingNames.length === 0 && (
          <div className="text-text-dim text-sm italic py-6 text-center">
            {t("attachments.empty")}
          </div>
        )}
        {error && (
          <div className="text-danger text-xs px-2 py-1 mb-2 bg-danger/10 rounded">
            {error}
          </div>
        )}
        {actionError && (
          <div className="text-danger text-xs px-2 py-1 mb-2 bg-danger/10 rounded">
            {actionError}
          </div>
        )}

        {/* In-flight uploads */}
        {uploadingNames.map((name) => (
          <div
            key={`uploading-${name}`}
            className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded bg-surface/50 text-xs text-text-muted"
          >
            <div className="w-3 h-3 rounded-full border-2 border-primary/50 border-t-primary animate-spin" />
            <span className="truncate flex-1">{name}</span>
          </div>
        ))}

        {items.map((attachment) => (
          <AttachmentRow
            key={attachment.id}
            attachment={attachment}
            canDelete={isOwner}
            onDelete={() => onDelete(attachment)}
          />
        ))}
      </div>
    </div>
  );
}

function AttachmentRow({
  attachment,
  canDelete,
  onDelete,
}: {
  attachment: ChannelAttachment;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 px-2 py-2 mb-1 rounded hover:bg-surface/50 group">
      {attachment.hasThumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/attachments/${attachment.id}/thumb`}
          alt=""
          className="w-10 h-10 rounded object-cover bg-surface flex-shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="w-10 h-10 rounded bg-surface flex items-center justify-center flex-shrink-0">
          <FileIcon className="w-5 h-5 text-text-dim" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{attachment.filename}</div>
        <div className="text-[10px] text-text-dim">
          {formatBytes(attachment.byteSize)} · {formatRelativeTime(attachment.createdAt)}
        </div>
      </div>
      <a
        href={`/api/attachments/${attachment.id}`}
        download={attachment.filename}
        className="opacity-0 group-hover:opacity-100 transition p-1 text-text-muted hover:text-text"
        title={t("attachments.download")}
      >
        <Download className="w-4 h-4" />
      </a>
      {canDelete && (
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 transition p-1 text-text-muted hover:text-danger"
          title={t("attachments.delete")}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

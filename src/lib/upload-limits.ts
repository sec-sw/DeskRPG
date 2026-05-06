export const MAX_MAIN_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_AUXILIARY_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 128;
export const MAX_ARCHIVE_TOTAL_BYTES = 25 * 1024 * 1024;

// Channel-shared attachments are a separate flow from AI-context uploads above.
// 100 MiB per file / 5 GiB per channel by default; both env-overridable.
export const DEFAULT_ATTACHMENT_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CHANNEL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback;
  return n;
}

export function getAttachmentFileMaxBytes(): number {
  return parsePositiveInt(process.env.STORAGE_FILE_MAX_BYTES, DEFAULT_ATTACHMENT_FILE_MAX_BYTES);
}

export function getChannelQuotaBytes(): number {
  // 0 disables the quota check entirely.
  return parsePositiveInt(process.env.STORAGE_CHANNEL_QUOTA_BYTES, DEFAULT_CHANNEL_QUOTA_BYTES);
}

export type UploadLimitErrorCode =
  | "upload_file_too_large"
  | "upload_archive_too_large"
  | "upload_archive_too_many_entries"
  | "attachment_file_too_large"
  | "channel_quota_exceeded";

export function validateAttachmentFileSize(byteLength: number): UploadLimitErrorCode | null {
  return byteLength > getAttachmentFileMaxBytes() ? "attachment_file_too_large" : null;
}

export function validateChannelQuota(currentBytes: number, incomingBytes: number): UploadLimitErrorCode | null {
  const cap = getChannelQuotaBytes();
  if (cap === 0) return null;
  return currentBytes + incomingBytes > cap ? "channel_quota_exceeded" : null;
}

export class UploadLimitError extends Error {
  errorCode: UploadLimitErrorCode;
  status: number;

  constructor(errorCode: UploadLimitErrorCode, message: string, status = 413) {
    super(message);
    this.name = "UploadLimitError";
    this.errorCode = errorCode;
    this.status = status;
  }
}

export function validateMainUploadSize(byteLength: number): UploadLimitErrorCode | null {
  return byteLength > MAX_MAIN_UPLOAD_BYTES ? "upload_file_too_large" : null;
}

export function validateAuxiliaryUploadSize(byteLength: number): UploadLimitErrorCode | null {
  return byteLength > MAX_AUXILIARY_UPLOAD_BYTES ? "upload_file_too_large" : null;
}

export function consumeArchiveEntry(
  budget: { entries: number; totalBytes: number },
  byteLength: number,
):
  | { ok: true; budget: { entries: number; totalBytes: number } }
  | { ok: false; errorCode: UploadLimitErrorCode } {
  const nextEntries = budget.entries + 1;
  if (nextEntries > MAX_ARCHIVE_ENTRIES) {
    return { ok: false, errorCode: "upload_archive_too_many_entries" };
  }

  const nextTotalBytes = budget.totalBytes + byteLength;
  if (nextTotalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
    return { ok: false, errorCode: "upload_archive_too_large" };
  }

  return {
    ok: true,
    budget: {
      entries: nextEntries,
      totalBytes: nextTotalBytes,
    },
  };
}

export function throwIfUploadLimitExceeded(errorCode: UploadLimitErrorCode | null): void {
  if (!errorCode) return;
  switch (errorCode) {
    case "upload_file_too_large":
      throw new UploadLimitError(errorCode, "Uploaded file exceeds size limit");
    case "upload_archive_too_large":
      throw new UploadLimitError(errorCode, "Archive expands beyond supported size");
    case "upload_archive_too_many_entries":
      throw new UploadLimitError(errorCode, "Archive contains too many files");
    case "attachment_file_too_large":
      throw new UploadLimitError(errorCode, "Attachment exceeds per-file size limit");
    case "channel_quota_exceeded":
      throw new UploadLimitError(errorCode, "Channel storage quota exceeded");
  }
}

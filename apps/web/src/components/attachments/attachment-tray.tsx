import { Icon } from "../icon.js";
import { attachmentDetail } from "./attachment-parts.js";
import type { StagedAttachment } from "./use-staged-attachments.js";

/**
 * The files riding on the message being written, above its words. Each says
 * where its upload stands; a failed one says why in place and offers Retry
 * when trying again can help. Thumbnails stay chip-sized whatever the image.
 */
export function AttachmentTray({
  disabled,
  items,
  notice,
  onDismissNotice,
  onRemove,
  onRetry,
  sending,
}: {
  readonly disabled: boolean;
  readonly items: readonly StagedAttachment[];
  readonly notice: string | null;
  readonly onDismissNotice: () => void;
  readonly onRemove: (localId: string) => void;
  readonly onRetry: (localId: string) => void;
  /** Files in the message now on its way, which can no longer be taken out. */
  readonly sending: ReadonlySet<string>;
}) {
  if (items.length === 0 && notice === null) return null;
  const waiting = items.filter(
    (item) => item.status === "uploading" || item.status === "checking",
  ).length;
  const failed = items.filter((item) => item.status === "failed").length;
  const summary = [
    waiting > 0 ? `${waiting} uploading` : "",
    failed > 0 ? `${failed} could not be attached` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="attachment-tray">
      {items.length > 0 ? (
        <ul aria-label="Attachments" className="attachment-tray__list">
          {items.map((item) => (
            <StagedChip
              disabled={disabled}
              item={item}
              key={item.localId}
              onRemove={onRemove}
              onRetry={onRetry}
              sending={sending.has(item.localId)}
            />
          ))}
        </ul>
      ) : null}
      <p aria-live="polite" className="visually-hidden">
        {summary}
      </p>
      {notice ? (
        <p className="attachment-tray__notice" role="alert">
          <span>{notice}</span>
          <button
            aria-label="Dismiss"
            className="attachment-tray__dismiss"
            onClick={onDismissNotice}
            type="button"
          >
            <Icon name="close" />
          </button>
        </p>
      ) : null}
    </div>
  );
}

function StagedChip({
  disabled,
  item,
  onRemove,
  onRetry,
  sending,
}: {
  readonly disabled: boolean;
  readonly item: StagedAttachment;
  readonly onRemove: (localId: string) => void;
  readonly onRetry: (localId: string) => void;
  readonly sending: boolean;
}) {
  const busy = item.status === "uploading" || item.status === "checking";
  const detail =
    item.status === "uploading"
      ? "Uploading…"
      : item.status === "checking"
        ? "Checking…"
        : item.status === "failed"
          ? (item.error ?? "Could not be attached.")
          : sending
            ? "Sending…"
            : attachmentDetail(item.name, item.mediaType, item.sizeBytes);
  const errorId = `attachment-${item.localId}-error`;
  return (
    <li
      aria-busy={busy || sending}
      className={[
        "staged-attachment",
        item.status === "failed" ? "staged-attachment--failed" : "",
        sending ? "staged-attachment--sending" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span aria-hidden className="staged-attachment__media">
        {item.previewUrl ? <img alt="" src={item.previewUrl} /> : <Icon name="file" />}
        {busy ? <span className="spinner staged-attachment__spinner" /> : null}
        {item.status === "failed" ? (
          <Icon className="staged-attachment__alert" name="alert-circle" />
        ) : null}
      </span>
      <span className="staged-attachment__text">
        <span className="staged-attachment__name" title={item.name}>
          {item.name}
        </span>
        <span
          className="staged-attachment__detail"
          id={item.status === "failed" ? errorId : undefined}
          title={item.status === "failed" ? detail : undefined}
        >
          {detail}
        </span>
      </span>
      {item.status === "failed" && item.retryable ? (
        <button
          aria-describedby={errorId}
          aria-label={`Retry uploading ${item.name}`}
          className="staged-attachment__action"
          disabled={disabled}
          onClick={() => onRetry(item.localId)}
          title="Retry"
          type="button"
        >
          <Icon name="reload" />
        </button>
      ) : null}
      <button
        aria-label={`Remove ${item.name}`}
        className="staged-attachment__action staged-attachment__action--remove"
        disabled={sending}
        onClick={() => onRemove(item.localId)}
        title="Remove"
        type="button"
      >
        <Icon name="close" />
      </button>
    </li>
  );
}

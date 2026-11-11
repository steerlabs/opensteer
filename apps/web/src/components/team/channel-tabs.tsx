import { useState } from "react";
import { formatBytes } from "../../app-model.js";
import { isInlineImage } from "../attachments/attachment-parts.js";
import { Icon } from "../icon.js";
import { SegmentedControl } from "../segmented-control.js";
import { fileIcon, MessageBody, MessageFiles } from "./message-body.js";
import { AuthorAvatar } from "./team-marks.js";
import {
  authorName,
  channelLabel,
  type ChannelFileView,
  type ChannelView,
  type FileView,
  type PinView,
} from "./team-models.js";
import { shortWhen } from "./team-time.js";

type FileKind = "all" | "images" | "documents" | "other";

const documentPattern = /pdf|word|document|text|sheet|excel|presentation|csv|markdown/iu;

function kindOf(file: FileView): Exclude<FileKind, "all"> {
  if (isInlineImage(file.mediaType)) return "images";
  if (documentPattern.test(file.mediaType)) return "documents";
  return "other";
}

/**
 * Every file shared in a channel, newest first. A file is always a message's
 * attachment: "In" goes to the message it came with.
 */
export function FilesTab({
  channel,
  files,
  onOpenFile,
  onShowMessage,
}: {
  readonly channel: ChannelView;
  readonly files: readonly ChannelFileView[];
  readonly onOpenFile: (file: FileView) => void;
  readonly onShowMessage: (fileId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FileKind>("all");
  const needle = query.trim().toLowerCase();
  const shown = files.filter(
    ({ file }) =>
      (kind === "all" || kindOf(file) === kind) &&
      (needle === "" || file.name.toLowerCase().includes(needle)),
  );
  return (
    <div className="channel-tab">
      <div className="channel-tab__toolbar">
        <label className="team-search-field">
          <Icon name="search" />
          <input
            aria-label={`Search files in ${channelLabel(channel)}`}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search files in ${channelLabel(channel)}`}
            value={query}
          />
        </label>
        <SegmentedControl
          ariaLabel="Kind of file"
          onChange={setKind}
          options={[
            { label: "All", value: "all" },
            { label: "Images", value: "images" },
            { label: "Documents", value: "documents" },
            { label: "Other", value: "other" },
          ]}
          value={kind}
        />
      </div>
      {files.length === 0 ? (
        <p className="channel-tab__empty">
          No files yet. Files shared in messages here show up in this list.
        </p>
      ) : shown.length === 0 ? (
        <p className="channel-tab__empty">No file matches.</p>
      ) : (
        <table className="team-table files-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Shared by</th>
              <th scope="col">In</th>
              <th className="team-table__num" scope="col">
                Size
              </th>
              <th scope="col">When</th>
              <th aria-label="Pinned" scope="col" />
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.file.id}>
                <td>
                  <button
                    className="files-table__name"
                    onClick={() => onOpenFile(entry.file)}
                    title={isInlineImage(entry.file.mediaType) ? "Open" : "Download"}
                    type="button"
                  >
                    <Icon name={fileIcon(entry.file)} />
                    <span>{entry.file.name}</span>
                  </button>
                </td>
                <td>
                  <span className="team-table__who">
                    <AuthorAvatar author={entry.sharedBy} size={18} />
                    {authorName(entry.sharedBy)}
                  </span>
                </td>
                <td>
                  <button
                    className="files-table__in"
                    onClick={() => onShowMessage(entry.file.id)}
                    title="Show the message"
                    type="button"
                  >
                    {entry.inThread ? "Thread · " : ""}“{entry.excerpt}”
                  </button>
                </td>
                <td className="team-table__num">{formatBytes(entry.file.sizeBytes)}</td>
                <td className="team-table__quiet">{shortWhen(entry.at)}</td>
                <td>
                  {entry.pinned ? <Icon className="files-table__pin" name="pushpin" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Pinned messages, newest pin first. Any member pins and unpins. */
export function PinnedTab({
  onOpenFile,
  onShowMessage,
  onUnpin,
  pins,
}: {
  readonly onOpenFile?: ((file: FileView) => void) | undefined;
  readonly onShowMessage: (messageId: string) => void;
  readonly onUnpin: (messageId: string) => void;
  readonly pins: readonly PinView[];
}) {
  if (pins.length === 0)
    return (
      <div className="channel-tab">
        <p className="channel-tab__empty">
          Nothing pinned. Pin a message from its actions, and everyone here sees it in this list.
        </p>
      </div>
    );
  return (
    <div className="channel-tab">
      <ul className="pin-list">
        {pins.map((pin) => (
          <li className="pin" key={pin.message.id}>
            <AuthorAvatar author={pin.message.author} size={36} />
            <div className="pin__main">
              <p className="pin__by">
                <Icon name="pushpin" /> Pinned by {pin.pinnedBy} · {shortWhen(pin.pinnedAt)}
              </p>
              <p className="tmsg__head">
                <span className="tmsg__name">{authorName(pin.message.author)}</span>
                <time className="tmsg__time" dateTime={pin.message.at}>
                  {shortWhen(pin.message.at)}
                </time>
                {pin.inThread ? <span className="tmsg__edited">in a thread</span> : null}
              </p>
              <MessageBody mentions={pin.message.mentions} text={pin.message.body} />
              <MessageFiles files={pin.message.files} onOpen={onOpenFile} />
            </div>
            <div className="pin__actions">
              <button
                className="btn btn--small"
                onClick={() => onShowMessage(pin.message.id)}
                type="button"
              >
                View in channel
              </button>
              <button
                className="btn btn--small btn--ghost"
                onClick={() => onUnpin(pin.message.id)}
                type="button"
              >
                Unpin
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

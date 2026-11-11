import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import type { ComputerView, FolderBrowseView, FolderView } from "./home-models.js";

export interface FolderPickerProps {
  readonly current: FolderView;
  /** Folders of recent tasks and team channels, newest first. */
  readonly recent: readonly FolderView[];
  /** Computers a task may run on. In this build only the hosting computer is offered. */
  readonly computers: readonly ComputerView[];
  /** The listing last asked for with `onBrowse`, once it arrives. */
  readonly browsing: FolderBrowseView | null;
  readonly onBrowse: (computerId: string, path: string | null) => void;
  readonly onChoose: (folder: FolderView) => void;
  readonly onUse: (computerId: string, path: string) => void;
  readonly onCreateFolder?:
    ((computerId: string, parentPath: string, name: string) => void) | undefined;
}

/**
 * Where the new task will work, in the composer's leading slot. Agent home
 * by default; the picker offers recent folders first, then any folder on a
 * computer. A task's folder is fixed once it starts.
 */
export function FolderChip(props: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const { current } = props;
  return (
    <div className="assignee folder-chip">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Folder: ${current.label}, ${current.path} on ${current.computerName}`}
        className="assignee__button folder-chip__button"
        onClick={() => setOpen((value) => !value)}
        ref={anchor}
        title={`${current.path} · ${current.computerName}`}
        type="button"
      >
        <Icon name={current.agentHome ? "home" : "folder"} />
        <span className="assignee__name">{current.label}</span>
        <Icon name="chevron-down" />
      </button>
      {open && anchor.current ? (
        <Popover
          anchor={anchor.current}
          className="folder-popover"
          label="Where should it work?"
          onClose={() => setOpen(false)}
          role="dialog"
        >
          <FolderPicker
            {...props}
            onChoose={(folder) => {
              setOpen(false);
              props.onChoose(folder);
            }}
            onUse={(computerId, path) => {
              setOpen(false);
              props.onUse(computerId, path);
            }}
          />
        </Popover>
      ) : null}
    </div>
  );
}

export function FolderPicker({
  browsing,
  computers,
  current,
  onBrowse,
  onChoose,
  onCreateFolder,
  onUse,
  recent,
}: FolderPickerProps) {
  const [query, setQuery] = useState("");
  const [browsingOpen, setBrowsingOpen] = useState(false);
  if (browsingOpen && browsing)
    return (
      <FolderBrowser
        browsing={browsing}
        onBack={() => setBrowsingOpen(false)}
        onBrowse={onBrowse}
        onCreateFolder={onCreateFolder}
        onUse={onUse}
      />
    );
  const needle = query.trim().toLowerCase();
  const shown = recent.filter(
    (folder) =>
      needle === "" ||
      folder.label.toLowerCase().includes(needle) ||
      folder.path.toLowerCase().includes(needle),
  );
  return (
    <div className="folder-picker">
      <label className="picker__search">
        <Icon name="search" />
        <input
          aria-label="Find a folder"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a folder"
          value={query}
        />
      </label>
      <div className="picker__list">
        <div className="picker__section">
          <p className="picker__heading">Recent</p>
          {shown.length === 0 ? <p className="picker__empty">No folder matches</p> : null}
          {shown.map((folder) => {
            const chosen = folder.id === current.id;
            return (
              <button
                aria-checked={chosen}
                className="picker__row"
                key={folder.id}
                onClick={() => onChoose(folder)}
                role="menuitemradio"
                type="button"
              >
                <span className="picker__glyph">
                  <Icon name={folder.agentHome ? "home" : "folder"} />
                </span>
                <span className="picker__label-stack">
                  <span className="picker__label">{folder.label}</span>
                  <span className="picker__detail">
                    {folder.path} · {folder.computerName}
                  </span>
                </span>
                <span className="picker__check">{chosen ? <Icon name="check" /> : null}</span>
              </button>
            );
          })}
        </div>
        <div className="picker__section">
          <p className="picker__heading">Choose a folder on</p>
          {computers.map((computer) => (
            <button
              className={computer.online ? "picker__row" : "picker__row picker__row--off"}
              disabled={!computer.online}
              key={computer.id}
              onClick={() => {
                onBrowse(computer.id, null);
                setBrowsingOpen(true);
              }}
              type="button"
            >
              <span className="picker__glyph">
                <Icon name={computer.kind} />
              </span>
              <span className="picker__label-stack">
                <span className="picker__label">{computer.name}</span>
                {computer.online ? null : <span className="picker__detail">Offline</span>}
              </span>
              {computer.hosting ? <span className="picker__state">This computer</span> : null}
              <Icon className="folder-picker__chevron" name="chevron-right" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Folders on one computer, read from its Runner. Nothing is copied: the task
 * works in the folder itself.
 */
export function FolderBrowser({
  browsing,
  onBack,
  onBrowse,
  onCreateFolder,
  onUse,
}: {
  readonly browsing: FolderBrowseView;
  readonly onBack: () => void;
  readonly onBrowse: (computerId: string, path: string | null) => void;
  readonly onCreateFolder?:
    ((computerId: string, parentPath: string, name: string) => void) | undefined;
  readonly onUse: (computerId: string, path: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const nameField = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (naming) nameField.current?.focus();
  }, [naming]);
  const { computer, crumbs, entries, path } = browsing;
  const here = crumbs.at(-1)?.label ?? computer.name;
  const parent = crumbs.at(-2);
  const create = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !onCreateFolder) return;
    onCreateFolder(computer.id, path, trimmed);
    setNaming(false);
    setName("");
  };
  return (
    <div className="folder-browser">
      <div className="folder-browser__head">
        <button
          aria-label={parent ? `Up to ${parent.label}` : "Back"}
          className="icon-btn icon-btn--small"
          onClick={() => (parent ? onBrowse(computer.id, parent.path) : onBack())}
          type="button"
        >
          <Icon name="chevron-left" />
        </button>
        <Icon className="folder-browser__computer" name={computer.kind} />
        <span className="folder-browser__crumbs">
          <span>{computer.name}</span>
          {crumbs.map((crumb) => (
            <span key={crumb.path}>
              <span aria-hidden className="folder-browser__slash">
                /
              </span>
              {crumb.label}
            </span>
          ))}
        </span>
      </div>
      <div className="picker__list folder-browser__list">
        {browsing.error ? (
          <p className="picker__empty">{browsing.error}</p>
        ) : entries === null ? (
          <p className="picker__empty">Reading folders…</p>
        ) : entries.length === 0 && !naming ? (
          <p className="picker__empty">No folders here</p>
        ) : (
          entries.map((entry) => (
            <button
              className="picker__row"
              key={entry.path}
              onClick={() => onBrowse(computer.id, entry.path)}
              type="button"
            >
              <span className="picker__glyph">
                <Icon name="folder" />
              </span>
              <span className="picker__label-stack">
                <span className="picker__label">{entry.name}</span>
              </span>
              <Icon className="folder-picker__chevron" name="chevron-right" />
            </button>
          ))
        )}
        {onCreateFolder ? (
          naming ? (
            <form className="folder-browser__new" onSubmit={create}>
              <Icon name="folder" />
              <input
                aria-label="New folder name"
                className="text-input"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setNaming(false);
                  }
                }}
                placeholder="Folder name"
                ref={nameField}
                value={name}
              />
            </form>
          ) : (
            <button className="picker__row" onClick={() => setNaming(true)} type="button">
              <span className="picker__glyph">
                <Icon name="plus" />
              </span>
              <span className="picker__label">New folder…</span>
            </button>
          )
        ) : null}
      </div>
      <div className="folder-browser__foot">
        <p className="folder-browser__note">Nothing is copied: the task works in this folder.</p>
        <button className="btn btn--small btn--ghost" onClick={onBack} type="button">
          Cancel
        </button>
        <button
          className="btn btn--small btn--primary"
          onClick={() => onUse(computer.id, path)}
          type="button"
        >
          Use “{here}”
        </button>
      </div>
    </div>
  );
}

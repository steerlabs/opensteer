import {
  clipboard,
  Menu,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

type MenuParams = Pick<
  ContextMenuParams,
  "dictionarySuggestions" | "editFlags" | "isEditable" | "linkURL" | "mediaType" | "selectionText"
> & { readonly inMainFrame: boolean };

export interface WindowContextMenuActions {
  readonly replaceMisspelling: (word: string) => void;
  readonly copyLink: () => void;
  readonly copyImage: () => void;
  readonly lookUp: () => void;
}

/**
 * What a right-click in the app's own window offers, as a browser would. A
 * transcript image the app acts on itself never reaches here: its page takes
 * the click first.
 */
export function windowContextMenuTemplate(
  params: MenuParams,
  actions: WindowContextMenuActions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const separate = () => {
    if (items.length && items.at(-1)?.type !== "separator") items.push({ type: "separator" });
  };
  if (params.isEditable) {
    for (const word of params.dictionarySuggestions.slice(0, 5))
      items.push({ label: word, click: () => actions.replaceMisspelling(word) });
    separate();
    items.push(
      { role: "undo", enabled: params.editFlags.canUndo },
      { role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
    return items;
  }
  if (params.selectionText.trim()) {
    items.push({ role: "copy" });
    if (platform === "darwin")
      items.push({
        label: `Look Up “${params.selectionText.trim().slice(0, 24)}”`,
        click: actions.lookUp,
      });
  }
  if (/^https?:\/\//iu.test(params.linkURL)) {
    separate();
    items.push({ label: "Copy Link", click: actions.copyLink });
  }
  // Chromium copies a subframe's image only from its own coordinates, which a published app's
  // frame does not share with the window.
  if (params.mediaType === "image" && params.inMainFrame) {
    separate();
    items.push({ label: "Copy Image", click: actions.copyImage });
  }
  return items;
}

/** Electron shows no menu of its own: without this a right-click in the app does nothing. */
export function configureDesktopWindowContextMenu(
  contents: WebContents,
  window: () => BaseWindow | null,
): void {
  contents.on("context-menu", (_event, params) => {
    const live = () => !contents.isDestroyed();
    const template = windowContextMenuTemplate(
      { ...params, inMainFrame: params.frame === contents.mainFrame },
      {
        replaceMisspelling: (word) => {
          if (live()) contents.replaceMisspelling(word);
        },
        copyLink: () => clipboard.writeText(params.linkURL),
        copyImage: () => {
          if (live()) contents.copyImageAt(params.x, params.y);
        },
        lookUp: () => {
          if (live()) contents.showDefinitionForSelection();
        },
      },
      process.platform,
    );
    const owner = window();
    if (template.length && owner && !owner.isDestroyed())
      Menu.buildFromTemplate(template).popup({
        window: owner,
        ...(params.frame ? { frame: params.frame } : {}),
      });
  });
}

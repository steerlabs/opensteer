import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: {}, Menu: {}, shell: {} }));
const { windowContextMenuTemplate } = await import("./window-context-menu.js");

const flags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
  canDelete: true,
  canEditRichly: false,
};
type Params = Parameters<typeof windowContextMenuTemplate>[0];
const plain: Params = {
  dictionarySuggestions: [],
  editFlags: flags,
  isEditable: false,
  linkURL: "",
  mediaType: "none",
  selectionText: "",
  inMainFrame: true,
};
const actions = {
  replaceMisspelling: vi.fn(),
  openLinkOutside: vi.fn(),
  copyLink: vi.fn(),
  copyImage: vi.fn(),
  lookUp: vi.fn(),
};
const labels = (params: Partial<Params>, platform: NodeJS.Platform = "darwin") =>
  windowContextMenuTemplate({ ...plain, ...params }, actions, platform).map(
    (item) => item.role ?? item.label ?? item.type,
  );

describe("the app window's context menu", () => {
  it("offers nothing on bare app chrome, so no empty menu opens", () => {
    expect(labels({})).toEqual([]);
  });

  it("edits a field, spelling first, with the field's own abilities", () => {
    expect(
      labels({
        isEditable: true,
        dictionarySuggestions: ["their", "there"],
        selectionText: "thier",
      }),
    ).toEqual([
      "their",
      "there",
      "separator",
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "selectAll",
    ]);
  });

  it("copies selected words, and looks them up only on a Mac", () => {
    expect(labels({ selectionText: "Host" })).toEqual(["copy", "Look Up “Host”"]);
    expect(labels({ selectionText: "Host" }, "linux")).toEqual(["copy"]);
  });

  it("opens and copies web links and window images, never app-internal links or a frame's image", () => {
    expect(labels({ linkURL: "https://example.com", mediaType: "image" })).toEqual([
      "Open Link in Default Browser",
      "Copy Link",
      "separator",
      "Copy Image",
    ]);
    expect(labels({ linkURL: "app://opensteer/tasks/1" })).toEqual([]);
    expect(labels({ mediaType: "image", inMainFrame: false })).toEqual([]);
  });
});

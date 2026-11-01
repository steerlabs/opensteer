import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createElectronAppWindow } from "./electron-window.js";

vi.mock("electron", () => ({
  BaseWindow: class extends EventEmitter {
    contentView = { addChildView: vi.fn(), setBackgroundColor: vi.fn() };
    getContentBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
  },
  WebContentsView: class {
    webContents = {};
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
  },
}));

it("paints the window ground inside the compositor beneath the transparent app view", () => {
  const window = createElectronAppWindow({ backgroundColor: "#080808" }, {});
  const ground = vi.mocked(window.contentView.setBackgroundColor);
  const attach = vi.mocked(window.contentView.addChildView);
  expect(ground).toHaveBeenCalledWith("#080808");
  expect(vi.mocked(window.appView.setBackgroundColor)).toHaveBeenCalledWith("#00000000");
  expect(ground.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0]!);
});

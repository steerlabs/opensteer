import { describe, expect, it } from "vitest";
import { composerView, type ComposerState } from "./composer-model.js";

const idle: ComposerState = {
  attachments: 0,
  attachmentsReady: true,
  canRespond: true,
  disabledReason: null,
  focused: false,
  pendingCommand: false,
  presenting: false,
  readOnly: false,
  running: false,
  sending: false,
  text: "",
  textHidden: false,
  voice: false,
};

describe("composerView", () => {
  it("does not send whitespace, but stays open for it", () => {
    const view = composerView({ ...idle, text: "   " });
    expect(view.canSend).toBe(false);
    expect(view.expanded).toBe(true);
  });

  it("puts Stop in the round slot while a run has nothing typed against it", () => {
    expect(composerView({ ...idle, running: true }).action).toBe("stop");
  });

  it("offers voice instead of a dead Send while there is nothing to send", () => {
    expect(composerView({ ...idle, voice: true }).action).toBe("voice");
    expect(composerView({ ...idle, voice: true, text: "hi" }).action).toBe("send");
    expect(composerView({ ...idle, voice: true, attachments: 1 }).action).toBe("send");
    expect(composerView({ ...idle, voice: true, running: true }).action).toBe("stop");
    expect(composerView({ ...idle, voice: false }).action).toBe("send");
  });

  it("keeps Send in the slot when a run is answered by typing", () => {
    const view = composerView({ ...idle, running: true, text: "stop after this" });
    expect(view.action).toBe("send");
    expect(view.canSend).toBe(true);
  });

  it("hides the field for a request that is answered by choosing", () => {
    const answering = composerView({ ...idle, running: true, textHidden: true });
    expect(answering.showField).toBe(false);
    expect(answering.action).toBe("stop");
    expect(composerView({ ...idle, textHidden: true }).action).toBeNull();
  });

  it("refuses to send a second message while one is owed", () => {
    expect(composerView({ ...idle, pendingCommand: true, text: "again" }).canSend).toBe(false);
    expect(composerView({ ...idle, sending: true, text: "again" }).canSend).toBe(false);
  });

  it("leaves an archived thread one sentence and no controls", () => {
    const view = composerView({
      ...idle,
      disabledReason: "This thread is archived and cannot take new messages.",
      focused: true,
      readOnly: true,
      text: "held",
    });
    expect(view).toMatchObject({
      action: null,
      canSend: false,
      expanded: false,
      readOnly: true,
      showField: false,
      showPills: false,
    });
  });

  it("keeps drafts editable while the Host is unreachable", () => {
    const typed = composerView({ ...idle, canRespond: false, text: "later" });
    expect(typed.canSend).toBe(false);
    expect(typed.showField).toBe(true);
  });
});

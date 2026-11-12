// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it } from "vitest";
import {
  click,
  element,
  mount,
  settle,
  teamHost,
  teamSession,
  write,
} from "../components/workspace/workspace.interaction.test-support.js";

const field = () => element<HTMLTextAreaElement>(".team-composer__input");
const rowsSaying = (text: string) =>
  [...document.querySelectorAll<HTMLElement>(".channel .tmsg")].filter((row) =>
    row.textContent?.includes(text),
  );

async function openChannel() {
  await mount("/", { team: true });
  await click(element('.side-switch__option:not([data-value="tasks"])'));
  await click(element(".team-row__main"));
  await settle();
}

async function send(text: string) {
  await write(field(), text);
  await click(element(".channel .composer__send"));
  await settle(50);
}

describe("sending in a channel", () => {
  it("shows a message whose answer was lost once, and still once after reconnecting", async () => {
    await openChannel();
    const stored = teamHost!.messages.size;
    teamHost!.loseNextSendAck = true;

    await send("Hello once");
    // The Host kept it and the socket delivered it; the unconfirmed send is the same message.
    expect(teamSession!.getSnapshot().pending).toHaveLength(1);
    expect(rowsSaying("Hello once")).toHaveLength(1);

    await act(async () => {
      teamSession!.disconnect();
      teamSession!.connect();
    });
    await settle(50);
    expect(teamSession!.getSnapshot().pending).toHaveLength(0);
    expect(rowsSaying("Hello once")).toHaveLength(1);
    expect(teamHost!.messages.size).toBe(stored + 1);
  });

  it("holds a message written offline as waiting, and sends it once on reconnecting", async () => {
    await openChannel();
    const stored = teamHost!.messages.size;
    await act(async () => teamSession!.disconnect());

    await send("Written offline");
    expect(rowsSaying("Written offline")).toHaveLength(1);
    expect(rowsSaying("Written offline")[0]!.textContent).toContain("Waiting for connection");

    await act(async () => teamSession!.connect());
    await settle(50);
    expect(rowsSaying("Written offline")).toHaveLength(1);
    expect(rowsSaying("Written offline")[0]!.textContent).not.toContain("Waiting for connection");
    expect(teamHost!.messages.size).toBe(stored + 1);
  });
});

import { describe, expect, it } from "vitest";
import type { HostToClientMessage } from "./client.js";
import type { NeedsYouPage } from "./needs-you.js";
import {
  personQuestionApiVersion,
  projectHostMessage,
  projectNeedsYouPage,
} from "./person-questions.js";

const older = personQuestionApiVersion - 1;
const requestEvent = (kind: string) => ({ type: "request.opened", data: { request: { kind } } });
const requestEntry = (kind: string) => ({ kind: "request", request: { kind } });

describe("person questions on older apps", () => {
  it("leaves them out of an older app's events and Needs you, and keeps everything else", () => {
    const events = {
      type: "host.events",
      events: [requestEvent("person.question"), requestEvent("harness.input")],
    } as unknown as HostToClientMessage;
    expect(projectHostMessage(events, older)).toMatchObject({
      events: [requestEvent("harness.input")],
    });
    const page = {
      count: 2,
      entries: [requestEntry("person.question"), requestEntry("device.access")],
    } as unknown as NeedsYouPage;
    expect(projectNeedsYouPage(page, older).entries).toEqual([requestEntry("device.access")]);
    const snapshot = { type: "host.snapshot", snapshot: { needsYou: page } };
    expect(projectHostMessage(snapshot as unknown as HostToClientMessage, older)).toMatchObject({
      snapshot: { needsYou: { entries: [requestEntry("device.access")] } },
    });
  });

  it("sends them whole to an app that reads them", () => {
    const events = {
      type: "host.events",
      events: [requestEvent("person.question")],
    } as unknown as HostToClientMessage;
    expect(projectHostMessage(events, personQuestionApiVersion)).toBe(events);
  });
});

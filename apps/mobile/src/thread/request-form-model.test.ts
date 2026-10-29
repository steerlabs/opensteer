import type { RequestFormField } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  isRequestFieldAnswered,
  nextRequestSubmission,
  requestAnswerMaxLength,
  requestDraftValues,
  requestFieldMode,
  requestFormAnswers,
  requestFormProgress,
  requestFormProgressLabel,
  sameRequestResponse,
  toggleRequestChoice,
  withRequestDraftValues,
  type RequestSubmission,
} from "./request-form-model.js";

const choices = [
  { label: "Alpha", value: "a" },
  { label: "Beta", value: "b" },
  { label: "Gamma", value: "c" },
];
const one: RequestFormField = {
  choices,
  id: "one",
  multiSelect: false,
  prompt: "Pick",
  secret: false,
};
const many: RequestFormField = {
  choices,
  id: "many",
  multiSelect: true,
  prompt: "Pick",
  secret: false,
};
const text: RequestFormField = { id: "text", multiSelect: false, prompt: "Say", secret: false };
const secret: RequestFormField = { id: "token", multiSelect: false, prompt: "Token", secret: true };
const empty: RequestFormField = { ...one, choices: [], id: "empty" };

describe("requestFieldMode", () => {
  it("reads a field without choices as text and one with no offered choices as unavailable", () => {
    expect(requestFieldMode(text)).toBe("text");
    expect(requestFieldMode({ ...text, multiSelect: true })).toBe("text");
    expect(requestFieldMode(empty)).toBe("unavailable");
    expect(requestFieldMode({ ...empty, multiSelect: true })).toBe("unavailable");
    expect(requestFieldMode(one)).toBe("one");
    expect(requestFieldMode(many)).toBe("many");
  });
});

describe("draft reads and writes", () => {
  const prototypeIds = ["constructor", "toString", "__proto__", "hasOwnProperty"];

  it("does not read a prototype member as a draft", () => {
    for (const id of prototypeIds) expect(requestDraftValues({}, id)).toEqual([]);
  });

  it("stores and reads back a prototype-named field as its own property", () => {
    let draft = {};
    for (const id of prototypeIds) draft = withRequestDraftValues(draft, id, [id]);
    for (const id of prototypeIds) {
      expect(Object.hasOwn(draft, id)).toBe(true);
      expect(requestDraftValues(draft, id)).toEqual([id]);
    }
    expect(Object.getPrototypeOf(draft)).toBe(Object.prototype);
    // A later write copies every earlier field, including `__proto__`.
    const next = withRequestDraftValues(draft, "other", ["x"]);
    expect(requestDraftValues(next, "__proto__")).toEqual(["__proto__"]);
  });

  it("builds a sendable form around prototype-named fields", () => {
    const sendableIds = prototypeIds.filter((id) => id !== "__proto__");
    const fields = sendableIds.map((id) => ({ ...text, id }));
    expect(requestFormProgress(fields, {}).answered).toBe(0);
    expect(requestFormAnswers(fields, {})).toBeNull();
    let draft = {};
    for (const id of sendableIds) draft = withRequestDraftValues(draft, id, [`${id} answer`]);
    const answers = requestFormAnswers(fields, draft);
    expect(answers).not.toBeNull();
    for (const id of sendableIds) {
      expect(Object.hasOwn(answers!, id)).toBe(true);
      expect(answers![id]).toEqual([`${id} answer`]);
    }
    expect(JSON.parse(JSON.stringify(answers))).toEqual(
      Object.fromEntries(sendableIds.map((id) => [id, [`${id} answer`]])),
    );
  });
});

it("does not offer an answer whose reserved id the response parser drops", () => {
  const field = { ...text, id: "__proto__" };
  expect(requestFieldMode(field)).toBe("unavailable");
  expect(requestFormAnswers([field], withRequestDraftValues({}, field.id, ["answer"]))).toBeNull();
});

describe("toggleRequestChoice", () => {
  it("replaces a single choice and never clears it", () => {
    expect(toggleRequestChoice(one, [], "b")).toEqual(["b"]);
    expect(toggleRequestChoice(one, ["b"], "c")).toEqual(["c"]);
    expect(toggleRequestChoice(one, ["b"], "b")).toEqual(["b"]);
  });

  it("toggles multiple choices in the order they were offered", () => {
    expect(toggleRequestChoice(many, [], "c")).toEqual(["c"]);
    expect(toggleRequestChoice(many, ["c"], "a")).toEqual(["a", "c"]);
    expect(toggleRequestChoice(many, ["a", "c"], "c")).toEqual(["a"]);
    expect(toggleRequestChoice(many, ["a"], "a")).toEqual([]);
  });

  it("never repeats a value offered twice", () => {
    const repeated = { ...many, choices: [...choices, { label: "Alpha again", value: "a" }] };
    expect(toggleRequestChoice(repeated, [], "a")).toEqual(["a"]);
  });
});

describe("isRequestFieldAnswered", () => {
  it("needs non-blank text within the Host's limit", () => {
    expect(isRequestFieldAnswered(text, [])).toBe(false);
    expect(isRequestFieldAnswered(text, ["   "])).toBe(false);
    expect(isRequestFieldAnswered(text, [" ok "])).toBe(true);
    expect(isRequestFieldAnswered(secret, ["hunter2"])).toBe(true);
    expect(isRequestFieldAnswered(text, ["x".repeat(requestAnswerMaxLength)])).toBe(true);
    expect(isRequestFieldAnswered(text, ["x".repeat(requestAnswerMaxLength + 1)])).toBe(false);
  });

  it("needs exactly one offered choice for a single-choice field", () => {
    expect(isRequestFieldAnswered(one, ["a"])).toBe(true);
    expect(isRequestFieldAnswered(one, ["a", "b"])).toBe(false);
    expect(isRequestFieldAnswered(one, ["z"])).toBe(false);
  });

  it("needs at least one choice, all offered, for a multi-choice field", () => {
    expect(isRequestFieldAnswered(many, [])).toBe(false);
    expect(isRequestFieldAnswered(many, ["a", "c"])).toBe(true);
    expect(isRequestFieldAnswered(many, ["a", "z"])).toBe(false);
  });

  it("takes nothing, not even text, for a field with no offered choices", () => {
    expect(isRequestFieldAnswered(empty, ["typed anyway"])).toBe(false);
  });
});

describe("requestFormProgress", () => {
  it("counts answered fields and says when the form is complete", () => {
    const fields = [one, many, text];
    expect(requestFormProgress(fields, {})).toEqual({
      answered: 0,
      complete: false,
      total: 3,
      unavailable: 0,
    });
    const partial = requestFormProgress(fields, { many: ["b"], one: ["a"], text: [" "] });
    expect(partial.answered).toBe(2);
    expect(partial.complete).toBe(false);
    expect(requestFormProgressLabel(partial)).toBe("2 of 3 answered");
    expect(requestFormProgress(fields, { many: ["b"], one: ["a"], text: ["x"] }).complete).toBe(
      true,
    );
  });

  it("says why a form with an unanswerable question can never be sent", () => {
    const progress = requestFormProgress([one, empty], { empty: ["x"], one: ["a"] });
    expect(progress).toEqual({ answered: 1, complete: false, total: 2, unavailable: 1 });
    expect(requestFormProgressLabel(progress)).toBe("A question cannot be answered");
    expect(requestFormProgressLabel(requestFormProgress([empty], {}))).toBe(
      "This question cannot be answered",
    );
    expect(requestFormAnswers([one, empty], { empty: ["x"], one: ["a"] })).toBeNull();
  });
});

describe("requestFormAnswers", () => {
  it("is null until every field is answered", () => {
    expect(requestFormAnswers([one, text], { one: ["a"] })).toBeNull();
  });

  it("sends exactly the form's fields, with text as typed", () => {
    expect(
      requestFormAnswers([one, text], { one: ["a"], stale: ["left over"], text: [" as typed "] }),
    ).toEqual({ one: ["a"], text: [" as typed "] });
  });
});

describe("sameRequestResponse", () => {
  it("matches an unchanged choice and nothing else", () => {
    expect(
      sameRequestResponse({ kind: "choice", optionId: "o" }, { kind: "choice", optionId: "o" }),
    ).toBe(true);
    expect(
      sameRequestResponse({ kind: "choice", optionId: "o" }, { kind: "choice", optionId: "p" }),
    ).toBe(false);
    expect(
      sameRequestResponse({ kind: "choice", optionId: "o" }, { answers: {}, kind: "form" }),
    ).toBe(false);
  });

  it("matches form answers value by value", () => {
    const sent = { answers: { many: ["a", "c"], text: ["x"] }, kind: "form" as const };
    expect(
      sameRequestResponse(sent, { answers: { many: ["a", "c"], text: ["x"] }, kind: "form" }),
    ).toBe(true);
    expect(sameRequestResponse(sent, { answers: { many: ["a"], text: ["x"] }, kind: "form" })).toBe(
      false,
    );
    expect(
      sameRequestResponse(sent, { answers: { many: ["a", "c"], text: ["y"] }, kind: "form" }),
    ).toBe(false);
    expect(sameRequestResponse(sent, { answers: { many: ["a", "c"] }, kind: "form" })).toBe(false);
  });

  it("does not match a field id against a prototype member", () => {
    const withConstructor = { answers: { constructor: ["x"] }, kind: "form" as const };
    const withOther = { answers: { other: ["x"] }, kind: "form" as const };
    expect(sameRequestResponse(withConstructor, withOther)).toBe(false);
    expect(sameRequestResponse(withOther, withConstructor)).toBe(false);
  });

  it("matches the same external decision independent of object key order", () => {
    expect(sameRequestResponse({ kind: "external" }, { kind: "external" })).toBe(true);
    expect(
      sameRequestResponse({ kind: "external" }, { kind: "external", value: { answer: true } }),
    ).toBe(false);
    expect(
      sameRequestResponse(
        { kind: "external", value: { decision: "declined", nested: { a: 1, b: true } } },
        { kind: "external", value: { nested: { b: true, a: 1 }, decision: "declined" } },
      ),
    ).toBe(true);
    expect(
      sameRequestResponse(
        { kind: "external", value: { decision: "declined" } },
        { kind: "external", value: { decision: "fulfilled" } },
      ),
    ).toBe(false);
  });
});

describe("nextRequestSubmission", () => {
  const keys = (): (() => string) => {
    let next = 0;
    return () => `key-${++next}`;
  };

  it("retries an unchanged response under its original key", () => {
    const held = { idempotencyKey: "held", response: { kind: "choice", optionId: "a" } } as const;
    expect(nextRequestSubmission(held, { kind: "choice", optionId: "a" }, keys())).toBe(held);
    const form: RequestSubmission = {
      idempotencyKey: "form",
      response: { answers: { q: ["x"] }, kind: "form" },
    };
    expect(
      nextRequestSubmission(form, { answers: { q: ["x"] }, kind: "form" }, keys()).idempotencyKey,
    ).toBe("form");
  });

  it("replaces the held response when the answer changed", () => {
    const held = { idempotencyKey: "held", response: { kind: "choice", optionId: "a" } } as const;
    expect(nextRequestSubmission(held, { kind: "choice", optionId: "b" }, keys())).toEqual({
      idempotencyKey: "key-1",
      response: { kind: "choice", optionId: "b" },
    });
  });
});

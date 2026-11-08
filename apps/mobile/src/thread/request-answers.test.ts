import type { Request } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

const { requestCardAnswers, requestCardQuestion, requestOptionLabel } =
  await import("./request-answers.js");

const allow = { hint: "allow-once", id: "allow", label: "Allow once" } as const;
const reject = { hint: "reject-once", id: "reject", label: "Reject" } as const;

function request(fields: object): Request {
  return {
    kind: "harness.approval",
    payload: { kind: "harness.approval" },
    status: "pending",
    ...fields,
  } as unknown as Request;
}

function choice(options: readonly object[], extra: object = {}): Request {
  return request({
    presentation: { kind: "choice", options, title: "Run this command?", ...extra },
  });
}

function form(fields: readonly object[], extra: object = {}): Request {
  return request({
    kind: "harness.input",
    payload: { kind: "harness.input" },
    presentation: { fields, kind: "form", title: "A question" },
    ...extra,
  });
}

const text = { id: "q", multiSelect: false, prompt: "Which branch?", secret: false };
const one = {
  ...text,
  choices: [
    { label: "Main", value: "main" },
    { label: "Beta", value: "beta" },
  ],
};

describe("requestCardAnswers", () => {
  it("offers a yes and a no, with anything else behind the menu", () => {
    const run = { hint: "allow-for-run", id: "run", label: "Allow for this Run" } as const;
    expect(requestCardAnswers(choice([allow, run, reject]), false)).toMatchObject({
      allow,
      decline: reject,
      highRisk: false,
      kind: "approve",
      more: [run],
      takesReason: true,
    });
  });

  it("asks again before allowing something high risk", () => {
    expect(requestCardAnswers(choice([allow, reject], { risk: "high" }), false)).toMatchObject({
      highRisk: true,
      kind: "approve",
    });
  });

  it("never lets high risk be answered by a tap on a row", () => {
    const options = [{ hint: "other", id: "a", label: "Go" }];
    expect(requestCardAnswers(choice(options, { risk: "high" }), false)).toEqual({
      kind: "sheet",
      label: "Answer",
    });
  });

  it("offers nothing to someone who can't answer, or on a Request already settled", () => {
    expect(requestCardAnswers(choice([allow, reject]), true)).toEqual({ kind: "none" });
    expect(
      requestCardAnswers(request({ ...choice([allow, reject]), status: "declined" }), false),
    ).toEqual({ kind: "none" });
  });

  it("shows short answers as pills and answers with detail as rows", () => {
    const short = [
      { hint: "other", id: "y", label: "Yes" },
      { hint: "other", id: "n", label: "Not yet" },
    ];
    expect(requestCardAnswers(choice(short), false)).toMatchObject({ look: "pills" });
    expect(
      requestCardAnswers(choice([{ ...short[0], description: "Today" }, short[1]!]), false),
    ).toMatchObject({ look: "rows" });
  });

  it("sends a card's worth of answers to the sheet past four", () => {
    const options = [1, 2, 3, 4, 5].map((n) => ({ hint: "other", id: `${n}`, label: `${n}` }));
    expect(requestCardAnswers(choice(options), false)).toEqual({ kind: "sheet", label: "Answer" });
  });

  it("reviews an install, which the card has no room to show", () => {
    const install = request({
      kind: "integration.install",
      payload: { kind: "integration.install" },
      presentation: {
        kind: "choice",
        options: [reject, { hint: "confirm", id: "installed", label: "Install" }],
        title: "Install?",
      },
    });
    expect(requestCardAnswers(install, false)).toEqual({ kind: "sheet", label: "Review" });
  });

  it("answers one choice with a tap, and one open question by typing", () => {
    expect(requestCardAnswers(form([one]), false)).toMatchObject({
      kind: "choose",
      options: [{ id: "main" }, { id: "beta" }],
    });
    expect(requestCardAnswers(form([text]), false)).toMatchObject({ field: text, kind: "type" });
  });

  it("keeps secrets, long questions, several questions and plugin input in the sheet", () => {
    const sheet = { kind: "sheet", label: "Answer" };
    expect(requestCardAnswers(form([{ ...text, secret: true }]), false)).toEqual(sheet);
    expect(requestCardAnswers(form([{ ...text, prompt: "x".repeat(200) }]), false)).toEqual(sheet);
    expect(requestCardAnswers(form([text, { ...text, id: "r" }]), false)).toEqual(sheet);
    expect(
      requestCardAnswers(
        form([text], {
          kind: "integration.input",
          payload: { kind: "integration.input" },
        }),
        false,
      ),
    ).toEqual(sheet);
  });

  it("reviews what this client can answer, and leaves the rest to a computer", () => {
    const external = (kind: string): Request =>
      request({
        kind,
        payload: { kind },
        presentation: { kind: "external", subject: { id: "a", kind: "b" }, title: "T" },
      });
    expect(requestCardAnswers(external("browser.sign-in"), false)).toEqual({
      kind: "sheet",
      label: "Review",
    });
    expect(requestCardAnswers(external("browser.profile.import"), false)).toEqual({ kind: "none" });
  });
});

describe("requestOptionLabel", () => {
  it("says an engine's two everyday answers the way the system does", () => {
    const approval = choice([allow, reject]);
    expect(requestOptionLabel(approval, allow)).toBe("Allow");
    expect(requestOptionLabel(approval, reject)).toBe("Don’t Allow");
  });

  it("keeps words chosen on purpose", () => {
    const install = request({ kind: "integration.install" });
    expect(requestOptionLabel(install, reject)).toBe("Reject");
    const run = { hint: "allow-for-run", id: "run", label: "Allow for this Run" } as const;
    expect(requestOptionLabel(choice([run]), run)).toBe("Allow for this Run");
  });
});

describe("requestCardQuestion", () => {
  it("asks a lone field's own question rather than the form's title", () => {
    expect(requestCardQuestion(form([text]), "A question")).toBe("Which branch?");
    expect(requestCardQuestion(form([{ ...text, prompt: "" }]), "A question")).toBe("A question");
    expect(requestCardQuestion(form([text, text]), "A question")).toBe("A question");
  });
});

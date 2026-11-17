import type { Request } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

const { questionHeading, requestCardAnswers, requestCardHeading, requestOptionLabel } =
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

  it("leaves a secret form and plugin input to the sheet", () => {
    const sheet = { kind: "sheet", label: "Answer" };
    expect(requestCardAnswers(form([{ ...text, secret: true }]), false)).toEqual(sheet);
    expect(
      requestCardAnswers(
        form([one], { kind: "plugin.input", payload: { kind: "plugin.input" } }),
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
    const plugin = request({ kind: "plugin.approval" });
    expect(requestOptionLabel(plugin, reject)).toBe("Reject");
    const run = { hint: "allow-for-run", id: "run", label: "Allow for this Run" } as const;
    expect(requestOptionLabel(choice([run]), run)).toBe("Allow for this Run");
  });
});

describe("requestCardHeading", () => {
  it("asks a lone field's own question when the title adds nothing", () => {
    expect(requestCardHeading(form([text]), "More information needed")).toEqual({
      context: null,
      question: "Which branch?",
    });
    expect(requestCardHeading(form([{ ...text, prompt: "" }]), "A question")).toEqual({
      context: null,
      question: "A question",
    });
    expect(requestCardHeading(form([text, text]), "A question")).toEqual({
      context: null,
      question: "A question",
    });
  });

  it("keeps a title that carries the explanation, as ACP's does", () => {
    expect(requestCardHeading(form([text]), "Choose where to deploy")).toEqual({
      context: "Which branch?",
      question: "Choose where to deploy",
    });
  });
});

describe("questionHeading", () => {
  it("heads a generic form with the question in view, and keeps a title that explains it", () => {
    expect(questionHeading("More information needed", "Which branch?")).toEqual({
      heading: "Which branch?",
      prompt: null,
    });
    expect(questionHeading("Choose where to deploy", "Which branch?")).toEqual({
      heading: "Choose where to deploy",
      prompt: "Which branch?",
    });
    expect(questionHeading("Which branch?", " Which branch? ")).toEqual({
      heading: "Which branch?",
      prompt: null,
    });
  });
});

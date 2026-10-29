import { describe, expect, it } from "vitest";
import {
  computerUseHeadline,
  computerUseHeadlineMaxLength,
  formatComputerUseResultHead,
  readComputerUseResultHeadline,
  readComputerStepHeadline,
} from "./computer-use-result-text.js";

const base = {
  appName: "Notes",
  elementCount: 42,
  stoppedBecause: null,
  geometry: { height: 800, width: 1280 },
  snapshot: "obs_7",
  truncated: false,
  windowTitle: "Offsite plan",
};

describe("computer use result text", () => {
  it("says what an observe and an act did, in a person's words", () => {
    expect(computerUseHeadline({ ...base, performed: null })).toBe("Looked at Notes");
    expect(
      computerUseHeadline({
        ...base,
        performed: ['Clicked "Save"', 'Typed "Venue shortlist" into "Title"'],
      }),
    ).toBe('Clicked "Save", then typed "Venue shortlist" into "Title"');
  });

  it("counts actions past the third and says when the batch stopped", () => {
    expect(
      computerUseHeadline({
        ...base,
        performed: ['Clicked "A"', 'Clicked "B"', 'Clicked "C"', 'Clicked "D"', 'Clicked "E"'],
        stoppedBecause: "The app restarted since it was observed.",
      }),
    ).toBe(
      'Clicked "A", then clicked "B", then clicked "C", and 2 more actions, then stopped. The app restarted since it was observed.',
    );
    expect(
      computerUseHeadline({
        ...base,
        performed: [],
        stoppedBecause: "The observed window closed.",
      }),
    ).toBe("Stopped. The observed window closed.");
  });

  it("keeps the headline to one bounded line", () => {
    const headline = computerUseHeadline({
      ...base,
      performed: [`Typed "${"x".repeat(400)}\nmore"`],
    });
    expect(headline).not.toContain("\n");
    expect(headline.length).toBe(computerUseHeadlineMaxLength);
    expect(headline.endsWith("…")).toBe(true);
  });

  it("keeps a window title with line breaks on the header's one line", () => {
    const text = formatComputerUseResultHead({
      ...base,
      performed: null,
      windowTitle: "Report\nfinal.pdf",
    });
    expect(text.split("\n")).toHaveLength(2);
    expect(readComputerUseResultHeadline(`${text}\n[0] window`)).toBe("Looked at Notes");
  });

  it("reads back only the headline of text it formatted", () => {
    const text = `${formatComputerUseResultHead({ ...base, performed: ['Clicked "Save"'], truncated: true })}\n[0] window "Offsite plan" (0,0 1280×800)`;
    expect(text.split("\n")[1]).toBe(
      "Observation obs_7 of Notes (Offsite plan) — 42 elements, truncated. Screenshot 1280×800 px; all coordinates are screenshot pixels.",
    );
    expect(readComputerUseResultHeadline(text)).toBe('Clicked "Save"');
    expect(readComputerUseResultHeadline('Clicked "Save" in Notes\nsomething else')).toBeNull();
    expect(readComputerUseResultHeadline("one line")).toBeNull();
  });

  it("keeps multiline app and window names inside the two-line header", () => {
    const text = formatComputerUseResultHead({
      ...base,
      appName: " Notes\r\n  Preview ",
      windowTitle: " Offsite\n\t plan\u2028today ",
      performed: null,
    });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("Observation obs_7 of Notes Preview (Offsite plan today) — 42 elements");
    expect(readComputerUseResultHeadline(text)).toBe("Looked at Notes Preview");
  });
});

// Trusted receipts may have no observation, contain later output, be empty or exceed the UI bound.
describe("Host computer step headlines", () => {
  it("reads only the bounded first line without changing historical observation guards", () => {
    expect(readComputerStepHeadline('Clicked "Save"\nprivate output')).toBe('Clicked "Save"');
    expect(readComputerStepHeadline("Stopped. This step was cancelled.")).toBe(
      "Stopped. This step was cancelled.",
    );
    expect(readComputerStepHeadline("")).toBe("");
    expect(readComputerStepHeadline("x".repeat(300))).toHaveLength(computerUseHeadlineMaxLength);
    expect(readComputerUseResultHeadline('Clicked "Save"')).toBeNull();
  });
});

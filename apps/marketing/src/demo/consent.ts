import "./consent.css";
import { find, icon } from "../dom.js";

/**
 * The consent screen an agent's sign-in lands on, in the app's own words
 * (`.opensteer/overhaul/design/copy.json`, `consent.*`). It works: choosing Everything hides the
 * pickers, turning on Tasks shows its warning, and Allow or Deny answers it.
 */

const AGENT = "Claude";
const HOME = "Mac mini";

const MODES = [
  ["approval-required", "Supervised", "Asks you before anything that changes something."],
  [
    "auto-accept-edits",
    "Auto-accept edits",
    "Edits files in its tasks without asking. Asks before anything else.",
  ],
  ["auto", "Auto", "Opensteer checks each action and asks you when it isn’t sure."],
  ["full-access", "Full access", "Never asks. Only for an agent you trust completely."],
] as const;

const choice = (name: string, value: string, label: string, line: string, on = false): string =>
  `<label class="cs-choice"><input type="radio" name="${name}" value="${value}"${on ? " checked" : ""} /><span><b>${label}</b><small>${line}</small></span></label>`;

const resource = (glyph: string, title: string, value: string): string =>
  `<div class="cs-row">${icon(glyph)}<span><b>${title}</b><small>${value}</small></span><span class="cs-pick" aria-hidden="true">Choose</span></div>`;

const FORM = `<form class="consent" aria-label="Example: what you see when an agent asks to connect">
  <div class="cs-head"><span class="amark amark--lg" aria-hidden="true">C</span><h3>${AGENT} wants to use your Opensteer</h3></div>
  <p class="cs-where">${icon("i-check")}<span>Access goes to claude.ai. Anyone who runs that service gets it.</span></p>
  <div class="cs-body">
    <p class="cs-label">What it can use</p>
    <div class="cs-group">
      ${choice("scope", "selected", "Choose what it can use", "Only what you pick below.", true)}
      ${choice("scope", "everything", "Everything my own agents can do", "Every browser profile, app, plugin and device, and Tasks. For an agent you trust as much as yourself.")}
    </div>
    <p class="cs-foot" data-part="settingsNote" hidden>Changing your settings also needs Full access.</p>
    <div data-part="resources">
      <div class="cs-group">
        ${resource("i-globe", "Browser", `Travel · On ${HOME} · signed in to the sites you use there`)}
        ${resource("i-app", "Apps and phone screens", "None")}
        ${resource("i-puzzle", "Plugins and data", "None")}
        <div class="cs-row">${icon("i-list")}<span><b>Tasks</b><small>Lets ${AGENT} ask your own agents to work on ${HOME}: read and change files and run commands there.</small></span><button class="cs-switch" type="button" role="switch" aria-checked="false" aria-label="Tasks"></button></div>
      </div>
      <p class="cs-foot cs-foot--warn" data-part="tasksWarning" hidden>This is the most powerful choice. Work it starts can change anything on ${HOME} that your own agents can, inside the safety mode below. Opensteer can stop what happens next, but can’t undo what an agent already did.</p>
      <p class="cs-foot">${AGENT} can use every site you’re signed in to in Travel, as you. A new profile starts signed out.</p>
    </div>
    <p class="cs-label">Safety mode</p>
    <div class="cs-group cs-group--modes">
      ${MODES.map(([value, label, line], at) => choice("mode", value, label, line, at === 0)).join("")}
    </div>
    <p class="cs-fine">${AGENT} can’t approve its own requests, open your saved passwords or cards, or change your settings. It lasts 30 days. Disconnect it any time in Settings → Connected agents.</p>
    <div class="cs-actions"><button class="btn btn--sm" type="button" data-answer="deny">Deny</button><button class="btn btn--sm btn--accent" type="button" data-answer="allow">Allow</button></div>
  </div>
  <div class="cs-done" data-part="done" hidden role="status"><p><b></b><span></span></p><button class="btn btn--sm" type="button" data-answer="again">Show it again</button></div>
</form>`;

export function mountConsent(root: HTMLElement): void {
  root.innerHTML = FORM;
  const form = find<HTMLFormElement>(root, "form");
  const part = (name: string): HTMLElement => find(form, `[data-part="${name}"]`);
  const tasks = find<HTMLButtonElement>(form, ".cs-switch");
  const body = find(form, ".cs-body");
  const done = part("done");

  const render = (): void => {
    const data = new FormData(form);
    const everything = data.get("scope") === "everything";
    part("resources").hidden = everything;
    part("settingsNote").hidden = !everything || data.get("mode") === "full-access";
    part("tasksWarning").hidden = tasks.getAttribute("aria-checked") !== "true";
  };

  form.addEventListener("change", render);
  form.addEventListener("submit", (event) => event.preventDefault());
  tasks.addEventListener("click", () => {
    tasks.setAttribute("aria-checked", String(tasks.getAttribute("aria-checked") !== "true"));
    render();
  });
  form.addEventListener("click", (event) => {
    const answer = (event.target as Element).closest<HTMLElement>("[data-answer]")?.dataset.answer;
    if (!answer) return;
    if (answer === "again") {
      done.hidden = true;
      body.hidden = false;
      find(form, '[data-answer="allow"]').focus();
      return;
    }
    find(done, "b").textContent = answer === "allow" ? "Connected agent added" : "Denied";
    find(done, "span").textContent =
      answer === "allow"
        ? "Go back to the agent to continue."
        : `${AGENT} gets nothing from your Opensteer.`;
    body.hidden = true;
    done.hidden = false;
    find(done, "button").focus();
  });
  render();
}

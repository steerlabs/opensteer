import "@fontsource-variable/inter/wght.css";
import "./styles/index.css";
import {
  BrowserEditingStore,
  autofillKey,
  type BrowserEditingTarget,
} from "@opensteer/client/host";
import type {
  BrowserServerMessage,
  PersonFillAccountView,
  PersonFillRole,
} from "@opensteer/protocol";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { StreamedAutofill, type AutofillFieldBox } from "./components/browser/streamed-autofill.js";
import { ToastProvider } from "./components/toast.js";

/**
 * Visual QA for the autofill chooser over a streamed page, on the real client
 * store: ↑/↓ move the highlight of the last chooser clicked, Return fills, Esc
 * closes and a click on its field opens it again. `?scene=` shows one case
 * alone; `&closed` starts it closed, for capturing the open motion.
 */
const search = new URLSearchParams(location.search);
const only = search.get("scene");

interface Case {
  readonly name: string;
  readonly title: string;
  readonly page: "light" | "dark";
  readonly role: PersonFillRole;
  readonly accounts: readonly Omit<PersonFillAccountView, "id" | "revision" | "ready">[];
  readonly highlighted?: number;
  /** The field sits low on the page, so the chooser opens above it. */
  readonly low?: boolean;
}

const cases: readonly Case[] = [
  {
    name: "one",
    title: "One login",
    page: "light",
    role: "username",
    accounts: [{ username: "alex@acme.co", label: null }],
  },
  {
    name: "labels",
    title: "Three logins with labels",
    page: "dark",
    role: "username",
    accounts: [
      { username: "alex@acme.co", label: "Work" },
      { username: "alex.admin@acme.co", label: "Admin" },
      { username: "alex.personal@gmail.com", label: "Personal" },
    ],
  },
  {
    name: "long",
    title: "A very long username",
    page: "light",
    role: "password",
    accounts: [
      {
        username:
          "alexandra.konstantinopoulou-wrightson+billing-notifications@enterprise-accounts.acme.co",
        label: "Billing",
      },
      { username: "a@acme.co", label: null },
    ],
  },
  {
    name: "code",
    title: "Verification code",
    page: "dark",
    role: "code",
    accounts: [{ username: "alex@acme.co", label: "Work" }],
  },
  {
    name: "highlighted",
    title: "Highlight moved down",
    page: "light",
    role: "username",
    highlighted: 2,
    accounts: [
      { username: "alex@acme.co", label: null },
      { username: "billing@acme.co", label: null },
      { username: "ops@acme.co", label: null },
      { username: "support@acme.co", label: null },
    ],
  },
  {
    name: "above",
    title: "Flipped above a low field",
    page: "dark",
    role: "password",
    low: true,
    accounts: [
      { username: "alex@acme.co", label: "Work" },
      { username: "alex.admin@acme.co", label: "Admin" },
    ],
  },
];

const consumerToken = "00000000-0000-4000-8000-0000000000aa";
const surfaceId = (index: number) =>
  `srf_00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as Extract<
    BrowserServerMessage,
    { type: "browser.autofill.offer" }
  >["surfaceId"];
const store = new BrowserEditingStore(() => undefined);
let focused: { target: BrowserEditingTarget } | null = null;
// Each click on a field is a new activation, so a new offer, as a page sends.
let offers = 0;

function offer(item: Case, index: number, anchor: AutofillFieldBox, stage: DOMRect) {
  const accounts = item.accounts.map((account, number) => ({
    ...account,
    id: `00000000-0000-4000-8000-${String(index * 100 + number).padStart(12, "0")}`,
    revision: 1,
    ready: false,
  }));
  return {
    type: "browser.autofill.offer",
    consumerToken,
    surfaceId: surfaceId(index),
    offerId: `00000000-0000-4000-9000-${String(++offers).padStart(12, "0")}`,
    role: item.role,
    geometryRevision: 0,
    anchor: {
      x: anchor.left / stage.width,
      y: anchor.top / stage.height,
      width: anchor.width / stage.width,
      height: anchor.height / stage.height,
    },
    accounts,
  } as Extract<BrowserServerMessage, { type: "browser.autofill.offer" }>;
}

function Tile({ item, index }: { readonly item: Case; readonly index: number }) {
  const stage = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<AutofillFieldBox | null>(null);
  const [view, setView] = useState({ width: 0, height: 0 });
  const target = useMemo(() => store.target("visual", surfaceId(index)), [index]);
  const state = useSyncExternalStore(target.subscribe, target.get);
  const listId = useId();
  const open = () => {
    const stageBox = stage.current!.getBoundingClientRect();
    const fieldBox = field.current!.getBoundingClientRect();
    const anchor = {
      left: fieldBox.left - stageBox.left,
      top: fieldBox.top - stageBox.top,
      width: fieldBox.width,
      height: fieldBox.height,
    };
    setBox(anchor);
    setView({ width: stageBox.width, height: stageBox.height });
    store.receive("visual", offer(item, index, anchor, stageBox));
    focused = { target };
  };
  useLayoutEffect(() => {
    open();
    for (let step = 0; step < (item.highlighted ?? 0); step++) target.moveAutofill(1);
    if (search.has("closed")) target.dismissAutofill();
    window.addEventListener("resize", open);
    return () => window.removeEventListener("resize", open);
  }, []);
  return (
    <figure className="autofill-visual__tile">
      <figcaption>{item.title}</figcaption>
      <div className={`autofill-visual__stage is-${item.page}`} ref={stage}>
        <div className={`autofill-visual__site${item.low ? " is-low" : ""}`}>
          <div className="autofill-visual__brand">
            <i />
            Acme
          </div>
          <h2>{item.role === "code" ? "Two-step verification" : "Sign in"}</h2>
          <label>
            {item.role === "code"
              ? "6-digit code"
              : item.role === "password"
                ? "Password"
                : "Email"}
          </label>
          <div
            className="autofill-visual__field is-focused"
            onPointerDown={(event) => {
              event.preventDefault();
              open();
            }}
            ref={field}
          >
            <span className="autofill-visual__caret" />
          </div>
          {item.role === "code" ? null : (
            <>
              <label>{item.role === "password" ? "Email" : "Password"}</label>
              <div className="autofill-visual__field" />
            </>
          )}
          <div className="autofill-visual__go">Continue</div>
        </div>
        {state.autofill && box ? (
          <StreamedAutofill
            autofill={state.autofill}
            field={box}
            listId={listId}
            onChoose={(accountId) => {
              target.fillAutofill(accountId);
              // As a page would answer: filled, then the offer leaves.
              setTimeout(() => {
                const sent = {
                  consumerToken,
                  surfaceId: surfaceId(index),
                  offerId: state.autofill!.offer.offerId,
                };
                store.receive("visual", {
                  type: "browser.autofill.result",
                  status: "filled",
                  ...sent,
                } as BrowserServerMessage);
              }, 300);
            }}
            view={view}
          />
        ) : null}
      </div>
    </figure>
  );
}

function App() {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const autofill = focused?.target.get().autofill;
      if (!focused || !autofill?.open || autofill.pending) return;
      const kept = autofillKey(focused.target, autofill, {
        key: event.key,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      });
      if (kept) event.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const shown = cases.filter((item) => !only || item.name === only);
  return (
    <main className={`autofill-visual${only ? " is-single" : ""}`}>
      {shown.map((item) => (
        <Tile index={cases.indexOf(item)} item={item} key={item.name} />
      ))}
    </main>
  );
}

const style = document.createElement("style");
// A drawing of somebody else's sign-in page under the chooser, not Opensteer UI.
style.textContent = `
  body { background: var(--bg); }
  .autofill-visual { display: grid; gap: 28px 24px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); padding: 24px; }
  .autofill-visual.is-single { grid-template-columns: minmax(0, 560px); }
  .autofill-visual__tile { margin: 0; }
  .autofill-visual__tile figcaption { color: var(--muted); font-size: 12px; margin: 0 2px 8px; }
  .autofill-visual__stage { position: relative; height: 380px; overflow: hidden; border-radius: 10px; border: 1px solid var(--line-strong); display: flex; justify-content: center; padding-top: 28px; }
  .autofill-visual__stage.is-light { background: #f4f3f1; color: #1a1a1a; --site: #fff; --field: #fff; --field-line: #d6d4d0; --label: #555; --go: #1a1a1a; --go-ink: #fff; }
  .autofill-visual__stage.is-dark { background: #1b1d22; color: #e8e9ec; --site: #24272e; --field: #1b1d22; --field-line: #3a3e48; --label: #a0a4ae; --go: #5b6cff; --go-ink: #fff; }
  .autofill-visual__site { width: min(300px, calc(100% - 32px)); height: fit-content; background: var(--site); border-radius: 12px; padding: 20px 22px; box-shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 8px 24px -12px rgb(0 0 0 / 20%); font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
  .autofill-visual__site.is-low { margin-top: 150px; }
  .autofill-visual__brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
  .autofill-visual__brand i { width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(135deg, #5b6cff, #8a5bff); }
  .autofill-visual__site h2 { margin: 12px 0 14px; font-size: 18px; font-weight: 650; }
  .autofill-visual__site label { display: block; font-size: 11.5px; color: var(--label); margin: 0 0 5px; font-weight: 550; }
  .autofill-visual__field { height: 34px; border: 1px solid var(--field-line); background: var(--field); border-radius: 8px; margin-bottom: 12px; display: flex; align-items: center; padding: 0 10px; }
  .autofill-visual__field.is-focused { border-color: #5b6cff; box-shadow: 0 0 0 3px rgb(91 108 255 / 18%); }
  .autofill-visual__caret { width: 1.5px; height: 16px; background: currentColor; }
  .autofill-visual__go { height: 34px; border-radius: 8px; background: var(--go); color: var(--go-ink); display: grid; place-items: center; font-size: 13px; font-weight: 600; }
`;
document.head.append(style);

const container = document.getElementById("root");
if (!container) throw new Error("Missing root");
createRoot(container).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);

import {
  iphoneSetupNeeds,
  iphoneSetupOnMacSteps,
  type IphoneSetupNeed,
} from "@opensteer/client/integrations";
import { useId } from "react";
import { Icon } from "../icon.js";

/** Where each need stands while setup on this Mac checks it; absent where nothing checks. */
export type NeedMark = "done" | "checking" | "you" | "todo" | "info";
export type NeedMarks = Readonly<Record<IphoneSetupNeed, NeedMark>>;

const markWords: Readonly<Record<NeedMark, string>> = {
  done: "Ready",
  checking: "Checking",
  you: "Needs you",
  todo: "Not yet",
  info: "",
};

/**
 * What iPhone setup takes, said before it starts. In the Mac's setup each need
 * is checked live; elsewhere it's the same list, so it reads the same on every
 * surface.
 */
export function IphoneSetupNeeds({ marks }: { readonly marks?: NeedMarks }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="iphone-needs">
      <h4 className="iphone-needs__title" id={titleId}>
        You’ll need
      </h4>
      <ul className="iphone-needs__list">
        {iphoneSetupNeeds.map((need) => {
          const mark = marks?.[need.id] ?? "info";
          return (
            <li className={`iphone-needs__item iphone-needs__item--${mark}`} key={need.id}>
              <span aria-hidden="true" className="iphone-needs__mark">
                {mark === "done" ? (
                  <Icon name="check" />
                ) : mark === "checking" ? (
                  <span className="spinner spinner--tiny" />
                ) : mark === "you" ? (
                  <Icon name="alert-circle" />
                ) : null}
              </span>
              <span className="iphone-needs__body">
                <span className="iphone-needs__name">
                  {need.title}
                  {markWords[mark] ? (
                    <span className="visually-hidden">{`: ${markWords[mark]}`}</span>
                  ) : null}
                </span>
                <span className="iphone-needs__detail">{need.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Where a window that can't reach iPhones sends the person: Opensteer on the Mac. */
export function IphoneSetupOnMac() {
  const stepsId = useId();
  return (
    <div className="iphone-on-mac">
      <p className="iphone-on-mac__lede">
        Your agent sees and controls the iPhone’s screen through one of your Macs, plugged in or on
        the same Wi‑Fi. Setup happens in Opensteer on that Mac.
      </p>
      <IphoneSetupNeeds />
      <section aria-labelledby={stepsId} className="iphone-needs">
        <h4 className="iphone-needs__title" id={stepsId}>
          On your Mac
        </h4>
        <ol className="iphone-setup__steps">
          {iphoneSetupOnMacSteps.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}

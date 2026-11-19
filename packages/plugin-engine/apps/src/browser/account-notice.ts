/** Advisory account card; must not depend on authored modules or their framework. */
import * as page from "../contracts/page-names.ts";
const install = () => {
  const data = document.getElementById(page.accountNoticeElement)?.textContent;
  if (!data) return;
  const notice: unknown = JSON.parse(data);
  if (typeof notice !== "object" || notice === null || !("items" in notice) || !("fix" in notice))
    return;
  const items = notice.items;
  const fix = notice.fix;
  if (!Array.isArray(items) || typeof fix !== "string") return;
  const show = () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `aside{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;box-sizing:border-box;padding:14px 16px;border-radius:10px;border:1px solid #fcd34d;background:#fffbeb;color:#451a03;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px rgb(0 0 0/.12)}strong{display:block;margin-bottom:4px}ul{margin:0 0 10px;padding-left:18px}div{display:flex;gap:12px;align-items:center}a{color:inherit;font-weight:600}button{margin-left:auto;font:inherit;background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer}`;
    const card = document.createElement("aside");
    card.setAttribute("role", "status");
    card.setAttribute("aria-label", "Account warning");
    const title = document.createElement("strong");
    title.textContent = "Some things might not work";
    const list = document.createElement("ul");
    for (const item of items) {
      const entry = document.createElement("li");
      entry.textContent = String(item);
      list.append(entry);
    }
    const actions = document.createElement("div");
    const link = document.createElement("a");
    link.href = fix;
    link.target = "_top";
    link.textContent = "Review accounts";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Dismiss";
    close.addEventListener("click", () => host.remove());
    actions.append(link, close);
    card.append(title, list, actions);
    root.append(style, card);
    document.documentElement.append(host);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", show, { once: true });
  } else {
    show();
  }
};

install();

export {};

import "./shop.css";
import type { BrowserTab } from "./browser.js";

const item = (name: string, variant: string, price: string, tint: string, count: number): string =>
  `<div class="sh-item"><i style="background:${tint}"><b>${count}</b></i><div><b>${name}</b><span>${variant}</span></div><em>${price}</em></div>`;

const summary = (label: string, value: string): string =>
  `<div class="sh-fact"><span>${label}</span><b>${value}</b><a>Change</a></div>`;

const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ALERT = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4.5M10 13.5v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

const PAYMENT = `<div class="sh-step sh-step--pay">
  <nav class="sh-crumbs"><a>Cart</a><a>Information</a><a>Shipping</a><b>Payment</b></nav>
  <div class="sh-facts">${summary("Contact", "maya@okafor.example")}${summary("Ship to", "418 Alder St, Portland OR 97205")}${summary("Method", "Standard · $5.00")}</div>
  <h4>Payment</h4>
  <p>All transactions are secure and encrypted.</p>
  <div class="sh-card">
    <div class="sh-card__head"><i></i>Credit card<span>VISA</span></div>
    <div class="sh-input"><label>Card number</label>4242 4242 4242 4242</div>
    <div class="sh-pair"><div class="sh-input"><label>Expiration date (MM / YY)</label>08 / 28</div><div class="sh-input"><label>Security code</label>•••</div></div>
  </div>
  <div class="sh-error" data-h="shop-error">${ALERT}<div><b>Your payment couldn't be processed</b><span>You haven't been charged. Please try again.</span></div></div>
  <span class="sh-pay" data-h="shop-pay"><span>Pay now</span><i></i></span>
</div>`;

const CONFIRMED = `<div class="sh-step sh-step--done" data-h="shop-done">
  <div class="sh-thanks">${CHECK}<div><span>Order #1048</span><h4>Thank you, Maya!</h4></div></div>
  <div class="sh-box"><b>Your order is confirmed</b><span>We've sent a receipt to maya@okafor.example. You'll get another email when your order ships.</span></div>
  <div class="sh-box sh-box--grid">
    <div><b>Contact</b><span>maya@okafor.example</span></div>
    <div><b>Payment</b><span>Visa •••• 4242 · $95.34</span></div>
    <div><b>Shipping address</b><span>Maya Okafor<br>418 Alder St<br>Portland OR 97205</span></div>
    <div><b>Shipping method</b><span>Standard · 3 to 5 days</span></div>
  </div>
  <span class="sh-again">Continue shopping</span>
</div>`;

/** A small coffee shop's own checkout, running from a local dev build. */
export const shop: BrowserTab = {
  id: "shop",
  title: "Checkout – Juniper Coffee",
  url: `localhost:3000<em data-h="shop-path">/checkout</em>`,
  mark: `<i class="br-fav" style="background:#1f3d2b">J</i>`,
  page: `<div class="sh">
  <main class="sh-main"><h3>Juniper Coffee</h3>${PAYMENT}${CONFIRMED}</main>
  <aside class="sh-side">
    ${item("Copper Pour-Over Kettle", "900 ml", "$48.00", "#e7c9a9", 1)}
    ${item("House Blend", "Whole bean · 340 g", "$34.50", "#c9b8a6", 2)}
    <div class="sh-code"><span>Discount code</span><b>Apply</b></div>
    <dl><dt>Subtotal</dt><dd>$82.50</dd><dt>Shipping</dt><dd>$5.00</dd><dt>Estimated taxes</dt><dd>$7.84</dd></dl>
    <div class="sh-total"><span>Total</span><em>USD</em><b>$95.34</b></div>
  </aside>
</div>`,
};

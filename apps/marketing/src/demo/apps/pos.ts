import "./pos.css";

const glyph = (d: string, cls: string): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

const SIDEBAR = [
  {
    name: "Orders",
    d: "M7 3.5h10v17l-2-1.4-1.6 1.4-1.4-1.4-1.4 1.4L9 19.1l-2 1.4zM9.5 8h5M9.5 11.5h5M9.5 15h3",
  },
  { name: "Catalog", d: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z" },
  {
    name: "Customers",
    d: "M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zM3.5 19.5c.6-3.4 2.6-5.3 5.5-5.3s4.9 1.9 5.5 5.3M15.5 5.2a3 3 0 0 1 0 5.6M17.2 14.4c1.8.6 2.9 2.3 3.3 5.1",
  },
  { name: "Reports", d: "M4.5 19.5h15M7 16v-4M11 16V7.5M15 16v-6M19 16V5" },
];

const PRODUCTS = [
  {
    key: "kettle",
    name: "Copper Kettle",
    price: "$48.00",
    tint: "#fde8d7",
    ink: "#c4622d",
    d: "M6.5 9.5h9l1 9a1 1 0 0 1-1 1.1h-9a1 1 0 0 1-1-1.1zM16 12.5c2.2-.2 3.2-2.4 4.5-4.5M8.5 9.5c0-3.4 5-3.4 5 0",
  },
  {
    key: "dripper",
    name: "Dripper",
    price: "$24.00",
    tint: "#e4eefc",
    ink: "#2f6fd1",
    d: "M4.5 6.5h15l-4.5 8h-6zM9.5 14.5v3.5M14.5 14.5v3.5M6.5 18h11",
  },
  {
    key: "filters",
    name: "Filters, 100",
    price: "$8.00",
    tint: "#f1efe9",
    ink: "#8a7f68",
    d: "M5.5 8h13l-4 10.5h-5zM8 5h8",
  },
  {
    key: "scale",
    name: "Brew Scale",
    price: "$34.50",
    tint: "#e3f5ec",
    ink: "#23885a",
    d: "M4 12.5h16v6.5H4zM7 9.5h10M12 9.5v3M8.5 16h3.5",
  },
  {
    key: "blend",
    name: "House Blend",
    price: "$18.50",
    tint: "#efe4dc",
    ink: "#7a4a2e",
    d: "M7 4h10l1.5 4v11.2a.8.8 0 0 1-.8.8H6.3a.8.8 0 0 1-.8-.8V8zM5.5 8h13M12 11.5c-1.6 1.2-1.6 3.8 0 5M12 11.5c1.6 1.2 1.6 3.8 0 5",
  },
  {
    key: "mug",
    name: "Juniper Mug",
    price: "$16.00",
    tint: "#f3e6f5",
    ink: "#9a4bab",
    d: "M5 9h11v7.5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM16 11h1.5a2.5 2.5 0 0 1 0 5H16M8.5 4.5v2M12 4v2.5",
  },
];

const CLICKED = new Set(["kettle", "scale", "blend"]);

const tile = (product: (typeof PRODUCTS)[number]): string =>
  `<div class="pos-tile pos-tile--${product.key}"${CLICKED.has(product.key) ? ` data-h="pos-${product.key}"` : ""}><span class="pos-art" style="--t:${product.tint};--k:${product.ink}">${glyph(product.d, "pos-art__ico")}</span><b>${product.name}</b><span>${product.price}</span><i class="pos-qty">1</i></div>`;

const line = (n: number, name: string, price: string): string =>
  `<div class="pos-line pos-line--${n}"><i>1</i><span>${name}</span><b>${price}</b></div>`;

const sum = (label: string, value: string, extra = ""): string =>
  `<div class="pos-sum${extra}"><span>${label}</span><b>${value}</b></div>`;

/** Till 2.4, the point-of-sale Mac app under test: a register with an order and its checkout sheet. */
export const pos = `<div class="win pos" data-win="pos" style="left:92px;top:8px;width:608px;height:424px">
  <aside class="pos-side">
    <div class="pos-lights"><span class="tl"><i></i><i></i><i></i></span></div>
    <h6>Juniper Coffee</h6>
    ${SIDEBAR.map(
      (item, index) =>
        `<div class="pos-nav${index === 0 ? " is-on" : ""}">${glyph(item.d, "pos-nav__ico")}<span>${item.name}</span>${index === 0 ? `<em data-h="pos-open">4</em>` : ""}</div>`,
    ).join("")}
  </aside>
  <section class="pos-main">
    <header class="pos-bar">
      ${glyph("M4 5.5h16v13H4zM9.5 5.5v13", "pos-bar__ico")}
      <div class="pos-title"><b>Orders</b><span>Register 1 · Silver Lake</span></div>
      <span class="pos-build">Build <span data-h="pos-build">2.4 (411)</span></span>
      <span class="pos-new" data-h="pos-new">${glyph("M12 5v14M5 12h14", "pos-new__ico")}New Order</span>
      ${glyph("M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.3 15.3 20 20", "pos-bar__ico")}
    </header>
    <div class="pos-body" data-h="pos-body">
      <div class="pos-catalog">
        <div class="pos-seg"><span class="is-on">All</span><span>Coffee</span><span>Brewing</span><span>Merch</span></div>
        <div class="pos-grid">${PRODUCTS.map(tile).join("")}</div>
      </div>
      <aside class="pos-cart">
        <div class="pos-empty">${glyph("M7 3.5h10v17l-2-1.4-1.6 1.4-1.4-1.4-1.4 1.4L9 19.1l-2 1.4zM9.5 8h5M9.5 11.5h5", "pos-empty__ico")}<b>No open order</b><span>Start one with New Order.</span></div>
        <div class="pos-order">
          <header><b>Order #1048</b><span>Walk-in · <span data-h="pos-count">0 items</span></span></header>
          <div class="pos-lines">
            <p class="pos-hint">Tap a product to add it.</p>
            ${line(1, "Copper Kettle", "$48.00")}
            ${line(2, "Brew Scale", "$34.50")}
            ${line(3, "House Blend", "$18.50")}
          </div>
          <div class="pos-discwrap"><span class="pos-disc" data-h="pos-disc">${glyph("M4 12.6V5.5A1.5 1.5 0 0 1 5.5 4h7.1L20 11.4 12.4 19zM8.5 8.5h.01", "pos-disc__ico")}<span class="pos-disc__add">Add Discount</span><span class="pos-disc__on">10% off</span></span>
          <div class="pos-pop">
            <b>Discount</b>
            <div class="pos-pop__opts"><span>5%</span><span data-h="pos-d10">10%</span><span>15%</span><span>20%</span></div>
          </div></div>
          <div class="pos-sums">
            ${sum("Subtotal", `<span data-h="pos-sub">$0.00</span>`)}
            ${sum("Discount (10%)", "−$10.10", " pos-sum--disc")}
            ${sum("Tax (9.5%)", `<span data-h="pos-tax">$0.00</span>`)}
            ${sum("Total", `<span data-h="pos-total">$0.00</span>`, " pos-sum--total")}
          </div>
          <span class="pos-charge" data-h="pos-charge"><span data-h="pos-charge-amt">Charge</span></span>
        </div>
      </aside>
    </div>
    <div class="pos-sheet" data-h="pos-sheet">
      <div class="pos-pay">
        <header><b>Checkout</b><span>Order #1048 · 3 items</span></header>
        <p class="pos-due"><span>Amount due</span><b data-h="pos-s-due">$99.53</b></p>
        <div class="pos-sums">
          ${sum("Subtotal", "$101.00")}
          ${sum("Discount (10%)", "−$10.10")}
          ${sum("Tax (9.5%)", `<span data-h="pos-s-tax">$8.63</span>`, " pos-sum--tax")}
          ${sum("Total", `<span data-h="pos-s-total">$99.53</span>`, " pos-sum--total")}
        </div>
        <div class="pos-seg pos-seg--wide"><span class="is-on">Card</span><span>Cash</span><span>Gift Card</span></div>
        <p class="pos-reader">Visa ••4242 on Reader 1</p>
        <footer><span class="pos-btn">Cancel</span><span class="pos-btn pos-btn--go" data-h="pos-take">Take Payment</span></footer>
      </div>
      <div class="pos-receipt">
        <span class="pos-paid"><svg><use href="#i-check"/></svg></span>
        <b>Payment complete</b>
        <span>$99.54 charged to Visa ••4242</span>
        <div class="pos-slip">
          ${sum("Copper Kettle", "$48.00")}
          ${sum("Brew Scale", "$34.50")}
          ${sum("House Blend", "$18.50")}
          ${sum("Discount (10%)", "−$10.10", " pos-sum--rule")}
          ${sum("Tax (9.5%)", "$8.64")}
          ${sum("Total", "$99.54", " pos-sum--total")}
        </div>
        <footer><span class="pos-btn">Print Receipt</span><span class="pos-btn pos-btn--go">New Order</span></footer>
      </div>
    </div>
  </section>
</div>`;

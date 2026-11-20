import { describe, expect, it } from "vitest";
import { loadOrganizationOffer } from "./config.js";
import { organizationSeats } from "./store.js";

describe("organization seats", () => {
  it.each([
    { billingStatus: "active", paidSeats: 3, pendingSeats: null, assigned: 2, free: 1 },
    { billingStatus: "active", paidSeats: 3, pendingSeats: 5, assigned: 2, free: 1 },
    { billingStatus: "active", paidSeats: 3, pendingSeats: 2, assigned: 1, free: 1 },
    { billingStatus: "active", paidSeats: 3, pendingSeats: 2, assigned: 2, free: 0 },
    { billingStatus: "active", paidSeats: 3, pendingSeats: null, assigned: 4, free: 0 },
    { billingStatus: "past_due", paidSeats: 3, pendingSeats: null, assigned: 1, free: 0 },
    { billingStatus: "canceled", paidSeats: 3, pendingSeats: 4, assigned: 1, free: 0 },
  ] as const)(
    "shows $free assignable seats with $billingStatus billing at $paidSeats paid, $pendingSeats pending and $assigned assigned",
    ({ assigned, free, ...org }) => {
      expect(organizationSeats(org, assigned)).toEqual({
        paid: org.paidSeats,
        pending: org.pendingSeats,
        assigned,
        free,
      });
    },
  );
});

it("enables a separate recurring offer only when fully configured", () => {
  expect(loadOrganizationOffer({})).toBeUndefined();
  expect(() =>
    loadOrganizationOffer({ OPENSTEER_ORGANIZATION_STRIPE_PRICE_ID: "price_seats" }),
  ).toThrow("OPENSTEER_ORGANIZATION_CURRENCY");
  expect(
    loadOrganizationOffer({
      OPENSTEER_ORGANIZATION_STRIPE_PRICE_ID: "price_seats",
      OPENSTEER_ORGANIZATION_CURRENCY: "usd",
      OPENSTEER_ORGANIZATION_PRICE_MINOR: "3200",
    }),
  ).toMatchObject({
    priceId: "price_seats",
    currency: "usd",
    amountMinor: 3200,
    interval: "month",
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub, scrubText, assertClean } from "../src/scrub.mjs";

// The observed shape that motivated pattern scrubbing: a postcode inside a
// free-text string while the named postCode field was null. The values here are
// fictional — real captured ones are personal data and do not belong in a test.
const OBSERVED_EVENT = {
  eventId: "00c50668",
  trackingNumber: "MZ544750899GB",
  status: "Shipment Received",
  location: "<Town> Post Office [AB12 3CD]",
  courierCode: "gb-post",
  statusMilestone: "in_transit",
};

test("redacts a place name by default, postcode and all", () => {
  const { data, report } = scrub(OBSERVED_EVENT);
  assert.equal(data.location, "[location]");
  assert.equal(report.places, 1);
});

test("retains a postcode-scrubbed place only when asked", () => {
  const { data, report } = scrub(OBSERVED_EVENT, { retainPlaces: true });
  assert.equal(data.location, "<Town> Post Office [[postcode]]");
  assert.equal(report.postcodes, 1);
  assert.deepEqual(report.locations, ["<Town> Post Office [[postcode]]"]);
});

test("leaves the tracking number intact", () => {
  for (const options of [{}, { retainPlaces: true }]) {
    assert.equal(scrub(OBSERVED_EVENT, options).data.trackingNumber, "MZ544750899GB");
  }
});

test("matches postcodes in every UK format, spaced or not", () => {
  for (const postcode of ["AB12 3CD", "SW1A 1AA", "M1 1AE", "B338TH", "ec1a 1bb"]) {
    assert.equal(scrubText(`at ${postcode} today`).count, 1, `missed ${postcode}`);
  }
});

test("does not mistake a tracking number for a postcode", () => {
  assert.equal(scrubText("MZ544750899GB").count, 0);
  assert.equal(scrubText("VU499656714GB").count, 0);
});

test("nulls named personal fields wherever they appear", () => {
  const { data, report } = scrub({
    shipment: {
      recipient: { name: "A Person", address: "12 Example Street", city: "<Town>", postCode: null },
      delivery: { signedBy: "A PERSON", service: "Tracked 48" },
    },
  });
  assert.equal(data.shipment.recipient.name, null);
  assert.equal(data.shipment.recipient.address, null);
  assert.equal(data.shipment.recipient.city, null);
  assert.equal(data.shipment.delivery.signedBy, null);
  assert.equal(data.shipment.delivery.service, "Tracked 48");
  assert.ok(report.fields.includes("shipment.recipient.address"));
});

test("does not modify its input", () => {
  const input = structuredClone(OBSERVED_EVENT);
  scrub(input);
  assert.deepEqual(input, OBSERVED_EVENT);
});

test("assertClean refuses a payload that still contains a postcode", () => {
  assert.throws(() => assertClean({ note: "delivered to AB12 3CD" }), /refusing to persist/);
  assert.ok(assertClean(scrub(OBSERVED_EVENT).data));
});

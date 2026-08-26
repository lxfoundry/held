// Removes personal location data from courier payloads.
//
// This repository is publishable at any moment, so scrubbing happens at
// capture time — before anything is written to disk or to a log — and never
// as a later audit pass. A committed JSON fixture is public from the moment
// the repository is, and nobody re-reads it.
//
// Two mechanisms, because one is not enough:
//
//   1. Named fields.   recipient.address, recipient.postCode, delivery.signedBy.
//   2. Pattern.        Postcodes also arrive inside free-text strings where no
//                      field name suggests it. A real observed event read
//                      "location": "<Town> Post Office [AB12 3CD]" while
//                      recipient.postCode was still null.
//
// Tracking numbers are public and are deliberately left intact.

// UK postcode: one or two letters, a digit, an optional letter or digit, then
// a digit and two letters. Matched case-insensitively, with or without the
// separating space, and anchored on word boundaries so it cannot bite into a
// tracking number.
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;

const POSTCODE_PLACEHOLDER = "[postcode]";

// Nulled wherever they appear, whatever the surrounding shape.
// Not "state": in a courier payload that is far more often a status than a
// region, and nulling it would quietly damage data this system reads.
const SENSITIVE_KEYS = new Set([
  "name",
  "address",
  "address1",
  "address2",
  "addressLine1",
  "addressLine2",
  "line1",
  "line2",
  "street",
  "houseNumber",
  "postCode",
  "postcode",
  "zip",
  "city",
  "county",
  "region",
  "province",
  "subdivision",
  "signedBy",
  "phone",
  "email",
]);

// Free text that names a place. A postcode-scrubbed location still says which
// town the parcel passed through, and a parcel's route ends at somebody's home,
// so by default the whole value is replaced rather than trimmed.
//
// Retaining them is a deliberate choice for the person whose addresses these
// are: pass { retainPlaces: true } to keep the postcode-scrubbed text. What is
// kept is always reported, so the decision stays visible at capture time
// instead of being discovered later in a committed file.
const PLACE_KEYS = new Set(["location", "originLocation", "destinationLocation"]);

const PLACE_PLACEHOLDER = "[location]";

export function scrubText(text) {
  if (typeof text !== "string") return { text, count: 0 };
  let count = 0;
  const cleaned = text.replace(UK_POSTCODE, () => {
    count += 1;
    return POSTCODE_PLACEHOLDER;
  });
  return { text: cleaned, count };
}

// Returns a scrubbed deep copy plus a report of what was removed and what was
// deliberately kept. The input is never modified.
export function scrub(input, { retainPlaces = false } = {}) {
  const report = { fields: [], postcodes: 0, locations: new Set(), places: 0 };

  const walk = (value, path) => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));

    if (value && typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;

        if (SENSITIVE_KEYS.has(key)) {
          if (child !== null && child !== undefined) report.fields.push(childPath);
          out[key] = null;
          continue;
        }

        if (PLACE_KEYS.has(key) && typeof child === "string" && child.trim() !== "") {
          const { text, count } = scrubText(child);
          report.postcodes += count;
          if (retainPlaces) {
            report.locations.add(text);
            out[key] = text;
          } else {
            report.places += 1;
            out[key] = PLACE_PLACEHOLDER;
          }
          continue;
        }

        out[key] = walk(child, childPath);
      }
      return out;
    }

    if (typeof value === "string") {
      const { text, count } = scrubText(value);
      report.postcodes += count;
      return text;
    }

    return value;
  };

  const data = walk(input, "");
  return { data, report: { ...report, locations: [...report.locations] } };
}

// Fails loudly rather than quietly writing a postcode into a public file.
// Used as a last check on the serialised form immediately before persisting.
export function assertClean(value) {
  const serialised = typeof value === "string" ? value : JSON.stringify(value);
  UK_POSTCODE.lastIndex = 0;
  const found = serialised.match(UK_POSTCODE);
  if (found) {
    throw new Error(
      `refusing to persist: ${found.length} unscrubbed postcode-shaped string(s) remain`,
    );
  }
  return true;
}

# Parcels

Real parcels posted to produce the tracking event streams this system runs on. Tracking numbers are
public and belong here; **addresses do not** — see rule 8 in `CLAUDE.md`.

All parcels are addressed to the sender's own address. Courier event payloads carry
`recipient.address` and `recipient.postCode`, so using anyone else's address would leak their
personal data into captured fixtures in a public repository.

⚠️ **Postcodes also appear inside free-text event strings**, not only in the named recipient fields —
an observed event reads `"location": "<Town> Post Office [AB12 3CD]"` while `recipient.postCode` is
still `null`. Scrub fixtures by pattern over the whole payload, not by field name.

⚠️ **Tracked services only.** Standard 1st/2nd class produces no tracking events at all.

| Parcel | Tracking number | Tracker id | Service | Posted | Job |
|---|---|---|---|---|---|
| **A** | `MZ544750899GB` | `8645991e-538a-40a2-8618-6f9d3777a6ae` | Tracked 24 | 2026-08-26, handed over 15:21Z | Delivered-path event stream; the damage photographs; the `gb-post` proof — ✅ **first scan event received** |
| **B1** | — | — | Tracked 48 | 2026-08-27 | In-transit events over a multi-day window |
| **B2** | — | — | Tracked 48 | 2026-08-28 | Backup undelivered-path target |
| **B3** | — | — | Tracked 48 | 2026-09-01 | ⭐ Primary undelivered-path target — posted the morning it is needed, so non-delivery is certain |

## Registering a parcel

```
node scripts/register-parcel.mjs <trackingNumber> [--ref "parcel A"]
```

Courier code defaults to `gb-post` (Royal Mail), which is required — Royal Mail tracking numbers are
not self-identifying. InPost UK is `inpost-uk`.

Registering is provisioning, not runtime: the oracle adapter only ever receives. Registering a parcel
late loses no history, because carrier event lists are cumulative and the first fetch returns
everything to date.

A newly registered tracker reports `statusMilestone: "pending"` with an empty `events` array until
the parcel is accepted into the network. That is not a failure.

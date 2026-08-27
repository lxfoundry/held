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
| **B1** | `VU499656714GB` | `96a4693b-33b5-45b3-9fff-32c596798c96` | Tracked 48 | 2026-08-27, handed over 15:16Z *(labelled 26 Aug)* | In-transit events over a multi-day window — ✅ **accepted into the network**; registering the tracker a day early caught the acceptance scan itself |
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

Registering early works too, and is the better default: the carrier issues the tracking number when
the label is generated, so a tracker can be created and its webhook armed before the parcel is
handed over. The tracker then captures the acceptance scan itself rather than picking it up later.

A newly registered tracker reports `statusMilestone: "pending"` with an empty `events` array until
the parcel is accepted into the network. That is not a failure.

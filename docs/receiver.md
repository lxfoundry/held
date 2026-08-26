# The webhook receiver

Courier tracking events arrive as HTTP pushes. This service receives them, scrubs personal location
data, stores them idempotently, and does nothing else.

It is deliberately small. It has **no dependencies**, so it deploys without an install step, and it
holds no credentials that can move money — it cannot call the chain at all.

## What it is not

- It **does not register trackers.** Registration is provisioning and lives in
  [`scripts/register-parcel.mjs`](../scripts/register-parcel.mjs). The receiver only ever receives.
- It **does not decide anything.** Mapping tracking state to a protocol action, and acting on a
  deadline, belong to the oracle adapter and the watchdog. See
  [`docs/specs/tracking-state-mapping.md`](./specs/tracking-state-mapping.md).
- It is **not the only copy of the data.** Carrier event lists are cumulative: a fetch returns
  everything to date. Losing this store costs the record of *when* each event arrived, nothing more.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness, uptime, number of trackers held |
| `GET` | `/events` | Per-tracker summary: tracking number, milestone, event count, last event time. Carries no location data by construction |
| `POST` | `/hooks/ship24/<secret>` | The webhook. Anything else, including a wrong secret, returns `404` |

The secret path segment is the access control. It is provider-agnostic — any provider can be pointed
at a URL — and it is the check that works today. A signature scheme, once confirmed against a real
delivery, is verified here as well; the two are complementary, not alternatives.

## Configuration

All optional except the webhook secret, which is required in any deployment.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `SHIP24_WEBHOOK_SECRET` | — | The unguessable path segment. Generate with `node -e "console.log(crypto.randomUUID())"`. Without it the path is guessable and the receiver says so at startup |
| `EVENTS_DIR` | `fixtures/events` | Relative to the repository root |
| `PUBLIC_BASE_URL` | — | Only used to print the correct webhook URL at startup |
| `RETAIN_LOCATIONS` | `false` | Keep place names in captured events. Postcodes are stripped either way |

A real environment variable always wins over `.env`, so a deployed host needs no `.env` file. An
empty value counts as unset.

## Running it

```
npm start                # or: node src/receiver.mjs
npm test                 # node --test
```

Startup prints the exact webhook URL to configure with the provider.

## Deploying it

Any host that runs Node 22 and gives the process a port. There is no build step and nothing to
install.

1. Set `SHIP24_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` to the host's public origin.
2. Start `npm start`; point the host's health check at `/health`.
3. In the provider's dashboard, set the account webhook to `<PUBLIC_BASE_URL>/hooks/ship24/<secret>`.
4. Confirm a real event lands by watching the log, or with `GET /events`.

> ⚠️ **A tunnel on a development machine is not a deployment.** Parcels move at night, at weekends
> and over public holidays. A receiver that is only up while someone is working collects only what
> happens while someone is working.

Storage is a plain directory. On a host with an ephemeral filesystem the store does not survive a
restart — which is recoverable, see below, but a persistent volume is worth the five minutes.

## Recovering missed events

Because carrier event lists are cumulative, nothing is permanently lost by not having been
listening:

```
node scripts/fetch-parcel.mjs <trackerId|trackingNumber>
node scripts/fetch-parcel.mjs --all      # re-fetch every tracker already in the store
```

This is also how a finished parcel is captured as a fixture. Fetched events go through exactly the
same scrubbing and deduplication as pushed ones.

## What the store holds

Per tracker, in `EVENTS_DIR`:

- `<trackerId>.json` — a snapshot: the tracker, the shipment, the full deduplicated event list
  sorted by time, and the derived state. Rewritten in place on every update.
- `<trackerId>.events.ndjson` — an append-only log of when each event *arrived*, which the snapshot
  cannot show.

Derived state follows [the mapping spec](./specs/tracking-state-mapping.md) §5:

- **Idempotent.** Events are keyed on the provider's event id; a repeat is discarded.
- **Order-independent.** State comes from the whole event list, never from the event that happened
  to arrive last.
- **Milestones never regress.** Once `delivered` has been seen, a later `in_transit` does not undo
  it.
- **`available_for_pickup` is sticky**, and recorded as `everAvailableForPickup`, because the
  watchdog must stand down permanently for such an exchange — including if the parcel is later
  returned to sender.
- **An empty event list is a resting state**, not a failure. A newly registered tracker reports
  `pending` with no events until the carrier accepts the parcel.

## Personal data

Courier payloads carry postcodes and address fragments. Scrubbing happens inside the store, on the
one path from payload to disk, so there is no way to write around it — and it happens at capture
time, because a committed fixture is public from the moment the repository is.

Two mechanisms, because either alone is insufficient:

1. **Named fields** — `recipient.address`, `recipient.postCode`, `delivery.signedBy` and similar are
   nulled wherever they appear.
2. **Pattern** — a UK postcode regex runs over every string in the payload. This is not belt and
   braces: a real observed event read `"location": "<Town> Post Office [AB12 3CD]"` while
   `recipient.postCode` was `null`.

Before anything is written, the serialised form is re-checked and the write **fails** if a
postcode-shaped string survives. Tracking numbers are public and are deliberately left intact.

**Place names are redacted too, by default.** A postcode-scrubbed location still says which town a
parcel passed through, and a parcel's route ends at somebody's home. `RETAIN_LOCATIONS=true` keeps
them — postcode-stripped — and every retained value is printed at capture time, so keeping them is a
visible decision made by the person whose addresses they are, not a default nobody chose.

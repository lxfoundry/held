# The webhook receiver

Courier tracking events arrive as HTTP pushes. This service receives them, scrubs personal location
data, stores them idempotently, and does nothing else.

It is deliberately small. It has **no dependencies**, so it deploys without an install step, and it
cannot call the chain at all.

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
| `GET` | `/health` | Liveness, uptime, number of trackers held. Open, because a platform probe cannot hold a secret |
| `GET` | `/events/<secret>` | Per-tracker summary: tracking number, shipment reference, milestone, event count, last event time. Carries no location data by construction |
| `POST` | `/hooks/ship24/<secret>` | The webhook |

Anything else — including either path with a wrong or missing secret — returns `404`, so the paths
cannot be probed for existence.

Request bodies over **2 MB** are rejected.

### What a response means to the provider

The status code is a delivery contract, so the distinction matters:

| Result | Status | Why |
|---|---|---|
| Stored, or already held | `200` | Includes a duplicate: the event is kept once and the push is done with |
| No trackings in the body (a ping) | `200` | A non-2xx would start a retry loop over nothing |
| Body unreadable or not JSON | `400` | Redelivering the same bytes cannot help |
| A tracking entry can never be stored — no usable tracker id, or a corrupt snapshot | `200`, with `rejected` counted | ⚠️ **Deliberately not 500.** Retrying cannot fix it, and a provider that keeps retrying one message wedges its queue behind something that will never succeed. The failure is logged loudly instead |
| Something transient — disk, lock contention | `500` | Ask for the redelivery; it may well work next time |

A `CORRUPT SNAPSHOT` line in the log is an operator alert, not a delivery problem: move the file
aside and re-fetch that tracker.

## Configuration

The receiver reads **only** these variables. It never loads the wallet keys, relayer credential or
model provider key that live in the same `.env` — an internet-facing process that cannot move funds
should not hold the means to either, and that is enforced in code rather than promised here.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Rejected at startup if it is not a valid port number |
| `SHIP24_WEBHOOK_SECRET` | — | **Required.** The unguessable path segment. Generate with `node -e "console.log(crypto.randomUUID())"` |
| `EVENTS_DIR` | `fixtures/events` | Relative to the repository root, or an absolute path |
| `PUBLIC_BASE_URL` | — | Only used to print the correct URLs at startup |
| `RETAIN_LOCATIONS` | `false` | Keep place names in captured events. Postcodes are stripped either way |
| `ALLOW_INSECURE_HOOK` | `false` | Start without a secret. Local development only |

A real environment variable always wins over `.env`, so a deployed host needs no `.env` file. An
empty value counts as unset.

**Without `SHIP24_WEBHOOK_SECRET` the receiver refuses to start**, because the fallback path is a
string anyone would guess and the consequence is event injection. `ALLOW_INSECURE_HOOK=true` opts
out of that check deliberately.

The secret is never written to a log. Startup prints the *shape* of each URL, not the value.

## Access control, and what it does not cover

The secret path segment authenticates the caller. It is provider-agnostic, it works today, and it is
the whole of the access control.

⚠️ **It carries no integrity check on the body.** Anyone who obtains the secret can inject arbitrary
events. The most damaging forgery is not a fake `delivered` — it is a fake `available_for_pickup`,
which is **sticky**: once observed for an exchange it stands the watchdog down permanently, and a
dispute window then lapses in the seller's favour.

**Signature verification is therefore a prerequisite for shipping the watchdog, not an optional
complement to the path secret.** Verify it in the same place and keep the path; the two are
independent checks. Until then, treat the secret as a credential — rotate it if it appears in a log,
a screen share or a proxy's access log.

Also absent, and worth knowing: no rate limiting, and no replay protection beyond event-id
deduplication.

## Running it

```
npm start                # or: node src/receiver.mjs
npm test                 # node --test
```

Startup prints the URLs to configure with the provider.

## Deploying it

Any host that runs Node 22 and gives the process a port. There is no build step and nothing to
install.

1. Set `SHIP24_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` to the host's public origin.
2. Start `npm start`; point the host's health check at `/health`.
3. In the provider's dashboard, set the account webhook to `<PUBLIC_BASE_URL>/hooks/ship24/<secret>`.
4. Confirm a real event lands by watching the log, or with `GET /events/<secret>`.

> ⚠️ **A tunnel on a development machine is not a deployment.** Parcels move at night, at weekends
> and over public holidays. A receiver that is only up while someone is working collects only what
> happens while someone is working.

### Supervision is required

The service is written so that nothing a caller sends ends the process: every request path is
wrapped, and `uncaughtException` and `unhandledRejection` are logged rather than fatal. That is a
belt, not a guarantee — the host must still restart it. Use the platform's restart policy, a Docker
`restart: always`, or a systemd unit with `Restart=always`.

Storage is a plain directory. On a host with an ephemeral filesystem the store does not survive a
restart — recoverable, see below, but a persistent volume is worth the five minutes.

## Recovering missed events

Because carrier event lists are cumulative, nothing is permanently lost by not having been
listening:

```
node scripts/fetch-parcel.mjs <trackerId|trackingNumber>
node scripts/fetch-parcel.mjs --all      # re-fetch every tracker already in the store
```

This is also how a finished parcel is captured as a fixture. Fetched events go through exactly the
same scrubbing and deduplication as pushed ones.

**It is safe to run this while the receiver is up.** Both processes take a per-tracker lock before
reading and write through a private temporary file, so neither can lose the other's events or
rename a file out from under it. A lock left behind by a process that died is broken after 30
seconds.

## What the store holds

Per tracker, in `EVENTS_DIR`:

- `<trackerId>.json` — a snapshot: the tracker, the shipment, the full deduplicated event list
  sorted by time, and the derived state. Rewritten in place when something changes; a redelivery
  that adds nothing leaves it untouched.
- `<trackerId>.events.ndjson` — an append-only log of when each event *arrived*, which the snapshot
  cannot show. Written before the snapshot, so it survives a crash mid-write.

The tracker id becomes a filename, so it is validated before any path is built — a payload whose id
is not filename-safe is rejected rather than stored.

Derived state follows [the mapping spec](./specs/tracking-state-mapping.md) §5:

- **Idempotent.** Events are keyed on the provider's event id; a repeat is discarded.
- **Order-independent.** State comes from the whole event list, never from the event that happened
  to arrive last.
- **`delivered` never regresses.** Once it has been seen, a later `in_transit` does not undo it.
  ⚠️ Note the limit: this is the rule the spec states, and it is the only one implemented. Other
  milestones are last-event-wins, so `failed_attempt` followed by `in_transit` reports `in_transit`.
  If the buyer-facing state needs furthest-reached semantics generally, that is a change to the spec
  first.
- **`available_for_pickup` is sticky**, recorded as `everAvailableForPickup`, because the watchdog
  must stand down permanently for such an exchange — including if the parcel is later returned to
  sender.
- **An empty event list is a resting state**, not a failure. A newly registered tracker reports
  `pending` with no events until the carrier accepts the parcel.
- **A snapshot that cannot be read is an error, never an empty history.** Treating it as a new
  tracker would rewrite the file with only the current push and silently drop the sticky flags
  above — which would let the watchdog raise a dispute against a seller who demonstrably performed.

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

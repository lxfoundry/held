# Running the demonstration

Driving the committed case — exchange `241` — from a known state, on a laptop, with no network.

[`running-a-case.md`](./running-a-case.md) goes the other way: a new exchange, seeded on chain,
mediated with real model calls, where what the model says has never been seen before. This is the
opposite on purpose. One case, every state of it already recorded, so every screen is reproducible
and nothing is asked of the network while somebody is watching it.

Two commands drive all of it. `npm run demo-reset` puts the case at a state and says what the next
round will cost; `npm run mediate` runs that round from there.

---

## 0 · What has to be true first

| | Where | If it isn't |
|---|---|---|
| The exchange record | `state/exchanges/241.json` | ⚠️ **`state/` is gitignored, so a fresh clone has none.** Nothing here can recreate it — copy `state/` across from the machine that seeded it |
| A dispute open on it | `disputeRaisedAt` set, `escalatedAt` and `finalisedAt` null | `demo-reset` refuses, and says so. It **cannot repair this**: all three live on the exchange record, which nothing in this document writes |
| The evidence | `fixtures/case/241.json` | Committed. `demo-reset` rewrites one region of it and checks the result |
| Four recordings | `fixtures/case/recordings/` | Committed. Without them every round below is a live API call |
| The resolution deadline still ahead | `demo-reset` prints it, and says `PASSED` if not | A round run past it is **final**, and the recorded question then comes back through the conclude path — the provisional split under a generic line, in place of the model's own argument |
| `MEDIATOR_MAX_ROUNDS` | `.env` | The recordings were made under a cap of 2, and `demo-reset` numbers the round against whatever is set. On the replay path the cap changes nothing — a recorded proposal replays either way — but a cap the opening round already reaches makes that round final, with the same result as a passed deadline |

Then, in two terminals:

```bash
npm run demo-reset      # writes nothing without --execute. Read the last line
npm run buyer           # http://127.0.0.1:3100/?purchase=241
```

⭐ **The last line of `demo-reset` is the whole preflight.** *"bundle … is recorded — this round
replays with no API call and no network"* is a promise that the next round costs nothing and needs
nothing. Any other last line is a warning that it will reach for the API on whatever network is in
the room.

⚠️ **No API key is needed, and it is better if none is set.** Every round below replays from a
recording. `--execute` on `mediate` is what calls the model, and nothing here passes it.

---

## 1 · The four states

The case opens with one photograph of the damaged item. The mediator asks for the outer shipping
carton, and the answer fills one evidence slot — which of three photographs fills it is the branch.

| Round | The carton slot | What the recording holds |
|---|---|---|
| **1** | empty — the question has not been answered | The mediator's question: *one photograph of the outer shipping package … including any padding or filling still inside it* |
| ⭐ **2** | the carton, square and sealed | A proposal: **30%** — £60 of £200 |
| **2b** | the same carton, crushed at one corner | **22%** — £44 |
| **2c** | that crushed carton opened, void fill still in it | **20%** — £40 |

The number barely moves. The reasoning moves a lot, and names the carton as the thing that moved
it. Why the three are a controlled comparison rather than three anecdotes — one photograph changes,
everything else in the bundle is identical, and both properties are tested — is
[`specs/evidence-and-mediation.md`](./specs/evidence-and-mediation.md) §7.1. The rounds themselves
are the table in [`src/case-fixture.mjs`](../src/case-fixture.mjs).

---

## 2 · The case, run forward

```bash
npm run demo-reset -- --execute     # back to round 1
npm run mediate -- 241              # replays the question
```

Refresh the browser: the mediator's question, the photograph the buyer already sent, and **Add a
photo**.

⚠️ **Run `mediate` before showing the screen.** Between the reset and it, the case stands at round 1
with no round run — so the buyer's opening photograph is on screen with no question above it and no
button below it. Nothing is wrong; the round simply has not happened yet.

Then answer the question. Every route below performs the identical edit to the identical region of
`fixtures/case/241.json` — the button and `demo-reset` go through the same function — and they differ
only in which photograph fills the slot. The first is the one to press in front of someone:

| | Answer | How | Reaches |
|---|---|---|---|
| ⭐ | **The carton is intact** | Press **Add a photo** | round 2 |
| | **It is crushed** | Open `?purchase=241&photo=carton-crushed`, then press it | round 2b |
| | **Crushed, padding visible** | `?purchase=241&photo=carton-crushed-padded`, then press it | round 2c |
| | **Without the browser** | `npm run demo-reset -- --round 2b --execute` | the same file, no press |

```bash
npm run mediate -- 241              # replays the proposal
```

Refresh: the percentage, the refund in pounds, and the whole of the model's reasoning.

---

## 3 · The comparison, run cold

Same case, one photograph swapped, nothing else touched.

⚠️ **It is four commands, not one.**

```bash
npm run demo-reset -- --round 1 --execute
npm run mediate -- 241
npm run demo-reset -- --round 2b --execute
npm run mediate -- 241
```

⚠️ **`--round 2b` on its own, straight after §2, does not do this.** The case record already holds
two rounds, so 2b numbers itself round 3 — past the cap of 2, which returns the recording through
the conclude path: the provisional split under *"Nothing further was provided in time"*, in place of
the model's own argument. Same recording, generic answer, and nothing on screen says so.
`demo-reset` prints three warnings before it happens. The reset to round 1 clears the case record,
which is what makes 2b the second round rather than the third.

`2c` is the same four commands with `2c` in place of `2b`.

---

## 4 · Between runs

```bash
npm run demo-reset -- --execute
```

Seconds, and it writes nothing but the fixture and the case record. A case left standing at a
proposal is a screenshot of a system rather than a system.

---

## 5 · When it goes wrong

Every one of these is something `demo-reset` says out loud before the round runs. That is what it is
for — the reset is the side effect, the verdict is the point.

| It says | What happened | What to do |
|---|---|---|
| **bundle … has NO recording** | The bundle hash moved, so the recording keyed on it is missed. A re-shot photograph, an edited message or a changed `disputeRaisedAt` all do this | Find what moved. `mediate --execute` would record a fresh answer — a live call, and a different number |
| **round 2 wants exactly one round on file** | The opening round has not been run, so this would number itself round 1 and open on the payoff with the question missing | `--round 1 --execute`, `mediate`, then come back |
| **recorded, but round N is final and the recording asks a question** | The cap is reached or the resolution deadline has passed, so a recorded question comes back through the conclude path | Reset to round 1, or raise `MEDIATOR_MAX_ROUNDS` |
| **`disputeRaisedAt` … carries milliseconds** | The dispute instant is the local fallback, not the chain's. The next watchdog sweep overwrites it with the whole second the protocol holds | Heal it before recording anything — every hash keyed on the fallback is missed the moment it changes |
| **has no open case / is escalated / is finalised** | The exchange itself is past mediating | ⚠️ Nothing here can undo it. Those fields live on the exchange record under `state/` |

⚠️ **A watchdog sweep can move the bundle hash.** It merges `disputeRaisedAt` back from chain at
whole seconds, so a record still carrying the millisecond fallback `raise-dispute` writes changes
value on the first sweep — and every recording keyed on the old hash is missed at once. Once the
value is whole seconds it is stable, and `demo-reset` says which of the two is on the record.

⚠️ **Settling is irreversible.** `BUYER_UI_ALLOW_SETTLE` arms the button that splits the pot and
finalises the exchange, and no reset reaches an exchange afterwards. Arming it is not by itself
enough to move anything — a settlement also needs a counterparty signature on disk, bound to one
exchange and one exact percentage — but leave it unset unless the run is meant to end there.

---

## 6 · Afterwards, leave the tree clean

⚠️ **Running the demonstration dirties a committed file.** `demo-reset` rewrites
`fixtures/case/241.json`, so whichever round was last on screen is what `git status` finds. Round 2
is the committed form:

```bash
npm run demo-reset -- --round 2 --execute
git status
```

It restores the file byte for byte — the edit replaces one region rather than re-serialising the
file, and `test/case-fixture.test.mjs` asserts the rounds are exact inverses over the real fixture.

---

## Where it all lives

| | |
|---|---|
| `state/exchanges/241.json` | The chain's view. Gitignored, and nothing here writes it |
| `state/cases/241.json` | The rounds so far. `--round 1` deletes it; that is what makes the next round round 1 |
| `fixtures/case/241.json` | The evidence. `demo-reset` and **Add a photo** rewrite the same one region of it |
| `fixtures/case/recordings/` | One file per bundle hash. Committed, so the demonstration replays anywhere |
| `fixtures/case/system.md` | The prompt the recordings were produced under |
| `src/case-fixture.mjs` | What each round holds, and the one edit that moves between them |

Fourteen further screens — every state the view can draw, including the ones this case never
reaches — are `npm run demo-states`, in the [README](../README.md#npm-run-demo-states).

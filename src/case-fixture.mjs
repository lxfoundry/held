// The evidence a demonstration case holds at each round, and the one edit that
// moves it between them.
//
// ⭐ This is a text replacement over the photographs alone, not a
// re-serialisation of the file. JSON.stringify would reformat the messages and
// the listing too, turning every reset into a large diff on a committed
// fixture — and whichever round the demo happened to end on would be the one
// that got committed. Replacing the one region means the two rounds are
// inverses: applying round 2 to the round-1 form restores the file byte for
// byte, which is the property test/case-fixture.test.mjs asserts against the
// real fixture rather than against a copy shaped like one.
//
// It lives here rather than in scripts/demo-reset.mjs because it is the one
// piece of that script where a silent wrong answer is possible: a fixture whose
// formatting drifts, or a regex that stops matching the region it means, moves
// the bundle hash, and a moved hash turns a free replay into a live API call
// with a non-deterministic answer. A pure function is testable; the script's
// top-level side effects are not.

// The photographs the case moves between, held here rather than read off the
// fixture: at round 1 the fixture does not mention the carton, so a script that
// learned the evidence from the file could never put it back.
//
// Three entries carry the same fixture id and differ only in which image it is.
// That is the point: the outer carton is one evidence slot, and what the demo
// changes is the photograph occupying it, not the shape of the case.
//
// ⚠️ All three sort before `inner.jpg`, and they have to. src/evidence.mjs numbers
// photographs by sorted path, so a filename sorting the other way would put the
// carton in the second slot and renumber both — and any difference in the
// model's answer could then be the renumbering rather than the image. That is
// why the third is named for the carton it shows and not for the packing.
export const PHOTOS = {
  inner: { id: "inner", path: "fixtures/case/photos/inner.jpg", media_type: "image/jpeg" },
  carton: { id: "carton", path: "fixtures/case/photos/carton.jpg", media_type: "image/jpeg" },
  "carton-crushed": { id: "carton", path: "fixtures/case/photos/carton-crushed.jpg", media_type: "image/jpeg" },
  "carton-crushed-padded": {
    id: "carton",
    path: "fixtures/case/photos/carton-crushed-padded.jpg",
    media_type: "image/jpeg",
  },
};

// The case in full, as evidence: the mediator asks for the outer carton, the
// buyer adds it, the number moves. Round 2 is round 1 plus one photograph, and
// that one photograph is the entire difference between the two bundle hashes.
//
// ⭐ 2b is round 2 with the outer carton crushed instead of intact, and it is
// the only claim in this system that can be demonstrated rather than asserted:
// the reasoning recorded for round 2 turns on the carton being undamaged, so
// swapping that one image is a controlled test of whether the model is reading
// the evidence or producing a plausible number. Everything else the bundle holds
// — the real parcel's tracking, the offer terms, the message thread, the
// protocol's dispute instant — is identical between them.
//
// 2c is that swap once more, to the crushed carton photographed open with the
// void fill still in it. It separates the two readings 2b leaves joined: a
// crushed carton on its own reads as packing that let an impact through, while
// the same carton showing the padding around the set moves part of the loss to
// handling neither party controlled. The recorded rounds bear that out — the
// intact carton proposes 30%, the crushed one 22%, the crushed and padded one
// 20% — and the three recordings are committed, so the claim is checkable
// rather than asserted.
//
// ⚠️ It has to be a state of *this* case for that claim to hold. The comparison
// is only controlled because nothing else moves; run against a different
// exchange, the tracking history and the timings move too, and any difference in
// the answer is unattributable. That is why there is one exchange here.
export const ROUNDS = {
  1: ["inner"],
  2: ["inner", "carton"],
  "2b": ["inner", "carton-crushed"],
  "2c": ["inner", "carton-crushed-padded"],
};

// Which mediation round a state stands in for. 2b is a round 2: it wants the
// opening round already on file, and it is final under a cap of 2.
export const ROUND_NUMBER = { 1: 1, 2: 2, "2b": 2, "2c": 2 };

// Deliberately narrow: the region ends at the first `]`, so it matches the flat
// array of objects the fixture holds and fails loudly on anything nested rather
// than silently truncating it.
export const PHOTOS_BLOCK = /"photos":\s*\[[^\]]*\]/;

// The photograph paths a round is defined to hold, in order — what a caller
// checks the edit actually produced.
export function photoPathsFor(round) {
  return (ROUNDS[round] ?? []).map((name) => PHOTOS[name].path);
}

// The round a case holds before it has been asked for anything.
export const OPENING_ROUND = "1";

// The round a case reaches once `name` is the photograph that has been added to
// it — the whole of what adding a photograph does here. It is the opening round
// plus one photograph, and which one is the branch choice: `carton` gives round
// 2, `carton-crushed` gives 2b, `carton-crushed-padded` gives 2c.
//
// ⭐ Derived from ROUNDS rather than tabulated beside them. A second table
// would be a second place the same mapping is stated, and a table that
// disagrees with ROUNDS fails silently: the wrong round writes the wrong
// evidence and every caller still reports success. A search over the rounds
// themselves cannot disagree with them.
//
// Undefined for a photograph no round adds to the opening one — `inner`, which
// the opening round already holds, and anything that is not a photograph at
// all. It is not an answer, and the caller decides what that means.
export function roundAdding(name) {
  const opening = ROUNDS[OPENING_ROUND];
  return Object.keys(ROUNDS).find((round) => {
    const names = ROUNDS[round];
    return (
      names.length === opening.length + 1 &&
      names[opening.length] === name &&
      opening.every((held, i) => names[i] === held)
    );
  });
}

// The photographs that can be added to a case standing at the opening round, in
// the order the rounds declare them. The first is the branch taken when nobody
// names one.
//
// ⭐ Derived from ROUNDS through roundAdding, for the reason roundAdding itself
// gives: a second table would be a second place the same mapping is stated, and
// one that disagreed would fail silently. Adding a branch to ROUNDS puts it on
// this list; it never has to be added twice.
//
// ⚠️ The order is the declaration order of ROUNDS, so which branch is the
// default is decided by where it sits in that table and nowhere else. Today
// that is the intact carton, and the two crushed ones are reached by naming
// them.
export function addablePhotos() {
  return Object.keys(PHOTOS).filter((name) => roundAdding(name) !== undefined);
}

// The round a case currently stands at: the key in ROUNDS whose photographs are
// exactly the ones it holds, in order — and `undefined` for a case holding
// anything else, including a case holding none at all.
//
// ⭐ Derived from ROUNDS, for the third time and the same reason roundAdding
// gives: a table of "what a case at round 2 looks like" would be a second
// statement of what round 2 is, and one that disagreed would answer this
// question wrongly while every caller still reported success.
//
// ⚠️ Read from the parsed case, never from its text. This is a question about
// which photographs a case holds, and the answer must not turn on how the file
// happens to be formatted — unlike applyPhotos, whose whole job is the text.
export function roundStoodAt(caseRecord) {
  const held = (caseRecord?.photos ?? []).map((photo) => photo?.path);
  return Object.keys(ROUNDS).find((round) => {
    const paths = photoPathsFor(round);
    return paths.length === held.length && paths.every((path, i) => path === held[i]);
  });
}

// Thrown when a fixture holds no photographs region this can replace. Named
// rather than plain because it is the one failure here that is neither a bad
// argument nor an absence: the file exists and parses, and its photographs are
// in a shape a hand edit produced and this regex was written to refuse rather
// than silently truncate. A caller cannot fix it, and neither can a buyer — it
// is a broken fixture, and it says so.
export class NoPhotosRegionError extends Error {
  constructor() {
    super("could not find the photos array — the fixture is edited by hand as well as by script");
    this.name = "NoPhotosRegionError";
  }
}

// Returns the fixture text with its photographs set to `round`. Throws rather
// than reporting, so the caller owns how a failure reads.
export function applyPhotos(text, round) {
  const names = ROUNDS[round];
  if (!names) {
    throw new Error(`round must be ${Object.keys(ROUNDS).join(" or ")}, not ${JSON.stringify(round)}`);
  }
  if (!PHOTOS_BLOCK.test(text)) {
    throw new NoPhotosRegionError();
  }
  const rendered = names
    .map((name) => {
      const p = PHOTOS[name];
      return `    { "id": "${p.id}", "path": "${p.path}", "media_type": "${p.media_type}" }`;
    })
    .join(",\n");
  // ⚠️ The replacement is a function, so `$&` and `$'` in a path would be
  // inserted rather than interpreted. Inert for today's paths; free to foreclose.
  return text.replace(PHOTOS_BLOCK, () => `"photos": [\n${rendered}\n  ]`);
}

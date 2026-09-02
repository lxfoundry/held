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
// Two entries carry the same fixture id and differ only in which image it is.
// That is the point: the outer carton is one evidence slot, and what the demo
// changes is the photograph occupying it, not the shape of the case.
export const PHOTOS = {
  inner: { id: "inner", path: "fixtures/case/photos/inner.jpg", media_type: "image/jpeg" },
  carton: { id: "carton", path: "fixtures/case/photos/carton.jpg", media_type: "image/jpeg" },
  "carton-crushed": { id: "carton", path: "fixtures/case/photos/carton-crushed.jpg", media_type: "image/jpeg" },
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
// ⚠️ It has to be a state of *this* case for that claim to hold. The comparison
// is only controlled because nothing else moves; run against a different
// exchange, the tracking history and the timings move too, and any difference in
// the answer is unattributable. That is why there is one exchange here.
export const ROUNDS = {
  1: ["inner"],
  2: ["inner", "carton"],
  "2b": ["inner", "carton-crushed"],
};

// Which mediation round a state stands in for. 2b is a round 2: it wants the
// opening round already on file, and it is final under a cap of 2.
export const ROUND_NUMBER = { 1: 1, 2: 2, "2b": 2 };

// Deliberately narrow: the region ends at the first `]`, so it matches the flat
// array of objects the fixture holds and fails loudly on anything nested rather
// than silently truncating it.
export const PHOTOS_BLOCK = /"photos":\s*\[[^\]]*\]/;

// The photograph paths a round is defined to hold, in order — what a caller
// checks the edit actually produced.
export function photoPathsFor(round) {
  return (ROUNDS[round] ?? []).map((name) => PHOTOS[name].path);
}

// Returns the fixture text with its photographs set to `round`. Throws rather
// than reporting, so the caller owns how a failure reads.
export function applyPhotos(text, round) {
  const names = ROUNDS[round];
  if (!names) {
    throw new Error(`round must be ${Object.keys(ROUNDS).join(" or ")}, not ${JSON.stringify(round)}`);
  }
  if (!PHOTOS_BLOCK.test(text)) {
    throw new Error("could not find the photos array — the fixture is edited by hand as well as by script");
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

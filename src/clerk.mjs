// src/clerk.mjs
// The file that goes to a person.
//
// ⚠️ The clerk never sees a proposal. Not filtered on the way out — absent on
// the way in. A human decider's job is to decide without being anchored, and
// implementing that as an instruction in a prompt would make it a request
// rather than a fact about what this code can possibly know.

export function buildCaseFile({ bundle, caseRecord }) {
  // ⚠️ Reads the item's normalised `at`, never the content's. A captured
  // carrier event carries no `at` of its own, so filtering on `content.at`
  // dropped every real tracking event and handed the person deciding the case
  // an empty timeline — assembly is what puts a time on the item.
  const timeline = bundle.items
    .filter((i) => i.at != null)
    .map((i) => ({
      id: i.id,
      at: i.at,
      provenance: i.provenance,
      // A carrier event's free-text `status` is the human-readable line
      // ("Delivered", "Shipment Received in Depot"). `statusCode` is frequently
      // null on real Royal Mail events and is never the thing to show.
      what: i.content?.status ?? i.content?.description ?? i.content?.text ?? i.kind,
    }))
    .sort((a, b) => a.at - b.at);

  const evidence = bundle.items.map((i) => ({
    id: i.id,
    kind: i.kind,
    // Provenance travels all the way here. A file that presented an
    // aggregator's tracking read and a buyer's photograph as the same kind of
    // fact would be misleading to the person who has to weigh them.
    provenance: i.provenance,
    authored: i.authored,
  }));

  const requests = (caseRecord.rounds ?? []).flatMap((round) => {
    // ⚠️ Matched per request, never per round. A round may carry a request to
    // the buyer and one to the seller, and there is no seller-side interface in
    // this build — so the seller's goes unanswered while the buyer's is
    // answered in the same round. "Something arrived this round" would mark
    // both answered and tell the human decider the opposite of what happened.
    // A `provided` entry names the request it answers by its `what`, which is
    // the round's own identifier for it.
    const answered = new Set(
      (round.provided ?? []).map((p) => p?.what).filter((what) => what != null),
    );
    return (round.requests ?? []).map((req) => ({
      what: req.what,
      whyItMatters: req.whyItMatters,
      askedOf: req.whoCanProvide,
      // What a party was asked for and did not supply is exactly what cannot be
      // reconstructed afterwards, so it is part of the record rather than an
      // absence from it.
      answered: answered.has(req.what),
    }));
  });

  const contested = requests.filter((r) => !r.answered).map((r) => r.what);

  return { exchangeId: bundle.exchangeId, timeline, evidence, requests, contested };
}

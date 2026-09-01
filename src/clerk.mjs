// src/clerk.mjs
// The file that goes to a person.
//
// ⚠️ The clerk never sees a proposal. Not filtered on the way out — absent on
// the way in. A human decider's job is to decide without being anchored, and
// implementing that as an instruction in a prompt would make it a request
// rather than a fact about what this code can possibly know.

export function buildCaseFile({ bundle, caseRecord }) {
  const timeline = bundle.items
    .filter((i) => i.content?.at != null)
    .map((i) => ({ id: i.id, at: i.content.at, provenance: i.provenance, what: i.content.description ?? i.content.text ?? i.kind }))
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

  const requests = (caseRecord.rounds ?? []).flatMap((round) =>
    (round.requests ?? []).map((req) => ({
      what: req.what,
      whyItMatters: req.whyItMatters,
      askedOf: req.whoCanProvide,
      // What a party was asked for and did not supply is exactly what cannot be
      // reconstructed afterwards, so it is part of the record rather than an
      // absence from it.
      answered: (round.provided ?? []).length > 0,
    })),
  );

  const contested = requests.filter((r) => !r.answered).map((r) => r.what);

  return { exchangeId: bundle.exchangeId, timeline, evidence, requests, contested };
}

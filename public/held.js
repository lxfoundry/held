// Draws the view model and nothing else. It computes no state, formats no
// copy and knows no protocol vocabulary — if a string is not in the response,
// it does not appear on screen.

const params = new URLSearchParams(location.search);
const id = params.get("purchase");
// ⚠️ Ruling on the photo action: the model never says which photograph to
// attach — that choice is which branch of the damage case to show, and that
// is an operator decision, not a buyer one. It is read from the URL instead,
// and never invented: absent, the photo action is simply not drawn (see
// actionsBlock below).
const photoId = params.get("photo");

const app = document.getElementById("app");

// The last model actually confirmed by a store read. Never the model an
// action is hoped to produce — see setFailed().
let lastModel = null;

// ⚠️ Fix round 1: action ids currently awaiting their POST's response. The
// 2-second poll keeps running while an action is in flight — it must, so the
// screen never stops reflecting the store — but a tick landing mid-action
// used to rebuild the actions block from model.actions alone, which redrew
// the clicked button as clickable again before its own request had answered.
// actionsBlock() below refuses to draw a button in this set as enabled,
// regardless of what the model says, so a concurrent render can't undo the
// hold. Cleared the instant the action settles — success, a !res.ok failure,
// or a thrown fetch — never left for the next poll to clean up, and never
// used to suppress the poll itself.
const inFlight = new Set();

async function tick() {
  const res = await fetch(id ? `/api/purchases/${id}` : "/api/purchases");
  render(await res.json());
}

async function act(action) {
  // ⚠️ Optimistic rendering is forbidden. The button reports that it is
  // working; what replaces it comes from the next read of the store.
  inFlight.add(action);
  setWorking(action);
  const opts =
    action === "photos"
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ photo: photoId }) }
      : { method: "POST" };
  let res;
  try {
    res = await fetch(`/api/purchases/${id}/${action}`, opts);
  } catch (err) {
    // The guard must not leak on a network failure either — that would
    // disable this button for good, which is worse than the pre-guard
    // behaviour. Cleared, then the original rejection still propagates
    // exactly as it did before this fix (deferred: nothing here catches it).
    inFlight.delete(action);
    throw err;
  }
  // Cleared before either recovery path renders, so that render already
  // reflects the settled truth instead of a guard about to be lifted.
  inFlight.delete(action);
  if (!res.ok) return setFailed(action, await res.text());
  await tick();
}

setInterval(tick, 2000);
tick();

// --- rendering ---------------------------------------------------------

function render(model) {
  app.textContent = "";

  // A response naming an error — an unknown purchase, a store that could not
  // be read — carries an operator diagnostic, never buyer copy. It is logged
  // for whoever runs this and shown as nothing, rather than as an invented
  // "unavailable" sentence this model never emitted.
  if (model && typeof model === "object" && "error" in model) {
    console.error(`could not load purchase: ${model.error}`);
    lastModel = null;
    return;
  }

  lastModel = model;
  if (Array.isArray(model)) return renderList(model);
  return renderPurchase(model);
}

function renderList(models) {
  for (const m of models) {
    const link = document.createElement("a");
    link.className = "item";
    link.href = `?purchase=${m.exchangeId}`;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    link.appendChild(thumb);

    const text = document.createElement("div");
    text.appendChild(textEl("div", m.item.title));
    text.appendChild(textEl("div", m.money.text));
    link.appendChild(text);

    app.appendChild(link);
  }
}

function renderPurchase(model) {
  app.appendChild(moneyBlock(model.money));
  app.appendChild(itemRow(model.item));

  // "split carries one supporting line beneath the item, and only split
  // does" — docs/specs/buyer-view.md §4.
  if (model.note) app.appendChild(textEl("div", model.note, "notice"));

  app.appendChild(textEl("div", model.parcel.text, "status"));

  // The tracking timeline and the mediation block answer different
  // questions and are never drawn together — model.timeline and
  // model.mediation are never both non-null at once.
  if (model.timeline) {
    app.appendChild(timelineBlock(model.timeline));
  } else if (model.mediation) {
    const box = mediationBlock(model.mediation);
    if (box) app.appendChild(box);
  }

  // The notice sits above the buttons, not below and not per-button.
  if (model.notice) app.appendChild(textEl("div", model.notice, "notice"));

  app.appendChild(actionsBlock(model.actions));
}

function moneyBlock(money) {
  const div = document.createElement("div");
  div.className = `money ${money.tone}`;
  div.appendChild(textEl("b", money.text));
  // `meta` is the second line — held has none, and nothing is drawn for it.
  if (money.meta) div.appendChild(textEl("span", money.meta));
  return div;
}

function itemRow(item) {
  const row = document.createElement("div");
  row.className = "item";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  row.appendChild(thumb);

  const text = document.createElement("div");
  text.appendChild(textEl("div", item.title));
  // item.price is "" for a priceless listing — an empty line is not drawn.
  if (item.price) text.appendChild(textEl("div", item.price));
  row.appendChild(text);

  return row;
}

function timelineBlock(entries) {
  const ul = document.createElement("ul");
  ul.className = "timeline";
  for (const e of entries) {
    // Verbatim, not reformatted: `at` is left exactly as the model supplied
    // it. Joined with the same "·" the model's own copy already uses to
    // join two pieces of data (e.g. "{price} · {date}").
    ul.appendChild(textEl("li", `${e.at} · ${e.text}`));
  }
  return ul;
}

function mediationBlock(mediation) {
  const box = document.createElement("div");
  box.className = "box";

  if (mediation.proposal) {
    box.appendChild(textEl("div", mediation.proposal.refund, "amount"));
    box.appendChild(textEl("div", mediation.proposal.reasoning, "why"));
    return box;
  }

  if (mediation.question) {
    box.appendChild(textEl("div", mediation.question, "why"));
    return box;
  }

  // A dispute exists but no round has yet produced a question or a
  // proposal — nothing to show, so nothing is drawn. An empty box would be
  // the same mistake a drawn-but-empty timeline would be.
  return null;
}

function actionsBlock(actions) {
  const wrap = document.createElement("div");
  for (const a of actions) {
    // ⚠️ Ruling: omitting the control is a rendering decision, not composed
    // copy. Without a photo id in the URL, this action is simply not drawn.
    if (a.id === "photos" && !photoId) continue;

    const btn = document.createElement("button");
    if (!a.primary) btn.className = "secondary";
    btn.textContent = a.label;
    // ⚠️ Fix round 1: inFlight overrides the model's enabled — a poll landing
    // mid-action must rebuild this button held, not clickable again.
    btn.disabled = !a.enabled || inFlight.has(a.id);
    btn.dataset.action = a.id;
    btn.addEventListener("click", () => act(a.id));
    wrap.appendChild(btn);

    // A disabled action renders greyed with its reason beneath it in small
    // type — an enabled action never carries one.
    if (a.reason) wrap.appendChild(textEl("div", a.reason, "reason"));
  }
  return wrap;
}

function textEl(tag, text, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function setWorking(action) {
  const btn = app.querySelector(`[data-action="${action}"]`);
  if (btn) btn.disabled = true;
}

function setFailed(action, body) {
  // ⚠️ Never render a server error body as buyer-facing copy — it carries
  // operator diagnostics (protocol vocabulary included). It is logged for
  // whoever runs this, and never reaches the DOM.
  let detail = body;
  try {
    detail = JSON.parse(body).error ?? body;
  } catch (err) {
    console.error(`action "${action}" failure body was not JSON: ${err.message}`);
  }
  console.error(`action "${action}" did not go through: ${detail}`);

  // Nothing here is rendered as a result the store hasn't confirmed. The
  // screen falls back to the last state a real read actually produced; the
  // next poll (at most 2s away) reconciles from the store, as everywhere
  // else in this system.
  if (lastModel) render(lastModel);
}

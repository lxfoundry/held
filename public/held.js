// Draws the view model and nothing else. It computes no state, formats no
// copy and knows no protocol vocabulary — if a string is not in the response,
// it does not appear on screen.

const params = new URLSearchParams(location.search);
const id = params.get("purchase");
// ⚠️ Which photograph the evidence action attaches — the branch of the damage
// case to show, an operator's decision and not a buyer's. The model never says
// which one, and this file never invents one.
//
// Absent is the ordinary case, and the button works without it: the server
// takes the first photograph the rounds declare. It is forwarded on the press
// alone, because it changes what that press attaches and nothing about what is
// drawn — the model is identical either way.
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

// ⚠️ Whether the buyer's last attempt at an action failed. Not a fact any
// store holds — no record says "a request did not arrive" — so it lives here
// and nowhere else, and it survives the poll: cleared when they try again,
// never by the next tick, or the only feedback they get would be wiped within
// two seconds of appearing.
let actionFailed = false;

// ⚠️ What the screen currently draws, as the model plus the two facts no store
// holds. The poll rebuilt the whole page every two seconds whether or not
// anything had changed, and the mediator's reasoning is some two thousand
// characters in a scrolling box: a buyer reading it was returned to the top
// twice a second and could never reach the end of the one thing this product
// exists to show them. Every tick also refetched both evidence photographs and
// dropped whatever had keyboard focus. A tick that reads what is already drawn
// now draws nothing.
//
// inFlight and actionFailed are in the key because they change the screen
// without any store changing — a button held disabled, the one sentence a
// failed action gets. Whatever is not in the key is in forceRedraw().
let lastDrawn = null;

// An action settles by drawing the screen again whatever the stores say. The
// button setWorking() disabled lives in the DOM and not in the model, so a
// press that changes nothing on disk — adding a photograph the case already
// holds — must still put it back; the model is identical either way, so only
// this says so.
function forceRedraw() {
  lastDrawn = null;
}

async function tick() {
  // ⚠️ A poll that cannot be answered leaves the last good screen standing.
  // Without this, one unreachable request threw out of tick() unhandled and
  // (with render() clearing first) the page went blank — a screen saying
  // nothing about a purchase, which is a claim no store made. The next poll
  // is at most two seconds away and reconciles from the stores.
  let res;
  try {
    res = await fetch(id ? `/api/purchases/${id}` : "/api/purchases");
  } catch (err) {
    console.error(`could not reach the server: ${err.message}`);
    return;
  }
  if (!res.ok) {
    // The body carries two separate things. `error` is an operator diagnostic —
    // protocol vocabulary included — and is logged here, never drawn. The
    // buyer's sentence is `unavailable`, and drawUnavailable() takes it only
    // when nothing else stands: once a real read has succeeded that screen
    // stays, and the next poll reconciles it.
    const body = await res.text();
    console.error(`could not load: HTTP ${res.status} ${body}`);
    if (!lastModel) drawUnavailable(body);
    return;
  }
  let model;
  try {
    model = await res.json();
  } catch (err) {
    console.error(`the response was not readable: ${err.message}`);
    return;
  }
  render(model);
}

// ⚠️ The one thing drawn without a model behind it, and it is still not this
// file's words: the sentence comes from the failure body, where the server put
// it from BUYER_STRINGS. Reached only before a first successful read — after
// one, tick() leaves the last good screen standing rather than replacing a real
// purchase with this. A body carrying no sentence draws nothing rather than an
// invented one, which is the same rule render() applies to an error model.
function drawUnavailable(body) {
  let text = null;
  try {
    text = JSON.parse(body).unavailable ?? null;
  } catch (err) {
    console.error(`the failure body was not readable: ${err.message}`);
  }
  if (!text) return;
  // The next real model must draw over this, and it carries no memory of it.
  lastDrawn = null;
  app.textContent = "";
  app.appendChild(textEl("div", text, "notice"));
}

async function act(action) {
  // A fresh attempt clears the previous one's failure — the buyer is told
  // about the attempt they just made, not the one before it.
  actionFailed = false;
  // ⚠️ Optimistic rendering is forbidden. The button reports that it is
  // working; what replaces it comes from the next read of the store.
  inFlight.add(action);
  setWorking(action);
  const opts =
    action === "photos"
      // An object either way, never an empty body: the route parses what it is
      // sent, and "{}" is how "no photograph named, take the default" is said.
      ? { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(photoId ? { photo: photoId } : {}) }
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
    forceRedraw();
    // The same silence, one failure earlier: a request that never left is no
    // more visible to the buyer than one that came back refused, so they are
    // told here too. The rejection itself still propagates exactly as it did.
    actionFailed = true;
    if (lastModel) render(lastModel);
    throw err;
  }
  // Cleared before either recovery path renders, so that render already
  // reflects the settled truth instead of a guard about to be lifted.
  inFlight.delete(action);
  forceRedraw();
  if (!res.ok) return setFailed(action, await res.text());
  await tick();
}

setInterval(tick, 2000);
tick();

// --- rendering ---------------------------------------------------------

function render(model) {
  // A response naming an error — an unknown purchase, a store that could not
  // be read — carries an operator diagnostic, never buyer copy. It is logged
  // for whoever runs this and shown as nothing, rather than as an invented
  // "unavailable" sentence this model never emitted.
  //
  // ⚠️ Checked before the screen is cleared, and lastModel is kept. Clearing
  // first blanked the page for at least one poll on any transient failure, and
  // permanently on one that persisted; dropping lastModel then took the
  // fallback in setFailed() with it.
  if (model && typeof model === "object" && "error" in model) {
    console.error(`could not load purchase: ${model.error}`);
    return;
  }

  lastModel = model;

  // Checked after lastModel is kept and before anything is cleared: the model
  // is confirmed by a store read either way, and only the drawing is skipped.
  const drawn = JSON.stringify([model, [...inFlight], actionFailed]);
  if (drawn === lastDrawn) return;
  lastDrawn = drawn;

  app.textContent = "";
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
    text.appendChild(textEl("div", m.item.title, "what"));
    // ⭐ The parcel line, not the money line. "Your money is held" is true of
    // every purchase that has not finished, so a list of them said the same
    // sentence over and over and distinguished nothing. Where the parcel has
    // got to is the one thing that differs between two open purchases.
    text.appendChild(textEl("div", m.parcel.text, "where"));
    // ...and the money line only once it says something the parcel line
    // cannot. A finished purchase reads "It arrived" whether the seller was
    // paid, the money came back or they split it, so the ending is drawn
    // beneath it — and only then, because before that it is the repetition
    // this change exists to remove. `held` is the line the model renders in
    // the absence of an outcome, so it is exactly the test for "nothing to
    // add yet".
    if (m.money.tone !== "held") text.appendChild(textEl("div", m.money.text, "ending"));
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

  // ⭐ What the buyer has already sent, beneath the mediator's question and
  // above the button that adds to it — so pressing "Add a photo" visibly
  // changes the thing it is about. Drawn only when the model carries it.
  if (model.evidence) app.appendChild(evidenceBlock(model.evidence));

  // The notice sits above the buttons, not below and not per-button.
  if (model.notice) app.appendChild(textEl("div", model.notice, "notice"));

  app.appendChild(actionsBlock(model.actions));

  // Beneath the buttons, because it is about the button that was just pressed.
  // The copy is the model's (BUYER_STRINGS.action_failed) — this file composes
  // no sentence of its own, and the server's error body never reaches the DOM.
  if (actionFailed && model.actionFailed) {
    app.appendChild(textEl("div", model.actionFailed, "reason"));
  }
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
  // One entry, one line, already composed: the stamp is formatted and joined
  // to the carrier's description by the model, like every other string here.
  for (const entry of entries) ul.appendChild(textEl("li", entry));
  return ul;
}

function mediationBlock(mediation) {
  const box = document.createElement("div");
  box.className = "box";

  if (mediation.proposal) {
    box.appendChild(textEl("div", mediation.proposal.refund, "amount"));
    box.appendChild(prose(mediation.proposal.reasoning, "reasoning"));
    return box;
  }

  if (mediation.question) {
    box.appendChild(prose(mediation.question, "why"));
    return box;
  }

  // A dispute exists but no round has yet produced a question or a
  // proposal — nothing to show, so nothing is drawn. An empty box would be
  // the same mistake a drawn-but-empty timeline would be.
  return null;
}

// ⚠️ The count is the model's sentence, not one composed here — "1 photo" and
// "2 photos" are two strings in BUYER_STRINGS and this file picks neither. The
// alt text is the model's too, for the same reason.
//
// Each src names a position in the case's own list of photographs, so the
// browser asks for "the first photograph on this case" and the server decides
// which file that is. Nothing here ever holds a path.
function evidenceBlock(evidence) {
  const box = document.createElement("div");
  box.className = "evidence";
  box.appendChild(textEl("div", evidence.summary, "sent"));

  const strip = document.createElement("div");
  strip.className = "strip";
  for (const src of evidence.photos) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = evidence.alt;
    // A photograph that cannot be loaded leaves its own gap rather than a
    // broken-image icon, which reads as a bug in the product.
    img.addEventListener("error", () => img.remove());
    // ⭐ A thumbnail is 84px square and the evidence is the thing being argued
    // about, so it has to be openable. Click rather than hover: hover has no
    // answer on a touch screen, and a picture that covers the page because the
    // pointer crossed it is a worse failure than one that needs a press.
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.addEventListener("click", () => showEnlarged(src, evidence.alt));
    img.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Space scrolls the page otherwise, which moves the thing being opened.
      e.preventDefault();
      showEnlarged(src, evidence.alt);
    });
    strip.appendChild(img);
  }
  box.appendChild(strip);
  return box;
}

// ⭐ The enlarged photograph lives outside #app, and has to. render() replaces
// the whole of #app whenever the model changes — a photograph added, a round
// answered, an action settling — and an overlay inside it would vanish
// mid-look, on a tick the buyer did not cause and cannot see. Appended to the
// body once, it outlives every redraw.
//
// ⚠️ No copy of its own, deliberately. Every string on this screen is the
// model's, and a close label invented here would be the one exception; the
// image carries the model's own alt text, and dismissal is the scrim, a press
// anywhere, or Escape.
const enlarged = document.createElement("div");
enlarged.className = "enlarged";
enlarged.hidden = true;
enlarged.setAttribute("role", "dialog");
enlarged.setAttribute("aria-modal", "true");
enlarged.tabIndex = -1;
const enlargedImg = document.createElement("img");
enlarged.appendChild(enlargedImg);
document.body.appendChild(enlarged);

// What had focus when it opened, so closing puts the buyer back on the
// thumbnail they pressed rather than at the top of the page.
let openedFrom = null;

function showEnlarged(src, alt) {
  enlargedImg.src = src;
  enlargedImg.alt = alt;
  openedFrom = document.activeElement;
  enlarged.hidden = false;
  enlarged.focus();
}

function hideEnlarged() {
  if (enlarged.hidden) return;
  enlarged.hidden = true;
  // ⚠️ Guarded, because a redraw while this was open can have removed the
  // element that opened it — focusing a detached node throws, and the throw
  // would leave the overlay closed with the page unusable behind it.
  if (openedFrom && document.contains(openedFrom)) openedFrom.focus();
  openedFrom = null;
}

enlarged.addEventListener("click", hideEnlarged);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideEnlarged();
    return;
  }
  // ⚠️ aria-modal asserts that everything behind this is inert, and Tab is
  // where that assertion gets tested. The overlay holds nothing focusable, so
  // without this a Tab press walks focus onto the buttons and thumbnails still
  // in #app behind the scrim — controls the buyer cannot see, cannot have meant
  // to reach, and one of which settles a case. Focus is held rather than
  // cycled, because there is nothing here to cycle between.
  if (e.key === "Tab" && !enlarged.hidden) {
    e.preventDefault();
    enlarged.focus();
  }
});

function actionsBlock(actions) {
  const wrap = document.createElement("div");
  for (const a of actions) {
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

// ⚠️ One element per paragraph, because the model writes in them and
// textContent does not. The mediator's reasoning arrives as four paragraphs
// separated by blank lines; set as the text of a single div, every one of those
// breaks collapsed into a space and two thousand characters of argument became
// one unbroken block — the whole of it, correctly, and unreadable.
//
// This composes no copy. It splits on the blank lines the text already has and
// draws what is between them; a text with none is one paragraph, which is what
// the mediator's question usually is.
function prose(text, className) {
  const wrap = document.createElement("div");
  wrap.className = className;
  for (const para of String(text).split(/\n\s*\n/)) {
    const trimmed = para.trim();
    if (trimmed) wrap.appendChild(textEl("p", trimmed));
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

  // ⚠️ The buyer is told, in the model's words. Silence here is what a buyer
  // pressing "Something's wrong" on a purchase this tool cannot act on used to
  // get: the button simply became pressable again, and that button is the only
  // protection a buyer with a damaged parcel has.
  actionFailed = true;

  // Nothing here is rendered as a result the store hasn't confirmed. The
  // screen falls back to the last state a real read actually produced; the
  // next poll (at most 2s away) reconciles from the store, as everywhere
  // else in this system.
  if (lastModel) render(lastModel);
}

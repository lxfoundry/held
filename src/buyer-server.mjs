// src/buyer-server.mjs
// Serves the buyer's view. It gathers, routes and guards; it decides nothing —
// the view model already holds every decision, and the static page already
// holds every pixel.
//
// ⭐ Unlike the receiver, this holds chain credentials — which is acceptable
// only because it binds to loopback and is never deployed. That ordering is
// load-bearing: if it ever listens on a public interface, this comment is wrong
// and so is the design.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { viewFor } from "./buyer-view.mjs";
import { NotBuiltError } from "./resolution.mjs";
import { UnknownPhotoError } from "./case-input.mjs";
import { loadEnv, ROOT } from "./env.mjs";

// A few kilobytes, never more: the photos body is one short JSON object
// naming a photograph that already exists, not an image — see the "photos"
// branch of run() below. Anything near this size is already a caller doing
// something other than what this route accepts.
const MAX_PHOTO_BODY_BYTES = 4 * 1024;

// ⚠️ A constant, never a setting. Nothing here reads HOST from the
// environment or a flag: the wallet credentials this process holds are safe
// only while it never answers a socket other than loopback.
const HOST = "127.0.0.1";

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/held.css": ["held.css", "text/css; charset=utf-8"],
  "/held.js": ["held.js", "text/javascript; charset=utf-8"],
};

// ⚠️ Loopback is not a security boundary. It is unreachable from another
// machine, and that is the whole of what it buys: it is reachable from every
// page open in this buyer's browser. A POST with no body and no custom header
// triggers no preflight, so CORS never intervenes on the way out — CORS hides
// the response, not the request. An armed server would therefore pay a seller,
// irreversibly, for any page in any tab that guessed a small integer at a
// documented port.
//
// src/receiver.mjs authenticates its caller too, for the opposite reason: it is
// exposed to the internet, so anyone at all may reach it and the question is
// *who*. Here nobody but this machine can reach it, and the question is *which
// page* — so what has to be established is the origin, and the two files check
// different things because they are defending against different callers.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// The Host header is a string a caller controls, so it is taken apart by hand
// rather than handed to a parser: "127.0.0.1:3100", "localhost", "[::1]:3100".
function hostnameOf(host) {
  if (typeof host !== "string" || host === "") return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? null : host.slice(0, end + 1).toLowerCase();
  }
  const colon = host.indexOf(":");
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

export function createApp({ exchanges, trackers, cases, listings, actions, allowConfirm, port = 3100 }) {
  // The two origins this view is ever served from — the same page, under
  // either name a browser resolves to this loopback socket.
  const ownOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // Null when the request is this view's own page asking, and a diagnostic
  // naming the caller when it is anything else. An absent Origin is not
  // suspicious — browsers omit it on same-origin reads — but an absent or
  // foreign Host is: HTTP/1.1 requires one, and a Host that is not loopback
  // means the request was addressed to a name that merely resolves here,
  // which is what DNS rebinding does.
  function foreignCaller(req) {
    const headers = req.headers ?? {};
    const origin = headers.origin;
    if (origin != null && origin !== "" && !ownOrigins.has(origin)) return `origin ${origin}`;
    const hostname = hostnameOf(headers.host);
    if (hostname == null) return "no Host header";
    if (!LOOPBACK_HOSTNAMES.has(hostname)) return `host ${headers.host}`;
    return null;
  }

  const send = (res, status, body, type = "application/json") => {
    res.statusCode = status;
    res.setHeader("content-type", type);
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  function modelFor(id) {
    const record = exchanges.get(id);
    if (!record) return null;
    const input = listings.read(id);
    // Omitted rather than half-drawn: a purchase with no listing has no title
    // and no price, and a blank card on screen looks like a bug in the product
    // rather than a missing file.
    if (!input?.listing) {
      console.error(`no listing for ${id} — omitted from the view`);
      return null;
    }
    const snapshot = record.trackerId ? trackers.read(record.trackerId) : null;
    return viewFor({
      record,
      tracking: snapshot?.state ?? null,
      caseRecord: cases.read(id),
      // Passed through exactly as read. The fixture carries no currency
      // field and viewFor already defaults one — inventing a key here would
      // be a second place that decision could be made.
      listing: input.listing,
      events: snapshot?.events ?? [],
      photos: input.photos?.length ?? 0,
      allowConfirm,
    });
  }

  // Body-reading discipline follows src/receiver.mjs's readBody: accumulate
  // and refuse anything over the cap. The cap here is a fraction of the
  // receiver's, because this is never more than one short JSON object — see
  // MAX_PHOTO_BODY_BYTES above. Chunks are coerced to Buffer rather than
  // assumed to be one: the receiver's own request objects deliver Buffers,
  // but nothing here should throw if a caller (or a test double) hands it a
  // string instead.
  function readSmallBody(req, maxBytes) {
    return new Promise((resolvePromise, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > maxBytes) {
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          if (typeof req.destroy === "function") req.destroy();
          return;
        }
        chunks.push(buf);
      });
      req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
      // ⚠️ Fix round 1, item 3: src/receiver.mjs's readBody also rejects on
      // "aborted" — without it, a client that disconnects mid-body leaves this
      // promise pending forever, and run() never sends a response at all.
      req.on("aborted", () => reject(Object.assign(new Error("client aborted"), { status: 400 })));
    });
  }

  async function run(res, id, name, req) {
    if (name === "complete" && !allowConfirm) {
      // ⚠️ The buyer's screen never learns an environment variable's name —
      // src/buyer-view.mjs renders a neutral reason instead. This is the one
      // place the real one is said out loud, for whoever operates the thing.
      console.error(`refusing to complete exchange ${id}: BUYER_UI_ALLOW_CONFIRM is not set`);
      return send(res, 403, { error: "BUYER_UI_ALLOW_CONFIRM is not set" });
    }
    // ⚠️ Fix round 1, item 2: an unwired action and a broken server are
    // different facts. Calling actions[name] unconditionally turns a route
    // that simply isn't implemented yet (e.g. photos) into a TypeError
    // laundered into a 500 below — this answers 501, the same honest "not
    // built" NotBuiltError already gives settle().
    if (typeof actions[name] !== "function") {
      return send(res, 501, { error: `${name} is not implemented` });
    }

    // ⭐ Task 6c: the one action that needs more than an exchange id. The
    // server reads and validates the body itself — a wrong or missing
    // "photo" key is refused here, before any action is called, so a bad
    // request never reaches store.addPhoto as a thrown TypeError laundered
    // into a 500. Every other action ignores body entirely.
    let body = null;
    if (name === "photos") {
      let raw;
      try {
        raw = await readSmallBody(req, MAX_PHOTO_BODY_BYTES);
      } catch (err) {
        const status = err.status ?? 400;
        console.error(`rejected photos body for exchange ${id}: ${err.message}`);
        return send(res, status, { error: "unreadable body" });
      }
      try {
        body = JSON.parse(raw);
      } catch {
        console.error(`photos body for exchange ${id} is not JSON`);
        return send(res, 400, { error: "body must be JSON" });
      }
      if (typeof body?.photo !== "string" || body.photo === "") {
        console.error(`photos body for exchange ${id} has no "photo" id`);
        return send(res, 400, { error: 'body must include a "photo" id' });
      }
    }

    try {
      await actions[name]({ exchangeId: id, body });
    } catch (err) {
      // ⚠️ 501, never 200. The client renders what it is told, and telling it
      // an unsettled proposal settled is the one failure to prevent.
      if (err instanceof NotBuiltError) return send(res, 501, { error: err.message });
      // A photo id that names nothing under fixtures/case/photos/ — including
      // a traversal attempt, which is simply another id that is not there.
      if (err instanceof UnknownPhotoError) return send(res, 404, { error: err.message });
      console.error(err);
      return send(res, 500, { error: err.message });
    }

    // ⭐ Outside that try, deliberately. Everything above it can fail *instead
    // of* the action; this fails *after* the action already happened — and
    // completing paid a seller irreversibly. Reporting an unreadable store as
    // a failed completion would tell the client the opposite of what is true,
    // so a render failure is reported as itself: logged for the operator, and
    // answered as the action's own success with nothing to draw. The next
    // poll reconciles from the stores, as everywhere else here.
    let model = null;
    try {
      model = modelFor(id);
    } catch (err) {
      console.error(`${name} succeeded for exchange ${id}, but the view could not be rendered: ${err.message}`);
    }
    return send(res, 200, model ?? {});
  }

  // Every path wrapped, as in the receiver: a request that cannot be handled
  // fails that request alone, and nothing a caller sends can end the process.
  return function handle(req, res) {
    try {
      // ⭐ Before anything is routed, and before any state is read or written:
      // the buyer's own page, or nothing. See foreignCaller() above for why a
      // loopback-only socket still needs this.
      const foreign = foreignCaller(req);
      if (foreign) {
        console.error(`refused a request from ${foreign} — this server answers its own page only`);
        return send(res, 403, { error: "this server answers only its own page on loopback" });
      }

      // ⚠️ new URL() here, where src/receiver.mjs's pathnameOf() deliberately
      // refuses it — the two files reach opposite conclusions from the same
      // fact. There, a throw inside the request listener would end a process
      // exposed to the internet, and the base it would need comes from a
      // header a remote caller controls. Here the base is this constant, so
      // nothing a caller sends reaches the parser, and a throw on a malformed
      // request target lands in this function's own try and fails that one
      // request. The Host header above is read as a string for the same
      // reason it is not parsed there.
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      const asset = STATIC[path];
      if (req.method === "GET" && asset) {
        return send(res, 200, readFileSync(join(ROOT, "public", asset[0]), "utf8"), asset[1]);
      }

      if (req.method === "GET" && path === "/api/purchases") {
        let records = [];
        try {
          records = exchanges.all();
        } catch (err) {
          console.error(`could not list exchanges: ${err.message}`);
        }
        // ⚠️ Fix round 1, item 1: one bad tracker snapshot or case file must
        // not blank the whole list (spec §11). Each record is rendered inside
        // its own try/catch — a throw here is logged and the record is
        // omitted, exactly like the "no listing" case modelFor already
        // handles — and .filter(Boolean) drops it from what is sent.
        const models = records.map((r) => {
          try {
            return modelFor(r.exchangeId);
          } catch (err) {
            console.error(`could not render exchange ${r.exchangeId}: ${err.message}`);
            return null;
          }
        });
        return send(res, 200, models.filter(Boolean));
      }

      const one = /^\/api\/purchases\/(\d+)$/.exec(path);
      if (req.method === "GET" && one) {
        const model = modelFor(one[1]);
        return model ? send(res, 200, model) : send(res, 404, { error: "unknown purchase" });
      }

      const action = /^\/api\/purchases\/(\d+)\/(complete|raise|photos|settle)$/.exec(path);
      if (req.method === "POST" && action) {
        // ⚠️ Fix round 1, item 4: run() is async and handle() cannot await
        // it, so its returned promise must be caught here. Uncaught, the two
        // paths run() cannot protect itself against — a non-object rejection
        // (err.message throwing on null/undefined) and a send() that fails
        // once headers are already out — reject silently, the client's
        // 2-second poll never gets a response, and sockets accumulate.
        return run(res, action[1], action[2], req).catch(() =>
          send(res, 500, { error: "the request could not be handled" })
        );
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: "the request could not be handled" });
    }
  };
}

// --- the listening server ----------------------------------------------------
// Everything below is wired only when this module is the entry point, so
// importing createApp for a test never opens a socket, reads .env, touches a
// store on disk, or holds a wallet key.
const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const { createExchangeStore } = await import("./exchanges.mjs");
  const { createStore } = await import("./store.mjs");
  const { createCaseStore } = await import("./cases.mjs");
  const { createCaseInputStore } = await import("./case-input.mjs");
  const { createAuthorisationStore } = await import("./authorisations.mjs");
  const { complete } = await import("./completion.mjs");
  const { raiseFor, confirmedAt } = await import("./disputes.mjs");
  const { settle } = await import("./resolution.mjs");
  const { connect, waitForState } = await import("./chain.mjs");
  const { Contract } = await import("ethers");
  const { abis } = await import("@bosonprotocol/core-sdk");

  const settings = loadEnv({
    only: ["BUYER_UI_PORT", "BUYER_UI_ALLOW_CONFIRM", "EXCHANGES_DIR", "EVENTS_DIR"],
  });

  const port = Number(settings.BUYER_UI_PORT ?? 3100);
  const allowConfirm = settings.BUYER_UI_ALLOW_CONFIRM === "true";

  // Anchored to the repository, not to wherever this was launched from — the
  // same reasoning as every script under scripts/.
  const under = (value, fallback) => resolve(ROOT, value || fallback);

  const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
  const trackers = createStore(under(settings.EVENTS_DIR, "fixtures/events"));
  // Fixed, not configurable — the same reasoning the spec gives for the case
  // store: a configurable copy that disagreed with the mediator's or the
  // watchdog's would be worse than a fixed one that cannot.
  const cases = createCaseStore(join(ROOT, "state/cases"));
  const authorisations = createAuthorisationStore(join(ROOT, "state/authorisations"));

  // The listing block, photos and messages live in fixtures/case/<id>.json —
  // the same file scripts/mediate.mjs reads for the same exchange, and the
  // same file the "Add a photo" action appends to. Absence is not an error:
  // modelFor() already treats a missing listing as "omit this purchase, log
  // why", per spec §11.
  const caseInput = createCaseInputStore(join(ROOT, "fixtures/case"));
  const listings = { read: caseInput.read };

  // ⭐ Connected lazily, on the first action that actually needs the chain.
  // Every GET the buyer's screen polls is answered from the stores alone, so
  // a server that is only ever read from never has to hold a signer in
  // memory at all — and never has to have BUYER_PRIVATE_KEY configured to
  // start and serve the view.
  let chainSingleton = null;
  function getChain() {
    if (!chainSingleton) {
      const { config, provider, coreSDK } = connect({ role: "buyer" });
      const exchangeHandler = new Contract(config.contracts.protocolDiamond, abis.IBosonExchangeHandlerABI, provider);
      const disputeHandler = new Contract(config.contracts.protocolDiamond, abis.IBosonDisputeHandlerABI, provider);
      chainSingleton = { config, provider, coreSDK, exchangeHandler, disputeHandler };
    }
    return chainSingleton;
  }

  // ⚠️ Fix round 1, item 3: an armed server connects eagerly. Lazy connection
  // is still right for an unarmed one — it keeps the no-.env property for a
  // read-only session — but leaving it lazy while armed moves the failure to
  // the worst possible moment: the first press of Confirm, mid-demo, as a
  // 500. An armed server proves it can sign *before* anyone touches the
  // button, and refuses to start at all rather than serve a broken one.
  let chainStatus = "not connected (BUYER_UI_ALLOW_CONFIRM is not set)";
  if (allowConfirm) {
    try {
      getChain();
      chainStatus = "connected";
    } catch (err) {
      console.error(`✗ armed (BUYER_UI_ALLOW_CONFIRM=true) but could not connect to the chain: ${err.message}`);
      console.error("  fix .env, or unset BUYER_UI_ALLOW_CONFIRM to serve the view read-only");
      process.exit(1);
    }
  }

  // Wired exactly as scripts/confirm-receipt.mjs: complete() decides plan vs
  // execute and holds the rules; this holds what needs a signer, a provider
  // and the ABI.
  const chain = {
    async complete({ exchangeId }) {
      const { coreSDK, exchangeHandler } = getChain();
      const nonce = Date.now();
      const signed = await coreSDK.signMetaTxCompleteExchange({ nonce, exchangeId });
      const tx = await coreSDK.relayMetaTransaction({
        functionName: signed.functionName,
        functionSignature: signed.functionSignature,
        sigR: signed.r,
        sigS: signed.s,
        sigV: signed.v,
        nonce,
      });
      // The relayer resolving is not the protocol having acted — see
      // scripts/confirm-receipt.mjs for why this reads back through
      // waitForState rather than trusting the receipt.
      await tx.wait();
      const finalised = await waitForState(
        async () => {
          const result = await exchangeHandler.getExchange(exchangeId);
          return result.exists && !result.exchange.finalizedDate.isZero() ? result : null;
        },
        { what: `exchange ${exchangeId} to read as finalised` }
      );
      return { finalisedAt: Number(finalised.exchange.finalizedDate) * 1000, paid: null };
    },
  };

  // Wired exactly as scripts/raise-dispute.mjs: relay the buyer's pre-signed
  // instruction, then read back through the protocol's own clock.
  const relay = async (stored) => {
    const { coreSDK } = getChain();
    const tx = await coreSDK.relayMetaTransaction(
      {
        functionName: stored.functionName,
        functionSignature: stored.functionSignature,
        sigR: stored.r,
        sigS: stored.s,
        sigV: stored.v,
        nonce: stored.nonce,
      },
      { userAddress: stored.userAddress }
    );
    return tx.wait();
  };
  const confirm = (stored) =>
    waitForState(
      async () => {
        const { disputeHandler } = getChain();
        return confirmedAt(await disputeHandler.getDispute(stored.exchangeId), "raiseDispute");
      },
      { what: `raiseDispute to be recorded for exchange ${stored.exchangeId}` }
    );

  // ⭐ Ruling 2: pre-bound callables. The handler above calls
  // actions[name]({ exchangeId, body }) with exactly these two, so everything
  // else each real function needs is closed over here rather than threaded
  // through the request path. Every action but photos ignores body — it is
  // the one action that carries anything beyond which exchange it is for.
  const actions = {
    // ⭐ Wired only when the operator armed it. The guard in run() already
    // refuses this route unarmed; omitting the callable as well means an
    // unarmed server has no path to complete() at all — it answers 501,
    // because there is nothing there — rather than one string comparison
    // standing between a stray request and an irreversible payment.
    ...(allowConfirm
      ? {
          complete: async ({ exchangeId }) => {
            // ⚠️ Which side of the chain call a failure fell on, tracked the
            // way scripts/confirm-receipt.mjs tracks it and reported in the
            // same words. Everything after the protocol confirms is local
            // bookkeeping, and a failure there means the seller has been paid
            // and nothing on disk says so — an operator who reads only "✗"
            // would re-run it and be told the exchange is already finalised,
            // with no idea why.
            let confirmed = false;
            const watched = {
              complete: async (args) => {
                const result = await chain.complete(args);
                confirmed = true;
                return result;
              },
            };
            try {
              return await complete({ exchangeId, exchanges, authorisations, chain: watched, execute: true });
            } catch (err) {
              if (confirmed) {
                console.error(`✗ ${err.message}`);
                console.error(`  exchange ${exchangeId} is finalised and the seller has been paid, but this record was not updated`);
              }
              throw err;
            }
          },
        }
      : {}),
    raise: ({ exchangeId }) => raiseFor({ exchangeId, by: "buyer", exchanges, authorisations, relay, confirm }),
    photos: ({ exchangeId, body }) => caseInput.addPhoto(exchangeId, body.photo),
    // buyerPercent is unused by settle() today — it throws unconditionally
    // until mutual resolution is implemented — but the call keeps the shape
    // src/resolution.mjs declares.
    settle: ({ exchangeId }) => settle({ exchangeId, buyerPercent: null }),
  };

  // ⭐ port, because the guard in createApp needs to recognise this server's
  // own origin — the page is served from exactly this socket.
  const app = createApp({ exchanges, trackers, cases, listings, actions, allowConfirm, port });

  const server = createServer(app);
  server.listen(port, HOST, () => {
    console.log(`buyer view listening on http://${HOST}:${port}`);
    console.log(`  exchanges → ${exchanges.dir}`);
    console.log(`  trackers  → ${trackers.dir}`);
    console.log(`  complete  → ${allowConfirm ? "armed" : "disabled (BUYER_UI_ALLOW_CONFIRM is not set)"}`);
    console.log(`  chain     → ${chainStatus}`);
  });

  // Nothing a browser sends should end this process — the same discipline as
  // the receiver, for the same reason: staying up and serving is better than
  // exiting silently on a machine nobody is watching mid-demo.
  process.on("uncaughtException", (err) => {
    console.error(`uncaught exception, staying up: ${err.stack ?? err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`unhandled rejection, staying up: ${reason?.stack ?? reason}`);
  });
}

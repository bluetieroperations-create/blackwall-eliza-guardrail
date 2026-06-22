// Confirmation-aware tests for blackwall-eliza-guardrail (v0.3.0).
//
// Proves the SAFETY INVARIANT: in enforce mode, an action carrying a
// confirmation REQUIREMENT (a `confirmation` object on the verdict) NEVER runs
// unless a same-origin poll returned status:'approved'. A confirmation object
// with no pollable poll_url (missing/empty/off-origin) fails CLOSED.
//
// Mocks globalThis.fetch to script BOTH the forecast POST and the poll GET(s).
// Run with: node test-confirmation.mjs
//
// HARNESS: each numbered block runs inside runTest(), which try/catches so a
// regression records a FAIL and CONTINUES — the run yields a per-invariant
// "N passed, M failed" map naming WHICH blocks broke, never a first-crash abort.
//
// Each test is mutation-proven non-vacuous; see the per-test NOTE comments and
// the agent's report for what removing each guard breaks.

import { blackwallGuardrail, gateCall } from './src/index.mjs';

// ---------------------------------------------------------------------------
// Scriptable fetch. We route by method + URL:
//   POST .../api/v1/forecast      -> shift from `forecastResponses`
//   GET  <poll_url>               -> shift from `pollResponses`
//   PATCH .../outcome             -> generic ok (observe)
// A response entry: { ok, status, body } or { throw: Error }.
// ---------------------------------------------------------------------------
let fetchCalls = [];
let forecastResponses = [];
let pollResponses = [];

globalThis.fetch = async (url, init) => {
  const method = init?.method ?? 'GET';
  fetchCalls.push({
    url: String(url),
    method,
    headers: init?.headers ?? {},
    body: init?.body ? safeParse(init.body) : null,
  });

  // observe / outcome PATCH — always succeed, irrelevant to these tests.
  if (method === 'PATCH' || String(url).includes('/outcome')) {
    return mkRes({ ok: true, status: 200, body: { ok: true } });
  }

  // forecast POST
  if (method === 'POST' && String(url).includes('/api/v1/forecast')) {
    const r = takeNext(forecastResponses, 'forecast');
    if (r.throw) throw r.throw;
    return mkRes(r);
  }

  // Everything else is a poll GET against poll_url.
  const r = takeNext(pollResponses, 'poll');
  if (r.throw) throw r.throw;
  return mkRes(r);
};

function safeParse(b) { try { return JSON.parse(b); } catch { return b; } }
function mkRes(r) {
  return {
    ok: r.ok ?? true,
    status: r.status ?? 200,
    json: async () => {
      if (r.unparseable) throw new SyntaxError('Unexpected token < in JSON');
      return r.body ?? {};
    },
  };
}
function takeNext(queue, label) {
  if (queue.length === 0) {
    return { ok: false, status: 500, body: { error: `no mock ${label} response queued` } };
  }
  return queue.shift();
}

// ---------------------------------------------------------------------------
function makeRuntime(actions) {
  return {
    actions,
    character: { name: 'test-agent' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}
function makeAction(name, handlerImpl) {
  return { name, handler: handlerImpl };
}

let passed = 0;
let failed = 0;
const failedTests = [];
let currentTest = '(none)';
function assert(cond, msg) {
  if (!cond) {
    console.error('  FAIL:', msg);
    failed += 1;
    throw new Error(`assertion failed: ${msg}`);
  } else {
    console.log('  ok —', msg);
    passed += 1;
  }
}
// Isolate each block: an uncaught throw (failed assertion, null-deref, hang-free
// error) records the block as FAILED and CONTINUES to the next block instead of
// aborting the whole run.
async function runTest(name, fn) {
  currentTest = name;
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (e) {
    // If the throw was an assertion we already counted+logged it. Any OTHER
    // throw (null-deref, unexpected exception) is an additional failure.
    if (!/^assertion failed: /.test(String(e?.message))) {
      console.error('  FAIL (uncaught):', e?.message ?? e);
      failed += 1;
    }
    failedTests.push(name);
  }
}
function reset() {
  fetchCalls = [];
  forecastResponses = [];
  pollResponses = [];
}

// A verdict with a confirmation handle (what a live risky send_money returns).
function confirmationVerdict(overrides = {}) {
  return {
    id: 'fc_conf',
    recommendation: 'CAUTION',
    risk_score: 60,
    gate: 'CONFIRM',
    hard_blocks: [],
    red_flags: [],
    confirmation: {
      id: 'conf_123',
      status: 'pending',
      poll_url: 'https://blackwalltier.com/api/v1/confirmations/conf_123',
    },
    ...overrides,
  };
}

// ===========================================================================
await runTest('[1] enforce + confirmation + wait=0 → handler NOT run; threw pending; message has poll_url', async () => {
// NOTE non-vacuity: if the confirmation branch were removed, the verdict (CAUTION,
// non-STOP) would fall through to "run + observe" and handlerRan would be true.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run (wait=0, pending)');
  assert(threw !== null, 'wrapper threw');
  assert(/pending/i.test(threw?.message), 'error message mentions pending');
  assert(threw?.message.includes('https://blackwalltier.com/api/v1/confirmations/conf_123'), 'error message contains the poll_url');
  assert(events.some((e) => e.type === 'confirmation_required'), 'confirmation_required event emitted');
  assert(events.some((e) => e.type === 'confirmation_pending'), 'confirmation_pending event emitted');
});

// ===========================================================================
await runTest('[2] enforce + confirmation + wait>0 + poll approved (after 1 pending) → handler RAN; result returned', async () => {
// NOTE non-vacuity: if the loop never re-polled, the first pending poll would
// abort and handlerRan would be false. If "approved" were not honored, it would abort.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'enforce',
    confirmationWaitMs: 1000, confirmationPollMs: 250,
    onEvent: (e) => events.push(e),
  });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ body: { status: 'pending' } });
  pollResponses.push({ body: { status: 'approved' } });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, 'handler RAN after approval');
  assert(result === 'SENT', 'wrapper returned the handler result');
  assert(events.some((e) => e.type === 'confirmation_approved'), 'confirmation_approved event emitted');
});

// ===========================================================================
await runTest('[3] enforce + confirmation + poll rejected → handler NOT run; threw rejected', async () => {
// NOTE non-vacuity: drop the rejected branch and "rejected" would be treated as
// pending (still aborts) — but the distinct event/message proves we read status.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000, confirmationPollMs: 250,
    onEvent: (e) => events.push(e),
  });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ body: { status: 'rejected' } });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run on rejection');
  assert(threw !== null && /REJECTED/i.test(threw?.message), 'threw REJECTED error');
  assert(events.some((e) => e.type === 'confirmation_rejected'), 'confirmation_rejected event emitted');
});

// ===========================================================================
await runTest('[4] enforce + confirmation + poll stays pending past budget → handler NOT run; threw pending', async () => {
// NOTE non-vacuity: if the wall-clock budget were not enforced, the loop would
// poll forever (this test caps poll-count and would FAIL the bound) instead of
// aborting. We assert on poll-COUNT (not wall-clock) so the test is not flaky:
// with confirmationWaitMs=600 / confirmationPollMs=250 the loop polls at t≈0,
// ~250, ~500, then the budget elapses ⇒ at most ~4 polls. A runaway loop would
// blow past that bound.
  reset();
  let handlerRan = false;
  let pollCount = 0;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 600, confirmationPollMs: 250,
    onEvent: (e) => events.push(e),
  });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  // Always pending — but count polls so a runaway loop is caught deterministically.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && String(url).includes('/confirmations/')) {
      pollCount += 1;
      if (pollCount > 20) throw new Error('SPIN: budget not enforced — poll ran away');
    }
    return origFetch(url, init);
  };
  for (let i = 0; i < 40; i++) pollResponses.push({ body: { status: 'pending' } });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  globalThis.fetch = origFetch;
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run after budget elapsed');
  assert(threw !== null && /pending/i.test(threw?.message), 'threw pending error');
  // Poll-count bound (deterministic; not wall-clock dependent ⇒ not flaky).
  assert(pollCount > 0 && pollCount <= 6, `poll loop bounded by budget (polled ${pollCount}×, not runaway)`);
  assert(events.some((e) => e.type === 'confirmation_pending'), 'confirmation_pending event emitted');
});

// ===========================================================================
await runTest('[5] enforce + confirmation + poll throws/network-error → handler NOT run (fail-closed)', async () => {
// NOTE non-vacuity: if poll errors were not caught-and-failed-closed, either the
// error escapes uncaught OR (worse) a naive impl could run the action. Must abort.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000, confirmationPollMs: 250,
    onEvent: (e) => events.push(e),
  });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ throw: new TypeError('fetch failed: ECONNREFUSED') });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run on poll network error (fail-closed)');
  assert(threw !== null && /pending/i.test(threw?.message), 'threw pending (fail-closed) error');
  assert(events.some((e) => e.type === 'confirmation_pending'), 'confirmation_pending event emitted');
});

// ===========================================================================
await runTest('[5b] enforce + confirmation + poll non-2xx → fail-closed (abort)', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000, confirmationPollMs: 250 });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ ok: false, status: 503, body: { error: 'down' } });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  assert(handlerRan === false, 'handler did NOT run on poll non-2xx');
  assert(threw !== null && /pending/i.test(threw?.message), 'threw pending on non-2xx');
});

// ===========================================================================
await runTest('[5c] enforce + confirmation + poll 2xx with garbage/no status → treated as pending', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 0 });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ body: { totally: 'unrelated' } }); // 2xx, no status

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  assert(handlerRan === false, 'handler did NOT run when status is missing (treated pending)');
  assert(threw !== null && /pending/i.test(threw?.message), 'threw pending for garbage body');
});

// ===========================================================================
// FIX 1 — confirmation REQUIRED but no pollable poll_url ⇒ FAIL CLOSED (enforce).
// This is the audit's real fail-open gap: a confirmation object with a
// missing/empty poll_url previously made hasConfirmationHandle() false, so the
// verdict (CAUTION) fell through to step 4 and the action RAN ungated.
// ===========================================================================
await runTest('[F1a] enforce + confirmation present + poll_url MISSING → handler NOT run (fail closed)', async () => {
// NOTE non-vacuity / MUTATION: revert hasConfirmationHandle to key off poll_url
// (the pre-fix bug) and this verdict is no longer a confirmation ⇒ falls through
// to GO/CAUTION run path ⇒ handlerRan becomes TRUE ⇒ this assertion fails.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  // confirmation object with NO poll_url at all.
  forecastResponses.push({ body: confirmationVerdict({ confirmation: { id: 'conf_np', status: 'pending' } }) });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run with confirmation present + no poll_url');
  assert(threw !== null, 'wrapper threw (fail closed)');
  assert(/no pollable approval URL/i.test(threw?.message), 'threw the no-pollable-URL fail-closed error');
  assert(events.some((e) => e.type === 'confirmation_required'), 'confirmation_required event emitted');
  assert(events.some((e) => e.type === 'confirmation_pending'), 'confirmation_pending event emitted');
  assert(!fetchCalls.some((c) => c.url.includes('/confirmations/')), 'never attempted a poll (nothing to poll)');
});

// ===========================================================================
await runTest('[F1b] enforce + confirmation present + poll_url EMPTY STRING → handler NOT run (fail closed)', async () => {
// NOTE non-vacuity / MUTATION: remove the empty-string guard in hasPollableUrl
// and an empty poll_url would be passed to pollConfirmation, fetched (against
// "" ⇒ unparseable ⇒ pending), still aborting — but the distinct fail-closed
// message + the "never polled" assertion pin the intended path.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000 });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict({ confirmation: { id: 'conf_es', status: 'pending', poll_url: '' } }) });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run with empty-string poll_url');
  assert(threw !== null && /no pollable approval URL/i.test(threw?.message), 'threw the no-pollable-URL fail-closed error');
  assert(!fetchCalls.some((c) => c.url.includes('/confirmations/')), 'never attempted a poll');
});

// ===========================================================================
await runTest('[F1c] observe + confirmation present + poll_url MISSING → handler RAN (observe contract unchanged)', async () => {
// NOTE non-vacuity: observe must NEVER alter behavior even on a malformed handle.
// The FIX-1 fail-closed branch is gated behind enforce; in observe the action
// still runs. If the fail-closed branch leaked into observe, handlerRan = false.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'observe', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict({ confirmation: { id: 'conf_np', status: 'pending' } }) });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, 'observe: handler RAN even with no poll_url (contract unchanged)');
  assert(result === 'SENT', 'observe: returned handler result');
  assert(events.some((e) => e.type === 'confirmation_required'), 'observe: confirmation_required still emitted');
});

// ===========================================================================
await runTest('[6] observe + confirmation → handler RAN; confirmation_required emitted; callback called', async () => {
// NOTE non-vacuity: observe must NEVER alter behavior. If observe blocked on the
// confirmation, handlerRan would be false — violating the observe contract.
  reset();
  let handlerRan = false;
  let callbackArgs = null;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'observe',
    onEvent: (e) => events.push(e),
    onConfirmationRequired: (handle, meta) => { callbackArgs = { handle, meta }; },
  });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, 'observe: handler RAN (behavior unchanged)');
  assert(result === 'SENT', 'observe: returned handler result');
  assert(events.some((e) => e.type === 'confirmation_required'), 'confirmation_required event emitted');
  assert(callbackArgs !== null, 'onConfirmationRequired was called');
  assert(callbackArgs?.handle?.id === 'conf_123', 'callback got the confirmation handle');
  assert(callbackArgs?.meta?.actionName === 'send_money', 'callback got actionName');
  // Observe must not poll.
  assert(pollResponses.length === 0 && !fetchCalls.some((c) => c.url.includes('/confirmations/')), 'observe did NOT poll');
});

// ===========================================================================
await runTest('[7] enforce + hard_blocks non-empty (WITH confirmation present) → hard-stop, NOT confirmation path', async () => {
// NOTE non-vacuity: strictest-wins. If hard_blocks were not checked first, the
// confirmation path would run and (with wait=0) throw a "pending" error instead
// of a hard-stop — or worse, poll for approval on an action that must never run.
  reset();
  let handlerRan = false;
  const action = makeAction('drain_wallet', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 5000, onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  // Has BOTH a confirmation handle AND hard_blocks. Hard blocks must win.
  forecastResponses.push({ body: confirmationVerdict({
    recommendation: 'STOP',
    hard_blocks: [{ code: 'IRREVERSIBLE_DESTRUCTION', severity: 'critical' }],
  }) });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'drain' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run (hard stop)');
  assert(threw !== null, 'threw on hard_blocks');
  assert(/blocked/i.test(threw?.message), 'threw a hard-stop (blocked) error, not a confirmation error');
  assert(!/pending|confirmation/i.test(threw?.message), 'did NOT take the confirmation path');
  assert(events.some((e) => e.type === 'stop'), 'stop event emitted (hard block)');
  assert(!events.some((e) => e.type === 'confirmation_required'), 'confirmation_required NOT emitted');
  assert(!fetchCalls.some((c) => c.url.includes('/confirmations/')), 'never polled');
});

// ===========================================================================
await runTest('[8] enforce + legacy STOP (no confirmation) → handler NOT run (unchanged v0.2.1 behavior)', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('delete_db', async () => { handlerRan = true; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce' });
  await plugin.init(runtime);

  forecastResponses.push({ body: { id: 'fc_s', recommendation: 'STOP', risk_score: 95, red_flags: [{ code: 'X' }] } });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'drop' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'legacy STOP: handler did NOT run');
  assert(threw !== null && /blocked/i.test(threw?.message), 'legacy STOP throws blocked error');
});

// ===========================================================================
await runTest('[9] enforce + GO (no confirmation) → handler RAN (unchanged v0.2.1 behavior)', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('post_tweet', async () => { handlerRan = true; return 'posted'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce' });
  await plugin.init(runtime);

  forecastResponses.push({ body: { id: 'fc_go', recommendation: 'GO', risk_score: 5 } });

  const r = await action.handler(runtime, { content: { text: 'tweet' } }, {}, {});
  await new Promise((res) => setTimeout(res, 10));

  assert(handlerRan === true, 'GO: handler RAN');
  assert(r === 'posted', 'GO: returned result');
});

// ===========================================================================
// FIX 3 — forecast() THROWS (BLACK_WALL outage) in enforce on a
// confirmation-bearing action → CURRENT documented behavior is fail-OPEN: the
// handler runs ungated. This pins that posture as a visible, asserted decision.
// ===========================================================================
await runTest('[F3a] enforce + forecast() THROWS (outage) → handler RAN ungated (fail-OPEN, pinned)', async () => {
// NOTE: this asserts the v0.2.x AVAILABILITY DOCTRINE — a BLACK_WALL outage must
// never break the agent, so forecast() failure falls open and the action runs
// UNGATED. This is deliberately NOT the fail-closed posture of the confirmation
// poll path (which fails closed only AFTER a successful forecast returns a
// confirmation requirement). A fail-closed `enforce-strict` mode is a DEFERRED
// product decision; if it ever ships, THIS test must flip and is the canary.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  // forecast() itself fails (outage / network), BEFORE any verdict exists.
  forecastResponses.push({ throw: new TypeError('fetch failed: forecast endpoint down') });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, 'forecast outage: handler RAN ungated (fail-OPEN doctrine)');
  assert(result === 'SENT', 'forecast outage: returned handler result');
  assert(events.some((e) => e.type === 'forecast_error'), 'forecast_error event emitted');
  assert(!fetchCalls.some((c) => c.url.includes('/confirmations/')), 'no confirmation poll (never got a verdict)');
});

// ===========================================================================
// FIX 3 — status normalization: removing .trim().toLowerCase() in the poll
// status read would break these.
// ===========================================================================
await runTest('[F3b] enforce + poll status " APPROVED " (whitespace+upper) → normalizes → handler RAN', async () => {
// NOTE non-vacuity / MUTATION: drop .trim().toLowerCase() and " APPROVED " !==
// "approved" ⇒ treated as pending ⇒ aborts ⇒ handlerRan false ⇒ fails.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000, confirmationPollMs: 250 });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ body: { status: ' APPROVED ' } });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, '" APPROVED " normalized → handler RAN');
  assert(result === 'SENT', 'returned handler result');
});

await runTest('[F3c] enforce + poll status "Approved" (mixed case) → normalizes → handler RAN', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000, confirmationPollMs: 250 });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ body: { status: 'Approved' } });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, '"Approved" normalized → handler RAN');
  assert(result === 'SENT', 'returned handler result');
});

await runTest('[F3d] enforce + poll status " REJECTED " (whitespace+upper) → normalizes → aborts', async () => {
// NOTE non-vacuity / MUTATION: drop .trim().toLowerCase() and " REJECTED " is
// treated as pending (still aborts) — but the REJECTED message + event pin that
// the rejected branch fired on the normalized value.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000, confirmationPollMs: 250, onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ body: { status: ' REJECTED ' } });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, '" REJECTED " normalized → handler did NOT run');
  assert(threw !== null && /REJECTED/i.test(threw?.message), 'threw the REJECTED error');
  assert(events.some((e) => e.type === 'confirmation_rejected'), 'confirmation_rejected event emitted');
});

// ===========================================================================
await runTest('[10] onConfirmationRequired that THROWS → does not break the wrap', async () => {
// NOTE non-vacuity: if the callback were not wrapped in try/catch, its throw would
// escape the wrap and the action would error out for the wrong reason.
  // 10a: observe — broken callback must not stop the handler from running.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'observe',
    onConfirmationRequired: () => { throw new Error('callback boom'); },
  });
  await plugin.init(runtime);
  forecastResponses.push({ body: confirmationVerdict() });
  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));
  assert(handlerRan === true, 'observe: broken callback did NOT stop the handler');
  assert(result === 'SENT', 'observe: still returned result');

  // 10b: enforce — broken callback must not turn the abort into the wrong error.
  reset();
  let ran2 = false;
  const action2 = makeAction('send_money', async () => { ran2 = true; return 'SENT'; });
  const runtime2 = makeRuntime([action2]);
  const plugin2 = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 0,
    onConfirmationRequired: () => { throw new Error('callback boom'); },
  });
  await plugin2.init(runtime2);
  forecastResponses.push({ body: confirmationVerdict() });
  let threw2 = null;
  try { await action2.handler(runtime2, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw2 = e; }
  assert(ran2 === false, 'enforce: broken callback still aborts (handler did NOT run)');
  assert(threw2 !== null && /pending/i.test(threw2?.message), 'enforce: threw the confirmation pending error, not the callback error');
});

// ===========================================================================
await runTest('[11] gateCall() honors the same confirmation logic (enforce, wait=0 → step NOT run)', async () => {
// NOTE non-vacuity: proves the shared helper is wired into gateCall too, not just
// the action wrap. If gateCall ignored confirmation, stepRan would be true.
  reset();
  let stepRan = false;
  // Queue the forecast response BEFORE the call — the mock fetch shifts the
  // queue synchronously, so a response queued after the call would be missed
  // (fail-open) and make this test vacuously pass.
  forecastResponses.push({ body: confirmationVerdict({ id: 'fc_gate' }) });
  const r = gateCall(
    'transfer',
    { to: '0xabc', amount_usd: 5000 },
    async () => { stepRan = true; return 'sent'; },
    { apiKey: 'bw_k', mode: 'enforce' }
  );

  let threw = null;
  try { await r; } catch (e) { threw = e; }
  await new Promise((res) => setTimeout(res, 10));

  assert(stepRan === false, 'gateCall: guarded step did NOT run (confirmation pending)');
  assert(threw !== null && /pending/i.test(threw?.message), 'gateCall: threw the confirmation pending error');
});

// ===========================================================================
await runTest('[11b] gateCall() confirmation approved (enforce, wait>0) → step RAN', async () => {
  reset();
  let stepRan = false;
  // Queue responses BEFORE the call (mock shifts the queue synchronously).
  forecastResponses.push({ body: confirmationVerdict({ id: 'fc_gate2' }) });
  pollResponses.push({ body: { status: 'approved' } });
  const p = gateCall(
    'transfer',
    { to: '0xabc', amount_usd: 5000 },
    async () => { stepRan = true; return 'sent'; },
    { apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 1000, confirmationPollMs: 250 }
  );

  const result = await p;
  await new Promise((res) => setTimeout(res, 10));
  assert(stepRan === true, 'gateCall: step RAN after approval');
  assert(result === 'sent', 'gateCall: returned step result');
});

// ===========================================================================
await runTest('[12] poll sends Authorization: Bearer <apiKey>', async () => {
  reset();
  const action = makeAction('send_money', async () => 'SENT');
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_secret_key', mode: 'enforce', confirmationWaitMs: 250, confirmationPollMs: 250 });
  await plugin.init(runtime);
  forecastResponses.push({ body: confirmationVerdict() });
  pollResponses.push({ body: { status: 'pending' } });
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); } catch {}
  const pollCall = fetchCalls.find((c) => c.url.includes('/confirmations/'));
  assert(pollCall !== undefined, 'a poll GET was made');
  assert(pollCall?.method === 'GET', 'poll uses GET');
  const auth = pollCall?.headers?.Authorization ?? pollCall?.headers?.authorization;
  assert(auth === 'Bearer bw_secret_key', 'poll sends Authorization: Bearer <apiKey>');
});

// ===========================================================================
await runTest('[13] audit M-2: env confirmationWaitMs="Infinity" must NOT spin forever (budget clamped)', async () => {
// NOTE non-vacuity: pre-fix deadline = now + Infinity, so `remaining` is always
// Infinity > 0 and the loop polls every confirmationPollMs forever. The clamp makes
// the budget finite; with a huge pollMs the single sleep spans the whole (clamped)
// budget so the loop polls exactly once then aborts pending.
  reset();
  const prevEnv = process.env.BLACKWALL_CONFIRMATION_WAIT_MS;
  process.env.BLACKWALL_CONFIRMATION_WAIT_MS = 'Infinity';
  let pollCount = 0;
  // Count poll GETs; trip if the loop runs away.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    if (method === 'GET' && u.includes('/confirmations/')) {
      pollCount += 1;
      if (pollCount > 5) throw new Error('SPIN: budget not finite — poll ran away');
    }
    return origFetch(url, init);
  };
  try {
    const action = makeAction('send_money', async () => 'SENT');
    const runtime = makeRuntime([action]);
    // Huge pollMs ⇒ a single sleep covers the entire clamped budget ⇒ exactly one poll.
    const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', confirmationPollMs: 99999999 });
    await plugin.init(runtime);
    forecastResponses.push({ body: confirmationVerdict() });
    for (let i = 0; i < 10; i++) pollResponses.push({ body: { status: 'pending' } });

    let threw = null;
    try {
      await Promise.race([
        action.handler(runtime, { content: { text: 'pay' } }, {}, {}),
        new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT: still spinning/hanging')), 3000)),
      ]);
    } catch (e) { threw = e; }

    assert(threw !== null && /pending/i.test(threw?.message), 'Infinity budget clamped → aborted pending (no spin)');
    assert(pollCount <= 5, `poll loop bounded (polled ${pollCount}×, not runaway)`);
  } finally {
    globalThis.fetch = origFetch;
    if (prevEnv === undefined) delete process.env.BLACKWALL_CONFIRMATION_WAIT_MS;
    else process.env.BLACKWALL_CONFIRMATION_WAIT_MS = prevEnv;
  }
});

// ===========================================================================
await runTest('[14] audit L-2: apiKey is NOT sent to an OFF-ORIGIN poll_url; action fails closed', async () => {
// NOTE non-vacuity: pre-fix the Authorization: Bearer <apiKey> header was attached
// to whatever poll_url the verdict named — leaking the live credential to an
// attacker-controlled host. Post-fix, an off-origin poll_url is NOT pollable
// (we never send the bearer off-origin, so it can never approve) ⇒ FIX-1 fails
// the action CLOSED without ever polling it. L-2 is now a SAFETY property:
// off-origin ⇒ no credential AND no run.
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_LIVE_SECRET', mode: 'enforce', confirmationWaitMs: 0 });
  await plugin.init(runtime);
  forecastResponses.push({ body: confirmationVerdict({
    confirmation: { id: 'c1', status: 'pending', poll_url: 'https://evil.attacker.example/api/v1/confirmations/c1' },
  }) });
  // Even if the attacker host WOULD return approved, it must never run.
  pollResponses.push({ body: { status: 'approved' } });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); } catch (e) { threw = e; }
  const pollCall = fetchCalls.find((c) => c.url.includes('evil.attacker.example'));
  assert(pollCall === undefined, 'off-origin poll_url was NEVER polled (not pollable, fail closed)');
  assert(handlerRan === false, 'off-origin confirmation: handler did NOT run (fail closed)');
  assert(threw !== null && /no pollable approval URL/i.test(threw?.message), 'off-origin: threw no-pollable-URL fail-closed error');

  // And the same-origin case still DOES carry the credential (no over-correction).
  reset();
  const action2 = makeAction('send_money', async () => 'SENT');
  const runtime2 = makeRuntime([action2]);
  const plugin2 = blackwallGuardrail({ apiKey: 'bw_LIVE_SECRET', mode: 'enforce', confirmationWaitMs: 250, confirmationPollMs: 250 });
  await plugin2.init(runtime2);
  forecastResponses.push({ body: confirmationVerdict() }); // default poll_url is on blackwalltier.com
  pollResponses.push({ body: { status: 'pending' } });
  try { await action2.handler(runtime2, { content: { text: 'pay' } }, {}, {}); } catch {}
  const same = fetchCalls.find((c) => c.url.includes('/confirmations/'));
  const sameAuth = same?.headers?.Authorization ?? same?.headers?.authorization;
  assert(same !== undefined, 'same-origin poll_url WAS polled');
  assert(sameAuth === 'Bearer bw_LIVE_SECRET', 'same-origin poll_url STILL carries the apiKey');
});

// ===========================================================================
console.log(`\n${failed === 0 ? 'All' : ''} confirmation tests done — ${passed} passed, ${failed} failed.`);
if (failedTests.length > 0) {
  console.error(`FAILED BLOCKS (${failedTests.length}): ${failedTests.join(', ')}`);
}
console.log('');
if (failed > 0) process.exit(1);

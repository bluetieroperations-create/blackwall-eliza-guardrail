// Confirmation-aware tests for blackwall-eliza-guardrail (v0.3.0).
//
// Proves the SAFETY INVARIANT: in enforce mode, an action carrying a
// confirmation handle NEVER runs unless a poll returned status:'approved'.
//
// Mocks globalThis.fetch to script BOTH the forecast POST and the poll GET(s).
// Run with: node test-confirmation.mjs
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
function assert(cond, msg) {
  if (!cond) {
    console.error('  FAIL:', msg);
    failed += 1;
  } else {
    console.log('  ok —', msg);
    passed += 1;
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
console.log('\n[1] enforce + confirmation + wait=0 → handler NOT run; threw pending; message has poll_url');
// NOTE non-vacuity: if the confirmation branch were removed, the verdict (CAUTION,
// non-STOP) would fall through to "run + observe" and handlerRan would be true.
{
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
  assert(/pending/i.test(threw.message), 'error message mentions pending');
  assert(threw.message.includes('https://blackwalltier.com/api/v1/confirmations/conf_123'), 'error message contains the poll_url');
  assert(events.some((e) => e.type === 'confirmation_required'), 'confirmation_required event emitted');
  assert(events.some((e) => e.type === 'confirmation_pending'), 'confirmation_pending event emitted');
}

// ===========================================================================
console.log('\n[2] enforce + confirmation + wait>0 + poll approved (after 1 pending) → handler RAN; result returned');
// NOTE non-vacuity: if the loop never re-polled, the first pending poll would
// abort and handlerRan would be false. If "approved" were not honored, it would abort.
{
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
}

// ===========================================================================
console.log('\n[3] enforce + confirmation + poll rejected → handler NOT run; threw rejected');
// NOTE non-vacuity: drop the rejected branch and "rejected" would be treated as
// pending (still aborts) — but the distinct event/message proves we read status.
{
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
  assert(threw !== null && /REJECTED/i.test(threw.message), 'threw REJECTED error');
  assert(events.some((e) => e.type === 'confirmation_rejected'), 'confirmation_rejected event emitted');
}

// ===========================================================================
console.log('\n[4] enforce + confirmation + poll stays pending past budget → handler NOT run; threw pending');
// NOTE non-vacuity: if the wall-clock budget were not enforced, the loop would
// spin forever (test would hang/timeout) instead of aborting.
{
  reset();
  let handlerRan = false;
  const action = makeAction('send_money', async () => { handlerRan = true; return 'SENT'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({
    apiKey: 'bw_k', mode: 'enforce', confirmationWaitMs: 600, confirmationPollMs: 250,
    onEvent: (e) => events.push(e),
  });
  await plugin.init(runtime);

  forecastResponses.push({ body: confirmationVerdict() });
  // Always pending — keep plenty queued so we never run dry into a 500.
  for (let i = 0; i < 20; i++) pollResponses.push({ body: { status: 'pending' } });

  const t0 = Date.now();
  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run after budget elapsed');
  assert(threw !== null && /pending/i.test(threw.message), 'threw pending error');
  assert(elapsed < 5000, `aborted within a bounded time (${elapsed}ms) — budget enforced`);
  assert(events.some((e) => e.type === 'confirmation_pending'), 'confirmation_pending event emitted');
}

// ===========================================================================
console.log('\n[5] enforce + confirmation + poll throws/network-error → handler NOT run (fail-closed)');
// NOTE non-vacuity: if poll errors were not caught-and-failed-closed, either the
// error escapes uncaught OR (worse) a naive impl could run the action. Must abort.
{
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
  assert(threw !== null && /pending/i.test(threw.message), 'threw pending (fail-closed) error');
  assert(events.some((e) => e.type === 'confirmation_pending'), 'confirmation_pending event emitted');
}

// ===========================================================================
console.log('\n[5b] enforce + confirmation + poll non-2xx → fail-closed (abort)');
{
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
  assert(threw !== null && /pending/i.test(threw.message), 'threw pending on non-2xx');
}

// ===========================================================================
console.log('\n[5c] enforce + confirmation + poll 2xx with garbage/no status → treated as pending');
{
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
  assert(threw !== null && /pending/i.test(threw.message), 'threw pending for garbage body');
}

// ===========================================================================
console.log('\n[6] observe + confirmation → handler RAN; confirmation_required emitted; callback called');
// NOTE non-vacuity: observe must NEVER alter behavior. If observe blocked on the
// confirmation, handlerRan would be false — violating the observe contract.
{
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
}

// ===========================================================================
console.log('\n[7] enforce + hard_blocks non-empty (WITH confirmation present) → hard-stop, NOT confirmation path');
// NOTE non-vacuity: strictest-wins. If hard_blocks were not checked first, the
// confirmation path would run and (with wait=0) throw a "pending" error instead
// of a hard-stop — or worse, poll for approval on an action that must never run.
{
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
  assert(/blocked/i.test(threw.message), 'threw a hard-stop (blocked) error, not a confirmation error');
  assert(!/pending|confirmation/i.test(threw.message), 'did NOT take the confirmation path');
  assert(events.some((e) => e.type === 'stop'), 'stop event emitted (hard block)');
  assert(!events.some((e) => e.type === 'confirmation_required'), 'confirmation_required NOT emitted');
  assert(!fetchCalls.some((c) => c.url.includes('/confirmations/')), 'never polled');
}

// ===========================================================================
console.log('\n[8] enforce + legacy STOP (no confirmation) → handler NOT run (unchanged v0.2.1 behavior)');
{
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
  assert(threw !== null && /blocked/i.test(threw.message), 'legacy STOP throws blocked error');
}

// ===========================================================================
console.log('\n[9] enforce + GO (no confirmation) → handler RAN (unchanged v0.2.1 behavior)');
{
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
}

// ===========================================================================
console.log('\n[10] onConfirmationRequired that THROWS → does not break the wrap');
// NOTE non-vacuity: if the callback were not wrapped in try/catch, its throw would
// escape the wrap and the action would error out for the wrong reason.
{
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
  assert(threw2 !== null && /pending/i.test(threw2.message), 'enforce: threw the confirmation pending error, not the callback error');
}

// ===========================================================================
console.log('\n[11] gateCall() honors the same confirmation logic (enforce, wait=0 → step NOT run)');
// NOTE non-vacuity: proves the shared helper is wired into gateCall too, not just
// the action wrap. If gateCall ignored confirmation, stepRan would be true.
{
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
  assert(threw !== null && /pending/i.test(threw.message), 'gateCall: threw the confirmation pending error');
}

// ===========================================================================
console.log('\n[11b] gateCall() confirmation approved (enforce, wait>0) → step RAN');
{
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
}

// ===========================================================================
console.log('\n[12] poll sends Authorization: Bearer <apiKey>');
{
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
}

// ===========================================================================
console.log(`\n${failed === 0 ? 'All' : ''} confirmation tests done — ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);

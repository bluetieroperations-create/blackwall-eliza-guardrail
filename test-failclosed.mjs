// Fail-closed-on-gate-outage tests for blackwall-eliza-guardrail (v0.4.0).
//
// Pins the opt-in `failClosed` feature: in ENFORCE mode, when forecast() THROWS
// (gate down / network / timeout / verdict-less body), an action configured to
// fail closed must ABORT (throw) instead of running ungated. The DEFAULT
// (failClosed:false) preserves the v0.2.x/v0.3.x fail-OPEN availability doctrine
// — backward-compat.
//
// SCOPE INVARIANT: this can ONLY make enforce MORE restrictive on the
// forecast-ERROR path. It never changes the verdict paths (GO/STOP/confirmation),
// and observe mode is NEVER affected.
//
// Mocks globalThis.fetch so forecast() (POST /api/v1/forecast) throws/rejects.
// Run with: node test-failclosed.mjs
//
// HARNESS: each numbered block runs inside runTest(), which try/catches so a
// regression records a FAIL and CONTINUES — yields a per-test "N passed, M
// failed" map naming WHICH blocks broke, never a first-crash abort.
//
// Each test is mutation-noted: the NOTE comment says what removing the guard
// breaks.

import { blackwallGuardrail, gateCall } from './src/index.mjs';

// ---------------------------------------------------------------------------
// Scriptable fetch. Route by method + URL:
//   POST .../api/v1/forecast  -> shift from `forecastResponses`
//   PATCH / *outcome*         -> generic ok (observe)
//   else (GET poll)           -> shift from `pollResponses`
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

  if (method === 'PATCH' || String(url).includes('/outcome')) {
    return mkRes({ ok: true, status: 200, body: { ok: true } });
  }
  if (method === 'POST' && String(url).includes('/api/v1/forecast')) {
    const r = takeNext(forecastResponses, 'forecast');
    if (r.throw) throw r.throw;
    return mkRes(r);
  }
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
async function runTest(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (e) {
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

const OUTAGE = () => new TypeError('fetch failed: forecast endpoint down');

// ===========================================================================
// [1] enforce + failClosed:true + forecast throws → handler NOT run; threw
//     fail-closed error naming the action.
// MUTATION: remove the onForecastError fail-closed branch (revert to bare
// "run original") and handlerRan flips to TRUE — this test fails.
// ===========================================================================
await runTest('[1] enforce + failClosed:true + forecast throws → NOT run; threw fail-closed (names action)', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('PAY_NEW_PAYEE', async () => { handlerRan = true; return 'PAID'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: true, onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  forecastResponses.push({ throw: OUTAGE() });

  let threw = null;
  try { await action.handler(runtime, { content: { text: 'pay' } }, {}, {}); }
  catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === false, 'handler did NOT run (fail-closed on outage)');
  assert(threw !== null, 'wrapper threw');
  assert(/gate unavailable/i.test(threw?.message), 'error mentions gate unavailable');
  assert(/failing closed/i.test(threw?.message), 'error mentions failing closed');
  assert(threw?.message.includes('PAY_NEW_PAYEE'), 'error names the action');
  assert(events.some((e) => e.type === 'fail_closed' && e.actionName === 'PAY_NEW_PAYEE'), 'fail_closed event emitted');
  assert(!events.some((e) => e.type === 'forecast_error'), 'did NOT emit forecast_error (took the fail-closed branch)');
});

// ===========================================================================
// [2] enforce + failClosed:false (DEFAULT) + forecast throws → handler RAN.
// Backward-compat: fail-OPEN preserved.
// MUTATION: if failClosed defaulted to true (or the guard ignored the flag),
// handlerRan would be false — this test fails. Pins the default posture.
// ===========================================================================
await runTest('[2] enforce + failClosed:false (default) + forecast throws → RAN (fail-open preserved)', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('PAY_NEW_PAYEE', async () => { handlerRan = true; return 'PAID'; });
  const runtime = makeRuntime([action]);
  const events = [];
  // No failClosed passed at all → must default to false.
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  forecastResponses.push({ throw: OUTAGE() });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, 'handler RAN (fail-open default)');
  assert(result === 'PAID', 'returned handler result');
  assert(events.some((e) => e.type === 'forecast_error'), 'forecast_error event emitted (fail-open path)');
  assert(!events.some((e) => e.type === 'fail_closed'), 'no fail_closed event (default is fail-open)');
});

// ===========================================================================
// [3] enforce + failClosed:['PAY_NEW_PAYEE'] → listed action aborts, unlisted runs.
// MUTATION: drop the list→predicate normalization (treat array as truthy "all")
// and READ_DOC would also abort — the unlisted-runs assertion fails. Drop the
// list-membership check entirely (always false) and PAY_NEW_PAYEE would run —
// the listed-aborts assertion fails.
// ===========================================================================
await runTest('[3] enforce + failClosed:[list] → listed action NOT run; unlisted action RAN', async () => {
  // 3a — listed action: fail closed.
  reset();
  let payRan = false;
  const pay = makeAction('PAY_NEW_PAYEE', async () => { payRan = true; return 'PAID'; });
  const rtPay = makeRuntime([pay]);
  const pPay = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: ['PAY_NEW_PAYEE'] });
  await pPay.init(rtPay);
  forecastResponses.push({ throw: OUTAGE() });
  let threwPay = null;
  try { await pay.handler(rtPay, { content: { text: 'pay' } }, {}, {}); } catch (e) { threwPay = e; }
  assert(payRan === false, 'listed action (PAY_NEW_PAYEE): did NOT run');
  assert(threwPay !== null && /failing closed/i.test(threwPay?.message), 'listed action: threw fail-closed');

  // 3b — unlisted action: fail open (runs).
  reset();
  let readRan = false;
  const read = makeAction('READ_DOC', async () => { readRan = true; return 'DOC'; });
  const rtRead = makeRuntime([read]);
  const pRead = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: ['PAY_NEW_PAYEE'] });
  await pRead.init(rtRead);
  forecastResponses.push({ throw: OUTAGE() });
  const result = await read.handler(rtRead, { content: { text: 'read' } }, {}, {});
  assert(readRan === true, 'unlisted action (READ_DOC): RAN (fail-open)');
  assert(result === 'DOC', 'unlisted action: returned result');
});

// ===========================================================================
// [4] enforce + failClosed predicate (n)=>n.startsWith('PAY') → PAY_* aborts, others run.
// MUTATION: if the predicate weren't actually CALLED (e.g. coerced to boolean
// `!!fn` = true-for-all), READ_DOC would also abort. If it were ignored, PAY_X
// would run. Either way a branch of this test fails.
// ===========================================================================
await runTest('[4] enforce + failClosed:predicate → PAY_* aborts, others run', async () => {
  const pred = (n) => n.startsWith('PAY');

  // 4a — PAY_X aborts.
  reset();
  let payRan = false;
  const pay = makeAction('PAY_X', async () => { payRan = true; return 'PAID'; });
  const rtPay = makeRuntime([pay]);
  const pPay = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: pred });
  await pPay.init(rtPay);
  forecastResponses.push({ throw: OUTAGE() });
  let threwPay = null;
  try { await pay.handler(rtPay, { content: { text: 'pay' } }, {}, {}); } catch (e) { threwPay = e; }
  assert(payRan === false, 'PAY_X (predicate true): did NOT run');
  assert(threwPay !== null && /failing closed/i.test(threwPay?.message), 'PAY_X: threw fail-closed');

  // 4b — SEND_TWEET runs (predicate false).
  reset();
  let tweetRan = false;
  const tweet = makeAction('SEND_TWEET', async () => { tweetRan = true; return 'TWEETED'; });
  const rtTweet = makeRuntime([tweet]);
  const pTweet = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: pred });
  await pTweet.init(rtTweet);
  forecastResponses.push({ throw: OUTAGE() });
  const result = await tweet.handler(rtTweet, { content: { text: 'tweet' } }, {}, {});
  assert(tweetRan === true, 'SEND_TWEET (predicate false): RAN (fail-open)');
  assert(result === 'TWEETED', 'SEND_TWEET: returned result');
});

// ===========================================================================
// [5] observe + failClosed:true + forecast throws → handler RAN.
// observe NEVER aborts (contract). failClosed has NO effect in observe.
// MUTATION: if the fail-closed branch weren't gated behind mode==='enforce',
// observe would abort — violating the observe contract. handlerRan flips false.
// ===========================================================================
await runTest('[5] observe + failClosed:true + forecast throws → RAN (observe never aborts)', async () => {
  reset();
  let handlerRan = false;
  const action = makeAction('PAY_NEW_PAYEE', async () => { handlerRan = true; return 'PAID'; });
  const runtime = makeRuntime([action]);
  const events = [];
  const plugin = blackwallGuardrail({ apiKey: 'bw_k', mode: 'observe', failClosed: true, onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  forecastResponses.push({ throw: OUTAGE() });

  const result = await action.handler(runtime, { content: { text: 'pay' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, 'observe: handler RAN despite failClosed:true (contract unchanged)');
  assert(result === 'PAID', 'observe: returned handler result');
  assert(!events.some((e) => e.type === 'fail_closed'), 'observe: no fail_closed event');
  assert(events.some((e) => e.type === 'forecast_error'), 'observe: forecast_error event emitted (fail-open path)');
});

// ===========================================================================
// [6] env BLACKWALL_FAIL_CLOSED resolves: 'true' (all), 'PAY_A,PAY_B' (list),
//     and config OVERRIDES env.
// MUTATION: drop env parsing and the env-true case runs (fail-open). Drop the
// "config wins" precedence and the config:false-over-env:true case aborts.
// ===========================================================================
await runTest('[6] env BLACKWALL_FAIL_CLOSED true / list resolve; config overrides env', async () => {
  const prev = process.env.BLACKWALL_FAIL_CLOSED;
  try {
    // 6a — env 'true' → all actions fail closed.
    process.env.BLACKWALL_FAIL_CLOSED = 'true';
    reset();
    let ranA = false;
    const a = makeAction('ANYTHING', async () => { ranA = true; return 'X'; });
    const rtA = makeRuntime([a]);
    const pA = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce' });
    await pA.init(rtA);
    forecastResponses.push({ throw: OUTAGE() });
    let threwA = null;
    try { await a.handler(rtA, { content: { text: 'x' } }, {}, {}); } catch (e) { threwA = e; }
    assert(ranA === false, "env 'true': handler did NOT run");
    assert(threwA !== null && /failing closed/i.test(threwA?.message), "env 'true': threw fail-closed");

    // 6b — env list 'PAY_A,PAY_B' → PAY_A aborts, PAY_C runs.
    process.env.BLACKWALL_FAIL_CLOSED = 'PAY_A,PAY_B';
    reset();
    let ranPayA = false;
    const payA = makeAction('PAY_A', async () => { ranPayA = true; return 'A'; });
    const rtPayA = makeRuntime([payA]);
    const pPayA = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce' });
    await pPayA.init(rtPayA);
    forecastResponses.push({ throw: OUTAGE() });
    let threwPayA = null;
    try { await payA.handler(rtPayA, { content: { text: 'x' } }, {}, {}); } catch (e) { threwPayA = e; }
    assert(ranPayA === false, "env list: PAY_A (listed) did NOT run");
    assert(threwPayA !== null && /failing closed/i.test(threwPayA?.message), 'env list: PAY_A threw fail-closed');

    reset();
    let ranPayC = false;
    const payC = makeAction('PAY_C', async () => { ranPayC = true; return 'C'; });
    const rtPayC = makeRuntime([payC]);
    const pPayC = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce' });
    await pPayC.init(rtPayC);
    forecastResponses.push({ throw: OUTAGE() });
    const resC = await payC.handler(rtPayC, { content: { text: 'x' } }, {}, {});
    assert(ranPayC === true, 'env list: PAY_C (unlisted) RAN (fail-open)');
    assert(resC === 'C', 'env list: PAY_C returned result');

    // 6c — config:false OVERRIDES env:'true' (config wins).
    process.env.BLACKWALL_FAIL_CLOSED = 'true';
    reset();
    let ranOverride = false;
    const ov = makeAction('PAY_OVERRIDE', async () => { ranOverride = true; return 'OV'; });
    const rtOv = makeRuntime([ov]);
    const pOv = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: false });
    await pOv.init(rtOv);
    forecastResponses.push({ throw: OUTAGE() });
    const resOv = await ov.handler(rtOv, { content: { text: 'x' } }, {}, {});
    assert(ranOverride === true, 'config:false over env:true → handler RAN (config wins)');
    assert(resOv === 'OV', 'config-wins: returned result');
  } finally {
    if (prev === undefined) delete process.env.BLACKWALL_FAIL_CLOSED;
    else process.env.BLACKWALL_FAIL_CLOSED = prev;
  }
});

// ===========================================================================
// [7] gateCall() honors failClosed (enforce + failClosed + forecast throws →
//     step NOT run).
// MUTATION: if onForecastError weren't wired into gateCall's catch, the step
// would run (the bare `return run()` fail-open) — stepRan flips true.
// ===========================================================================
await runTest('[7] gateCall() honors failClosed (enforce + forecast throws → step NOT run)', async () => {
  reset();
  let stepRan = false;
  // Queue the throw BEFORE the call (mock shifts synchronously).
  forecastResponses.push({ throw: OUTAGE() });
  const p = gateCall(
    'transfer',
    { to: '0xabc', amount_usd: 5000 },
    async () => { stepRan = true; return 'sent'; },
    { apiKey: 'bw_k', mode: 'enforce', failClosed: true }
  );
  let threw = null;
  try { await p; } catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 10));

  assert(stepRan === false, 'gateCall: step did NOT run (fail-closed on outage)');
  assert(threw !== null && /failing closed/i.test(threw?.message), 'gateCall: threw fail-closed error');
  assert(threw?.message.includes('transfer'), 'gateCall: error names the step');

  // And the default (failClosed omitted) still fails OPEN in gateCall.
  reset();
  let stepRan2 = false;
  forecastResponses.push({ throw: OUTAGE() });
  const r2 = await gateCall(
    'transfer',
    { to: '0xabc', amount_usd: 5000 },
    async () => { stepRan2 = true; return 'sent'; },
    { apiKey: 'bw_k', mode: 'enforce' }
  );
  assert(stepRan2 === true, 'gateCall default: step RAN (fail-open preserved)');
  assert(r2 === 'sent', 'gateCall default: returned step result');
});

// ===========================================================================
// [8] Regression: failClosed ONLY changes the forecast-ERROR path. A successful
//     verdict is unaffected — GO runs, STOP aborts, confirmation still polls.
// MUTATION: if failClosed leaked into the verdict path, the GO action would
// abort (false) instead of running — this test fails.
// ===========================================================================
await runTest('[8] regression: failClosed:true does NOT change verdict paths (GO runs, STOP aborts, confirmation polls)', async () => {
  // 8a — GO verdict still RUNS even with failClosed:true.
  reset();
  let goRan = false;
  const go = makeAction('POST_TWEET', async () => { goRan = true; return 'posted'; });
  const rtGo = makeRuntime([go]);
  const pGo = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: true });
  await pGo.init(rtGo);
  forecastResponses.push({ body: { id: 'fc_go', recommendation: 'GO', risk_score: 5 } });
  const resGo = await go.handler(rtGo, { content: { text: 'tweet' } }, {}, {});
  assert(goRan === true, 'GO + failClosed:true → handler STILL RAN (verdict path unaffected)');
  assert(resGo === 'posted', 'GO: returned result');

  // 8b — STOP verdict still ABORTS (unchanged), and NOT via the fail-closed error.
  reset();
  let stopRan = false;
  const events = [];
  const stop = makeAction('DELETE_DB', async () => { stopRan = true; });
  const rtStop = makeRuntime([stop]);
  const pStop = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: true, onEvent: (e) => events.push(e) });
  await pStop.init(rtStop);
  forecastResponses.push({ body: { id: 'fc_s', recommendation: 'STOP', risk_score: 95, red_flags: [{ code: 'X' }] } });
  let threwStop = null;
  try { await stop.handler(rtStop, { content: { text: 'drop' } }, {}, {}); } catch (e) { threwStop = e; }
  await new Promise((r) => setTimeout(r, 10));
  assert(stopRan === false, 'STOP + failClosed:true → handler did NOT run (unchanged)');
  assert(threwStop !== null && /blocked/i.test(threwStop?.message), 'STOP threw the normal blocked error (NOT the fail-closed error)');
  assert(!/failing closed|gate unavailable/i.test(threwStop?.message), 'STOP did NOT use the fail-closed message');
  assert(!events.some((e) => e.type === 'fail_closed'), 'STOP path emitted no fail_closed event');
  assert(events.some((e) => e.type === 'stop'), 'STOP path emitted the normal stop event');

  // 8c — confirmation verdict still POLLS (and with wait=0 aborts pending), NOT fail-closed.
  reset();
  let confRan = false;
  const confEvents = [];
  const conf = makeAction('SEND_MONEY', async () => { confRan = true; return 'SENT'; });
  const rtConf = makeRuntime([conf]);
  const pConf = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: true, onEvent: (e) => confEvents.push(e) });
  await pConf.init(rtConf);
  forecastResponses.push({ body: {
    id: 'fc_conf', recommendation: 'CAUTION', risk_score: 60, hard_blocks: [],
    confirmation: { id: 'c1', status: 'pending', poll_url: 'https://blackwalltier.com/api/v1/confirmations/c1' },
  } });
  pollResponses.push({ body: { status: 'pending' } });
  let threwConf = null;
  try { await conf.handler(rtConf, { content: { text: 'pay' } }, {}, {}); } catch (e) { threwConf = e; }
  await new Promise((r) => setTimeout(r, 10));
  assert(confRan === false, 'confirmation + failClosed:true → handler did NOT run (pending, unchanged)');
  assert(threwConf !== null && /pending/i.test(threwConf?.message), 'confirmation threw the normal pending error (NOT fail-closed)');
  assert(!/failing closed|gate unavailable/i.test(threwConf?.message), 'confirmation did NOT use the fail-closed message');
  assert(confEvents.some((e) => e.type === 'confirmation_required'), 'confirmation path emitted confirmation_required');
  assert(!confEvents.some((e) => e.type === 'fail_closed'), 'confirmation path emitted no fail_closed event');
});

// ===========================================================================
// [9] verdict-LESS body (2xx but missing recommendation/risk_score) makes
//     blackwall-mcp forecast() THROW → it is on the SAME fail-closed path as a
//     network outage. enforce + failClosed:true → abort; default → run.
// MUTATION: this proves the "verdict-less body" trigger documented for failClosed
// is real — forecast() validation throws on it, and onForecastError owns it.
// (If forecast() ever stopped validating, this would fall through to the verdict
// path; the assertion on the fail-closed message would then catch the drift.)
// ===========================================================================
await runTest('[9] enforce + failClosed:true + 2xx verdict-LESS body → forecast throws → fail-closed abort', async () => {
  // 9a — fail closed.
  reset();
  let ran = false;
  const a = makeAction('PAY_NEW_PAYEE', async () => { ran = true; return 'PAID'; });
  const rt = makeRuntime([a]);
  const p = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce', failClosed: true });
  await p.init(rt);
  forecastResponses.push({ body: { id: 'fc_empty' } }); // 2xx but no recommendation/risk_score
  let threw = null;
  try { await a.handler(rt, { content: { text: 'pay' } }, {}, {}); } catch (e) { threw = e; }
  assert(ran === false, 'verdict-less body: handler did NOT run (fail closed)');
  assert(threw !== null && /failing closed/i.test(threw?.message), 'verdict-less body: threw fail-closed');

  // 9b — default fails open on the same verdict-less body.
  reset();
  let ran2 = false;
  const a2 = makeAction('PAY_NEW_PAYEE', async () => { ran2 = true; return 'PAID'; });
  const rt2 = makeRuntime([a2]);
  const p2 = blackwallGuardrail({ apiKey: 'bw_k', mode: 'enforce' });
  await p2.init(rt2);
  forecastResponses.push({ body: { id: 'fc_empty' } });
  const result = await a2.handler(rt2, { content: { text: 'pay' } }, {}, {});
  assert(ran2 === true, 'verdict-less body + default: handler RAN (fail-open)');
  assert(result === 'PAID', 'default: returned result');
});

// ===========================================================================
console.log(`\n${failed === 0 ? 'All ' : ''}fail-closed tests done — ${passed} passed, ${failed} failed.`);
if (failedTests.length > 0) {
  console.error(`FAILED BLOCKS (${failedTests.length}): ${failedTests.join(', ')}`);
}
console.log('');
if (failed > 0) process.exit(1);

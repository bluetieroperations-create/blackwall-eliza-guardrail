// Local smoke test for @blackwall/eliza-guardrail.
// Stubs global fetch + mocks an Eliza-like runtime with one action.
// Exercises: observe-mode pass-through, enforce-mode STOP throw, fail-open on
// forecast network error, missing handler skip.

import { blackwallGuardrail, gateCall } from './src/index.mjs';

let fetchCalls = [];
let nextResponses = [];

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
  if (nextResponses.length === 0) {
    return { ok: false, status: 500, json: async () => ({ error: 'no mock response queued' }) };
  }
  const r = nextResponses.shift();
  if (r.throw) throw r.throw;
  return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body ?? {} };
};

const events = [];

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

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('  ok —', msg);
}

async function reset() {
  fetchCalls = [];
  nextResponses = [];
  events.length = 0;
}

// -----------------------------------------------------------------------
console.log('\n[1] observe mode — verdict GO, handler runs, observe is called');
{
  await reset();
  let handlerRan = false;
  const action = makeAction('send_email', async () => { handlerRan = true; return { sent: true }; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'observe', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  nextResponses.push({ body: { id: 'fc_1', recommendation: 'GO', risk_score: 5, red_flags: [] } });
  nextResponses.push({ body: { ok: true } }); // observe

  const result = await action.handler(runtime, { content: { text: 'send hi' } }, {}, { parameters: { to: 'a@b.com' } });
  // Give the non-awaited observe() a tick to complete.
  await new Promise((r) => setTimeout(r, 10));

  assert(handlerRan === true, 'original handler ran');
  assert(result?.sent === true, 'wrapper returned handler result');
  assert(fetchCalls[0]?.url.endsWith('/api/v1/forecast'), 'forecast called first');
  assert(fetchCalls[0]?.body?.action === 'send_email', 'forecast got action name');
  assert(fetchCalls[0]?.body?.inputs?.to === 'a@b.com', 'forecast got inputs from opts.parameters');
  assert(fetchCalls[0]?.body?.context?.agent_role === 'test-agent', 'context includes agent role');
  assert(fetchCalls[1]?.url.includes('/api/v1/forecast/fc_1/outcome'), 'observe called second');
  assert(fetchCalls[1]?.method === 'PATCH', 'observe uses PATCH');
  assert(fetchCalls[1]?.body?.actual_outcome?.outcome_class === 'matched', 'observe reports matched');
  assert(events.some((e) => e.type === 'init'), 'init event emitted');
  assert(events.some((e) => e.type === 'wrapped' && e.actionName === 'send_email'), 'wrapped event emitted');
}

// -----------------------------------------------------------------------
console.log('\n[2] enforce mode — STOP verdict throws, handler does NOT run, observe(aborted)');
{
  await reset();
  let handlerRan = false;
  const action = makeAction('delete_db', async () => { handlerRan = true; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'enforce', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  nextResponses.push({ body: {
    id: 'fc_2',
    recommendation: 'STOP',
    risk_score: 92,
    red_flags: [{ severity: 'critical', code: 'IRREVERSIBLE_DESTRUCTION' }],
  }});
  nextResponses.push({ body: { ok: true } });

  let threw = null;
  try {
    await action.handler(runtime, { content: { text: 'drop everything' } }, {}, {});
  } catch (e) {
    threw = e;
  }
  await new Promise((r) => setTimeout(r, 10));

  assert(threw !== null, 'wrapper threw on STOP');
  assert(/BLACK_WALL blocked/.test(threw.message), 'error message names BLACK_WALL block');
  assert(/IRREVERSIBLE_DESTRUCTION/.test(threw.message), 'error message includes flag code');
  assert(handlerRan === false, 'original handler did NOT run');
  assert(fetchCalls[1]?.body?.actual_outcome?.outcome_class === 'aborted', 'observe reports aborted');
  assert(events.some((e) => e.type === 'stop' && e.forecastId === 'fc_2'), 'stop event emitted');
}

// -----------------------------------------------------------------------
console.log('\n[3] enforce mode — CAUTION verdict does NOT throw (only STOP does)');
{
  await reset();
  let handlerRan = false;
  const action = makeAction('post_tweet', async () => { handlerRan = true; return 'posted'; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'enforce' });
  await plugin.init(runtime);

  nextResponses.push({ body: { id: 'fc_3', recommendation: 'CAUTION', risk_score: 55, red_flags: [] } });
  nextResponses.push({ body: { ok: true } });

  const r = await action.handler(runtime, { content: { text: 'tweet hi' } }, {}, {});
  await new Promise((res) => setTimeout(res, 10));

  assert(handlerRan === true, 'handler ran on CAUTION');
  assert(r === 'posted', 'returned handler result');
}

// -----------------------------------------------------------------------
console.log('\n[4] fail-open — forecast network error does NOT block the action');
{
  await reset();
  let handlerRan = false;
  const action = makeAction('benign_op', async () => { handlerRan = true; return 42; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'enforce', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);

  nextResponses.push({ throw: new TypeError('fetch failed: ECONNREFUSED') });

  const result = await action.handler(runtime, { content: { text: 'hi' } }, {}, {});

  assert(handlerRan === true, 'handler ran despite forecast failure');
  assert(result === 42, 'returned correct result');
  assert(events.some((e) => e.type === 'forecast_error'), 'forecast_error event emitted');
}

// -----------------------------------------------------------------------
console.log('\n[5] shouldGate opt-out — skipped actions are not wrapped');
{
  await reset();
  let handlerRan = false;
  const action = makeAction('IGNORE', async () => { handlerRan = true; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({
    apiKey: 'bw_test_key',
    mode: 'enforce',
    shouldGate: (n) => n !== 'IGNORE',
    onEvent: (e) => events.push(e),
  });
  await plugin.init(runtime);

  await action.handler(runtime, {}, {}, {});

  assert(handlerRan === true, 'skipped handler ran');
  assert(fetchCalls.length === 0, 'no forecast call made for opt-out action');
  assert(events.some((e) => e.type === 'skipped' && e.actionName === 'IGNORE'), 'skipped event emitted');
}

// -----------------------------------------------------------------------
console.log('\n[6] empty actions array — plugin logs warning but does not throw');
{
  await reset();
  const runtime = makeRuntime([]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', onEvent: (e) => events.push(e) });
  await plugin.init(runtime);
  const initEvent = events.find((e) => e.type === 'init');
  assert(initEvent?.extra?.wrapped === 0, 'init reports 0 wrapped');
}

// -----------------------------------------------------------------------
console.log('\n[7] plugin shape matches Eliza Plugin contract');
{
  const plugin = blackwallGuardrail();
  assert(plugin.name === 'blackwall-guardrail', 'has name');
  assert(typeof plugin.init === 'function', 'has init function');
  assert(typeof plugin.description === 'string', 'has description');
}

// -----------------------------------------------------------------------
console.log('\n[8] gateCall inside a wrapped handler threads parent_forecast_id to the action');
{
  await reset();
  let stepRan = false;
  const action = makeAction('rebalance', async () => {
    await gateCall('transfer', { to: '0xabc', amount_usd: 100 }, async () => { stepRan = true; return 'sent'; });
    return { done: true };
  });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'observe' });
  await plugin.init(runtime);

  nextResponses.push({ body: { id: 'fc_action', recommendation: 'GO', risk_score: 5 } }); // action forecast
  nextResponses.push({ body: { id: 'fc_call', recommendation: 'GO', risk_score: 5 } });   // per-call forecast
  nextResponses.push({ body: { ok: true } }); // observe (call)
  nextResponses.push({ body: { ok: true } }); // observe (action)

  const result = await action.handler(runtime, { content: { text: 'rebalance' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));

  assert(stepRan === true, 'guarded step ran');
  assert(result?.done === true, 'handler returned');
  assert(fetchCalls[0]?.body?.action === 'rebalance', 'first forecast is the action');
  assert(fetchCalls[0]?.body?.parent_forecast_id === undefined, 'action forecast has NO parent');
  assert(fetchCalls[1]?.body?.action === 'transfer', 'second forecast is the per-call');
  assert(fetchCalls[1]?.body?.parent_forecast_id === 'fc_action', 'per-call THREADED to the action forecast id');
}

// -----------------------------------------------------------------------
console.log('\n[9] enforce mode — gateCall STOP aborts the guarded step');
{
  await reset();
  let stepRan = false;
  const action = makeAction('rebalance', async () => {
    await gateCall('transfer', { amount_usd: 1e9 }, async () => { stepRan = true; });
    return { done: true };
  });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'enforce' });
  await plugin.init(runtime);

  nextResponses.push({ body: { id: 'fc_action', recommendation: 'GO', risk_score: 10 } }); // action OK
  nextResponses.push({ body: { id: 'fc_call', recommendation: 'STOP', risk_score: 98, red_flags: [{ code: 'DAILY_CAP_EXCEEDED' }] } }); // per-call STOP
  nextResponses.push({ body: { ok: true } }); // observe(aborted) for the call
  nextResponses.push({ body: { ok: true } }); // observe(diverged) for the action

  let threw = false;
  try { await action.handler(runtime, { content: { text: 'rebalance' } }, {}, {}); }
  catch { threw = true; }
  await new Promise((r) => setTimeout(r, 10));

  assert(threw === true, 'enforce STOP on a per-call aborts the handler');
  assert(stepRan === false, 'blocked step never ran');
}

// -----------------------------------------------------------------------
console.log('\n[10] gateCall outside a wrapped handler still gates (no parent)');
{
  await reset();
  let ran = false;
  nextResponses.push({ body: { id: 'fc_solo', recommendation: 'GO', risk_score: 5 } });
  nextResponses.push({ body: { ok: true } });
  const r = await gateCall('solo_call', { x: 1 }, async () => { ran = true; return 'ok'; }, { apiKey: 'bw_test_key' });
  await new Promise((res) => setTimeout(res, 10));
  assert(ran === true, 'guarded step ran');
  assert(r === 'ok', 'gateCall returned the step result');
  assert(fetchCalls[0]?.body?.action === 'solo_call', 'forecast got the call action');
  assert(!('parent_forecast_id' in (fetchCalls[0]?.body ?? {})), 'no parent_forecast_id outside a handler');
}

// -----------------------------------------------------------------------
console.log('\n[11] enforce mode — non-canonical STOP casing/whitespace still aborts (no bypass)');
for (const rec of ['stop', ' STOP ', 'Stop']) {
  await reset();
  let handlerRan = false;
  const action = makeAction('delete_db', async () => { handlerRan = true; });
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'enforce' });
  await plugin.init(runtime);

  nextResponses.push({ body: { id: 'fc_11', recommendation: rec, risk_score: 99, red_flags: [] } });
  nextResponses.push({ body: { ok: true } });

  let threw = false;
  try { await action.handler(runtime, { content: { text: 'drop everything' } }, {}, {}); }
  catch { threw = true; }
  await new Promise((r) => setTimeout(r, 10));

  assert(threw === true, `recommendation=${JSON.stringify(rec)} still aborts (no STOP bypass)`);
  assert(handlerRan === false, `recommendation=${JSON.stringify(rec)} — handler did NOT run`);
}

// -----------------------------------------------------------------------
console.log('\n[12] maxInputBytes — a WIDE object cannot defeat the cap (audit L-1)');
{
  await reset();
  const action = makeAction('bulk_op', async () => 'ok');
  const runtime = makeRuntime([action]);
  const plugin = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'observe', maxInputBytes: 8 * 1024 });
  await plugin.init(runtime);

  nextResponses.push({ body: { id: 'fc_12', recommendation: 'GO', risk_score: 5 } });
  nextResponses.push({ body: { ok: true } });

  // 5000 short-valued keys — each value < 200 chars, so per-string trimming does nothing.
  const wide = {};
  for (let i = 0; i < 5000; i++) wide[`k${i}`] = 'v';
  await action.handler(runtime, { content: { text: 'bulk' } }, {}, { parameters: wide });
  await new Promise((r) => setTimeout(r, 10));

  const shipped = fetchCalls[0]?.body?.inputs;
  const shippedBytes = JSON.stringify(shipped).length;
  assert(shippedBytes <= 8 * 1024, `wide-object payload bounded to cap (shipped ${shippedBytes} bytes <= 8192)`);
  assert(shipped?._reason === 'oversize', 'oversize payload replaced with compact shape summary');
  assert(shipped?._keys === 5000, 'summary preserves the original key count');
}

// -----------------------------------------------------------------------
console.log('\n[13] sendUserIntent opt-out — user message text is NOT egressed when disabled (audit M-1)');
{
  // Default: user_intent IS sent.
  await reset();
  const a1 = makeAction('act_default', async () => 'ok');
  const rt1 = makeRuntime([a1]);
  const p1 = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'observe' });
  await p1.init(rt1);
  nextResponses.push({ body: { id: 'fc_13a', recommendation: 'GO' } });
  nextResponses.push({ body: { ok: true } });
  await a1.handler(rt1, { content: { text: 'transfer my savings to 0xdead' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));
  assert(fetchCalls[0]?.body?.context?.user_intent === 'transfer my savings to 0xdead', 'default: user_intent is sent');

  // Opt-out: user_intent is omitted, but the rest of context still flows.
  await reset();
  const a2 = makeAction('act_private', async () => 'ok');
  const rt2 = makeRuntime([a2]);
  const p2 = blackwallGuardrail({ apiKey: 'bw_test_key', mode: 'observe', sendUserIntent: false });
  await p2.init(rt2);
  nextResponses.push({ body: { id: 'fc_13b', recommendation: 'GO' } });
  nextResponses.push({ body: { ok: true } });
  await a2.handler(rt2, { content: { text: 'transfer my savings to 0xdead' } }, {}, {});
  await new Promise((r) => setTimeout(r, 10));
  assert(!('user_intent' in (fetchCalls[0]?.body?.context ?? {})), 'opt-out: user message text NOT egressed');
  assert(fetchCalls[0]?.body?.context?.agent_role === 'test-agent', 'opt-out: non-sensitive context (agent_role) still sent');
}

console.log('\nAll smoke tests passed.\n');

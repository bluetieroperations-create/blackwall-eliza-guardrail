// Local smoke test for @blackwall/eliza-guardrail.
// Stubs global fetch + mocks an Eliza-like runtime with one action.
// Exercises: observe-mode pass-through, enforce-mode STOP throw, fail-open on
// forecast network error, missing handler skip.

import { blackwallGuardrail } from './src/index.mjs';

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

console.log('\nAll smoke tests passed.\n');

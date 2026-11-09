import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportTotal, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseWraps, counterDeltas, analyzeCounter, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/model.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-counter-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later intervals; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '1'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a count', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '1'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.totalExport, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across intervals', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '1'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).totalExport, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '1');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '1'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '1'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '1');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '1'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).totalExport, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const oneInterval = (from = 90, to = 10, modulus = 100) => ({ ...simple(), modulus, readings: [
  { at: '2026-11-09T09:00:00.000Z', value: from }, { at: '2026-11-09T09:00:10.000Z', value: to },
] });
const answers = (input, texts) => tasksFor(input).map((row, index) => ({ intervalId: row.id, text: texts[index] }));

test('independent stepwise increment simulation reconstructs every bounded wrap outcome', () => {
  let cases = 0;
  for (let modulus = 2; modulus <= 12; modulus++) for (let start = 0; start < modulus; start++) {
    let value = start, crossings = 0;
    for (let increments = 0; crossings <= 3; increments++) {
      const result = analyzeCounter(oneInterval(start, value, modulus), { 'interval-1': crossings });
      assert.equal(result.exactTotal, String(increments));
      assert.deepEqual(result.intervals[0].ratePerSecond, { numerator: String(increments * 1000), denominator: '10000', unit: 'cards/second' });
      assert.equal(result.coverage.complete, true); cases++;
      value++; if (value === modulus) { value = 0; crossings++; }
    }
  }
  assert.equal(cases, 2310);
});

test('decreases require documented wraps; increasing and identical values can include full wraps', () => {
  assert.equal(analyzeCounter(oneInterval(), { 'interval-1': 1 }).exactTotal, '20');
  const bad = analyzeCounter(oneInterval(), { 'interval-1': 0 });
  assert.equal(bad.status, 'inconsistent'); assert.equal(bad.intervals[0].signedComputedDelta, '-80');
  assert.equal(bad.intervals[0].delta, null); assert.equal(bad.intervals[0].ratePerSecond, null); assert.equal(bad.exactTotal, null); assert.equal(bad.knownSubtotal, '0');
  assert.equal(analyzeCounter(oneInterval(10, 40), { 'interval-1': 2 }).exactTotal, '230');
  assert.equal(analyzeCounter(oneInterval(10, 10), { 'interval-1': 3 }).exactTotal, '300');
  assert.equal(analyzeCounter(oneInterval(10, 10), { 'interval-1': 0 }).exactTotal, '0');
});

test('multi-interval totals and rates remain exact decimal strings with explicit coverage', () => {
  const a = analyzeCounter(simple(), { 'interval-1': 1, 'interval-2': 0, 'interval-3': 2 });
  assert.deepEqual(a.intervals.map(row => row.delta), ['20', '25', '205']); assert.equal(a.exactTotal, '250'); assert.equal(a.knownSubtotal, '250');
  assert.deepEqual(a.exactRatePerSecond, { numerator: '250000', denominator: '30000', unit: 'cards/second' });
  assert.deepEqual(a.coverage, { includedIntervalIds: ['interval-1', 'interval-2', 'interval-3'], resetIntervalIds: [], inconsistentIntervalIds: [], includedIntervalCount: 3, totalIntervalCount: 3, coveredElapsedMs: '30000', totalElapsedMs: '30000', complete: true });
  assert.equal(a.analysisHash, hash(Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'analysisHash'))));
});

test('Reset is a known discontinuity with no inferred usage or rate; subtotal excludes its interval', () => {
  const a = analyzeCounter(simple(), { 'interval-1': 1, 'interval-2': 'Reset', 'interval-3': 2 });
  assert.equal(a.status, 'has_discontinuities'); assert.equal(a.knownSubtotal, '225'); assert.equal(a.exactTotal, null); assert.equal(a.exactRatePerSecond, null);
  assert.deepEqual(a.coverage.includedIntervalIds, ['interval-1', 'interval-3']); assert.deepEqual(a.coverage.resetIntervalIds, ['interval-2']); assert.equal(a.coverage.coveredElapsedMs, '20000'); assert.equal(a.coverage.totalElapsedMs, '30000');
  assert.equal(a.intervals[1].delta, null); assert.equal(a.intervals[1].signedComputedDelta, null); assert.equal(a.intervals[1].ratePerSecond, null); assert.equal(a.resetUsageInferred, false);
  const none = analyzeCounter(simple(), { 'interval-1': 'Reset', 'interval-2': 'Reset', 'interval-3': 'Reset' });
  assert.equal(none.knownSubtotal, '0'); assert.equal(none.coverage.includedIntervalCount, 0); assert.equal(none.coverage.coveredElapsedMs, '0'); assert.equal(none.exactTotal, null);
});

test('contradictions and resets both remain visible in complete evidence', () => {
  const result = counterDeltas(simple(), answers(simple(), ['0', 'Reset', '2']));
  assert.equal(result.status, 'complete'); assert.equal(result.analysis.status, 'inconsistent'); assert.equal(result.analysis.knownSubtotal, '205');
  assert.deepEqual(result.analysis.coverage.inconsistentIntervalIds, ['interval-1']); assert.deepEqual(result.analysis.coverage.resetIntervalIds, ['interval-2']);
  assert.equal(result.analysis.exactTotal, null);
});

test('Unknown and missing evidence withhold the entire analysis, including apparently valid intervals', () => {
  for (const unknown of ['Unknown', null]) for (let position = 0; position < 3; position++) {
    const texts = ['1', '0', '2']; texts[position] = unknown;
    assert.deepEqual(counterDeltas(simple(), answers(simple(), texts)), { status: 'incomplete', analysis: null });
  }
  for (const text of ['', '4', '-1', '+1', '01', '1.0', '1e0', ' 1', '1 ', '1\n', 'Reset\n', 'reset', 'unknown', '１', '1\u200b']) assert.throws(() => parseWraps(text));
  for (const text of ['0', '1', '2', '3']) assert.deepEqual(parseWraps(text), { kind: 'wraps', wraps: Number(text) });
  assert.deepEqual(parseWraps('Reset'), { kind: 'reset', wraps: null }); assert.deepEqual(parseWraps('Unknown'), { kind: 'unknown', wraps: null });
});

test('timestamps normalize only millisecond precision UTC and preserve strict input chronology', () => {
  const input = oneInterval(); input.readings = [{ at: '2024-02-29T23:59:59.999+00:00', value: 1 }, { at: '2024-03-01T00:00:00Z', value: 2 }];
  assert.equal(validateInput(input).readings[0].at, '2024-02-29T23:59:59.999Z');
  assert.deepEqual(analyzeCounter(input, { 'interval-1': 0 }).exactRatePerSecond, { numerator: '1000', denominator: '1', unit: 'cards/second' });
  const equivalent = structuredClone(input); equivalent.readings[1].at = '2024-03-01T00:00:00.000+00:00'; assert.equal(hash(validateInput(input)), hash(validateInput(equivalent)));
  for (const invalid of ['2023-02-29T00:00:00Z', '2024-03-01T00:00:00.0001Z', '2024-03-01T00:00:00.0000Z', '2024-03-01T00:00:00+04:00', '2024-03-01', '2024-03-01T00:00:00Z\n', '2024-03-01T00:00:60Z']) {
    const bad = oneInterval(); bad.readings[0].at = invalid; assert.throws(() => validateInput(bad), invalid);
  }
  for (const later of ['2026-11-09T09:00:00Z', '2026-11-09T08:59:59.999Z']) { const bad = oneInterval(); bad.readings[1].at = later; assert.throws(() => validateInput(bad), /strictly increasing/); }
  const reversed = simple(); reversed.readings.reverse(); assert.throws(() => validateInput(reversed), /strictly increasing/);
});

test('fractional UTC seconds, year boundaries, long spans and maximum totals retain exact arithmetic', () => {
  const input = oneInterval(0, 1); input.readings[0].at = '2026-12-31T23:59:59.9Z'; input.readings[1].at = '2027-01-01T00:00:00.001Z';
  assert.equal(analyzeCounter(input, { 'interval-1': 0 }).intervals[0].elapsedMs, '101');
  input.readings[0].at = '0000-01-01T00:00:00Z'; input.readings[1].at = '9999-12-31T23:59:59.999Z';
  const elapsed = (BigInt(Date.parse(input.readings[1].at)) - BigInt(Date.parse(input.readings[0].at))).toString();
  assert.equal(analyzeCounter(input, { 'interval-1': 3 }).exactRatePerSecond.denominator, elapsed);
  const max = { ...simple(), modulus: 1000000000, readings: Array.from({ length: 8 }, (_, i) => ({ at: `2026-11-09T09:00:0${i}.000Z`, value: 999999999 })) };
  const result = analyzeCounter(max, Object.fromEntries(tasksFor(max).map(row => [row.id, 3])));
  assert.equal(result.exactTotal, '21000000000'); assert.equal(result.exactRatePerSecond.numerator, '21000000000000');
});

test('exact schemas, integer bounds, Unicode safety and sparse arrays reject ambiguous inputs', () => {
  for (const mutate of [
    x => { x.extra = true; }, x => { x.counterId = 'x\n'; }, x => { x.counterId = 'a'.repeat(33); }, x => { x.context = 'x\u2028y'; }, x => { x.meaning = '\ud800'; }, x => { x.unit = ' cards'; },
    x => { x.modulus = 1; }, x => { x.modulus = 1000000001; }, x => { x.modulus = 2.1; }, x => { x.modulus = -0; },
    x => { x.readings[0].value = -0; }, x => { x.readings[0].value = x.modulus; }, x => { x.readings[0].value = 1.1; }, x => { x.readings[0].extra = 1; }, x => { delete x.readings[0]; },
    x => { x.readings = x.readings.slice(0, 1); }, x => { x.readings = Array(9).fill(x.readings[0]); },
  ]) { const input = simple(); mutate(input); assert.throws(() => validateInput(input)); }
  for (const events of [{}, { 'interval-1': 1, extra: 0 }, { 'interval-1': -0 }, { 'interval-1': 4 }, { 'interval-1': null }, { 'interval-1': 'Unknown' }]) assert.throws(() => analyzeCounter(oneInterval(), events));
  const sparse = answers(simple(), ['1', '0', '2']); delete sparse[1]; assert.throws(() => counterDeltas(simple(), sparse));
  const wrong = answers(simple(), ['1', '0', '2']); wrong.reverse(); assert.throws(() => counterDeltas(simple(), wrong)); wrong.reverse(); wrong[0].extra = 1; assert.throws(() => counterDeltas(simple(), wrong));
});

test('maximum complete prompts fit the published SDK and include reset precedence and exact interval meaning', () => {
  const input = { ...simple(), counterId: 'a'.repeat(32), title: 'é'.repeat(32), context: '界'.repeat(60), meaning: 'μ'.repeat(40), unit: 'u'.repeat(16), modulus: 1000000000,
    readings: Array.from({ length: 8 }, (_, i) => ({ at: `2026-11-09T09:00:0${i}.000Z`, value: 999999999 })) };
  for (const task of tasksFor(input)) {
    const req = requestFor(input, CONFIG, task.id, id(99)); assert.ok(req.prompt.length <= 500);
    for (const text of [input.title, input.meaning, input.context, input.unit, task.start.at, task.end.at, 'If any reset occurred, reply Reset.', 'Otherwise give documented full modulus crossings']) assert.ok(req.prompt.includes(text));
    assert.equal(req.data.interval_hash, hash(task)); assert.equal(req.data.policy_hash, POLICY_HASH); assert.equal(req.target_user_id, CONFIG.participant.id); assert.equal(req.options, undefined);
  }
});

test('completed SDK evidence exports an attributed exact total privately and offline', async t => {
  const s = await setup(t), result = await decide(s, ['1', '0', '2']);
  assert.equal(result.status, 'complete'); assert.equal(result.analysis.exactTotal, '250'); assert.ok(result.totalExport);
  assert.deepEqual(result.answers.map(row => row.wraps), [1, 0, 2]); assert.ok(result.answers.every(row => row.responderId === CONFIG.participant.id && row.askerId === ASKER && row.answeredAt && row.intervalHash));
  const calls = s.api.calls.length; assert.deepEqual(await exportTotal(s.directory, simple()), result.totalExport); assert.deepEqual((await exportAnalysis(s.directory, simple())).analysis, result.analysis); assert.equal(s.api.calls.length, calls);
  assert.equal((await stat(join(s.directory, 'total.json'))).mode & 0o777, 0o600); assert.equal((await stat(join(s.directory, 'analysis.json'))).mode & 0o777, 0o600);
  assert.equal(result.billingPerformed, false); assert.equal(result.deviceModified, false); assert.equal(sends(s.api), 3);
  const release = await acquireLock(s.directory); await assert.rejects(exportTotal(s.directory, simple()), /lock exists/); await release();
});

test('SDK reset and inconsistent outcomes allow complete analysis export but refuse exact totals', async t => {
  for (const [values, status, subtotal] of [[['1', 'Reset', '2'], 'has_discontinuities', '225'], [['0', '0', '2'], 'inconsistent', '230']]) {
    const s = await setup(t), result = await decide(s, values); assert.equal(result.status, 'complete'); assert.equal(result.analysis.status, status); assert.equal(result.analysis.knownSubtotal, subtotal); assert.equal(result.totalExport, null);
    assert.deepEqual((await exportAnalysis(s.directory, simple())).analysis, result.analysis); await assert.rejects(exportTotal(s.directory, simple()), /continuous and consistent/); assert.equal(await readJson(join(s.directory, 'total.json')), null);
  }
  const s = await setup(t, oneInterval(0, 0, 2)), result = await decide(s, ['0']); assert.equal(result.analysis.exactTotal, '0'); assert.equal((await exportTotal(s.directory, s.options.input)).analysis.exactTotal, '0');
});

test('Unknown and failed SDK evidence cannot export any complete analysis', async t => {
  for (const text of ['Unknown', '4']) {
    const s = await setup(t), result = await decide(s, [text, '0', '2']); assert.equal(result.status, 'incomplete'); assert.equal(result.analysis, null); assert.equal(result.totalExport, null);
    await assert.rejects(exportAnalysis(s.directory, simple())); await assert.rejects(exportTotal(s.directory, simple()));
  }
});

test('source, connection and saved evidence changes are rejected before any request or export', async t => {
  const s = await setup(t); await decide(s, ['1', '0', '2']); const original = await s.saved(), calls = s.api.calls.length;
  for (const mutate of [x => { x.meaning = 'Different counter'; }, x => { x.unit = 'pages'; }, x => { x.modulus = 101; }, x => { x.readings[0].value = 89; }, x => { x.readings[0].at = '2026-11-09T08:59:59Z'; }]) {
    const input = simple(); mutate(input); await assert.rejects(s.run({ input })); await assert.rejects(exportAnalysis(s.directory, input));
  }
  for (const mutate of [x => { x.attempts[0].observation.answer.wraps = 2; }, x => { x.attempts[0].observation.answer.kind = 'reset'; }, x => { x.attempts[0].request.data.policy_hash = hash({}); }, x => { x.attempts[0].observation.checkedAt = '2025-01-01T00:00:00.000Z'; }]) {
    const saved = structuredClone(original); mutate(saved); await atomicJson(s.directory, 'state.json', saved); await assert.rejects(s.run()); await assert.rejects(exportTotal(s.directory, simple()));
  }
  await atomicJson(s.directory, 'state.json', original);
  await assert.rejects(s.run({ token: 'other' })); await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } })); assert.equal(s.api.calls.length, calls);
});

test('credential and identity validators reject suffix newlines and Unicode separators', () => {
  for (const suffix of ['\n', '\r', '\u2028', '\u2029']) { assert.equal(isId(CONFIG.participant.id + suffix), false); assert.equal(ROOM.test(ROOM_CODE + suffix), false); assert.equal(TOKEN.test('token' + suffix), false); }
  assert.throws(() => validateConfig({ participant: { ...CONFIG.participant, extra: 1 } })); assert.throws(() => validateConnection({ token: 'token\n', room: ROOM_CODE }));
});

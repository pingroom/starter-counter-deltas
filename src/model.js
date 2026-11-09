import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const POLICY = Object.freeze({ algorithm: 'documented-modular-deltas-v1', wraps: 'exact-crossings-zero-through-three-v1', reset: 'no-inferred-usage-v1', unknown: 'withhold-whole-analysis-v1', rate: 'exact-unreduced-per-second-v1' });
export const POLICY_HASH = hash(POLICY);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max && !Object.is(value, -0);
const readingTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+00:00)(?![\s\S])/.test(value)) throw new Error('Reading timestamps require UTC seconds with at most millisecond precision.');
  return iso(value);
};
const intervalsFor = input => input.readings.slice(1).map((end, index) => ({ id: `interval-${index + 1}`, start: input.readings[index], end }));
const intervalPrompt = (input, interval) => `${input.title}\nCounter ${input.counterId}: ${input.meaning}\nContext: ${input.context}\nUnit: ${input.unit}; modulus: ${input.modulus}\nFrom ${interval.start.at} = ${interval.start.value}\nTo ${interval.end.at} = ${interval.end.value}\nIf any reset occurred, reply Reset. Otherwise give documented full modulus crossings for this exact interval: 0..3 or Unknown. Never guess from a decrease.`;

export function validateInput(input) {
  if (!keys(input, ['counterId', 'title', 'context', 'meaning', 'unit', 'modulus', 'readings']) || !word(input.counterId) || input.counterId.length > 32
    || !line(input.title, 32) || !line(input.context, 60) || !line(input.meaning, 40) || !line(input.unit, 16)
    || !integer(input.modulus, 1000000000) || input.modulus < 2 || !Array.isArray(input.readings) || input.readings.length < 2 || input.readings.length > 8) throw new Error('Provide counter meaning, unit, modulus 2..1000000000 and 2–8 ordered UTC readings.');
  const readings = []; let previous = null;
  for (const reading of input.readings) {
    if (!keys(reading, ['at', 'value']) || !integer(reading.value, input.modulus - 1)) throw new Error('Each reading requires only at and an integer value 0..modulus-1.');
    const at = readingTime(reading.at);
    if (previous !== null && at <= previous) throw new Error('Reading timestamps must be strictly increasing; input order is preserved.');
    readings.push({ at, value: reading.value }); previous = at;
  }
  const result = { ...structuredClone(input), readings };
  if (intervalsFor(result).some(interval => intervalPrompt(result, interval).length > 500)) throw new Error('Full counter interval prompt exceeds 500 characters.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact counter operator UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => intervalsFor(validateInput(input));
export function parseWraps(text) {
  if (text === 'Unknown') return { kind: 'unknown', wraps: null };
  if (text === 'Reset') return { kind: 'reset', wraps: null };
  if (typeof text !== 'string' || !/^[0-3](?![\s\S])/.test(text)) throw new Error('Reply one digit 0..3 for documented full modulus crossings, exactly Reset, or exactly Unknown.');
  return { kind: 'wraps', wraps: Number(text) };
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput), interval = tasksFor(input).find(row => row.id === taskId); validateConfig(config);
  if (!interval || !isId(attemptId)) throw new Error('Invalid interval or attempt.');
  const key = `counter-${attemptId}`;
  return { prompt: intervalPrompt(input, interval), context: `To ${config.participant.id}`, text_input: { placeholder: '0..3, Reset, or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), interval_hash: hash(interval), policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

export function analyzeCounter(rawInput, events) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(events, tasks.map(row => row.id)) || Object.values(events).some(value => value !== 'Reset' && !integer(value, 3))) throw new Error('Every interval needs a documented wrap count 0..3 or Reset.');
  const intervals = tasks.map(interval => {
    const elapsedMs = BigInt(Date.parse(interval.end.at)) - BigInt(Date.parse(interval.start.at)), event = events[interval.id];
    const base = { intervalId: interval.id, start: interval.start, end: interval.end, elapsedMs: elapsedMs.toString(), wraps: event === 'Reset' ? null : event };
    if (event === 'Reset') return { ...base, status: 'reset', signedComputedDelta: null, delta: null, ratePerSecond: null };
    const computed = BigInt(interval.end.value) - BigInt(interval.start.value) + BigInt(event) * BigInt(input.modulus);
    if (computed < 0n) return { ...base, status: 'inconsistent', signedComputedDelta: computed.toString(), delta: null, ratePerSecond: null };
    return { ...base, status: 'continuous', signedComputedDelta: computed.toString(), delta: computed.toString(),
      ratePerSecond: { numerator: (computed * 1000n).toString(), denominator: elapsedMs.toString(), unit: `${input.unit}/second` } };
  });
  const continuous = intervals.filter(row => row.status === 'continuous'), resets = intervals.filter(row => row.status === 'reset'), inconsistent = intervals.filter(row => row.status === 'inconsistent');
  const subtotal = continuous.reduce((sum, row) => sum + BigInt(row.delta), 0n), coveredMs = continuous.reduce((sum, row) => sum + BigInt(row.elapsedMs), 0n);
  const totalMs = intervals.reduce((sum, row) => sum + BigInt(row.elapsedMs), 0n), completeCoverage = continuous.length === intervals.length;
  const result = { status: inconsistent.length ? 'inconsistent' : resets.length ? 'has_discontinuities' : 'continuous', intervals, unit: input.unit,
    knownSubtotal: subtotal.toString(), coverage: { includedIntervalIds: continuous.map(row => row.intervalId), resetIntervalIds: resets.map(row => row.intervalId),
      inconsistentIntervalIds: inconsistent.map(row => row.intervalId), includedIntervalCount: continuous.length, totalIntervalCount: intervals.length,
      coveredElapsedMs: coveredMs.toString(), totalElapsedMs: totalMs.toString(), complete: completeCoverage },
    exactTotal: completeCoverage ? subtotal.toString() : null,
    exactRatePerSecond: completeCoverage ? { numerator: (subtotal * 1000n).toString(), denominator: totalMs.toString(), unit: `${input.unit}/second` } : null,
    resetUsageInferred: false, billingPerformed: false, deviceModified: false };
  return { ...result, analysisHash: hash(result) };
}
export function counterDeltas(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || Array.from(answers).some((row, index) => !keys(row, ['intervalId', 'text']) || row.intervalId !== tasks[index].id || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide one ordered answer or missing outcome for every interval.');
  const outcomes = answers.map(row => row.text === null ? { kind: 'missing', wraps: null } : parseWraps(row.text));
  if (outcomes.some(row => !['wraps', 'reset'].includes(row.kind))) return { status: 'incomplete', analysis: null };
  return { status: 'complete', analysis: analyzeCounter(input, Object.fromEntries(tasks.map((row, index) => [row.id, outcomes[index].kind === 'reset' ? 'Reset' : outcomes[index].wraps]))) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed counter readings. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved wrap request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(interval => {
    const attempt = state.attempts.find(row => row.taskId === interval.id), answer = attempt?.observation?.answer;
    return { intervalId: interval.id, intervalHash: hash(interval), status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, wraps: answer?.wraps ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = counterDeltas(input, answers.map(({ intervalId, text }) => ({ intervalId, text })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { counterId: input.counterId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, analysis: calculation.analysis, billingPerformed: false, deviceModified: false };
  return { ...evidence, status, totalExport: calculation.status === 'complete' && calculation.analysis.exactTotal !== null ? { ...evidence, status: 'complete' } : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'wraps', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseWraps(answer.text)) !== hash({ kind: answer.kind, wraps: answer.wraps })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved wrap evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain wrap evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or counter operator.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseWraps(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}

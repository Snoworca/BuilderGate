const MAX_TICKETS_PER_WAVE = 64;
const MAX_TICKET_BYTES_PER_WAVE = 8 * 1024;
const PORT_KEYS = new Set(['beginWave', 'readTicket', 'finishWave', 'digestBytes', 'events', 'reads']);
const FORBIDDEN_KEYS = new Set([
  'fs',
  'path',
  'workspaceRoot',
  'manifestPath',
  'reparseGuard',
  'snapshot',
  'writer',
  'admission',
  'options',
]);
const REQUIRED_TRANSITION = Object.freeze(['ensure-parent', 'preflight', 'exclusive-write', 'postflight']);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNoForbiddenKeys(value, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} rejects authority-shaped input: ${key}`);
  }
}

function cloneBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${label} must be bytes`);
  }
  return Buffer.from(value);
}

function normalizeTickets(tickets) {
  if (!Array.isArray(tickets)) throw new Error('opaque ticket wave must be an array');
  const byId = new Map();
  for (const candidate of tickets) {
    assertPlainObject(candidate, 'opaque ticket');
    const keys = Object.keys(candidate);
    if (keys.some(key => key !== 'opaqueId' && key !== 'byteBudget')) {
      throw new Error('opaque ticket rejects paths and unsupported fields');
    }
    if (typeof candidate.opaqueId !== 'string' || !candidate.opaqueId) {
      throw new Error('opaque ticket requires a non-empty identity');
    }
    if (!Number.isInteger(candidate.byteBudget) || candidate.byteBudget < 0 || candidate.byteBudget > MAX_TICKET_BYTES_PER_WAVE) {
      throw new Error('opaque ticket has an invalid fixed byte budget');
    }
    const existing = byId.get(candidate.opaqueId);
    if (existing && existing.byteBudget !== candidate.byteBudget) {
      throw new Error('opaque ticket identity has conflicting byte budgets');
    }
    if (!existing) byId.set(candidate.opaqueId, Object.freeze({ opaqueId: candidate.opaqueId, byteBudget: candidate.byteBudget }));
  }
  return [...byId.values()].sort((left, right) => left.opaqueId.localeCompare(right.opaqueId));
}

function splitTickets(tickets) {
  const waves = [];
  let wave = [];
  let budget = 0;
  for (const candidate of tickets) {
    if (wave.length > 0 && (wave.length >= MAX_TICKETS_PER_WAVE || budget + candidate.byteBudget > MAX_TICKET_BYTES_PER_WAVE)) {
      waves.push(wave);
      wave = [];
      budget = 0;
    }
    wave.push(candidate);
    budget += candidate.byteBudget;
  }
  if (wave.length > 0) waves.push(wave);
  return waves;
}

function resultFor(ticket, entry) {
  return {
    opaqueId: ticket.opaqueId,
    sha256: entry.sha256,
    bytes: Buffer.from(entry.bytes),
  };
}

export function createOpaqueWaveCache(port) {
  assertPlainObject(port, 'opaque wave port');
  assertNoForbiddenKeys(port, 'opaque wave port');
  for (const key of Object.keys(port)) {
    if (!PORT_KEYS.has(key)) throw new Error(`opaque wave port rejects unsupported field: ${key}`);
  }
  for (const key of ['beginWave', 'readTicket', 'finishWave', 'digestBytes']) {
    if (typeof port[key] !== 'function') throw new Error(`opaque wave port requires ${key}`);
  }

  const entries = new Map();
  return Object.freeze({
    readWave(rawTickets) {
      const tickets = normalizeTickets(rawTickets);
      const misses = tickets.filter(ticket => !entries.has(ticket.opaqueId));
      const provisional = new Map();
      for (const waveTickets of splitTickets(misses)) {
        const wave = port.beginWave(waveTickets);
        for (const ticket of waveTickets) {
          const bytes = cloneBytes(port.readTicket(ticket), 'opaque ticket read result');
          const sha256 = port.digestBytes(Buffer.from(bytes));
          if (typeof sha256 !== 'string' || !sha256) throw new Error('opaque ticket digest must be a non-empty string');
          provisional.set(ticket.opaqueId, Object.freeze({ bytes, sha256 }));
        }
        port.finishWave(wave);
      }
      for (const [opaqueId, entry] of provisional) entries.set(opaqueId, entry);
      return tickets.map(ticket => resultFor(ticket, entries.get(ticket.opaqueId)));
    },
  });
}

function sameTransition(actual) {
  return Array.isArray(actual)
    && actual.length === REQUIRED_TRANSITION.length
    && actual.every((step, index) => step === REQUIRED_TRANSITION[index]);
}

function assertParent(state, label) {
  assertPlainObject(state, label);
  if (state.role !== 'directory') throw new Error(`${label} must be a directory`);
  for (const key of ['dev', 'ino', 'mode']) {
    if (!Object.hasOwn(state, key)) throw new Error(`${label} lacks structural identity`);
  }
}

function sameParentStructure(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function assertLeaf(state, label, expectedRole) {
  assertPlainObject(state, label);
  if (state.role !== expectedRole) {
    throw new Error(`${label} has an invalid manifest leaf role: ${state.role ?? 'unknown'}`);
  }
}

export function evaluateManifestWriteState(state) {
  assertPlainObject(state, 'manifest write state');
  assertNoForbiddenKeys(state, 'manifest write state');
  if (!sameTransition(state.transition)) throw new Error('manifest write transition is invalid');
  assertParent(state.parentBefore, 'manifest parent before write');
  assertParent(state.parentAfter, 'manifest parent after write');
  if (!sameParentStructure(state.parentBefore, state.parentAfter)) {
    throw new Error('manifest parent identity changed structurally');
  }
  assertLeaf(state.leafBefore, 'manifest leaf before write', 'missing');
  assertLeaf(state.leafAfter, 'manifest leaf after write', 'regular');
  return {
    allowed: true,
    transition: [...REQUIRED_TRANSITION],
  };
}

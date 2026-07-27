const MAX_TICKETS_PER_WAVE = 64;
const MAX_TICKET_BYTES_PER_WAVE = 8 * 1024;
const PORT_KEYS = Object.freeze(['beginWave', 'readTicket', 'finishWave', 'digestBytes']);
const PORT_KEY_SET = new Set(PORT_KEYS);
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
  'capability',
]);
const REQUIRED_TRANSITION = Object.freeze(['ensure-parent', 'preflight', 'exclusive-write', 'postflight']);
const MANIFEST_STATE_KEYS = new Set([
  'stage',
  'transition',
  'parentBefore',
  'parentAfter',
  'leafBefore',
  'leafWritten',
  'leafAfter',
]);
const PARENT_STATE_KEYS = new Set(['role', 'dev', 'ino', 'mode', 'ctimeMs', 'mtimeMs', 'size']);
const LEAF_STATE_KEYS = new Set(['role', 'dev', 'ino', 'mode', 'ctimeMs', 'mtimeMs', 'size']);

function assertPlainObject(value, label) {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertOnlyKeys(value, label, allowedKeys) {
  assertPlainObject(value, label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} rejects symbol-shaped input`);
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} rejects authority-shaped input: ${key}`);
    if (!allowedKeys.has(key)) throw new Error(`${label} rejects unsupported field: ${key}`);
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
    assertOnlyKeys(candidate, 'opaque ticket', new Set(['opaqueId', 'byteBudget']));
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
  assertOnlyKeys(port, 'opaque wave port', PORT_KEY_SET);
  const portKeys = Reflect.ownKeys(port);
  if (portKeys.length !== PORT_KEYS.length) {
    throw new Error('opaque wave port requires exactly four callbacks');
  }
  for (const key of PORT_KEYS) {
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

function assertParent(state, label, { allowMissing = false } = {}) {
  assertOnlyKeys(state, label, PARENT_STATE_KEYS);
  if (allowMissing && state.role === 'missing') return state;
  if (state.role !== 'directory') throw new Error(`${label} must be a directory`);
  for (const key of ['dev', 'ino', 'mode']) {
    if (!Object.hasOwn(state, key)) throw new Error(`${label} lacks structural identity`);
  }
  return state;
}

function sameParentStructure(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function assertLeaf(state, label, expectedRole) {
  assertOnlyKeys(state, label, LEAF_STATE_KEYS);
  if (state.role !== expectedRole) {
    throw new Error(`${label} has an invalid manifest leaf role: ${state.role ?? 'unknown'}`);
  }
  if (expectedRole === 'regular') {
    for (const key of ['dev', 'ino', 'mode', 'ctimeMs', 'mtimeMs', 'size']) {
      if (!Object.hasOwn(state, key)) throw new Error(`${label} lacks manifest leaf identity`);
    }
  }
  return state;
}

function sameLeafIdentity(left, right) {
  return ['dev', 'ino', 'mode', 'ctimeMs', 'mtimeMs', 'size'].every(key => left[key] === right[key]);
}

export function evaluateManifestWriteState(state) {
  assertOnlyKeys(state, 'manifest write state', MANIFEST_STATE_KEYS);
  if (!sameTransition(state.transition)) throw new Error('manifest write transition is invalid');
  if (state.stage !== undefined && state.stage !== 'preflight') {
    throw new Error('manifest write state has an invalid evaluation stage');
  }
  const parentBefore = assertParent(state.parentBefore, 'manifest parent before write', { allowMissing: true });
  const leafBefore = assertLeaf(state.leafBefore, 'manifest leaf before write', 'missing');

  if (state.stage === 'preflight') {
    if (state.leafWritten !== undefined || state.leafAfter !== undefined) {
      throw new Error('manifest preflight rejects postflight leaf state');
    }
    if (state.parentAfter === undefined) {
      return {
        allowed: true,
        transition: [...REQUIRED_TRANSITION],
      };
    }

    const parentAfter = assertParent(state.parentAfter, 'manifest parent after write');
    if (parentBefore.role === 'directory' && !sameParentStructure(parentBefore, parentAfter)) {
      throw new Error('manifest parent identity changed structurally');
    }
    return {
      allowed: true,
      transition: [...REQUIRED_TRANSITION],
    };
  }

  const parentAfter = assertParent(state.parentAfter, 'manifest parent after write');
  if (parentBefore.role === 'directory' && !sameParentStructure(parentBefore, parentAfter)) {
    throw new Error('manifest parent identity changed structurally');
  }

  const leafAfter = assertLeaf(state.leafAfter, 'manifest leaf after write', 'regular');
  const leafWritten = state.leafWritten === undefined
    ? leafAfter
    : assertLeaf(state.leafWritten, 'manifest leaf written by exclusive write', 'regular');
  if (!sameLeafIdentity(leafWritten, leafAfter)) {
    throw new Error('manifest leaf identity changed after exclusive write');
  }
  return {
    allowed: true,
    transition: [...REQUIRED_TRANSITION],
  };
}

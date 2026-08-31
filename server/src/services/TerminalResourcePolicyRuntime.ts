import { createHash } from 'node:crypto';
import {
  createTerminalResourcePolicyLeaseIssuer,
  type TerminalResourcePolicyCanaryContract,
  type TerminalResourcePolicyLeaseAuthority,
} from './TerminalResourcePolicyCanary.js';

const TRUSTED_RUNTIME_EVIDENCE = Object.freeze({
  requirementId: 'OBS-BGSTAB-005',
  status: 'implemented',
  manifestSha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
});

const REGISTERED_RUNTIME_CONTRACTS: readonly TerminalResourcePolicyCanaryContract[] = Object.freeze([]);

export function getRegisteredTerminalResourcePolicyRuntimeContracts(): readonly TerminalResourcePolicyCanaryContract[] {
  return REGISTERED_RUNTIME_CONTRACTS;
}

export function createTerminalResourcePolicyRuntimeAuthority(options: {
  contracts?: readonly TerminalResourcePolicyCanaryContract[];
} = {}): TerminalResourcePolicyLeaseAuthority {
  return createTerminalResourcePolicyLeaseIssuer({
    trustedEvidence: TRUSTED_RUNTIME_EVIDENCE,
    contracts: options.contracts ?? REGISTERED_RUNTIME_CONTRACTS,
  });
}

export function getTerminalResourcePolicyRuntimeAssemblySnapshot() {
  const stableContracts = REGISTERED_RUNTIME_CONTRACTS.filter(contract => contract.stability === 'stable');
  return Object.freeze({
    stableProfileCount: stableContracts.length,
    registryHash: createHash('sha256').update(JSON.stringify(stableContracts)).digest('hex'),
  });
}

// One issuer instance is the production provenance root for every adapter.
// The empty reviewed registry keeps default behavior fail-closed/candidate-unavailable.
export const terminalResourcePolicyRuntimeAuthority = createTerminalResourcePolicyRuntimeAuthority();

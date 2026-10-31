// FR-USAGE-007 AC-5: catalog keys the usage screens show, as literal tables.
import type { MessageKey } from '../../i18n/i18n.ts';
import type { UsageAgent, UsageSource, UsageWindowKind } from './usageLimitsTypes.ts';

export const AGENT_KEYS = { claude: 'usage.agent.claude', codex: 'usage.agent.codex' } as const satisfies Record<UsageAgent, MessageKey>;
export const WINDOW_KEYS = { fiveHour: 'usage.window.fiveHour', weekly: 'usage.window.weekly' } as const satisfies Record<UsageWindowKind, MessageKey>;
export const SOURCE_KEYS = { windows: 'usage.source.windows', wsl: 'usage.source.wsl', local: 'usage.source.local' } as const satisfies Record<UsageSource, MessageKey>;

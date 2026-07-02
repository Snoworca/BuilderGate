export type RecoveryOptionIcon =
  | { type: 'builtin'; key: string }
  | { type: 'text'; value: string };

export interface RecoveryOption {
  id: string;
  command: string;
  arguments: string[];
  enabled: boolean;
  icon?: RecoveryOptionIcon | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryOptionListResponse {
  options: RecoveryOption[];
}

export interface CreateRecoveryOptionRequest {
  command: string;
  arguments?: string[];
  enabled?: boolean;
  icon?: RecoveryOptionIcon | null;
}

export interface UpdateRecoveryOptionRequest {
  command?: string;
  arguments?: string[];
  enabled?: boolean;
  icon?: RecoveryOptionIcon | null;
}

const BUILTIN_RECOVERY_ICON_LABELS: Record<string, string> = {
  bot: 'AI',
  brain: 'AI',
  code: '{}',
  sparkles: '**',
  terminal: '>_',
};

const UNSAFE_TEXT_ICON_PATTERN = /<|>|javascript:|data:|https?:\/\/|url\s*\(|script|svg|on\w+\s*=|style\s*=/i;

// @req SEC-AITUI-002
export function getRecoveryIconLabel(icon: RecoveryOptionIcon | null | undefined): string | null {
  if (!icon || typeof icon !== 'object') {
    return null;
  }

  if (icon.type === 'builtin') {
    return BUILTIN_RECOVERY_ICON_LABELS[icon.key] ?? null;
  }

  if (icon.type === 'text') {
    const value = typeof icon.value === 'string' ? icon.value.trim() : '';
    if (!value || value.length > 4 || UNSAFE_TEXT_ICON_PATTERN.test(value)) {
      return null;
    }
    return value;
  }

  return null;
}


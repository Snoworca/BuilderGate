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

export interface RecoveryOptionFile {
  version: 1;
  lastUpdated: string;
  options: RecoveryOption[];
}

export interface CreateRecoveryOptionInput {
  command: string;
  arguments?: string[];
  enabled?: boolean;
  icon?: RecoveryOptionIcon | null;
}

export interface UpdateRecoveryOptionInput {
  command?: string;
  arguments?: string[];
  enabled?: boolean;
  icon?: RecoveryOptionIcon | null;
}

export interface RecoveryOptionDiagnostic {
  code: string;
  level: 'warning' | 'error';
  message: string;
  optionId?: string;
  command?: string;
}

export type CommandPresetKind = 'command' | 'directory' | 'prompt';

export interface CommandPreset {
  id: string;
  kind: CommandPresetKind;
  label: string;
  value: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommandPresetListResponse {
  presets: CommandPreset[];
}

export interface CreateCommandPresetRequest {
  kind: CommandPresetKind;
  label: string;
  value: string;
}

export interface UpdateCommandPresetRequest {
  label?: string;
  value?: string;
}

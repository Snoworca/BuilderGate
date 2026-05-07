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

export interface CommandPresetFile {
  version: 1;
  lastUpdated: string;
  presets: CommandPreset[];
}

export interface CreateCommandPresetInput {
  kind: CommandPresetKind;
  label: string;
  value: string;
}

export interface UpdateCommandPresetInput {
  label?: string;
  value?: string;
}

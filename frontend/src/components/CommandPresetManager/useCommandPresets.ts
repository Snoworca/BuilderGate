import { useCallback, useEffect, useMemo, useState } from 'react';
import { commandPresetApi } from '../../services/api';
import type { CommandPreset, CommandPresetKind } from '../../types';

export function useCommandPresets(): {
  presets: CommandPreset[];
  loading: boolean;
  error: string | null;
  createPreset(input: { kind: CommandPresetKind; label: string; value: string }): Promise<void>;
  updatePreset(id: string, input: { label?: string; value?: string }): Promise<void>;
  deletePreset(id: string): Promise<void>;
  movePreset(id: string, direction: 'up' | 'down'): Promise<void>;
  reload(): Promise<void>;
} {
  const [presets, setPresets] = useState<CommandPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sortedPresets = useMemo(() => {
    return [...presets].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.sortOrder - b.sortOrder;
    });
  }, [presets]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPresets(await commandPresetApi.getAll());
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : 'Failed to load command presets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createPreset = useCallback(async (input: { kind: CommandPresetKind; label: string; value: string }) => {
    setError(null);
    await commandPresetApi.create(input);
    await reload();
  }, [reload]);

  const updatePreset = useCallback(async (id: string, input: { label?: string; value?: string }) => {
    setError(null);
    await commandPresetApi.update(id, input);
    await reload();
  }, [reload]);

  const deletePreset = useCallback(async (id: string) => {
    setError(null);
    await commandPresetApi.delete(id);
    await reload();
  }, [reload]);

  const movePreset = useCallback(async (id: string, direction: 'up' | 'down') => {
    setError(null);
    const preset = presets.find(item => item.id === id);
    if (!preset) return;

    const kindPresets = presets
      .filter(item => item.kind === preset.kind)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const index = kindPresets.findIndex(item => item.id === id);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= kindPresets.length) {
      return;
    }

    const nextIds = kindPresets.map(item => item.id);
    [nextIds[index], nextIds[targetIndex]] = [nextIds[targetIndex], nextIds[index]];
    await commandPresetApi.reorder(preset.kind, nextIds);
    await reload();
  }, [presets, reload]);

  return {
    presets: sortedPresets,
    loading,
    error,
    createPreset,
    updatePreset,
    deletePreset,
    movePreset,
    reload,
  };
}

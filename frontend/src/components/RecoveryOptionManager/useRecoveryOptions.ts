import { useCallback, useEffect, useMemo, useState } from 'react';
import { recoveryOptionApi } from '../../services/api';
import type {
  CreateRecoveryOptionRequest,
  RecoveryOption,
  UpdateRecoveryOptionRequest,
} from '../../types';

export interface UseRecoveryOptionsResult {
  options: RecoveryOption[];
  loading: boolean;
  error: string | null;
  createOption(input: CreateRecoveryOptionRequest): Promise<void>;
  updateOption(id: string, input: UpdateRecoveryOptionRequest): Promise<void>;
  deleteOption(id: string): Promise<void>;
  moveOption(id: string, direction: 'up' | 'down'): Promise<void>;
  reload(): Promise<void>;
}

// @req FR-AITUI-001
export function useRecoveryOptions(): UseRecoveryOptionsResult {
  const [options, setOptions] = useState<RecoveryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sortedOptions = useMemo(() => {
    return [...options].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [options]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOptions(await recoveryOptionApi.getAll());
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : 'Failed to load recovery options');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createOption = useCallback(async (input: CreateRecoveryOptionRequest) => {
    setError(null);
    await recoveryOptionApi.create(input);
    await reload();
  }, [reload]);

  const updateOption = useCallback(async (id: string, input: UpdateRecoveryOptionRequest) => {
    setError(null);
    await recoveryOptionApi.update(id, input);
    await reload();
  }, [reload]);

  const deleteOption = useCallback(async (id: string) => {
    setError(null);
    await recoveryOptionApi.delete(id);
    await reload();
  }, [reload]);

  const moveOption = useCallback(async (id: string, direction: 'up' | 'down') => {
    setError(null);
    const index = sortedOptions.findIndex(option => option.id === id);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= sortedOptions.length) {
      return;
    }

    const optionIds = sortedOptions.map(option => option.id);
    [optionIds[index], optionIds[targetIndex]] = [optionIds[targetIndex], optionIds[index]];
    await recoveryOptionApi.reorder(optionIds);
    await reload();
  }, [reload, sortedOptions]);

  return {
    options: sortedOptions,
    loading,
    error,
    createOption,
    updateOption,
    deleteOption,
    moveOption,
    reload,
  };
}


import { useCallback, useEffect, useState } from 'react';
import { terminalShortcutApi } from '../../services/api';
import type {
  CreateTerminalShortcutBindingRequest,
  ResetTerminalShortcutScopeRequest,
  SetTerminalShortcutProfileRequest,
  TerminalShortcutBinding,
  TerminalShortcutState,
  UpdateTerminalShortcutBindingRequest,
} from '../../types';

export interface UseTerminalShortcutsResult {
  state: TerminalShortcutState | null;
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
  setProfile(input: SetTerminalShortcutProfileRequest): Promise<void>;
  createBinding(input: CreateTerminalShortcutBindingRequest): Promise<TerminalShortcutBinding>;
  updateBinding(id: string, input: UpdateTerminalShortcutBindingRequest): Promise<TerminalShortcutBinding>;
  deleteBinding(id: string): Promise<void>;
  reset(input: ResetTerminalShortcutScopeRequest): Promise<void>;
}

export function useTerminalShortcuts(): UseTerminalShortcutsResult {
  const [state, setState] = useState<TerminalShortcutState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await terminalShortcutApi.getState());
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : 'Failed to load terminal shortcuts');
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setProfile = useCallback(async (input: SetTerminalShortcutProfileRequest) => {
    setError(null);
    setState(await terminalShortcutApi.setProfile(input));
  }, []);

  const createBinding = useCallback(async (input: CreateTerminalShortcutBindingRequest) => {
    setError(null);
    const binding = await terminalShortcutApi.createBinding(input);
    await reload();
    return binding;
  }, [reload]);

  const updateBinding = useCallback(async (id: string, input: UpdateTerminalShortcutBindingRequest) => {
    setError(null);
    const binding = await terminalShortcutApi.updateBinding(id, input);
    await reload();
    return binding;
  }, [reload]);

  const deleteBinding = useCallback(async (id: string) => {
    setError(null);
    await terminalShortcutApi.deleteBinding(id);
    await reload();
  }, [reload]);

  const reset = useCallback(async (input: ResetTerminalShortcutScopeRequest) => {
    setError(null);
    setState(await terminalShortcutApi.reset(input));
  }, []);

  return {
    state,
    loading,
    error,
    reload,
    setProfile,
    createBinding,
    updateBinding,
    deleteBinding,
    reset,
  };
}

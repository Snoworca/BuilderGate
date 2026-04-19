/**
 * Auth Context
 * Phase 7: Frontend Security
 *
 * Global authentication state management
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { tokenStorage } from '../services/tokenStorage';
import { authApi } from '../services/api';
import type { AuthState, BootstrapStatusResponse } from '../types';

// ============================================================================
// Context Type
// ============================================================================

interface AuthContextType extends AuthState {
  login: (password: string) => Promise<boolean>;
  bootstrapPassword: (password: string, confirmPassword: string) => Promise<boolean>;
  verify2FA: (otpCode: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const CONFIGURED_BOOTSTRAP_STATE: BootstrapStatusResponse = {
  setupRequired: false,
  requesterAllowed: false,
  allowPolicy: 'configured',
};

// ============================================================================
// Auth Provider
// ============================================================================

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
      error: null,
      requires2FA: false,
      tempToken: null,
      nextStage: null,
      expiresAt: null,
      bootstrapStatus: null,
      bootstrapError: null,
    });

  const fetchBootstrapStatus = useCallback(async (): Promise<{
    bootstrapStatus: BootstrapStatusResponse | null;
    bootstrapError: string | null;
  }> => {
    try {
      const bootstrapStatus = await authApi.getBootstrapStatus();
      return { bootstrapStatus, bootstrapError: null };
    } catch (error) {
      return {
        bootstrapStatus: null,
        bootstrapError: error instanceof Error ? error.message : 'Failed to check bootstrap status',
      };
    }
  }, []);

  // Check token on mount
  useEffect(() => {
    let active = true;

    const initialize = async () => {
      const token = tokenStorage.getToken();
      if (token && !tokenStorage.isExpired()) {
        const { bootstrapStatus, bootstrapError } = await fetchBootstrapStatus();
        if (!active) return;

        if (bootstrapStatus?.setupRequired) {
          tokenStorage.clearToken();
          setState({
            isAuthenticated: false,
            isLoading: false,
            error: null,
            requires2FA: false,
            tempToken: null,
            nextStage: null,
            expiresAt: null,
            bootstrapStatus,
            bootstrapError,
          });
          return;
        }

        if (!active) return;
        setState({
          isAuthenticated: true,
          isLoading: false,
          error: null,
          requires2FA: false,
          tempToken: null,
          nextStage: null,
          expiresAt: tokenStorage.getExpiresAt(),
          bootstrapStatus: bootstrapStatus ?? CONFIGURED_BOOTSTRAP_STATE,
          bootstrapError,
        });
        return;
      }

      tokenStorage.clearToken();
      const { bootstrapStatus, bootstrapError } = await fetchBootstrapStatus();
      if (!active) return;
      setState({
        isAuthenticated: false,
        isLoading: false,
        error: null,
        requires2FA: false,
        tempToken: null,
        nextStage: null,
        expiresAt: null,
        bootstrapStatus,
        bootstrapError,
      });
    };

    void initialize();

    return () => {
      active = false;
    };
  }, [fetchBootstrapStatus]);

  // Listen for auth-expired events from API layer (e.g. 401 responses)
  useEffect(() => {
    const handleAuthExpired = () => {
      void (async () => {
        tokenStorage.clearToken();
        const { bootstrapStatus, bootstrapError } = await fetchBootstrapStatus();
        setState({
          isAuthenticated: false,
          isLoading: false,
          error: 'Session expired. Please login again.',
          requires2FA: false,
          tempToken: null,
          nextStage: null,
          expiresAt: null,
          bootstrapStatus,
          bootstrapError,
        });
      })();
    };
    window.addEventListener('auth-expired', handleAuthExpired);
    return () => window.removeEventListener('auth-expired', handleAuthExpired);
  }, [fetchBootstrapStatus]);

  // Login handler
  const login = useCallback(async (password: string): Promise<boolean> => {
    setState(s => ({ ...s, isLoading: true, error: null }));

    try {
      const response = await authApi.login(password);

      if (response.requires2FA) {
        setState(s => ({
          ...s,
          isLoading: false,
          requires2FA: true,
          tempToken: response.tempToken || null,
          nextStage: response.nextStage || null,
          bootstrapStatus: CONFIGURED_BOOTSTRAP_STATE,
          bootstrapError: null,
        }));
        return false;
      }

      if (response.token && response.expiresIn) {
        tokenStorage.setToken(response.token, response.expiresIn);
        setState(s => ({
          ...s,
          isAuthenticated: true,
          isLoading: false,
          expiresAt: Date.now() + response.expiresIn!,
          bootstrapStatus: CONFIGURED_BOOTSTRAP_STATE,
          bootstrapError: null,
        }));
        return true;
      }

      throw new Error('Invalid login response');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setState(s => ({ ...s, isLoading: false, error: message }));
      return false;
    }
  }, []);

  const bootstrapPassword = useCallback(async (password: string, confirmPassword: string): Promise<boolean> => {
    setState(s => ({ ...s, isLoading: true, error: null }));

    try {
      const response = await authApi.bootstrapPassword(password, confirmPassword);
      tokenStorage.setToken(response.token, response.expiresIn);
      setState(s => ({
        ...s,
        isAuthenticated: true,
        isLoading: false,
        error: null,
        requires2FA: false,
        tempToken: null,
        nextStage: null,
        expiresAt: Date.now() + response.expiresIn,
        bootstrapStatus: CONFIGURED_BOOTSTRAP_STATE,
        bootstrapError: null,
      }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Initial password setup failed';
      setState(s => ({ ...s, isLoading: false, error: message }));
      return false;
    }
  }, []);

  // 2FA verification handler
  const verify2FA = useCallback(async (otpCode: string): Promise<boolean> => {
    if (!state.tempToken) {
      setState(s => ({ ...s, error: 'No pending 2FA request' }));
      return false;
    }

    setState(s => ({ ...s, isLoading: true, error: null }));

    try {
      const response = await authApi.verify(state.tempToken, otpCode, state.nextStage ?? undefined);

      if (response.nextStage && !response.token) {
        setState(s => ({
          ...s,
          isLoading: false,
          nextStage: response.nextStage!,
          tempToken: response.tempToken ?? s.tempToken,
        }));
        return false;
      }

      if (response.token && response.expiresIn) {
        tokenStorage.setToken(response.token, response.expiresIn);
        setState(s => ({
          ...s,
          isAuthenticated: true,
          isLoading: false,
          requires2FA: false,
          tempToken: null,
          nextStage: null,
          expiresAt: Date.now() + response.expiresIn!,
          bootstrapStatus: CONFIGURED_BOOTSTRAP_STATE,
          bootstrapError: null,
        }));
        return true;
      }

      throw new Error(response.message || 'Verification failed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      setState(s => ({ ...s, isLoading: false, error: message }));
      return false;
    }
  }, [state.tempToken, state.nextStage]);

  // Logout handler
  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } catch {
      // Ignore errors, logout anyway
    }
    tokenStorage.clearToken();
    const { bootstrapStatus, bootstrapError } = await fetchBootstrapStatus();
    setState({
      isAuthenticated: false,
      isLoading: false,
      error: null,
      requires2FA: false,
      tempToken: null,
      nextStage: null,
      expiresAt: null,
      bootstrapStatus,
      bootstrapError,
    });
  }, [fetchBootstrapStatus]);

  // Token refresh handler
  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      const response = await authApi.refresh();
      tokenStorage.setToken(response.token, response.expiresIn);
      setState(s => ({
        ...s,
        expiresAt: Date.now() + response.expiresIn
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, bootstrapPassword, verify2FA, logout, refreshToken }}>
      {children}
    </AuthContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

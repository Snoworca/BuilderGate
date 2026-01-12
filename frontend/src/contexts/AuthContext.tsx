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
import type { AuthState } from '../types';

// ============================================================================
// Context Type
// ============================================================================

interface AuthContextType extends AuthState {
  login: (password: string) => Promise<boolean>;
  verify2FA: (otpCode: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | null>(null);

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
    maskedEmail: null,
    expiresAt: null
  });

  // Check token on mount
  useEffect(() => {
    const token = tokenStorage.getToken();
    if (token && !tokenStorage.isExpired()) {
      setState(s => ({
        ...s,
        isAuthenticated: true,
        isLoading: false,
        expiresAt: tokenStorage.getExpiresAt()
      }));
    } else {
      tokenStorage.clearToken();
      setState(s => ({ ...s, isLoading: false }));
    }
  }, []);

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
          maskedEmail: response.maskedEmail || null
        }));
        return false;
      }

      if (response.token && response.expiresIn) {
        tokenStorage.setToken(response.token, response.expiresIn);
        setState(s => ({
          ...s,
          isAuthenticated: true,
          isLoading: false,
          expiresAt: Date.now() + response.expiresIn!
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

  // 2FA verification handler
  const verify2FA = useCallback(async (otpCode: string): Promise<boolean> => {
    if (!state.tempToken) {
      setState(s => ({ ...s, error: 'No pending 2FA request' }));
      return false;
    }

    setState(s => ({ ...s, isLoading: true, error: null }));

    try {
      const response = await authApi.verify(state.tempToken, otpCode);

      if (response.token && response.expiresIn) {
        tokenStorage.setToken(response.token, response.expiresIn);
        setState(s => ({
          ...s,
          isAuthenticated: true,
          isLoading: false,
          requires2FA: false,
          tempToken: null,
          maskedEmail: null,
          expiresAt: Date.now() + response.expiresIn!
        }));
        return true;
      }

      throw new Error(response.message || 'Verification failed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      setState(s => ({ ...s, isLoading: false, error: message }));
      return false;
    }
  }, [state.tempToken]);

  // Logout handler
  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } catch {
      // Ignore errors, logout anyway
    }
    tokenStorage.clearToken();
    setState({
      isAuthenticated: false,
      isLoading: false,
      error: null,
      requires2FA: false,
      tempToken: null,
      maskedEmail: null,
      expiresAt: null
    });
  }, []);

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
    <AuthContext.Provider value={{ ...state, login, verify2FA, logout, refreshToken }}>
      {children}
    </AuthContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

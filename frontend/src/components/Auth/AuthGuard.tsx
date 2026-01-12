/**
 * Auth Guard Component
 * Phase 7: Frontend Security
 *
 * Wraps protected content and shows login/2FA forms when needed
 */

import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { LoginForm } from './LoginForm';
import { TwoFactorForm } from './TwoFactorForm';
import './Auth.css';

interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, isLoading, requires2FA } = useAuth();

  if (isLoading) {
    return (
      <div className="auth-container">
        <div className="auth-loading">
          <span className="spinner large"></span>
          <p>Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (requires2FA) {
      return <TwoFactorForm />;
    }
    return <LoginForm />;
  }

  return <>{children}</>;
}

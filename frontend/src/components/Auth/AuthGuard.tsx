/**
 * Auth Guard Component
 * Phase 7: Frontend Security
 *
 * Wraps protected content and shows login/2FA forms when needed
 */

import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { BootstrapPasswordForm } from './BootstrapPasswordForm';
import { LoginForm } from './LoginForm';
import { TwoFactorForm } from './TwoFactorForm';
import './Auth.css';

interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, isLoading, requires2FA, bootstrapStatus, bootstrapError } = useAuth();

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
    if (bootstrapStatus?.setupRequired && bootstrapStatus.requesterAllowed) {
      return <BootstrapPasswordForm />;
    }
    if (bootstrapStatus?.setupRequired && !bootstrapStatus.requesterAllowed) {
      return (
        <div className="auth-container">
          <div className="auth-card">
            <div className="auth-logo">
              <img src="/logo.svg" alt="BuilderGate" className="auth-logo-icon" width="64" height="64" />
              <h1>Initial Setup Restricted</h1>
            </div>
            <p className="auth-info">
              This BuilderGate instance does not yet have an administrator password.
            </p>
            <div className="auth-warning" role="alert">
              Initial password setup is only allowed from localhost or an explicitly allowed IP address.
            </div>
            {bootstrapError && (
              <div className="auth-error" role="alert">
                {bootstrapError}
              </div>
            )}
          </div>
        </div>
      );
    }
    return <LoginForm />;
  }

  return <>{children}</>;
}

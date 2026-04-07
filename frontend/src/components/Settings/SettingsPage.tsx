import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  EditableSettingsKey,
  EditableSettingsValues,
  FieldApplyScope,
  SettingsApplySummary,
  SettingsPatchRequest,
  SettingsSnapshot,
} from '../../types';
import { settingsApi } from '../../services/api';
import { ConfirmModal } from '../Modal';
import { AUTO_FOCUS_RATIO_KEY, AUTO_FOCUS_RATIO_DEFAULT, FOCUS_RATIO_KEY, FOCUS_RATIO_DEFAULT } from '../../utils/mosaic';
import './SettingsPage.css';

interface SecretDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  smtpPassword: string;
}

interface Props {
  visible: boolean;
  onBack: () => void;
}

const EMPTY_SECRETS: SecretDraft = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
  smtpPassword: '',
};

export function SettingsPage({ visible, onBack }: Props) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<EditableSettingsValues | null>(null);
  const [secrets, setSecrets] = useState<SecretDraft>(EMPTY_SECRETS);
  const [loading, setLoading] = useState(false);

  // Grid Layout 로컬 설정 (localStorage, 서버 무관)
  const [autoFocusRatio, setAutoFocusRatio] = useState<number>(() => {
    try {
      const v = localStorage.getItem(AUTO_FOCUS_RATIO_KEY);
      if (v) { const n = parseFloat(v); if (n >= 1 && n <= 3) return n; }
    } catch { /* ignore */ }
    return AUTO_FOCUS_RATIO_DEFAULT;
  });

  const handleAutoFocusRatioChange = (value: number) => {
    const clamped = Math.round(Math.max(1, Math.min(3, value)) * 10) / 10;
    setAutoFocusRatio(clamped);
    localStorage.setItem(AUTO_FOCUS_RATIO_KEY, clamped.toString());
  };

  const [focusRatio, setFocusRatio] = useState<number>(() => {
    try {
      const v = localStorage.getItem(FOCUS_RATIO_KEY);
      if (v) { const n = parseFloat(v); if (n > 0 && n < 1) return n; }
    } catch { /* ignore */ }
    return FOCUS_RATIO_DEFAULT;
  });

  const handleFocusRatioChange = (value: number) => {
    const clamped = Math.round(Math.max(0.1, Math.min(0.9, value)) * 100) / 100;
    setFocusRatio(clamped);
    localStorage.setItem(FOCUS_RATIO_KEY, clamped.toString());
  };

  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SettingsApplySummary | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  useEffect(() => {
    if (!visible) return;

    let active = true;
    setLoading(true);
    setLoadError(null);

    settingsApi.getSettings()
      .then((nextSnapshot) => {
        if (!active) return;
        setSnapshot(nextSnapshot);
        setDraft(structuredClone(nextSnapshot.values));
        setSecrets(EMPTY_SECRETS);
        setSummary(null);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : 'Failed to load settings');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [visible]);

  const validationErrors = useMemo(() => {
    if (!draft || !snapshot) return [];

    const errors: string[] = [];
    const passwordRequested = Boolean(secrets.currentPassword || secrets.newPassword || secrets.confirmPassword);

    if (passwordRequested) {
      if (!secrets.currentPassword || !secrets.newPassword || !secrets.confirmPassword) {
        errors.push('Password rotation requires current, new, and confirm password.');
      }
      if (secrets.newPassword !== secrets.confirmPassword) {
        errors.push('New password confirmation does not match.');
      }
    }

    if (draft.twoFactor.enabled) {
      if (!draft.twoFactor.email || !draft.twoFactor.smtp.host || !draft.twoFactor.smtp.auth.user) {
        errors.push('2FA requires email, SMTP host, and SMTP user.');
      }
      if (!snapshot.secretState.smtpPasswordConfigured && !secrets.smtpPassword) {
        errors.push('2FA requires an SMTP password.');
      }
    }

    for (const origin of draft.security.cors.allowedOrigins) {
      if (!isValidOrigin(origin)) {
        errors.push(`Invalid CORS origin: ${origin}`);
      }
    }

    for (const ext of draft.fileManager.blockedExtensions) {
      if (!ext.startsWith('.')) errors.push(`Blocked extension must start with ".": ${ext}`);
    }

    for (const item of draft.fileManager.blockedPaths) {
      if (/\s/.test(item)) errors.push(`Blocked path cannot contain whitespace: ${item}`);
    }

    return errors;
  }, [draft, secrets, snapshot]);

  const isDirty = useMemo(() => {
    if (!snapshot || !draft) return false;
    return JSON.stringify(snapshot.values) !== JSON.stringify(draft) || JSON.stringify(secrets) !== JSON.stringify(EMPTY_SECRETS);
  }, [draft, secrets, snapshot]);

  if (!visible) return null;

  const updateDraft = (mutator: (current: EditableSettingsValues) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutator(next);
      return next;
    });
  };

  const requestBack = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onBack();
  };

  const save = async () => {
    if (!snapshot || !draft || validationErrors.length > 0) return;

    const patch = buildPatch(snapshot.values, draft, secrets);
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    setSaveError(null);
    try {
      const response = await settingsApi.patchSettings(patch);
      setSnapshot(response);
      setDraft(structuredClone(response.values));
      setSecrets(EMPTY_SECRETS);
      setSummary(response.applySummary);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-page">
      <div className="settings-toolbar">
        <div>
          <h2>Runtime Settings</h2>
          <p>Only the runtime-safe subset of `config.json5` is exposed here.</p>
        </div>
        <div className="settings-toolbar-actions">
          <button className="settings-secondary-button" onClick={requestBack}>Back</button>
          <button className="settings-primary-button" onClick={save} disabled={!isDirty || saving || loading || validationErrors.length > 0}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {loading && <div className="settings-state-card">Loading settings...</div>}
      {loadError && <div className="settings-state-card settings-error-card">{loadError}</div>}

      {!loading && !loadError && snapshot && draft && (
        <div className="settings-scroll">
          {saveError && <div className="settings-banner settings-banner-error">{saveError}</div>}
          {validationErrors.length > 0 && (
            <div className="settings-banner settings-banner-error">
              {validationErrors.map((error) => <div key={error}>{error}</div>)}
            </div>
          )}
          {summary && (
            <div className="settings-banner settings-banner-success">
              Immediate {summary.immediate.length}, next login {summary.new_logins.length}, new terminal sessions {summary.new_sessions.length}
            </div>
          )}

          <div className="settings-grid">
            <Card title="Authentication">
              <Field label="Session duration (ms)" scope={scope(snapshot, 'auth.durationMs')}>
                <input type="number" value={draft.auth.durationMs} onChange={(e) => updateDraft((next) => { next.auth.durationMs = Number(e.target.value || draft.auth.durationMs); })} />
              </Field>
              <Field label="Current password" scope={scope(snapshot, 'auth.password')} hint={snapshot.secretState.authPasswordConfigured ? 'Configured' : 'Not configured'}>
                <input type="password" value={secrets.currentPassword} onChange={(e) => setSecrets((current) => ({ ...current, currentPassword: e.target.value }))} />
              </Field>
              <Field label="New password" scope={scope(snapshot, 'auth.password')}>
                <input type="password" value={secrets.newPassword} onChange={(e) => setSecrets((current) => ({ ...current, newPassword: e.target.value }))} />
              </Field>
              <Field label="Confirm password" scope={scope(snapshot, 'auth.password')}>
                <input type="password" value={secrets.confirmPassword} onChange={(e) => setSecrets((current) => ({ ...current, confirmPassword: e.target.value }))} />
              </Field>
            </Card>

            <Card title="Two-Factor Authentication">
              <Field label="Enabled" scope={scope(snapshot, 'twoFactor.enabled')}><input type="checkbox" checked={draft.twoFactor.enabled} onChange={(e) => updateDraft((next) => { next.twoFactor.enabled = e.target.checked; })} /></Field>
              <Field label="Email" scope={scope(snapshot, 'twoFactor.email')}><input type="email" value={draft.twoFactor.email} onChange={(e) => updateDraft((next) => { next.twoFactor.email = e.target.value; })} /></Field>
              <Field label="OTP length" scope={scope(snapshot, 'twoFactor.otpLength')}><input type="number" value={draft.twoFactor.otpLength} onChange={(e) => updateDraft((next) => { next.twoFactor.otpLength = Number(e.target.value || draft.twoFactor.otpLength); })} /></Field>
              <Field label="OTP expiry (ms)" scope={scope(snapshot, 'twoFactor.otpExpiryMs')}><input type="number" value={draft.twoFactor.otpExpiryMs} onChange={(e) => updateDraft((next) => { next.twoFactor.otpExpiryMs = Number(e.target.value || draft.twoFactor.otpExpiryMs); })} /></Field>
              <Field label="SMTP host" scope={scope(snapshot, 'twoFactor.smtp.host')}><input type="text" value={draft.twoFactor.smtp.host} onChange={(e) => updateDraft((next) => { next.twoFactor.smtp.host = e.target.value; })} /></Field>
              <Field label="SMTP port" scope={scope(snapshot, 'twoFactor.smtp.port')}><input type="number" value={draft.twoFactor.smtp.port} onChange={(e) => updateDraft((next) => { next.twoFactor.smtp.port = Number(e.target.value || draft.twoFactor.smtp.port); })} /></Field>
              <Field label="SMTP secure" scope={scope(snapshot, 'twoFactor.smtp.secure')}><input type="checkbox" checked={draft.twoFactor.smtp.secure} onChange={(e) => updateDraft((next) => { next.twoFactor.smtp.secure = e.target.checked; })} /></Field>
              <Field label="SMTP user" scope={scope(snapshot, 'twoFactor.smtp.auth.user')}><input type="text" value={draft.twoFactor.smtp.auth.user} onChange={(e) => updateDraft((next) => { next.twoFactor.smtp.auth.user = e.target.value; })} /></Field>
              <Field label="SMTP password" scope={scope(snapshot, 'twoFactor.smtp.auth.password')} hint={snapshot.secretState.smtpPasswordConfigured ? 'Configured' : 'Not configured'}>
                <input type="password" value={secrets.smtpPassword} onChange={(e) => setSecrets((current) => ({ ...current, smtpPassword: e.target.value }))} />
              </Field>
              <Field label="Reject unauthorized" scope={scope(snapshot, 'twoFactor.smtp.tls.rejectUnauthorized')}><input type="checkbox" checked={draft.twoFactor.smtp.tls.rejectUnauthorized} onChange={(e) => updateDraft((next) => { next.twoFactor.smtp.tls.rejectUnauthorized = e.target.checked; })} /></Field>
              <Field label="Minimum TLS version" scope={scope(snapshot, 'twoFactor.smtp.tls.minVersion')}>
                <select value={draft.twoFactor.smtp.tls.minVersion} onChange={(e) => updateDraft((next) => { next.twoFactor.smtp.tls.minVersion = e.target.value as 'TLSv1.2' | 'TLSv1.3'; })}>
                  <option value="TLSv1.2">TLSv1.2</option>
                  <option value="TLSv1.3">TLSv1.3</option>
                </select>
              </Field>
            </Card>

            <Card title="CORS">
              <Field label="Allowed origins" scope={scope(snapshot, 'security.cors.allowedOrigins')}><textarea value={draft.security.cors.allowedOrigins.join('\n')} onChange={(e) => updateDraft((next) => { next.security.cors.allowedOrigins = parseList(e.target.value); })} /></Field>
              <Field label="Credentials" scope={scope(snapshot, 'security.cors.credentials')}><input type="checkbox" checked={draft.security.cors.credentials} onChange={(e) => updateDraft((next) => { next.security.cors.credentials = e.target.checked; })} /></Field>
              <Field label="Max age" scope={scope(snapshot, 'security.cors.maxAge')}><input type="number" value={draft.security.cors.maxAge} onChange={(e) => updateDraft((next) => { next.security.cors.maxAge = Number(e.target.value || draft.security.cors.maxAge); })} /></Field>
            </Card>

            <Card title="Terminal Defaults">
              <Field label="TERM name" scope={scope(snapshot, 'pty.termName')}><input type="text" value={draft.pty.termName} onChange={(e) => updateDraft((next) => { next.pty.termName = e.target.value; })} /></Field>
              <Field label="Default cols" scope={scope(snapshot, 'pty.defaultCols')}><input type="number" value={draft.pty.defaultCols} onChange={(e) => updateDraft((next) => { next.pty.defaultCols = Number(e.target.value || draft.pty.defaultCols); })} /></Field>
              <Field label="Default rows" scope={scope(snapshot, 'pty.defaultRows')}><input type="number" value={draft.pty.defaultRows} onChange={(e) => updateDraft((next) => { next.pty.defaultRows = Number(e.target.value || draft.pty.defaultRows); })} /></Field>
              <Field label="Shell" scope={scope(snapshot, 'pty.shell')}>
                <select value={draft.pty.shell} onChange={(e) => updateDraft((next) => { next.pty.shell = e.target.value as EditableSettingsValues['pty']['shell']; })}>
                  {(snapshot.capabilities['pty.shell'].options ?? ['auto']).map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </Field>
              {snapshot.capabilities['pty.useConpty'].available && (
                <Field label="Use ConPTY" scope={scope(snapshot, 'pty.useConpty')}><input type="checkbox" checked={draft.pty.useConpty} onChange={(e) => updateDraft((next) => { next.pty.useConpty = e.target.checked; })} /></Field>
              )}
              <Field label="Max buffer size" scope={scope(snapshot, 'pty.maxBufferSize')}><input type="number" value={draft.pty.maxBufferSize} onChange={(e) => updateDraft((next) => { next.pty.maxBufferSize = Number(e.target.value || draft.pty.maxBufferSize); })} /></Field>
            </Card>

            <Card title="Session And File Manager">
              <Field label="Idle delay (ms)" scope={scope(snapshot, 'session.idleDelayMs')}><input type="number" value={draft.session.idleDelayMs} onChange={(e) => updateDraft((next) => { next.session.idleDelayMs = Number(e.target.value || draft.session.idleDelayMs); })} /></Field>
              <Field label="Max file size" scope={scope(snapshot, 'fileManager.maxFileSize')}><input type="number" value={draft.fileManager.maxFileSize} onChange={(e) => updateDraft((next) => { next.fileManager.maxFileSize = Number(e.target.value || draft.fileManager.maxFileSize); })} /></Field>
              <Field label="Max directory entries" scope={scope(snapshot, 'fileManager.maxDirectoryEntries')}><input type="number" value={draft.fileManager.maxDirectoryEntries} onChange={(e) => updateDraft((next) => { next.fileManager.maxDirectoryEntries = Number(e.target.value || draft.fileManager.maxDirectoryEntries); })} /></Field>
              <Field label="Blocked extensions" scope={scope(snapshot, 'fileManager.blockedExtensions')}><textarea value={draft.fileManager.blockedExtensions.join('\n')} onChange={(e) => updateDraft((next) => { next.fileManager.blockedExtensions = parseList(e.target.value); })} /></Field>
              <Field label="Blocked paths" scope={scope(snapshot, 'fileManager.blockedPaths')}><textarea value={draft.fileManager.blockedPaths.join('\n')} onChange={(e) => updateDraft((next) => { next.fileManager.blockedPaths = parseList(e.target.value); })} /></Field>
              <Field label="CWD cache TTL (ms)" scope={scope(snapshot, 'fileManager.cwdCacheTtlMs')}><input type="number" value={draft.fileManager.cwdCacheTtlMs} onChange={(e) => updateDraft((next) => { next.fileManager.cwdCacheTtlMs = Number(e.target.value || draft.fileManager.cwdCacheTtlMs); })} /></Field>
            </Card>

            <Card title="Grid Layout">
              <label className="settings-field-row">
                <div className="settings-field-label">
                  <span>Auto mode idle focus ratio</span>
                  <span className="settings-local-badge">Local</span>
                  <span className="settings-field-hint">idle 세션이 running 대비 몇 배 큰지 (1.0 ~ 3.0)</span>
                </div>
                <input
                  type="number"
                  min="1"
                  max="3"
                  step="0.1"
                  value={autoFocusRatio}
                  onChange={(e) => handleAutoFocusRatioChange(parseFloat(e.target.value) || AUTO_FOCUS_RATIO_DEFAULT)}
                />
              </label>
              <label className="settings-field-row">
                <div className="settings-field-label">
                  <span>Focus mode ratio</span>
                  <span className="settings-local-badge">Local</span>
                  <span className="settings-field-hint">선택한 세션이 차지하는 비율 (0.1 ~ 0.9)</span>
                </div>
                <input
                  type="number"
                  min="0.1"
                  max="0.9"
                  step="0.05"
                  value={focusRatio}
                  onChange={(e) => handleFocusRatioChange(parseFloat(e.target.value) || FOCUS_RATIO_DEFAULT)}
                />
              </label>
            </Card>
          </div>

          <section className="settings-info-card">
            <h3>Excluded settings</h3>
            <div className="settings-chip-list">
              {snapshot.excludedSections.map((item) => <span key={item} className="settings-chip">{item}</span>)}
            </div>
          </section>
        </div>
      )}

      {showDiscardConfirm && (
        <ConfirmModal
          title="Discard changes?"
          message="You have unsaved changes. Leave settings and discard them?"
          confirmLabel="Discard"
          destructive
          onConfirm={() => {
            setShowDiscardConfirm(false);
            onBack();
          }}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-card">
      <div className="settings-card-header"><h3>{title}</h3></div>
      {children}
    </section>
  );
}

function Field({
  label,
  scope,
  hint,
  children,
}: {
  label: string;
  scope: FieldApplyScope;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-field-row">
      <div className="settings-field-label">
        <span>{label}</span>
        <ScopeBadge scope={scope} />
        {hint && <span className="settings-field-hint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function ScopeBadge({ scope }: { scope: FieldApplyScope }) {
  const text = scope === 'immediate' ? 'Immediate' : scope === 'new_logins' ? 'Next login' : 'New terminal sessions';
  return <span className={`settings-scope-badge scope-${scope}`}>{text}</span>;
}

function scope(snapshot: SettingsSnapshot, key: EditableSettingsKey): FieldApplyScope {
  return snapshot.capabilities[key]?.applyScope ?? 'immediate';
}

function parseList(value: string): string[] {
  return value.split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean);
}

function isValidOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function buildPatch(initial: EditableSettingsValues, draft: EditableSettingsValues, secrets: SecretDraft): SettingsPatchRequest {
  const patch: SettingsPatchRequest = {};

  if (initial.auth.durationMs !== draft.auth.durationMs || secrets.currentPassword || secrets.newPassword || secrets.confirmPassword) {
    patch.auth = {};
    if (initial.auth.durationMs !== draft.auth.durationMs) patch.auth.durationMs = draft.auth.durationMs;
    if (secrets.currentPassword) patch.auth.currentPassword = secrets.currentPassword;
    if (secrets.newPassword) patch.auth.newPassword = secrets.newPassword;
    if (secrets.confirmPassword) patch.auth.confirmPassword = secrets.confirmPassword;
  }

  if (JSON.stringify(initial.twoFactor) !== JSON.stringify(draft.twoFactor) || secrets.smtpPassword) {
    patch.twoFactor = {
      enabled: draft.twoFactor.enabled,
      email: draft.twoFactor.email,
      otpLength: draft.twoFactor.otpLength,
      otpExpiryMs: draft.twoFactor.otpExpiryMs,
      smtp: {
        host: draft.twoFactor.smtp.host,
        port: draft.twoFactor.smtp.port,
        secure: draft.twoFactor.smtp.secure,
        auth: {
          user: draft.twoFactor.smtp.auth.user,
          ...(secrets.smtpPassword ? { password: secrets.smtpPassword } : {}),
        },
        tls: {
          rejectUnauthorized: draft.twoFactor.smtp.tls.rejectUnauthorized,
          minVersion: draft.twoFactor.smtp.tls.minVersion,
        },
      },
    };
  }

  if (JSON.stringify(initial.security.cors) !== JSON.stringify(draft.security.cors)) {
    patch.security = { cors: { ...draft.security.cors } };
  }

  if (JSON.stringify(initial.pty) !== JSON.stringify(draft.pty)) {
    patch.pty = { ...draft.pty };
  }

  if (initial.session.idleDelayMs !== draft.session.idleDelayMs) {
    patch.session = { idleDelayMs: draft.session.idleDelayMs };
  }

  if (JSON.stringify(initial.fileManager) !== JSON.stringify(draft.fileManager)) {
    patch.fileManager = { ...draft.fileManager };
  }

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value && Object.keys(value).length > 0)) as SettingsPatchRequest;
}

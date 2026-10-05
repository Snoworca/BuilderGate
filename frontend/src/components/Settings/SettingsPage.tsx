import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  EditableSettingsKey,
  EditableSettingsValues,
  FieldApplyScope,
  FieldCapability,
  SettingsApplySummary,
  SettingsSnapshot,
  TOTPQRInfo,
} from '../../types';
import { authApi, settingsApi } from '../../services/api';
import { ConfirmModal } from '../Modal';
import { Icon } from '../common/Icon';
import type { IconName } from '../common/iconGlyphs';
import { Button, Checkbox, Chip, Field, NumberInput, Select, Spinner, TextInput } from '../ui';
import type { ChipTone } from '../ui';
import { AUTO_FOCUS_RATIO_KEY, AUTO_FOCUS_RATIO_DEFAULT, FOCUS_RATIO_KEY, FOCUS_RATIO_DEFAULT } from '../../utils/mosaic';
import { validatePasswordPolicy } from '../../utils/passwordPolicy';
import { reloadRuntimeConfig } from '../../utils/inputReliabilityMode';
import {
  TERMINAL_BACKEND_OPTIONS,
  WAVE6_RESOURCE_LIMIT_GROUPS,
  buildSettingsPatch,
  formatResourceLimitInput,
  getResourceLimitValue,
  parseResourceLimitInput,
  resourceLimitTestId,
  resourceLimitUnitLabel,
  setResourceLimitValue,
  terminalBackendFromUseConpty,
  useConptyFromTerminalBackend,
  validateWave6ResourceLimitDraft,
  validateWave6ResourceLimitField,
} from './settingsDraftHelpers';
import { availableLanguages, readLanguagePreference, t, writeLanguagePreference } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import { APP_VERSION } from '../../utils/appVersion.ts';
import './SettingsPage.css';

interface SecretDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

interface Props {
  visible: boolean;
  onBack: () => void;
}

const EMPTY_SECRETS: SecretDraft = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

/** Shown when a request fails without an Error to describe it. */
const UNKNOWN_CAUSE: MessageKey = 'settings.error.unknownCause';
const WINPTY_UNAVAILABLE: MessageKey = 'settings.pty.winptyUnavailable';
const PASSWORD_MISMATCH: MessageKey = 'settings.password.mismatch';
const PASSWORD_INCOMPLETE: MessageKey = 'settings.password.incomplete';

/** Option values stay what config.json5 holds; only the plain-word ones get Korean. */
const SHELL_OPTION_LABELS: Record<string, MessageKey | string> = {
  auto: 'settings.shell.auto',
  powershell: 'PowerShell',
  wsl: 'WSL',
};
const POWERSHELL_BACKEND_LABELS: Record<string, MessageKey | string> = {
  inherit: 'settings.pty.inheritTerminalBackend',
  conpty: 'ConPTY',
};

export function SettingsPage({ visible, onBack }: Props) {
  const isInteractiveRef = useRef(false);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<EditableSettingsValues | null>(null);
  const [secrets, setSecrets] = useState<SecretDraft>(EMPTY_SECRETS);
  const [loading, setLoading] = useState(false);
  const [totpQR, setTotpQR] = useState<TOTPQRInfo | null>(null);
  const [totpQRLoading, setTotpQRLoading] = useState(false);
  const [totpQRError, setTotpQRError] = useState<string | null>(null);

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

  const loadTotpQr = useCallback(async (isActive: () => boolean = () => true): Promise<void> => {
    setTotpQRLoading(true);
    setTotpQRError(null);

    try {
      const nextQr = await authApi.getTotpQr();
      if (!isActive()) return;
      setTotpQR(nextQr);
    } catch (error) {
      if (!isActive()) return;
      setTotpQR(null);
      setTotpQRError(error instanceof Error ? error.message : t(UNKNOWN_CAUSE));
    } finally {
      if (isActive()) setTotpQRLoading(false);
    }
  }, []);

  useEffect(() => {
    isInteractiveRef.current = visible;
    return () => {
      isInteractiveRef.current = false;
    };
  }, [visible]);

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
        setLoadError(error instanceof Error ? error.message : t(UNKNOWN_CAUSE));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    // Load TOTP QR code
    setTotpQR(null);
    setTotpQRError(null);
    setTotpQRLoading(true);
    authApi.getTotpQr()
      .then((data) => {
        if (!active) return;
            // TOTP not enabled — no QR to show
        if (!active) return;
        setTotpQR(data);
      })
      .catch((error) => {
        if (!active) return;
        setTotpQRError(error instanceof Error ? error.message : t(UNKNOWN_CAUSE));
      })
      .finally(() => {
        if (active) setTotpQRLoading(false);
      });

    return () => {
      active = false;
    };
  }, [visible]);

  // The list feeds the banner above the cards; fieldErrors puts the same
  // problem beside the field it belongs to (FR-UIDS-002 AC-7).
  const validation = useMemo(() => {
    const errors: string[] = [];
    const fieldErrors: Record<string, string> = {};
    if (!draft || !snapshot) return { errors, fieldErrors };

    const passwordRequested = Boolean(secrets.currentPassword || secrets.newPassword || secrets.confirmPassword);
    const allowedPowerShellBackends = new Set(
      snapshot.capabilities['pty.windowsPowerShellBackend']?.options ?? ['inherit', 'conpty', 'winpty'],
    );
    const winptyUnavailable = !allowedPowerShellBackends.has('winpty');

    if (passwordRequested) {
      if (!secrets.currentPassword || !secrets.newPassword || !secrets.confirmPassword) {
        errors.push(t('settings.password.allRequired'));
        if (!secrets.currentPassword) fieldErrors.currentPassword = t(PASSWORD_INCOMPLETE);
        if (!secrets.newPassword) fieldErrors.newPassword = t(PASSWORD_INCOMPLETE);
        if (!secrets.confirmPassword) fieldErrors.confirmPassword = t(PASSWORD_INCOMPLETE);
      }
      if (secrets.newPassword) {
        const passwordPolicy = validatePasswordPolicy(secrets.newPassword);
        if (!passwordPolicy.valid && passwordPolicy.message) {
          errors.push(passwordPolicy.message);
          fieldErrors.newPassword = passwordPolicy.message;
        }
      }
      if (secrets.newPassword !== secrets.confirmPassword) {
        errors.push(t(PASSWORD_MISMATCH));
        if (secrets.confirmPassword) fieldErrors.confirmPassword = t(PASSWORD_MISMATCH);
      }
    }

    const invalidOrigins = draft.security.cors.allowedOrigins.filter((origin) => !isValidOrigin(origin));
    for (const origin of invalidOrigins) {
      errors.push(t('settings.cors.invalidOrigin', { origin }));
    }
    if (invalidOrigins.length > 0) {
      fieldErrors.allowedOrigins = t('settings.cors.invalidOriginsField', { values: invalidOrigins.join(', ') });
    }

    const invalidExtensions = draft.fileManager.blockedExtensions.filter((ext) => !ext.startsWith('.'));
    for (const ext of invalidExtensions) {
      errors.push(t('settings.files.invalidExtension', { ext }));
    }
    if (invalidExtensions.length > 0) {
      fieldErrors.blockedExtensions = t('settings.files.invalidExtensionsField', { values: invalidExtensions.join(', ') });
    }

    const invalidPaths = draft.fileManager.blockedPaths.filter((item) => /\s/.test(item));
    for (const item of invalidPaths) {
      errors.push(t('settings.files.invalidPath', { item }));
    }
    if (invalidPaths.length > 0) {
      fieldErrors.blockedPaths = t('settings.files.invalidPathsField', { values: invalidPaths.map((item) => `"${item}"`).join(', ') });
    }

    if (winptyUnavailable && !draft.pty.useConpty) {
      errors.push(t(WINPTY_UNAVAILABLE));
      fieldErrors.useConpty = t(WINPTY_UNAVAILABLE);
    }

    errors.push(...validateWave6ResourceLimitDraft(draft, snapshot.capabilities));

    return { errors, fieldErrors };
  }, [draft, secrets, snapshot]);
  const validationErrors = validation.errors;
  const fieldErrors = validation.fieldErrors;

  const isDirty = useMemo(() => {
    if (!snapshot || !draft) return false;
    return JSON.stringify(snapshot.values) !== JSON.stringify(draft) || JSON.stringify(secrets) !== JSON.stringify(EMPTY_SECRETS);
  }, [draft, secrets, snapshot]);

  // 이슈 117. Names the relationship the two controls have, which the old checkbox
  // plus select could not show: this one is the default every shell inherits.
  const terminalBackendHint = t('settings.pty.terminalBackendHint');

  const powerShellBackendHint = useMemo(() => {
    if (!draft || !snapshot) return '';
    const capabilityReason = snapshot.capabilities['pty.windowsPowerShellBackend']?.reason;
    const allowsWinpty = (snapshot.capabilities['pty.windowsPowerShellBackend']?.options ?? ['inherit', 'conpty', 'winpty']).includes('winpty');
    const baseHint = draft.pty.windowsPowerShellBackend === 'inherit'
      ? (!draft.pty.useConpty && !allowsWinpty
          ? t(WINPTY_UNAVAILABLE)
          : t('settings.pty.powerShellInheritHint', { backend: draft.pty.useConpty ? 'conpty' : 'winpty' }))
      : (!draft.pty.useConpty && !allowsWinpty
          ? t(WINPTY_UNAVAILABLE)
          : t('settings.pty.powerShellOverrideHint', { backend: draft.pty.windowsPowerShellBackend }));
    return capabilityReason ? `${baseHint} ${capabilityReason}` : baseHint;
  }, [draft, snapshot]);

  if (!visible) return null;

  const updateDraft = (mutator: (current: EditableSettingsValues) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutator(next);
      return next;
    });
    setSummary(null);
  };

  const updateSecrets = (mutator: (current: SecretDraft) => SecretDraft) => {
    setSecrets(mutator);
    setSummary(null);
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

    const patch = buildSettingsPatch(snapshot.values, draft, secrets, snapshot.capabilities);
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    setSaveError(null);
    setSummary(null);
    try {
      const response = await settingsApi.patchSettings(patch);
      setSnapshot(response);
      setDraft(structuredClone(response.values));
      setSecrets(EMPTY_SECRETS);
      setSummary(response.applySummary);
      await reloadRuntimeConfig();

      const shouldRefreshQr = response.changedKeys.some((key) =>
        key === 'twoFactor.enabled' || key === 'twoFactor.issuer' || key === 'twoFactor.accountName',
      );
      if (shouldRefreshQr) {
        if (!response.values.twoFactor.enabled) {
          setTotpQR(null);
          setTotpQRError(null);
          setTotpQRLoading(false);
        } else {
          await loadTotpQr(() => isInteractiveRef.current);
        }
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t(UNKNOWN_CAUSE));
      try {
        const nextSnapshot = await settingsApi.getSettings();
        setSnapshot(nextSnapshot);
        setDraft((current) => {
          if (!current) {
            return structuredClone(nextSnapshot.values);
          }
          const nextDraft = structuredClone(current);
          const allowedPowerShellBackends = new Set(
            nextSnapshot.capabilities['pty.windowsPowerShellBackend']?.options ?? ['inherit', 'conpty', 'winpty'],
          );
          if (!allowedPowerShellBackends.has(nextDraft.pty.windowsPowerShellBackend)) {
            nextDraft.pty.windowsPowerShellBackend = nextSnapshot.values.pty.windowsPowerShellBackend;
          }
          if (!allowedPowerShellBackends.has('winpty') && !nextDraft.pty.useConpty) {
            nextDraft.pty.windowsPowerShellBackend = nextSnapshot.values.pty.windowsPowerShellBackend;
            nextDraft.pty.useConpty = nextSnapshot.values.pty.useConpty;
          }
          return nextDraft;
        });
      } catch {
        // Keep the existing draft if capability refresh fails.
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-page">
      <div className="settings-toolbar">
        <div className="settings-toolbar-heading">
          <h2>{t('settings.page.title')}</h2>
          <p>{t('settings.page.description')}</p>
          <p className="settings-version">{t('settings.page.version', { version: APP_VERSION })}</p>
        </div>
        <div className="settings-toolbar-actions">
          <Button variant="secondary" onClick={requestBack}>{t('common.close')}</Button>
          <Button variant="primary" icon="save" data-testid="settings-save-button" onClick={save} disabled={!isDirty || saving || loading || validationErrors.length > 0}>
            {saving ? t('settings.page.saving') : t('settings.page.save')}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="settings-state-card" role="status">
          <Spinner />
          {t('settings.page.loading')}
        </div>
      )}
      {loadError && (
        <div className="settings-state-card settings-error-card" role="alert">
          <Icon name="alert" />
          <span>{t('settings.page.loadFailed', { error: loadError })}</span>
        </div>
      )}

      {!loading && !loadError && snapshot && draft && (
        <div className="settings-scroll">
          {saveError && (
            <div className="settings-banner settings-banner-error" role="alert">
              <Icon name="alert" />
              <div className="settings-banner-body">{t('settings.page.saveFailed', { error: saveError })}</div>
            </div>
          )}
          {validationErrors.length > 0 && (
            <div className="settings-banner settings-banner-error">
              <Icon name="alert" />
              <div className="settings-banner-body">
                <strong>{t('settings.page.fixBeforeSave')}</strong>
                {validationErrors.map((error) => <div key={error}>{error}</div>)}
              </div>
            </div>
          )}
          {summary && (
            <div className="settings-banner settings-banner-success" role="status">
              <Icon name="check-circle" />
              <div className="settings-banner-body">
                {t('settings.page.saved', { immediate: summary.immediate.length, newLogins: summary.new_logins.length, newSessions: summary.new_sessions.length })}
              </div>
            </div>
          )}
          {summary?.warnings.length ? (
            <div className="settings-banner settings-banner-warning">
              <Icon name="alert" />
              <div className="settings-banner-body">
                {summary.warnings.map((warning) => <div key={warning}>{warning}</div>)}
              </div>
            </div>
          ) : null}

          <div className="settings-grid">
            {/* FR-I18N-006: per-browser language choice, applied by reloading so the catalog loads before render. */}
            <Card title={t('settings.language.title')} icon="settings" description={t('settings.language.description')}>
              <SettingField htmlFor="settings-language" label={t('settings.language.label')} local help={t('settings.language.help')}>
                <Select
                  id="settings-language"
                  data-testid="settings-language-select"
                  value={readLanguagePreference() ?? 'auto'}
                  onChange={(e) => {
                    writeLanguagePreference(e.target.value);
                    window.location.reload();
                  }}
                >
                  <option value="auto">{t('settings.language.auto')}</option>
                  {Object.entries(availableLanguages()).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </Select>
              </SettingField>
            </Card>
            <Card title={t('settings.auth.title')} icon="lock">
              <SettingField htmlFor="settings-auth-duration" label={t('settings.auth.duration')} scope={scope(snapshot, 'auth.durationMs')} help={t('settings.auth.durationHelp')}>
                <NumberInput id="settings-auth-duration" unit="ms" value={draft.auth.durationMs} onChange={(e) => updateDraft((next) => { next.auth.durationMs = Number(e.target.value || draft.auth.durationMs); })} />
              </SettingField>
              <SettingField
                htmlFor="settings-auth-current-password"
                label={t('settings.auth.currentPassword')}
                scope={scope(snapshot, 'auth.password')}
                help={`${t('settings.auth.currentPasswordHelp')} ${snapshot.secretState.authPasswordConfigured ? t('settings.auth.passwordConfigured') : t('settings.auth.passwordNotConfigured')}`}
                error={fieldErrors.currentPassword}
              >
                <TextInput id="settings-auth-current-password" type="password" aria-invalid={fieldErrors.currentPassword ? true : undefined} value={secrets.currentPassword} onChange={(e) => updateSecrets((current) => ({ ...current, currentPassword: e.target.value }))} />
              </SettingField>
              <SettingField htmlFor="settings-auth-new-password" label={t('settings.auth.newPassword')} scope={scope(snapshot, 'auth.password')} error={fieldErrors.newPassword}>
                <TextInput id="settings-auth-new-password" type="password" aria-invalid={fieldErrors.newPassword ? true : undefined} value={secrets.newPassword} onChange={(e) => updateSecrets((current) => ({ ...current, newPassword: e.target.value }))} />
              </SettingField>
              <SettingField htmlFor="settings-auth-confirm-password" label={t('settings.auth.confirmPassword')} scope={scope(snapshot, 'auth.password')} error={fieldErrors.confirmPassword}>
                <TextInput id="settings-auth-confirm-password" type="password" aria-invalid={fieldErrors.confirmPassword ? true : undefined} value={secrets.confirmPassword} onChange={(e) => updateSecrets((current) => ({ ...current, confirmPassword: e.target.value }))} />
              </SettingField>
            </Card>

            <Card title={t('settings.twoFactor.title')} icon="check-circle" description={t('settings.twoFactor.description')}>
              <CheckField
                testId="twofactor-enabled"
                label={t('settings.twoFactor.enabled')}
                scope={scope(snapshot, 'twoFactor.enabled')}
                help={t('settings.twoFactor.enabledHelp')}
                checked={draft.twoFactor.enabled}
                onChange={(checked) => updateDraft((next) => { next.twoFactor.enabled = checked; })}
              />
              <CheckField
                label={t('settings.twoFactor.externalOnly')}
                scope={scope(snapshot, 'twoFactor.externalOnly')}
                help={t('settings.twoFactor.externalOnlyHelp')}
                checked={draft.twoFactor.externalOnly}
                onChange={(checked) => updateDraft((next) => { next.twoFactor.externalOnly = checked; })}
              />
              <SettingField htmlFor="settings-twofactor-issuer" label={t('settings.twoFactor.issuer')} scope={scope(snapshot, 'twoFactor.issuer')} help={t('settings.twoFactor.issuerHelp')}>
                <TextInput id="settings-twofactor-issuer" data-testid="twofactor-issuer" value={draft.twoFactor.issuer} onChange={(e) => updateDraft((next) => { next.twoFactor.issuer = e.target.value; })} />
              </SettingField>
              <SettingField htmlFor="settings-twofactor-account-name" label={t('settings.twoFactor.accountName')} scope={scope(snapshot, 'twoFactor.accountName')} help={t('settings.twoFactor.accountNameHelp')}>
                <TextInput id="settings-twofactor-account-name" data-testid="twofactor-account-name" value={draft.twoFactor.accountName} onChange={(e) => updateDraft((next) => { next.twoFactor.accountName = e.target.value; })} />
              </SettingField>

              <SettingField label={t('settings.twoFactor.qr')} help={t('settings.twoFactor.qrHelp')}>
                <div className="settings-qr">
                  {totpQRLoading && (
                    <span className="settings-qr-status" role="status"><Spinner />{t('settings.twoFactor.qrLoading')}</span>
                  )}
                  {totpQRError && (
                    <span className="settings-qr-status settings-qr-error" role="alert">
                      <Icon name="alert" size={14} />
                      {t('settings.twoFactor.qrFailed', { error: totpQRError })}
                    </span>
                  )}
                  {totpQR && totpQR.registered && totpQR.dataUrl && (
                    <div data-testid="totp-qr-section" className="settings-qr-section">
                      <img
                        data-testid="totp-qr-image"
                        className="settings-qr-image"
                        src={totpQR.dataUrl}
                        alt={t('settings.twoFactor.qrAlt')}
                      />
                      <span data-testid="totp-qr-uri" className="settings-qr-uri">
                        {totpQR.uri}
                      </span>
                    </div>
                  )}
                  {totpQR && !totpQR.registered && (
                    <span data-testid="totp-qr-unregistered" className="settings-qr-status">{t('settings.twoFactor.qrUnregistered')}</span>
                  )}
                  {!totpQRLoading && !totpQR && !totpQRError && (
                    <span data-testid="totp-qr-disabled" className="settings-qr-status">{t('settings.twoFactor.qrDisabled')}</span>
                  )}
                </div>
              </SettingField>
            </Card>

            <Card title="CORS" icon="plug" description={t('settings.cors.description')}>
              <SettingField htmlFor="settings-cors-origins" label={t('settings.cors.allowedOrigins')} scope={scope(snapshot, 'security.cors.allowedOrigins')} help={t('settings.cors.allowedOriginsHelp')} error={fieldErrors.allowedOrigins}>
                <textarea id="settings-cors-origins" className="ui-input ui-input-mono settings-textarea" aria-invalid={fieldErrors.allowedOrigins ? true : undefined} value={draft.security.cors.allowedOrigins.join('\n')} onChange={(e) => updateDraft((next) => { next.security.cors.allowedOrigins = parseList(e.target.value); })} />
              </SettingField>
              <CheckField
                label={t('settings.cors.credentials')}
                scope={scope(snapshot, 'security.cors.credentials')}
                help={t('settings.cors.credentialsHelp')}
                checked={draft.security.cors.credentials}
                onChange={(checked) => updateDraft((next) => { next.security.cors.credentials = checked; })}
              />
              <SettingField htmlFor="settings-cors-max-age" label={t('settings.cors.maxAge')} scope={scope(snapshot, 'security.cors.maxAge')} help={t('settings.cors.maxAgeHelp')}>
                <NumberInput id="settings-cors-max-age" unit={t('settings.unit.seconds')} value={draft.security.cors.maxAge} onChange={(e) => updateDraft((next) => { next.security.cors.maxAge = Number(e.target.value || draft.security.cors.maxAge); })} />
              </SettingField>
            </Card>

            <Card title={t('settings.pty.title')} icon="terminal" description={t('settings.pty.description')}>
              <SettingField htmlFor="settings-pty-term-name" label={t('settings.pty.termName')} scope={scope(snapshot, 'pty.termName')} help={t('settings.pty.termNameHelp')}>
                <TextInput id="settings-pty-term-name" mono value={draft.pty.termName} onChange={(e) => updateDraft((next) => { next.pty.termName = e.target.value; })} />
              </SettingField>
              <SettingField htmlFor="settings-pty-default-cols" label={t('settings.pty.defaultCols')} scope={scope(snapshot, 'pty.defaultCols')}>
                <NumberInput id="settings-pty-default-cols" unit={t('settings.unit.columns')} value={draft.pty.defaultCols} onChange={(e) => updateDraft((next) => { next.pty.defaultCols = Number(e.target.value || draft.pty.defaultCols); })} />
              </SettingField>
              <SettingField htmlFor="settings-pty-default-rows" label={t('settings.pty.defaultRows')} scope={scope(snapshot, 'pty.defaultRows')}>
                <NumberInput id="settings-pty-default-rows" unit={t('settings.unit.rows')} value={draft.pty.defaultRows} onChange={(e) => updateDraft((next) => { next.pty.defaultRows = Number(e.target.value || draft.pty.defaultRows); })} />
              </SettingField>
              <SettingField htmlFor="settings-pty-shell" label={t('settings.pty.shell')} scope={scope(snapshot, 'pty.shell')} help={t('settings.pty.shellHelp')}>
                <Select id="settings-pty-shell" value={draft.pty.shell} onChange={(e) => updateDraft((next) => { next.pty.shell = e.target.value as EditableSettingsValues['pty']['shell']; })}>
                  {(snapshot.capabilities['pty.shell'].options ?? ['auto']).map((item) => <option key={item} value={item}>{item === 'auto' ? t('settings.shell.auto') : SHELL_OPTION_LABELS[item] ?? item}</option>)}
                </Select>
              </SettingField>
              {/* 이슈 117: a select in the SAME vocabulary as the PowerShell override
                  below, so the two read as parent and child. The stored value is
                  still the boolean node-pty expects, so nothing migrates. */}
              {snapshot.capabilities['pty.useConpty'].available && (
                <SettingField htmlFor="settings-pty-terminal-backend" label={t('settings.pty.terminalBackend')} scope={scope(snapshot, 'pty.useConpty')} help={terminalBackendHint} error={fieldErrors.useConpty}>
                  <Select
                    id="settings-pty-terminal-backend"
                    value={terminalBackendFromUseConpty(draft.pty.useConpty)}
                    onChange={(e) => updateDraft((next) => {
                      next.pty.useConpty = useConptyFromTerminalBackend(e.target.value, next.pty.useConpty);
                    })}
                  >
                    {TERMINAL_BACKEND_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </Select>
                </SettingField>
              )}
              {snapshot.capabilities['pty.windowsPowerShellBackend']?.available && (
                <SettingField htmlFor="settings-pty-powershell-backend" label={t('settings.pty.powerShellBackend')} scope={scope(snapshot, 'pty.windowsPowerShellBackend')} help={powerShellBackendHint}>
                  <Select id="settings-pty-powershell-backend" value={draft.pty.windowsPowerShellBackend} onChange={(e) => updateDraft((next) => { next.pty.windowsPowerShellBackend = e.target.value as EditableSettingsValues['pty']['windowsPowerShellBackend']; })}>
                    {(snapshot.capabilities['pty.windowsPowerShellBackend'].options ?? ['inherit']).map((item) => <option key={item} value={item}>{item === 'inherit' ? t('settings.pty.inheritTerminalBackend') : POWERSHELL_BACKEND_LABELS[item] ?? item}</option>)}
                  </Select>
                </SettingField>
              )}
            </Card>

            <Card title={t('settings.sessionFiles.title')} icon="folder">
              <SettingField htmlFor="settings-session-idle-delay" label={t('settings.sessionFiles.idleDelay')} scope={scope(snapshot, 'session.idleDelayMs')} help={t('settings.sessionFiles.idleDelayHelp')}>
                <NumberInput id="settings-session-idle-delay" unit="ms" value={draft.session.idleDelayMs} onChange={(e) => updateDraft((next) => { next.session.idleDelayMs = Number(e.target.value || draft.session.idleDelayMs); })} />
              </SettingField>
              <SettingField htmlFor="settings-files-max-file-size" label={t('settings.sessionFiles.maxFileSize')} scope={scope(snapshot, 'fileManager.maxFileSize')} help={t('settings.sessionFiles.maxFileSizeHelp')}>
                <NumberInput id="settings-files-max-file-size" unit={t('settings.unit.bytes').trim()} value={draft.fileManager.maxFileSize} onChange={(e) => updateDraft((next) => { next.fileManager.maxFileSize = Number(e.target.value || draft.fileManager.maxFileSize); })} />
              </SettingField>
              <SettingField htmlFor="settings-files-max-entries" label={t('settings.sessionFiles.maxEntries')} scope={scope(snapshot, 'fileManager.maxDirectoryEntries')} help={t('settings.sessionFiles.maxEntriesHelp')}>
                <NumberInput id="settings-files-max-entries" unit={t('settings.unit.items')} value={draft.fileManager.maxDirectoryEntries} onChange={(e) => updateDraft((next) => { next.fileManager.maxDirectoryEntries = Number(e.target.value || draft.fileManager.maxDirectoryEntries); })} />
              </SettingField>
              <SettingField htmlFor="settings-files-blocked-extensions" label={t('settings.sessionFiles.blockedExtensions')} scope={scope(snapshot, 'fileManager.blockedExtensions')} help={t('settings.sessionFiles.blockedExtensionsHelp')} error={fieldErrors.blockedExtensions}>
                <textarea id="settings-files-blocked-extensions" className="ui-input ui-input-mono settings-textarea" aria-invalid={fieldErrors.blockedExtensions ? true : undefined} value={draft.fileManager.blockedExtensions.join('\n')} onChange={(e) => updateDraft((next) => { next.fileManager.blockedExtensions = parseList(e.target.value); })} />
              </SettingField>
              <SettingField htmlFor="settings-files-blocked-paths" label={t('settings.sessionFiles.blockedPaths')} scope={scope(snapshot, 'fileManager.blockedPaths')} help={t('settings.sessionFiles.blockedPathsHelp')} error={fieldErrors.blockedPaths}>
                <textarea id="settings-files-blocked-paths" className="ui-input ui-input-mono settings-textarea" aria-invalid={fieldErrors.blockedPaths ? true : undefined} value={draft.fileManager.blockedPaths.join('\n')} onChange={(e) => updateDraft((next) => { next.fileManager.blockedPaths = parseList(e.target.value); })} />
              </SettingField>
              <SettingField htmlFor="settings-files-cwd-cache-ttl" label={t('settings.sessionFiles.cwdCacheTtl')} scope={scope(snapshot, 'fileManager.cwdCacheTtlMs')} help={t('settings.sessionFiles.cwdCacheTtlHelp')}>
                <NumberInput id="settings-files-cwd-cache-ttl" unit="ms" value={draft.fileManager.cwdCacheTtlMs} onChange={(e) => updateDraft((next) => { next.fileManager.cwdCacheTtlMs = Number(e.target.value || draft.fileManager.cwdCacheTtlMs); })} />
              </SettingField>
            </Card>

            {WAVE6_RESOURCE_LIMIT_GROUPS.map((group) => {
              const visibleFields = group.fields.filter((field) => snapshot.capabilities[field.key]?.available);
              if (visibleFields.length === 0) return null;

              return (
                <Card key={group.titleKey} title={t(group.titleKey)} icon="tools">
                  {visibleFields.map((field) => {
                    const capability = snapshot.capabilities[field.key];
                    const value = getResourceLimitValue(draft, field.key);
                    const constraints = capability.constraints;
                    const inputId = resourceLimitTestId(field.key);
                    const problems = validateWave6ResourceLimitField(field, value, capability);
                    const error = problems.length > 0 ? problems.join(' ') : undefined;

                    return (
                      <SettingField
                        key={field.key}
                        htmlFor={inputId}
                        label={t(field.labelKey)}
                        scope={scope(snapshot, field.key)}
                        help={formatConstraintHint(capability.reason, constraints)}
                        error={error}
                      >
                        {field.control === 'select' ? (
                          <Select
                            id={inputId}
                            data-testid={inputId}
                            value={String(value)}
                            onChange={(e) => updateDraft((next) => {
                              setResourceLimitValue(next, field.key, e.target.value);
                            })}
                          >
                            {(capability.options ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
                          </Select>
                        ) : (
                          <NumberInput
                            id={inputId}
                            data-testid={inputId}
                            unit={resourceLimitUnitLabel(constraints?.unit) || undefined}
                            aria-invalid={error ? true : undefined}
                            min={constraints?.min}
                            max={constraints?.max}
                            step={constraints?.step ?? 1}
                            value={formatResourceLimitInput(value)}
                            onChange={(e) => updateDraft((next) => {
                              setResourceLimitValue(next, field.key, parseResourceLimitInput(e.target.value));
                            })}
                          />
                        )}
                      </SettingField>
                    );
                  })}
                </Card>
              );
            })}

            <Card title={t('settings.grid.title')} icon="grid" description={t('settings.grid.description')}>
              <SettingField htmlFor="settings-grid-auto-focus-ratio" label={t('settings.grid.autoFocusRatio')} local help={t('settings.grid.autoFocusRatioHelp')}>
                <NumberInput
                  id="settings-grid-auto-focus-ratio"
                  unit={t('settings.unit.times')}
                  min="1"
                  max="3"
                  step="0.1"
                  value={autoFocusRatio}
                  onChange={(e) => handleAutoFocusRatioChange(parseFloat(e.target.value) || AUTO_FOCUS_RATIO_DEFAULT)}
                />
              </SettingField>
              <SettingField htmlFor="settings-grid-focus-ratio" label={t('settings.grid.focusRatio')} local help={t('settings.grid.focusRatioHelp')}>
                <NumberInput
                  id="settings-grid-focus-ratio"
                  min="0.1"
                  max="0.9"
                  step="0.05"
                  value={focusRatio}
                  onChange={(e) => handleFocusRatioChange(parseFloat(e.target.value) || FOCUS_RATIO_DEFAULT)}
                />
              </SettingField>
            </Card>
          </div>

          <section className="settings-info-card">
            <div className="settings-card-header">
              <span className="settings-card-icon"><Icon name="info" size={18} /></span>
              <div className="settings-card-heading">
                <h3>{t('settings.readOnly.title')}</h3>
                <p>{t('settings.readOnly.description')}</p>
              </div>
            </div>
            <div className="settings-chip-list">
              {snapshot.excludedSections.map((item) => <Chip key={item} className="settings-chip">{item}</Chip>)}
            </div>
          </section>
        </div>
      )}

      {showDiscardConfirm && (
        <ConfirmModal
          title={t('settings.discard.title')}
          message={t('settings.discard.message')}
          confirmLabel={t('settings.discard.confirm')}
          cancelLabel={t('settings.discard.cancel')}
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

function Card({
  title,
  icon,
  description,
  children,
}: {
  title: string;
  icon: IconName;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <span className="settings-card-icon"><Icon name={icon} size={18} /></span>
        <div className="settings-card-heading">
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

/** A form row: label and apply-scope chip above, the input, then error and help (FR-UIDS-002 AC-7). */
function SettingField({
  label,
  htmlFor,
  scope,
  local,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  scope?: FieldApplyScope;
  local?: boolean;
  help?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <Field
      className="settings-field-row"
      htmlFor={htmlFor}
      label={(
        <>
          {label}
          {scope && <>{' '}<ScopeChip scope={scope} /></>}
          {local && <>{' '}<Chip className="settings-local-badge">{t('settings.field.localOnly')}</Chip></>}
        </>
      )}
      help={help}
      error={error}
    >
      {children}
    </Field>
  );
}

/**
 * An on/off setting. The page saves on demand, so the control is a checkbox,
 * not a switch, and the checkbox's own words are its label.
 */
function CheckField({
  label,
  scope,
  help,
  error,
  checked,
  onChange,
  testId,
}: {
  label: string;
  scope: FieldApplyScope;
  help?: ReactNode;
  error?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  return (
    <Field
      className="settings-field-row settings-check-row"
      label={(
        <>
          <Checkbox data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)}>{label}</Checkbox>
          {' '}
          <ScopeChip scope={scope} />
        </>
      )}
      help={help}
      error={error}
    >
      {null}
    </Field>
  );
}

const SCOPE_CHIPS: Record<FieldApplyScope, { tone: ChipTone; textKey: MessageKey }> = {
  immediate: { tone: 'ok', textKey: 'settings.scope.immediate' },
  new_logins: { tone: 'warn', textKey: 'settings.scope.newLogins' },
  new_sessions: { tone: 'accent', textKey: 'settings.scope.newSessions' },
};

function ScopeChip({ scope }: { scope: FieldApplyScope }) {
  const chip = SCOPE_CHIPS[scope] ?? SCOPE_CHIPS.new_sessions;
  return <Chip tone={chip.tone} className={`settings-scope-badge scope-${scope}`}>{t(chip.textKey)}</Chip>;
}

function scope(snapshot: SettingsSnapshot, key: EditableSettingsKey): FieldApplyScope {
  return snapshot.capabilities[key]?.applyScope ?? 'immediate';
}

function formatConstraintHint(
  reason: string | undefined,
  constraints: FieldCapability['constraints'],
): string | undefined {
  const unit = resourceLimitUnitLabel(constraints?.unit);
  const range = constraints?.min !== undefined && constraints.max !== undefined
    ? t('settings.field.allowedRange', { min: constraints.min, max: constraints.max, unit })
    : undefined;
  const parts = [range, reason].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
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

// Mockup ④: my name, my connection code, the company-network switch, the
// contacts table and one input for an address or a code.
// @req FR-MSG-008 FR-MSG-014
import { useEffect, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Button, TextInput } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { messengerApi, MessengerError } from '../../services/api.ts';
import { copyTextToClipboard } from '../../utils/clipboardCopy.ts';
import { classifyContactInput, connectFailureKey, validatePersonName } from './messengerModel.ts';
import { parseLanPort, visibleConnectionCode } from './messengerWindowModel.ts';
import { errorText } from './messengerFormat.ts';
import { contactDot, contactStateText } from './RoomList.tsx';
import type { Invite, MessengerState } from './messengerTypes.ts';

interface ContactsDialogProps {
  state: MessengerState;
  /** Fills the new contact's name (「연락처에 추가」 in the members panel). */
  initialName?: string;
  /** A pasted invite code (bgi1.) was redeemed: open its join dialog. */
  onInvite?: (invite: Invite) => void;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * The connection failures of mockup ④ name the contact being added, which the server's refusal
 * does not carry. Every other code arrives worded by messengerApi.
 */
function refusalText(reason: unknown, failureName: string): string | null {
  if (!(reason instanceof MessengerError)) return null;
  const failure = connectFailureKey(reason.code);
  return failure === null ? null : t(failure, { name: failureName });
}

export function ContactsDialog({ state, initialName, onInvite, onClose, onChanged }: ContactsDialogProps) {
  const [myName, setMyName] = useState(state.me.name);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [lan, setLan] = useState(state.lan);
  const [portText, setPortText] = useState(state.lan.port === undefined ? '' : String(state.lan.port));
  const [webhookUrl, setWebhookUrl] = useState('');
  const [hasWebhook, setHasWebhook] = useState(state.hasWebhook);
  const [name, setName] = useState(initialName ?? '');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const others = state.contacts.map((contact) => contact.name);
  const myNameError = myName.trim() === state.me.name ? null : validatePersonName(myName, { myName: '', existing: others });
  const kind = classifyContactInput(address);
  const isCode = kind === 'contact-code' || kind === 'invite-code';
  const nameError = isCode || name === '' ? null : validatePersonName(name, { myName: state.me.name, existing: others });
  const canConnect = !busy && (isCode || (kind === 'address' && name.trim() !== '' && nameError === null));

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDetail(null);
    setShowDetail(false);
    setDone(null);
    try {
      await action();
      onChanged();
    } catch (reason) {
      const worded = refusalText(reason, name.trim() || address.trim());
      setError(worded ?? errorText(reason));
      if (worded !== null && reason instanceof MessengerError && connectFailureKey(reason.code) !== null) {
        setDetail(`${address.trim()} · ${errorText(reason)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const connect = () => guard(async () => {
    if (isCode) {
      const result = await messengerApi.redeemCode(address.trim());
      // An invite code goes straight to the join dialog (mockup ⑨: the code opens ⑤).
      if (result.kind === 'invite' && onInvite) {
        onInvite(result.invite);
        return;
      }
      setDone(result.kind === 'invite' ? t('messenger.contacts.inviteRedeemed') : t('messenger.contacts.codeConnected'));
    } else {
      await messengerApi.addContact(name.trim(), address.trim());
      setDone(t('messenger.contacts.requestSent', { name: name.trim() }));
    }
    setName('');
    setAddress('');
  });

  const makeCode = () => guard(async () => {
    const result = await messengerApi.connectionCode();
    setCode(result.code);
    setCopied(false);
  });

  useEffect(() => {
    let alive = true;
    messengerApi.lan().then((next) => {
      if (!alive) return;
      setLan(next);
      if (next.port !== undefined) setPortText(String(next.port));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  // Mockup ④ shows my code at once; each call makes a fresh one-time code. A code needs the
  // company-network listener, so it waits until that is on.
  useEffect(() => {
    if (lan.receiving && code === null) void makeCode();
  }, [lan.receiving]); // eslint-disable-line react-hooks/exhaustive-deps

  const port = parseLanPort(portText);
  const portChanged = port.ok && port.port !== undefined && port.port !== lan.port;
  const applyLan = (receiving: boolean) => guard(async () => {
    const next = await messengerApi.setLan(receiving, port.ok && portChanged ? port.port : undefined);
    setLan({ receiving: next.receiving, port: next.port ?? lan.port });
    // D3: a code made while receiving stops working when it is off; turning on again makes a new one.
    if (!next.receiving) setCode(null);
    if (next.port !== undefined) setPortText(String(next.port));
  });

  const saveWebhook = (url: string) => guard(async () => {
    const result = await messengerApi.setWebhook(url);
    setHasWebhook(result.hasWebhook);
    setWebhookUrl('');
    setDone(t('messenger.webhook.saved'));
  });

  const shownCode = visibleConnectionCode(code, lan.receiving);
  const copyCode = async () => {
    if (shownCode === null) return;
    try {
      await copyTextToClipboard(shownCode);
      setCopied(true);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const removeContact = (contactName: string) => {
    if (!window.confirm(t('messenger.contacts.removeConfirm', { name: contactName }))) return;
    void guard(async () => { await messengerApi.removeContact(contactName); });
  };

  return (
    <WindowDialog
      dialogId="messenger-contacts"
      title={t('messenger.contacts.title')}
      mode="modal"
      defaultRect={{ x: 180, y: 50, width: 660, height: 680 }}
      minSize={{ width: 320, height: 420 }}
      onClose={onClose}
    >
      <div className="msgr-dialog">
        <div className="msgr-dlg-b">
          <div className="msgr-field">
            <label htmlFor="msgr-my-name">{t('messenger.contacts.myName')}</label>
            <div>
              <div className="msgr-row">
                <TextInput id="msgr-my-name" value={myName} className={myNameError ? 'is-bad' : undefined} onChange={(event) => setMyName(event.target.value)} />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || myNameError !== null || myName.trim() === state.me.name}
                  onClick={() => void guard(async () => { await messengerApi.rename(myName.trim()); })}
                >
                  {t('common.save')}
                </Button>
              </div>
              {myNameError !== null && <div className="msgr-err">{t(myNameError)}</div>}
              <div className="msgr-hint">{t('messenger.contacts.myNameHint')}</div>
            </div>
          </div>

          <div className="msgr-field">
            <span className="msgr-field-label">{t('messenger.contacts.myCode')}</span>
            <div>
              <div className="msgr-row">
                {shownCode !== null
                  ? <code className="msgr-code">{shownCode}</code>
                  : <span className="msgr-faint msgr-grow">{t(lan.receiving ? 'messenger.contacts.noCode' : 'messenger.lan.offForCode')}</span>}
                {shownCode !== null
                  ? <Button size="sm" variant="secondary" icon="copy" onClick={() => void copyCode()}>{copied ? t('messenger.copied') : t('common.copy')}</Button>
                  : <Button size="sm" variant="secondary" disabled={busy || !lan.receiving} onClick={() => void makeCode()}>{t('messenger.contacts.makeCode')}</Button>}
              </div>
              <div className="msgr-hint">{t('messenger.contacts.codeHint')}</div>
            </div>
          </div>

          <div className="msgr-banner msgr-banner-info">
            <span aria-hidden="true">ⓘ</span>
            <span>
              {lan.receiving
                ? <><b>{t('messenger.lan.onTitle', { port: String(lan.port ?? '') })}</b><br />{t('messenger.lan.firewallHint')}</>
                : <><b>{t('messenger.lan.offTitle')}</b><br />{t('messenger.lan.offBody')}</>}
            </span>
            <span className="msgr-lan-actions">
              <label className="msgr-lan-port">
                <span>{t('messenger.lan.port')}</span>
                <TextInput mono inputMode="numeric" value={portText} className={port.ok ? undefined : 'is-bad'} onChange={(event) => setPortText(event.target.value)} />
              </label>
              {lan.receiving && portChanged && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void applyLan(true)}>{t('messenger.lan.applyPort')}</Button>
              )}
              <Button size="sm" variant={lan.receiving ? 'secondary' : 'primary'} disabled={busy || !port.ok} onClick={() => void applyLan(!lan.receiving)}>
                {lan.receiving ? t('messenger.lan.turnOff') : t('messenger.lan.turnOn')}
              </Button>
            </span>
          </div>
          {!port.ok && <div className="msgr-err">{t('messenger.lan.portInvalid')}</div>}

          <table className="msgr-tbl">
            <thead><tr><th>{t('messenger.contacts.col.name')}</th><th>{t('messenger.contacts.col.state')}</th><th /></tr></thead>
            <tbody>
              {state.contacts.length === 0 && <tr><td colSpan={3} className="msgr-faint">{t('messenger.contacts.none')}</td></tr>}
              {state.contacts.map((contact) => (
                <tr key={contact.name}>
                  <td><b>{contact.name}</b>{contact.address && <div className="msgr-faint msgr-mono">{contact.address}</div>}</td>
                  <td>
                    <span className={`msgr-pill msgr-pill-${contact.state === 'connected' ? 'ok' : contact.state === 'disconnected' ? 'neutral' : 'wait'}`}>
                      <span className={`msgr-dot ${contactDot(contact)}`} aria-hidden="true" />
                      {contactStateText(contact)}
                    </span>
                  </td>
                  <td className="msgr-right">
                    <Button size="sm" variant="danger-text" disabled={busy} onClick={() => removeContact(contact.name)}>
                      {contact.state === 'requested' ? t('common.cancel') : t('messenger.contacts.remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="msgr-newcontact">
            <b>{t('messenger.contacts.new')}</b>
            <div className="msgr-field">
              <label htmlFor="msgr-contact-name">{t('messenger.contacts.col.name')}</label>
              <div>
                <TextInput
                  id="msgr-contact-name"
                  value={name}
                  disabled={isCode}
                  className={nameError ? 'is-bad' : undefined}
                  onChange={(event) => setName(event.target.value)}
                />
                {nameError !== null && <div className="msgr-err">{t(nameError)}</div>}
              </div>
            </div>
            <div className="msgr-field">
              <label htmlFor="msgr-contact-address">{t('messenger.contacts.address')}</label>
              <div>
                <TextInput
                  id="msgr-contact-address"
                  mono
                  value={address}
                  placeholder={t('messenger.contacts.addressPlaceholder')}
                  onChange={(event) => setAddress(event.target.value)}
                />
                {kind === 'invalid' && <div className="msgr-err">{t('messenger.contacts.addressInvalid')}</div>}
                <div className="msgr-hint">{t('messenger.contacts.addressHint')}</div>
              </div>
            </div>
            {error !== null && (
              <div className="msgr-err" role="alert">
                {error}{' '}
                {detail !== null && <button type="button" className="msgr-link" onClick={() => setShowDetail((open) => !open)}>{t('messenger.contacts.details')}</button>}
                {showDetail && detail !== null && <div className="msgr-mono">{detail}</div>}
              </div>
            )}
            {done !== null && <div className="msgr-ok" role="status">{done}</div>}
            <div className="msgr-row msgr-row-end">
              <Button variant="primary" size="md" disabled={!canConnect} onClick={() => void connect()}>{t('messenger.contacts.connect')}</Button>
            </div>
          </div>

          <div className="msgr-field">
            <label htmlFor="msgr-webhook">{t('messenger.webhook.label')}</label>
            <div>
              <div className="msgr-row">
                <span className={`msgr-pill msgr-pill-${hasWebhook ? 'ok' : 'neutral'}`}>{t(hasWebhook ? 'messenger.webhook.set' : 'messenger.webhook.none')}</span>
                {hasWebhook && (
                  <Button size="sm" variant="danger-text" disabled={busy} onClick={() => void saveWebhook('')}>{t('messenger.webhook.clear')}</Button>
                )}
              </div>
              <div className="msgr-row">
                <TextInput
                  id="msgr-webhook"
                  type="url"
                  mono
                  value={webhookUrl}
                  autoComplete="off"
                  placeholder="https://chat.googleapis.com/v1/spaces/…"
                  onChange={(event) => setWebhookUrl(event.target.value)}
                />
                <Button size="sm" variant="secondary" disabled={busy || webhookUrl.trim() === ''} onClick={() => void saveWebhook(webhookUrl.trim())}>{t('common.save')}</Button>
              </div>
              <div className="msgr-hint">{t('messenger.webhook.hint')}</div>
            </div>
          </div>
        </div>
        <div className="msgr-dlg-f">
          <Button variant="secondary" size="md" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </div>
    </WindowDialog>
  );
}

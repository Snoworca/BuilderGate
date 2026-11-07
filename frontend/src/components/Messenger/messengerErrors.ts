// FR-MSG-013 AC-5: the messenger server's refusal codes ({ok:false, code}) and their wording.
// Kept apart from services/apiErrorMessages.ts: that table must equal the codes written as
// `code: '…'` in the browser-facing server files (its own guard), and the messenger routes
// answer through a helper instead.
import type { MessageKey } from '../../i18n/i18n.ts';

const MESSENGER_ERROR_KEYS = {
  INVALID_INPUT: 'messenger.error.INVALID_INPUT',
  INVALID_REQUEST: 'messenger.error.INVALID_INPUT',
  INTERNAL_ERROR: 'messenger.error.INTERNAL_ERROR',
  NAME_EMPTY: 'messenger.name.error.empty',
  NAME_HAS_SPACE: 'messenger.name.error.space',
  NAME_INVALID_CHAR: 'messenger.name.error.forbidden',
  NAME_TOO_LONG: 'messenger.name.error.pattern',
  NAME_TAKEN: 'messenger.name.error.duplicate',
  NAME_IS_SELF: 'messenger.name.error.mine',
  NAME_HAS_CONTACTS: 'messenger.name.error.hasContacts',
  LAN_OFF: 'messenger.error.LAN_OFF',
  LAN_TLS_UNAVAILABLE: 'messenger.lan.tlsUnavailable',
  LAN_PORT_IN_USE: 'messenger.lan.portInUse',
  LAN_PORT_INVALID: 'messenger.lan.portInvalid',
  LAN_ADDRESS_DENIED: 'messenger.error.LAN_ADDRESS_DENIED',
  CODE_INVALID: 'messenger.connect.error.codeExpired',
  ADDRESS_INVALID: 'messenger.contacts.addressInvalid',
  ADDRESS_UNREACHABLE: 'messenger.connect.error.unreachable',
  TLS_FINGERPRINT_CHANGED: 'messenger.connect.error.fingerprint',
  LINK_SAVE_FAILED: 'messenger.error.LINK_SAVE_FAILED',
  INVITE_UNSUPPORTED: 'messenger.error.INVITE_UNSUPPORTED',
  ALREADY_MEMBER: 'messenger.error.ALREADY_MEMBER',
  REQUEST_PENDING: 'messenger.error.REQUEST_PENDING',
  TOO_MANY_REQUESTS: 'messenger.error.TOO_MANY_REQUESTS',
  REQUEST_REFUSED: 'messenger.error.REQUEST_REFUSED',
  NOT_FOUND: 'messenger.error.NOT_FOUND',
  CONTACT_NOT_FOUND: 'messenger.error.CONTACT_NOT_FOUND',
  REQUEST_NOT_FOUND: 'messenger.error.NOT_FOUND',
  APPROVAL_NOT_FOUND: 'messenger.error.NOT_FOUND',
  INVITE_NOT_FOUND: 'messenger.error.INVITE_NOT_FOUND',
  ROOM_NOT_FOUND: 'messenger.error.ROOM_NOT_FOUND',
  APPROVAL_PENDING: 'messenger.error.APPROVAL_PENDING',
  NOT_INVITED: 'messenger.error.NOT_INVITED',
  JOIN_FAILED: 'messenger.error.JOIN_FAILED',
  HOST_OFFLINE: 'messenger.error.HOST_OFFLINE',
  HOST_ERROR: 'messenger.error.HOST_ERROR',
  TARGET_OFFLINE: 'messenger.error.TARGET_OFFLINE',
  TRANSFER_FAILED: 'messenger.error.TRANSFER_FAILED',
  NOT_CREATOR: 'messenger.settings.creatorOnly',
  NOT_HOST: 'messenger.error.NOT_HOST',
  NOT_IN_ROOM: 'messenger.error.NOT_IN_ROOM',
  SESSION_NOT_IN_ROOM: 'messenger.error.SESSION_NOT_IN_ROOM',
  ROOM_LINK_INVALID: 'messenger.error.ROOM_LINK_INVALID',
  MESSENGER_KEYS_UNAVAILABLE: 'messenger.error.MESSENGER_KEYS_UNAVAILABLE',
  MESSENGER_UNAVAILABLE: 'apiError.MESSENGER_UNAVAILABLE',
  AMBIGUOUS_TARGET: 'messenger.composer.error.ambiguous',
  TARGET_NOT_FOUND: 'messenger.composer.error.notFound',
} satisfies Record<string, MessageKey>;

export function messengerErrorKey(code: string | undefined): MessageKey | null {
  if (code === undefined || !Object.prototype.hasOwnProperty.call(MESSENGER_ERROR_KEYS, code)) return null;
  return MESSENGER_ERROR_KEYS[code as keyof typeof MESSENGER_ERROR_KEYS];
}

/** The refusal body as message parameters: text and numbers as text, lists joined. */
export function messengerErrorParams(body: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') params[key] = value;
    else if (typeof value === 'number') params[key] = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) params[key] = value.join(', ');
  }
  return params;
}

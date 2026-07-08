export interface TerminalPointerEventLike {
  button: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function shouldSuppressTerminalSecondaryButtonEvent(button: number): boolean {
  return button === 2;
}

export function suppressTerminalSecondaryButtonEvent(event: TerminalPointerEventLike): boolean {
  if (!shouldSuppressTerminalSecondaryButtonEvent(event.button)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  return true;
}

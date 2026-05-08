import { useId, useLayoutEffect, useState } from 'react';

export interface DialogStackEntry {
  token: string;
  dialogId: string;
  active: boolean;
}

export interface DialogStackState {
  layerIndex: number;
  isTopmost: boolean;
}

const entries: DialogStackEntry[] = [];
const subscribers = new Set<() => void>();

export function createDialogStackState(
  stackEntries: DialogStackEntry[],
  token: string,
): DialogStackState {
  const activeEntries = stackEntries.filter(entry => entry.active);
  const layerIndex = activeEntries.findIndex(entry => entry.token === token);

  return {
    layerIndex: layerIndex < 0 ? 0 : layerIndex,
    isTopmost: layerIndex >= 0 && layerIndex === activeEntries.length - 1,
  };
}

export function useDialogStack(dialogId: string, active: boolean): DialogStackState {
  const token = useId();
  const [state, setState] = useState<DialogStackState>(() => ({
    layerIndex: 0,
    isTopmost: false,
  }));

  useLayoutEffect(() => {
    if (!active) {
      return undefined;
    }

    const update = () => {
      setState(createDialogStackState(entries, token));
    };

    entries.push({ token, dialogId, active: true });
    subscribers.add(update);
    notifySubscribers();
    update();

    return () => {
      const entryIndex = entries.findIndex(entry => entry.token === token);
      if (entryIndex >= 0) {
        entries.splice(entryIndex, 1);
      }
      subscribers.delete(update);
      notifySubscribers();
    };
  }, [active, dialogId, token]);

  return active ? state : { layerIndex: 0, isTopmost: false };
}

function notifySubscribers(): void {
  subscribers.forEach(subscriber => subscriber());
}

// FR-MSG-013 AC-3: room names per session key, for the room dot on tabs and grid tiles. A context
// so the grid tile can read it without every layer between App and the tile passing it on.
import { createContext, useContext } from 'react';

export const SessionRoomsContext = createContext<Record<string, string[]> | undefined>(undefined);

export function useSessionRooms(): Record<string, string[]> | undefined {
  return useContext(SessionRoomsContext);
}

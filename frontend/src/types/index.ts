export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
}

export type SessionStatus = 'running' | 'idle';

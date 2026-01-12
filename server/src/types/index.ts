export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: Date;
  lastActiveAt: Date;
}

export type SessionStatus = 'running' | 'idle';

export interface SessionDTO {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
}

export interface CreateSessionRequest {
  name?: string;
}

export interface InputRequest {
  data: string;
}

export interface ResizeRequest {
  cols: number;
  rows: number;
}

export interface OutputEvent {
  data: string;
}

export interface StatusEvent {
  status: SessionStatus;
}

export interface ErrorEvent {
  message: string;
}

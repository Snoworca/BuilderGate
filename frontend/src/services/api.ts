import type { Session } from '../types';

const API_BASE = '/api';

// Common fetch options with keepalive
const fetchOptions: RequestInit = {
  keepalive: true,
};

export const sessionApi = {
  getAll: async (): Promise<Session[]> => {
    const res = await fetch(`${API_BASE}/sessions`, fetchOptions);
    if (!res.ok) throw new Error('Failed to fetch sessions');
    return res.json();
  },

  create: async (name?: string): Promise<Session> => {
    const res = await fetch(`${API_BASE}/sessions`, {
      ...fetchOptions,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to create session');
    return res.json();
  },

  get: async (id: string): Promise<Session> => {
    const res = await fetch(`${API_BASE}/sessions/${id}`, fetchOptions);
    if (!res.ok) throw new Error('Failed to get session');
    return res.json();
  },

  delete: async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${id}`, {
      ...fetchOptions,
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete session');
  },

  // Fire-and-forget for low latency input
  sendInput: (id: string, data: string): void => {
    fetch(`${API_BASE}/sessions/${id}/input`, {
      ...fetchOptions,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }).catch(err => console.error('Input error:', err));
  },

  resize: async (id: string, cols: number, rows: number): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${id}/resize`, {
      ...fetchOptions,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    });
    if (!res.ok) throw new Error('Failed to resize terminal');
  },

  getStreamUrl: (id: string): string => {
    return `${API_BASE}/sessions/${id}/stream`;
  },
};

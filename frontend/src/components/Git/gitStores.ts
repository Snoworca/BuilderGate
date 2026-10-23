/**
 * The app's shared git summary store, wired to the real API.
 * @req FR-GIT-011
 */
import { gitApi } from '../../services/api.ts';
import { createGitSummaryStore, type GitSummaryStore } from './gitSummaryStore.ts';

let store: GitSummaryStore | null = null;

export function gitSummaryStore(): GitSummaryStore {
  if (!store) store = createGitSummaryStore({ fetchSummary: (id, signal) => gitApi.summary(id, signal) });
  return store;
}

/**
 * FR-GIT-013: whether commit subjects wrap in the commit list. Off by default, kept in this
 * browser, and shared by every open Git window, so toggling it in one changes them all.
 *
 * @req FR-GIT-013
 */
import { browserPreferenceStorage, createBooleanPreferenceStore, type BooleanPreferenceStore, type PreferenceStorage } from '../../utils/booleanPreferenceStore.ts';

export const SUBJECT_WRAP_KEY = 'buildergate.git.wrapSubjects';

export type SubjectWrapStore = BooleanPreferenceStore;

export function createSubjectWrapStore(storage: () => PreferenceStorage | null): SubjectWrapStore {
  return createBooleanPreferenceStore(SUBJECT_WRAP_KEY, false, storage);
}

export const subjectWrapStore = createSubjectWrapStore(browserPreferenceStorage);

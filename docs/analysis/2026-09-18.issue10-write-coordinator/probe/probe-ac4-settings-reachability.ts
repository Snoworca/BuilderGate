// Issue #10 AC-4, executable: is the frame CPU budget reachable from settings?
import { getTerminalResourceLimits } from '/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/frontend/src/utils/inputReliabilityMode.ts';
const limits = getTerminalResourceLimits() as Record<string, unknown>;
const keys = Object.keys(limits).sort();
console.log('resolved terminal limit keys (' + keys.length + '):');
console.log('  ' + keys.join('\n  '));
// Control: a key that IS plumbed must be present, else this probe proves nothing.
console.log('CONTROL visibleFlushBudgetBytes present =', Object.hasOwn(limits, 'visibleFlushBudgetBytes'),
  '(value', limits.visibleFlushBudgetBytes + ')');
console.log('SUBJECT visibleFlushFrameBudgetMs present =', Object.hasOwn(limits, 'visibleFlushFrameBudgetMs'));

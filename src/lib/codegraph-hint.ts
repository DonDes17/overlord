// The "index this project with CodeGraph" suggestion above the chat input can be put off for a while
// ("Plus tard") or switched off for a project. Kept per project in this browser only: it is a viewing
// preference, and the same actions stay available in Settings.
const key = (projectId: number) => `overlord:codegraph-hint:${projectId}`;
const SNOOZE_DAYS = 7;

interface Hint {
  never?: boolean;
  /** Timestamp (ms) until which the suggestion stays hidden. */
  until?: number;
}

function write(projectId: number, hint: Hint) {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(hint));
  } catch {}
}

export function isCodegraphHintVisible(projectId: number): boolean {
  try {
    const hint: Hint = JSON.parse(localStorage.getItem(key(projectId)) ?? "{}");
    if (hint.never) return false;
    if (hint.until && Date.now() < hint.until) return false;
  } catch {}
  return true;
}

export function snoozeCodegraphHint(projectId: number) {
  write(projectId, { until: Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000 });
}

export function dismissCodegraphHint(projectId: number) {
  write(projectId, { never: true });
}

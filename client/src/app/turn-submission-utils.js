export function realSessionIdFromTurn(turn) {
  const sessionIdText = String(turn?.sessionId || '');
  if (!sessionIdText || sessionIdText.startsWith('draft-') || sessionIdText.startsWith('codex-')) {
    return null;
  }
  return sessionIdText;
}

export function turnMatchesSelection(currentSession, { turnId, optimisticSessionId, realSessionId, previousSessionId } = {}) {
  if (!currentSession) {
    return true;
  }
  return (
    currentSession.id === optimisticSessionId ||
    currentSession.id === realSessionId ||
    currentSession.id === previousSessionId ||
    currentSession.turnId === turnId ||
    Boolean(currentSession.draft)
  );
}

export function displayMessageForTurn(message, attachments = [], fileMentions = []) {
  const text = String(message || '').trim();
  if (text) {
    return text;
  }
  if (Array.isArray(attachments) && attachments.length) {
    return '请查看附件。';
  }
  if (Array.isArray(fileMentions) && fileMentions.length) {
    return '请查看引用文件。';
  }
  return '';
}

export function selectedSkillsForPaths(skills, selectedSkillPaths) {
  const selected = new Set(selectedSkillPaths || []);
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => selected.has(skill.path))
    .map((skill) => ({
      name: skill.name || skill.label,
      path: skill.path
    }));
}

export function restoredComposerText(current, nextText) {
  const value = String(nextText || '').trim();
  if (!value) {
    return current;
  }
  const base = String(current || '').trimEnd();
  if (!base) {
    return value;
  }
  if (base.includes(value)) {
    return current;
  }
  return `${base}\n${value}`;
}

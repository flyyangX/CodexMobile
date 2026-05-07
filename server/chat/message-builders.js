import path from 'node:path';
import {
  normalizeFileMentions,
  normalizeAttachments,
  withFileMentionReferences,
  withAttachmentReferences,
  withImageAttachmentPreviews
} from '../upload-service.js';

export function normalizeSelectedSkills(value, availableSkills = []) {
  const requested = Array.isArray(value) ? value : [];
  if (!requested.length || !Array.isArray(availableSkills) || !availableSkills.length) {
    return [];
  }

  const byPath = new Map();
  const byName = new Map();
  for (const skill of availableSkills) {
    if (skill?.path) {
      byPath.set(String(skill.path), skill);
    }
    if (skill?.name) {
      byName.set(String(skill.name), skill);
    }
  }

  const selected = [];
  const seen = new Set();
  for (const item of requested) {
    const pathValue = typeof item === 'string' ? item : item?.path;
    const nameValue = typeof item === 'string' ? item : item?.name;
    const skill = byPath.get(String(pathValue || '')) || byName.get(String(nameValue || ''));
    if (!skill?.path || seen.has(skill.path)) {
      continue;
    }
    seen.add(skill.path);
    selected.push({
      type: 'skill',
      name: skill.name || skill.label || path.basename(path.dirname(skill.path)),
      path: skill.path
    });
  }
  return selected.slice(0, 8);
}

export function buildChatMessageParts(body, config = {}) {
  const attachments = normalizeAttachments(body.attachments);
  const fileMentions = normalizeFileMentions(body.fileMentions);
  const message = String(body.message || '').trim();
  const selectedSkills = normalizeSelectedSkills(body.selectedSkills, config.skills);
  const displayMessage = message || '请查看附件。';
  const visibleMessage = withImageAttachmentPreviews(displayMessage, attachments);
  const codexMessage = withFileMentionReferences(
    withAttachmentReferences(displayMessage, attachments),
    fileMentions
  );
  return {
    attachments,
    codexMessage,
    displayMessage,
    fileMentions,
    message,
    selectedSkills,
    visibleMessage
  };
}

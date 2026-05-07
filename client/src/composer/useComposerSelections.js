import { useEffect, useState } from 'react';
import { safeStoredJsonArray } from '../app/session-utils.js';

const SELECTED_SKILLS_KEY = 'codexmobile.selectedSkills';

export function useComposerSelections(status) {
  const [fileMentions, setFileMentions] = useState([]);
  const [selectedSkillPaths, setSelectedSkillPaths] = useState(() =>
    safeStoredJsonArray(SELECTED_SKILLS_KEY).filter((item) => typeof item === 'string' && item.trim())
  );

  useEffect(() => {
    localStorage.setItem(SELECTED_SKILLS_KEY, JSON.stringify(selectedSkillPaths));
  }, [selectedSkillPaths]);

  useEffect(() => {
    if (!Array.isArray(status.skills) || !status.skills.length || !selectedSkillPaths.length) {
      return;
    }
    const available = new Set(status.skills.map((skill) => skill.path));
    const next = selectedSkillPaths.filter((item) => available.has(item));
    if (next.length !== selectedSkillPaths.length) {
      setSelectedSkillPaths(next);
    }
  }, [selectedSkillPaths, status.skills]);

  function toggleSelectedSkill(path) {
    const value = String(path || '').trim();
    if (!value) {
      return;
    }
    setSelectedSkillPaths((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    );
  }

  function selectSkill(path) {
    const value = String(path || '').trim();
    if (!value) {
      return;
    }
    setSelectedSkillPaths((current) => current.includes(value) ? current : [...current, value]);
  }

  function clearSelectedSkills() {
    setSelectedSkillPaths([]);
  }

  function addFileMention(file) {
    const pathValue = String(file?.path || '').trim();
    if (!pathValue) {
      return;
    }
    setFileMentions((current) => {
      if (current.some((item) => item.path === pathValue)) {
        return current;
      }
      return [
        ...current,
        {
          name: file.name || pathValue.split('/').pop() || pathValue,
          path: pathValue,
          relativePath: file.relativePath || file.name || pathValue
        }
      ].slice(0, 12);
    });
  }

  function removeFileMention(pathValue) {
    setFileMentions((current) => current.filter((item) => item.path !== pathValue));
  }

  return {
    fileMentions,
    setFileMentions,
    selectedSkillPaths,
    setSelectedSkillPaths,
    toggleSelectedSkill,
    selectSkill,
    clearSelectedSkills,
    addFileMention,
    removeFileMention
  };
}

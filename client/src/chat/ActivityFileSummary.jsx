function parseUnifiedDiffLines(unifiedDiff = '') {
  const rows = [];
  let oldLine = null;
  let newLine = null;
  for (const rawLine of String(unifiedDiff || '').split(/\r?\n/)) {
    const hunk = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ type: 'hunk', oldLine: '', newLine: '', text: rawLine });
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ )/.test(rawLine)) {
      continue;
    }
    if (rawLine.startsWith('\\ No newline')) {
      rows.push({ type: 'meta', oldLine: '', newLine: '', text: rawLine });
      continue;
    }
    if (oldLine === null || newLine === null) {
      if (rawLine.trim()) {
        rows.push({ type: 'meta', oldLine: '', newLine: '', text: rawLine });
      }
      continue;
    }
    if (rawLine.startsWith('+')) {
      rows.push({ type: 'add', oldLine: '', newLine: newLine++, text: rawLine.slice(1) });
    } else if (rawLine.startsWith('-')) {
      rows.push({ type: 'del', oldLine: oldLine++, newLine: '', text: rawLine.slice(1) });
    } else {
      rows.push({ type: 'ctx', oldLine: oldLine++, newLine: newLine++, text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine });
    }
  }
  return rows;
}

function ActivityDiffView({ diffs }) {
  const rows = (diffs || []).flatMap((diff, diffIndex) => {
    const parsed = parseUnifiedDiffLines(diff);
    if (diffIndex === 0) {
      return parsed;
    }
    return [{ type: 'gap', oldLine: '', newLine: '', text: '' }, ...parsed];
  });

  if (!rows.length) {
    return null;
  }
  return (
    <div className="activity-diff-shell">
      <div className="activity-diff-view">
        {rows.map((row, index) => (
          <div key={`${index}-${row.oldLine}-${row.newLine}`} className={`activity-diff-row is-${row.type}`}>
            <span className="activity-diff-num">{row.oldLine}</span>
            <span className="activity-diff-num">{row.newLine}</span>
            <code>{row.text || ' '}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ActivityFileSummary({ summary }) {
  return (
    <div className="activity-file-summary">
      <div className="activity-file-summary-head">
        <span>{summary.files.length} 个文件已更改</span>
        {summary.additions ? <strong className="is-added">+{summary.additions}</strong> : null}
        {summary.deletions ? <strong className="is-deleted">-{summary.deletions}</strong> : null}
      </div>
      <div className="activity-file-list">
        {summary.files.map((file) => (
          <details key={file.path} className="activity-file-item">
            <summary>
              <span>{file.label}</span>
              {file.additions ? <strong className="is-added">+{file.additions}</strong> : null}
              {file.deletions ? <strong className="is-deleted">-{file.deletions}</strong> : null}
            </summary>
            <ActivityDiffView diffs={file.diffs} />
          </details>
        ))}
      </div>
    </div>
  );
}

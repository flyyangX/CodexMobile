import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findSecretLikeMatches } from './bundle-secret-scan.mjs';

test('findSecretLikeMatches returns no matches for normal bundle text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-bundle-clean-'));
  await fs.writeFile(path.join(root, 'app.js'), 'console.log("CodexMobile");', 'utf8');
  try {
    assert.deepEqual(await findSecretLikeMatches(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('findSecretLikeMatches reports obvious key-like bundle text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-bundle-secret-'));
  await fs.writeFile(path.join(root, 'app.js'), 'const value = "sk-abc1234567890abcdef";', 'utf8');
  try {
    const matches = await findSecretLikeMatches(root);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].file.endsWith('app.js'), true);
    assert.match(matches[0].text, /sk-/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

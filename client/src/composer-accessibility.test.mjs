import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('permission selector keeps an explicit accessible label when compact text is shown', async () => {
  const app = await fs.readFile(new URL('./App.jsx', import.meta.url), 'utf8');
  const buttonMatch = app.match(/<button[^>]+className="permission-pill"[^>]*>/);

  assert.ok(buttonMatch, 'permission selector button is rendered');
  assert.match(buttonMatch[0], /aria-label=\{`权限：/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

function blockFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] || '';
}

test('pairing screen centers the pairing panel on wide viewports', async () => {
  const css = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = blockFor(css, '.pairing-screen');

  assert.match(rule, /justify-content:\s*center/);
  assert.match(rule, /align-items:\s*center/);
});

test('light theme user bubbles are light, not dark chat bubbles', async () => {
  const css = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const root = blockFor(css, ':root');

  assert.doesNotMatch(root, /--bubble-user:\s*#18181b/i);
  assert.doesNotMatch(root, /--bubble-user-text:\s*#ffffff/i);
});

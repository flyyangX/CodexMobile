import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionLabel, permissionShortLabel } from './permission-mode.js';

test('permission labels have compact mobile variants', () => {
  assert.equal(permissionLabel('default'), '默认权限');
  assert.equal(permissionLabel('acceptEdits'), '自动接受编辑');
  assert.equal(permissionLabel('bypassPermissions'), '完全访问');
  assert.equal(permissionShortLabel('default'), '默认');
  assert.equal(permissionShortLabel('acceptEdits'), '自动');
  assert.equal(permissionShortLabel('bypassPermissions'), '全权');
});

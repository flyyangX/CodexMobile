/**
 * 验证配对页滚动兜底：挂载期间解除全局 App 滚动锁，卸载时还原。
 *
 * Keywords: pairing, scroll-lock, mobile-keyboard, tests
 *
 * Exports: 无导出 / 内含用例
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { unlockPairingPageScroll } from './pairing-scroll-lock.js';

function createElement(initialStyle = {}) {
  const classes = new Set();
  return {
    style: { ...initialStyle },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    }
  };
}

test('unlockPairingPageScroll applies hard scroll fallback and restores prior inline styles', () => {
  const documentLike = {
    documentElement: createElement({ height: '100%', overflowY: '' }),
    body: createElement({ position: 'fixed', inset: '0px', overflowY: '', touchAction: 'pan-y' }),
    root: createElement({ height: '100%', overflow: 'hidden' }),
    getElementById(id) {
      return id === 'root' ? this.root : null;
    }
  };

  const restore = unlockPairingPageScroll(documentLike);

  assert.equal(documentLike.documentElement.classList.contains('is-pairing-screen'), true);
  assert.equal(documentLike.body.classList.contains('is-pairing-screen'), true);
  assert.equal(documentLike.documentElement.style.height, 'auto');
  assert.equal(documentLike.documentElement.style.overflowY, 'auto');
  assert.equal(documentLike.body.style.position, 'static');
  assert.equal(documentLike.body.style.inset, 'auto');
  assert.equal(documentLike.body.style.overflowY, 'auto');
  assert.equal(documentLike.body.style.touchAction, 'auto');
  assert.equal(documentLike.root.style.height, 'auto');
  assert.equal(documentLike.root.style.overflow, 'visible');

  restore();

  assert.equal(documentLike.documentElement.classList.contains('is-pairing-screen'), false);
  assert.equal(documentLike.body.classList.contains('is-pairing-screen'), false);
  assert.equal(documentLike.documentElement.style.height, '100%');
  assert.equal(documentLike.documentElement.style.overflowY, '');
  assert.equal(documentLike.body.style.position, 'fixed');
  assert.equal(documentLike.body.style.inset, '0px');
  assert.equal(documentLike.body.style.overflowY, '');
  assert.equal(documentLike.body.style.touchAction, 'pan-y');
  assert.equal(documentLike.root.style.height, '100%');
  assert.equal(documentLike.root.style.overflow, 'hidden');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { composerSendState } from './send-state.js';

test('composerSendState blocks sending when the desktop bridge is unavailable', () => {
  const state = composerSendState({
    hasInput: true,
    desktopBridge: { connected: false, mode: 'unavailable' }
  });

  assert.equal(state.disabled, true);
  assert.equal(state.mode, 'unavailable');
  assert.equal(state.label, '桌面端 Codex 未连接');
});

test('composerSendState starts a desktop turn when idle', () => {
  const state = composerSendState({
    hasInput: true,
    desktopBridge: { connected: true, mode: 'desktop-proxy', capabilities: { createThread: true } },
    sessionIsDraft: true
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
  assert.equal(state.showMenu, false);
});

test('composerSendState defaults running input to queue follow-up mode', () => {
  const state = composerSendState({
    running: true,
    hasInput: true,
    steerable: true,
    desktopBridge: { connected: true, mode: 'desktop-proxy' }
  });

  assert.equal(state.mode, 'queue');
  assert.equal(state.label, '排队');
  assert.equal(state.showMenu, true);
  assert.equal(state.canSteer, true);
});

test('composerSendState can default running input to steer follow-up mode', () => {
  const state = composerSendState({
    running: true,
    hasInput: true,
    steerable: true,
    followUpMode: 'steer',
    desktopBridge: { connected: true, mode: 'desktop-proxy' }
  });

  assert.equal(state.mode, 'steer');
  assert.equal(state.label, '引导');
  assert.equal(state.showMenu, true);
  assert.equal(state.canSteer, true);
});

test('composerSendState preserves queue and interrupt when active turn cannot steer', () => {
  const state = composerSendState({
    running: true,
    hasInput: true,
    steerable: false,
    desktopBridge: { connected: true, mode: 'desktop-proxy' }
  });

  assert.equal(state.mode, 'queue');
  assert.equal(state.canSteer, false);
  assert.equal(state.canQueue, true);
  assert.equal(state.canInterrupt, true);
});

test('composerSendState blocks draft sends when desktop bridge cannot create threads', () => {
  const state = composerSendState({
    hasInput: true,
    sessionIsDraft: true,
    desktopBridge: {
      connected: true,
      mode: 'desktop-ipc',
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }
  });

  assert.equal(state.disabled, true);
  assert.equal(state.mode, 'create-unavailable');
  assert.equal(state.label, '只能继续桌面端已有对话');
});

test('composerSendState still allows existing desktop threads when createThread is unavailable', () => {
  const state = composerSendState({
    hasInput: true,
    sessionIsDraft: false,
    desktopBridge: {
      connected: true,
      mode: 'desktop-ipc',
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('composerSendState allows draft sends in headless local mode', () => {
  const state = composerSendState({
    hasInput: true,
    sessionIsDraft: true,
    desktopBridge: {
      connected: true,
      mode: 'headless-local',
      capabilities: { createThread: true }
    }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('composerSendState allows draft sends through desktop background fallback', () => {
  const state = composerSendState({
    hasInput: true,
    sessionIsDraft: true,
    desktopBridge: {
      connected: true,
      mode: 'desktop-ipc',
      capabilities: {
        createThread: false,
        backgroundCodex: true,
        createThreadViaBackground: true
      }
    }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

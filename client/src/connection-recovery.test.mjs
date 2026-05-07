import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionRecoveryState } from './connection-recovery.js';

test('connectionRecoveryState maps connection states to recovery cards', () => {
  assert.equal(connectionRecoveryState({ authenticated: false }).state, 'pairing');
  assert.equal(connectionRecoveryState({ connectionState: 'connecting' }).state, 'reconnecting');
  assert.equal(connectionRecoveryState({ connectionState: 'disconnected' }).state, 'disconnected');
  assert.equal(connectionRecoveryState({ syncing: true }).state, 'syncing');
  assert.deepEqual(
    connectionRecoveryState({
      syncing: true,
      connectionState: 'connected',
      desktopBridge: { mode: 'desktop-ipc', connected: true }
    }),
    null
  );
});

test('connectionRecoveryState reports desktop bridge problems but stays quiet when healthy', () => {
  assert.deepEqual(
    connectionRecoveryState({
      connectionState: 'connected',
      desktopBridge: { mode: 'desktop-ipc', connected: true }
    }),
    null
  );
  assert.equal(
    connectionRecoveryState({
      connectionState: 'connected',
      desktopBridge: { mode: 'desktop-ipc', connected: false, reason: 'not open' }
    }).state,
    'desktop-unavailable'
  );
});

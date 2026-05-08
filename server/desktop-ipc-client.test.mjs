import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DesktopIpcClient,
  desktopIpcMethodVersion,
  submitDesktopFollowerUserInput
} from './desktop-ipc-client.js';

test('desktop follower IPC methods use the current desktop protocol version', () => {
  assert.equal(desktopIpcMethodVersion('initialize'), 0);
  assert.equal(desktopIpcMethodVersion('thread-archived'), 2);
  assert.equal(desktopIpcMethodVersion('thread-follower-start-turn'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-steer-turn'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-interrupt-turn'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-set-collaboration-mode'), 1);
  assert.equal(desktopIpcMethodVersion('thread-follower-submit-user-input'), 1);
});

function frameFor(payload) {
  const json = JSON.stringify(payload);
  const frame = Buffer.alloc(4 + Buffer.byteLength(json));
  frame.writeUInt32LE(Buffer.byteLength(json), 0);
  frame.write(json, 4);
  return frame;
}

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected = null;
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expected == null && buffer.length >= 4) {
        expected = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
      }
      if (expected != null && buffer.length >= expected) {
        socket.off('data', onData);
        resolve(JSON.parse(buffer.subarray(0, expected).toString('utf8')));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

async function createSocketEndpoint() {
  if (process.platform === 'win32') {
    return {
      socketPath: String.raw`\\.\pipe\codexmobile-ipc-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cleanup: async () => {}
    };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-ipc-test-'));
  return {
    socketPath: path.join(dir, 'ipc.sock'),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

test('sendBroadcast writes desktop IPC broadcast frames', async () => {
  const endpoint = await createSocketEndpoint();
  const socketPath = endpoint.socketPath;
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const client = new DesktopIpcClient({ clientType: 'codexmobile-test', socketPath });
  const connected = client.connect({ timeoutMs: 1000 });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));
  await connected;

  client.sendBroadcast('thread-archived', {
    hostId: 'local',
    conversationId: 'thread-1',
    cwd: null
  });
  const broadcast = await readFrame(socket);

  assert.equal(broadcast.type, 'broadcast');
  assert.equal(broadcast.method, 'thread-archived');
  assert.equal(broadcast.sourceClientId, 'client-1');
  assert.equal(broadcast.version, 2);
  assert.deepEqual(broadcast.params, {
    hostId: 'local',
    conversationId: 'thread-1',
    cwd: null
  });

  client.close();
  server.close();
  await endpoint.cleanup();
});

test('submitDesktopFollowerUserInput writes the desktop IPC request frame', async () => {
  const endpoint = await createSocketEndpoint();
  const socketPath = endpoint.socketPath;
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const submitted = submitDesktopFollowerUserInput('conversation-1', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    response: { answers: { choice: { answers: ['A'] } } }
  }, { socketPath, timeoutMs: 1000 });
  const socket = await accepted;
  const init = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: init.requestId,
    resultType: 'success',
    method: 'initialize',
    result: { clientId: 'client-1' }
  }));

  const request = await readFrame(socket);
  socket.write(frameFor({
    type: 'response',
    requestId: request.requestId,
    resultType: 'success',
    method: 'thread-follower-submit-user-input',
    result: { accepted: true }
  }));
  const result = await submitted;

  assert.equal(request.type, 'request');
  assert.equal(request.method, 'thread-follower-submit-user-input');
  assert.equal(request.sourceClientId, 'client-1');
  assert.equal(request.version, 1);
  assert.deepEqual(request.params, {
    conversationId: 'conversation-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    response: { answers: { choice: { answers: ['A'] } } }
  });
  assert.deepEqual(result, { accepted: true });

  socket.destroy();
  server.close();
  await endpoint.cleanup();
});

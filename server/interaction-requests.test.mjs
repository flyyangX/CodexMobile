/**
 * 测试 server/interaction-requests.js：Codex app-server 运行中提问/审批请求的挂起、广播与响应结果。
 *
 * Keywords: interaction, approval, user-input, app-server, test
 *
 * Exports: 无导出，内含用例
 *
 * Inward: interaction-requests.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractionBroker } from './interaction-requests.js';

test('requestUserInput stays pending until the mobile response supplies answers', async () => {
  const broadcasts = [];
  const broker = createInteractionBroker({
    broadcast: (payload) => broadcasts.push(payload),
    timeoutMs: 1000
  });

  const pending = broker.requestFromAppServer(
    {
      id: 'app-request-1',
      method: 'item/tool/requestUserInput',
      params: {
        title: '检查方式',
        questions: [
          {
            id: 'check_method',
            question: '更新检查要做到什么程度？',
            options: [
              { label: '自动检查 + 手动更新', description: '只在点击按钮时执行更新。' },
              { label: '仅手动检查', description: '不主动联网。' }
            ]
          }
        ]
      }
    },
    { projectId: 'project-1', sessionId: 'thread-1', turnId: 'turn-1' }
  );

  const pendingInteractions = broker.listPendingInteractions({ sessionId: 'thread-1' });
  assert.equal(pendingInteractions.length, 1);
  assert.equal(pendingInteractions[0].kind, 'user_input');
  assert.equal(pendingInteractions[0].title, '检查方式');
  assert.equal(pendingInteractions[0].questions[0].options.length, 2);
  assert.equal(broadcasts[0].type, 'sync-event');
  assert.equal(broadcasts[0].event.eventType, 'interaction.requested');
  assert.equal(broadcasts[0].event.interaction.id, pendingInteractions[0].id);

  await broker.respondInteraction(pendingInteractions[0].id, {
    answers: { check_method: '仅手动检查' }
  });

  await assert.doesNotReject(pending);
  assert.deepEqual(await pending, { answers: { check_method: { answers: ['仅手动检查'] } } });
  assert.equal(broker.listPendingInteractions().length, 0);
  assert.equal(broadcasts.at(-1).type, 'sync-event');
  assert.equal(broadcasts.at(-1).event.eventType, 'interaction.resolved');
  assert.equal(broadcasts.at(-1).event.interactionId, pendingInteractions[0].id);
});

test('requestUserInput rejects approved responses missing required answers', async () => {
  const broker = createInteractionBroker({ broadcast: () => null, timeoutMs: 1000 });
  const pending = broker.requestFromAppServer(
    {
      id: 'app-request-empty',
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'check_method',
            question: '更新检查要做到什么程度？',
            options: ['自动检查 + 手动更新', '仅手动检查']
          }
        ]
      }
    },
    { projectId: 'project-1', sessionId: 'thread-1', turnId: 'turn-1' }
  );

  const interaction = broker.listPendingInteractions()[0];
  assert.throws(
    () => broker.respondInteraction(interaction.id, { action: 'approve', answers: {} }),
    /missing required answers/
  );
  assert.equal(broker.listPendingInteractions().length, 1);

  await broker.cancelInteraction(interaction.id);
  assert.deepEqual(await pending, { answers: {} });
});

test('requestUserInput accepts content object as answer payload for client compatibility', async () => {
  const broker = createInteractionBroker({ broadcast: () => null, timeoutMs: 1000 });
  const pending = broker.requestFromAppServer(
    {
      id: 'app-request-content',
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'check_method',
            question: '更新检查要做到什么程度？',
            options: ['自动检查 + 手动更新', '仅手动检查']
          }
        ]
      }
    },
    { projectId: 'project-1', sessionId: 'thread-1', turnId: 'turn-1' }
  );

  const interaction = broker.listPendingInteractions()[0];
  await broker.respondInteraction(interaction.id, {
    action: 'approve',
    content: { check_method: '自动检查 + 手动更新' }
  });

  assert.deepEqual(await pending, { answers: { check_method: { answers: ['自动检查 + 手动更新'] } } });
});

test('elicitation request accepts JSON schema questions and returns content answers', async () => {
  const broadcasts = [];
  const broker = createInteractionBroker({
    broadcast: (payload) => broadcasts.push(payload),
    timeoutMs: 1000
  });

  const pending = broker.requestFromAppServer(
    {
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        message: '生成计划前需要补充信息。',
        requestedSchema: {
          type: 'object',
          required: ['scope'],
          properties: {
            scope: {
              title: '更新检查要做到什么程度？',
              description: '影响联网、下载和安装策略。',
              enum: ['auto_check_manual_update', 'manual_only'],
              enumNames: ['自动检查 + 手动更新', '仅手动检查']
            },
            channel: {
              title: '在哪里展示提醒？',
              oneOf: [
                { const: 'settings', title: '设置页', description: '只在设置页展示。' },
                { const: 'chat', title: '聊天流', description: '作为运行中卡片展示。' }
              ]
            }
          }
        }
      }
    },
    { projectId: 'project-1', sessionId: 'thread-1', turnId: 'turn-1' }
  );

  const interaction = broker.listPendingInteractions()[0];
  assert.equal(interaction.kind, 'elicitation');
  assert.equal(interaction.questions.length, 2);
  assert.equal(interaction.questions[0].id, 'scope');
  assert.equal(interaction.questions[0].description, '影响联网、下载和安装策略。');
  assert.equal(interaction.questions[0].options[0].label, '自动检查 + 手动更新');
  assert.equal(interaction.questions[1].options[1].id, 'chat');
  assert.equal(broadcasts[0].event.interaction.prompt, '生成计划前需要补充信息。');

  await broker.respondInteraction(interaction.id, {
    action: 'approve',
    answers: {
      scope: 'manual_only',
      channel: 'chat'
    }
  });

  assert.deepEqual(await pending, {
    action: 'accept',
    content: {
      scope: 'manual_only',
      channel: 'chat'
    },
    _meta: null
  });
});

test('command approval response maps approve and decline decisions for app-server', async () => {
  const broker = createInteractionBroker({ broadcast: () => null, timeoutMs: 1000 });
  const approved = broker.requestFromAppServer(
    {
      id: 'command-approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        command: 'npm test',
        reason: '需要运行测试'
      }
    },
    { projectId: 'project-1', sessionId: 'thread-1', turnId: 'turn-1' }
  );
  const approvalRequest = broker.listPendingInteractions()[0];
  await broker.respondInteraction(approvalRequest.id, { action: 'approve' });
  assert.deepEqual(await approved, { decision: 'approve' });

  const declined = broker.requestFromAppServer(
    {
      id: 'command-approval-2',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'rm -rf tmp' }
    },
    { projectId: 'project-1', sessionId: 'thread-1', turnId: 'turn-1' }
  );
  const declineRequest = broker.listPendingInteractions()[0];
  await broker.respondInteraction(declineRequest.id, { action: 'decline' });
  assert.deepEqual(await declined, { decision: 'decline' });
});

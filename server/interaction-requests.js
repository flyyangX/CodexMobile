/**
 * 管理 Codex app-server 运行中提问与审批请求：广播到移动端，等待用户响应后回填 app-server。
 *
 * Keywords: interaction, approval, user-input, app-server, broker
 *
 * Exports:
 * - createInteractionBroker — 创建内存 pending 请求管理器。
 *
 * Inward（本模块依赖/组装的关键符号）: app-server server request 消息、HTTP 响应体、WebSocket broadcast。
 *
 * Outward（谁在用/调用场景）: chat-service、codex-runner、chat-routes。
 *
 * 不负责: React UI 渲染。
 */
import { createSyncEventPayload } from './sync/sync-events.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  const text = String(value || '').trim();
  return text;
}

function requestIdFor(message = {}) {
  return clean(message.id || message.requestId || `${message.method || 'interaction'}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function optionTitle(option = {}, fallback = '') {
  return clean(option.label || option.title || option.name || option.const || option.value || option.id || fallback);
}

function normalizeOptions(options = []) {
  return (Array.isArray(options) ? options : [])
    .map((option, index) => {
      if (typeof option === 'string') {
        return { id: option, label: option, description: '', recommended: index === 0 };
      }
      const label = optionTitle(option, `选项 ${index + 1}`);
      return {
        id: clean(option?.id || option?.value || option?.const || label),
        label,
        description: clean(option?.description || option?.detail || option?.body),
        recommended: Boolean(option?.recommended || option?.isRecommended || index === 0 && /\brecommended\b/i.test(label))
      };
    })
    .filter((option) => option.label);
}

function optionsFromJsonSchema(field = {}) {
  if (Array.isArray(field.options) || Array.isArray(field.choices)) {
    return normalizeOptions(field.options || field.choices);
  }
  if (Array.isArray(field.enum)) {
    const names = Array.isArray(field.enumNames) ? field.enumNames : [];
    return normalizeOptions(field.enum.map((value, index) => ({
      id: String(value),
      value: String(value),
      label: names[index] || String(value),
      description: ''
    })));
  }
  const variants = Array.isArray(field.oneOf) ? field.oneOf : Array.isArray(field.anyOf) ? field.anyOf : [];
  return normalizeOptions(variants.map((variant, index) => ({
    id: clean(variant.const || variant.value || variant.title || `option_${index + 1}`),
    value: clean(variant.const || variant.value || variant.title || `option_${index + 1}`),
    label: optionTitle(variant, `选项 ${index + 1}`),
    description: clean(variant.description)
  })));
}

function questionsFromJsonSchema(schema = {}) {
  const root = schema?.requestedSchema || schema?.inputSchema || schema;
  const properties = root?.properties && typeof root.properties === 'object' ? root.properties : null;
  if (!properties) {
    return [];
  }
  const required = new Set(Array.isArray(root.required) ? root.required.map(String) : []);
  return Object.entries(properties)
    .map(([key, field = {}], index) => {
      const options = optionsFromJsonSchema(field);
      return {
        id: clean(field.id || field.name || key || `answer_${index + 1}`),
        header: clean(field.header || field.group || field.category || field.title),
        question: clean(field.question || field.prompt || field.title || field.label || key),
        description: clean(field.description || field.detail || field.body),
        options,
        placeholder: clean(field.placeholder || field.freeformPlaceholder || '请描述其他答案'),
        allowCustom: field.allowCustom !== false && (!options.length || field.type !== 'boolean'),
        required: required.has(key)
      };
    })
    .filter((question) => question.id && (question.question || question.options.length));
}

function normalizeQuestions(params = {}) {
  const schemaQuestions = questionsFromJsonSchema(params.requestedSchema || params.inputSchema || params.schema || {});
  if (schemaQuestions.length) {
    return schemaQuestions;
  }
  const rawQuestions =
    params.questions ||
    params.input?.questions ||
    params.schema?.questions ||
    params.elicitation?.questions ||
    [];
  const questions = (Array.isArray(rawQuestions) ? rawQuestions : [])
    .map((question, index) => ({
      id: clean(question?.id || question?.name || `answer_${index + 1}`),
      header: clean(question?.header || question?.label || question?.title),
      question: clean(question?.question || question?.prompt || question?.label || question?.title),
      description: clean(question?.description || question?.detail || question?.body),
      options: normalizeOptions(question?.options || question?.choices || question?.enum || []),
      placeholder: clean(question?.placeholder || question?.freeformPlaceholder || '请描述其他答案'),
      allowCustom: question?.allowCustom !== false,
      required: question?.required !== false
    }))
    .filter((question) => question.id && (question.question || question.options.length));
  if (questions.length) {
    return questions;
  }
  const prompt = clean(params.prompt || params.message || params.title || params.label);
  return prompt
    ? [{ id: 'answer', header: '', question: prompt, description: '', options: normalizeOptions(params.options || params.choices || []), placeholder: '请描述其他答案', allowCustom: true, required: true }]
    : [];
}

function commandText(params = {}) {
  if (typeof params.command === 'string') {
    return params.command;
  }
  if (Array.isArray(params.command)) {
    return params.command.join(' ');
  }
  if (params.command && typeof params.command === 'object') {
    return clean(params.command.command || params.command.cmd || params.command.text);
  }
  return clean(params.cmd || params.shellCommand || params.description);
}

function fileChangeText(params = {}) {
  const changes = params.fileChanges || params.changes || params.files || [];
  if (Array.isArray(changes) && changes.length) {
    return changes
      .map((change) => clean(change?.path || change?.file || change?.filename || change))
      .filter(Boolean)
      .join('\n');
  }
  return clean(params.path || params.file || params.description || params.reason);
}

function interactionKind(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return 'command_approval';
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return 'file_approval';
    case 'item/permissions/requestApproval':
      return 'permissions';
    case 'item/tool/requestUserInput':
      return 'user_input';
    case 'mcpServer/elicitation/request':
      return 'elicitation';
    default:
      return 'interaction';
  }
}

function interactionFromMessage(message = {}, context = {}) {
  const method = clean(message.method);
  const params = message.params || {};
  const kind = interactionKind(method);
  const id = `interaction-${requestIdFor(message)}`;
  const base = {
    id,
    appRequestId: requestIdFor(message),
    method,
    kind,
    projectId: clean(context.projectId),
    sessionId: clean(context.sessionId),
    turnId: clean(context.turnId),
    title: clean(params.title || params.label),
    prompt: clean(params.prompt || params.message || params.instruction || params.reason || params.description),
    questions: normalizeQuestions(params),
    permissions: params.permissions || params.requestedPermissions || {},
    scope: clean(params.scope || 'turn') || 'turn',
    status: 'pending',
    createdAt: nowIso()
  };
  if (kind === 'command_approval') {
    return {
      ...base,
      title: base.title || '允许执行命令？',
      prompt: commandText(params) || base.prompt,
      questions: []
    };
  }
  if (kind === 'file_approval') {
    return {
      ...base,
      title: base.title || '允许修改文件？',
      prompt: fileChangeText(params) || base.prompt,
      questions: []
    };
  }
  if (kind === 'permissions') {
    return {
      ...base,
      title: base.title || '确认授权',
      prompt: base.prompt || 'Codex 请求扩大本轮权限。',
      questions: []
    };
  }
  if (kind === 'elicitation') {
    return {
      ...base,
      title: base.title || '需要补充信息',
      prompt: base.prompt || clean(params.message || params.instruction),
      questions: base.questions
    };
  }
  return {
    ...base,
    title: base.title || '需要你选择',
    prompt: base.prompt || base.questions[0]?.question || ''
  };
}

function responseAction(response = {}) {
  const action = clean(response.action || response.decision || response.status).toLowerCase();
  if (['approve', 'approved', 'accept', 'accepted', 'confirm', 'confirmed', 'allow', 'allowed'].includes(action)) {
    return 'approve';
  }
  if (['skip', 'cancel', 'cancelled', 'canceled', 'decline', 'declined', 'deny', 'denied', 'reject', 'rejected'].includes(action)) {
    return 'decline';
  }
  return action || '';
}

function answersFromResponse(response = {}, interaction = {}) {
  if (response.answers && typeof response.answers === 'object') {
    return response.answers;
  }
  if (response.content && typeof response.content === 'object') {
    return response.content;
  }
  const questionId = interaction.questions?.[0]?.id || 'answer';
  const value = response.value ?? response.answer ?? response.selectedOption ?? response.option ?? response.text ?? '';
  return value ? { [questionId]: value } : {};
}

function answerValues(value) {
  if (Array.isArray(value)) {
    return value.map((item) => clean(item)).filter(Boolean);
  }
  if (value && typeof value === 'object' && Array.isArray(value.answers)) {
    return value.answers.map((item) => clean(item)).filter(Boolean);
  }
  const text = clean(value);
  return text ? [text] : [];
}

function appServerUserInputAnswers(answers = {}) {
  const result = {};
  for (const [questionId, value] of Object.entries(answers || {})) {
    const values = answerValues(value);
    if (questionId && values.length) {
      result[questionId] = { answers: values };
    }
  }
  return result;
}

function elicitationContentAnswers(answers = {}) {
  const result = {};
  for (const [questionId, value] of Object.entries(answers || {})) {
    const values = answerValues(value);
    if (!questionId || !values.length) {
      continue;
    }
    result[questionId] = values.length === 1 ? values[0] : values;
  }
  return result;
}

function requiredQuestions(interaction = {}) {
  return (Array.isArray(interaction.questions) ? interaction.questions : [])
    .filter((question) => question.required !== false);
}

function missingRequiredAnswers(interaction = {}, answers = {}) {
  return requiredQuestions(interaction)
    .filter((question) => !answerValues(answers?.[question.id]).length)
    .map((question) => question.id);
}

function validateInteractionResponse(interaction = {}, response = {}, status = 'completed') {
  if (status !== 'completed') {
    return;
  }
  const action = responseAction(response);
  const isApproved = action === 'approve' || !action;
  if (!isApproved || !['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(interaction.method)) {
    return;
  }
  const answers = answersFromResponse(response, interaction);
  const missing = missingRequiredAnswers(interaction, answers);
  if (!missing.length) {
    return;
  }
  const error = new Error('Interaction response is missing required answers');
  error.statusCode = 400;
  error.code = 'MISSING_REQUIRED_INTERACTION_ANSWERS';
  error.missingAnswers = missing;
  throw error;
}

function appServerResultForResponse(interaction = {}, response = {}) {
  if (response.result && typeof response.result === 'object') {
    return response.result;
  }
  const action = responseAction(response);
  const approved = action === 'approve';
  switch (interaction.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: approved ? 'approve' : 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: approved ? 'approved' : 'denied' };
    case 'item/permissions/requestApproval':
      return approved
        ? { permissions: response.permissions || interaction.permissions || {}, scope: response.scope || interaction.scope || 'turn' }
        : { permissions: {}, scope: response.scope || interaction.scope || 'turn' };
    case 'item/tool/requestUserInput':
      return { answers: approved || !action ? appServerUserInputAnswers(answersFromResponse(response, interaction)) : {} };
    case 'mcpServer/elicitation/request':
      return approved || (!action && (response.content || response.answers))
        ? { action: 'accept', content: elicitationContentAnswers(response.content ?? response.answers ?? answersFromResponse(response, interaction)), _meta: response._meta || null }
        : { action: 'decline', content: null, _meta: null };
    default:
      return response;
  }
}

function conservativeResult(interaction = {}) {
  return appServerResultForResponse(interaction, { action: 'decline' });
}

export function createInteractionBroker({ broadcast = () => null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const pending = new Map();

  function listPendingInteractions(filter = {}) {
    const sessionId = clean(filter.sessionId);
    const turnId = clean(filter.turnId);
    return [...pending.values()]
      .map((entry) => entry.interaction)
      .filter((interaction) =>
        (!sessionId || interaction.sessionId === sessionId) &&
        (!turnId || interaction.turnId === turnId)
      );
  }

  function settleInteraction(id, response = {}, status = 'completed') {
    const key = clean(id);
    const entry = pending.get(key);
    if (!entry) {
      const error = new Error('Interaction request not found');
      error.statusCode = 404;
      throw error;
    }
    validateInteractionResponse(entry.interaction, response, status);
    pending.delete(key);
    clearTimeout(entry.timeout);
    const result = status === 'completed'
      ? appServerResultForResponse(entry.interaction, response)
      : conservativeResult(entry.interaction);
    entry.resolve(result);
    broadcast(createSyncEventPayload('interaction.resolved', {
      interactionId: key,
      projectId: entry.interaction.projectId,
      sessionId: entry.interaction.sessionId,
      turnId: entry.interaction.turnId,
      status,
      timestamp: nowIso()
    }, {
      interactionId: key
    }));
    return { success: true, interactionId: key, result, status };
  }

  function requestFromAppServer(message = {}, context = {}) {
    const interaction = interactionFromMessage(message, context);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!pending.has(interaction.id)) {
          return;
        }
        pending.delete(interaction.id);
        const result = conservativeResult(interaction);
        resolve(result);
        broadcast(createSyncEventPayload('interaction.resolved', {
          interactionId: interaction.id,
          projectId: interaction.projectId,
          sessionId: interaction.sessionId,
          turnId: interaction.turnId,
          status: 'timeout',
          timestamp: nowIso()
        }, {
          interactionId: interaction.id
        }));
      }, timeoutMs);
      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }
      pending.set(interaction.id, { interaction, resolve, timeout });
      broadcast(createSyncEventPayload('interaction.requested', {
        projectId: interaction.projectId,
        sessionId: interaction.sessionId,
        turnId: interaction.turnId,
        label: interaction.title || '等待用户确认',
        detail: interaction.prompt || '',
        interaction,
        timestamp: interaction.createdAt
      }, {
        interaction
      }));
    });
  }

  function respondInteraction(id, response = {}) {
    return settleInteraction(id, response, 'completed');
  }

  function cancelInteraction(id, response = {}) {
    return settleInteraction(id, response, 'cancelled');
  }

  function cancelInteractionsForRun(filter = {}) {
    if (!clean(filter.sessionId) && !clean(filter.turnId)) {
      return [];
    }
    const ids = listPendingInteractions(filter).map((interaction) => interaction.id);
    return ids.map((id) => cancelInteraction(id));
  }

  return {
    requestFromAppServer,
    respondInteraction,
    cancelInteraction,
    cancelInteractionsForRun,
    listPendingInteractions
  };
}

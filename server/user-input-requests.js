function stringOrEmpty(value) {
  return String(value || '').trim();
}

export function userInputRequestKey({ threadId, turnId, itemId } = {}) {
  return [threadId, turnId, itemId].map(stringOrEmpty).join(':');
}

function normalizeOptions(options) {
  return Array.isArray(options)
    ? options.map((option) => ({
      label: String(option?.label || ''),
      description: String(option?.description || '')
    }))
    : null;
}

export function normalizeUserInputRequest(message = {}) {
  const params = message.params || {};
  const request = {
    threadId: stringOrEmpty(params.threadId),
    turnId: stringOrEmpty(params.turnId),
    itemId: stringOrEmpty(params.itemId),
    questions: Array.isArray(params.questions)
      ? params.questions.map((question) => ({
        id: stringOrEmpty(question?.id),
        header: String(question?.header || ''),
        question: String(question?.question || ''),
        isOther: Boolean(question?.isOther),
        isSecret: Boolean(question?.isSecret),
        options: normalizeOptions(question?.options)
      })).filter((question) => question.id)
      : []
  };
  const conversationId = stringOrEmpty(params.conversationId || message.conversationId);
  if (conversationId) {
    request.conversationId = conversationId;
  }
  const transport = stringOrEmpty(params.transport || message.transport);
  if (transport) {
    request.transport = transport;
  }
  const delivery = stringOrEmpty(params.delivery || message.delivery);
  if (delivery) {
    request.delivery = delivery;
  }
  if (!request.threadId || !request.turnId || !request.itemId || !request.questions.length) {
    throw new Error('Malformed user input request');
  }
  return request;
}

export function normalizeUserInputAnswers(value = {}) {
  const source = value.answers && typeof value.answers === 'object' ? value.answers : value;
  const answers = {};
  for (const [questionId, answerValue] of Object.entries(source || {})) {
    const rawAnswers = Array.isArray(answerValue)
      ? answerValue
      : Array.isArray(answerValue?.answers)
        ? answerValue.answers
        : [];
    answers[questionId] = {
      answers: rawAnswers.map((answer) => String(answer)).filter((answer) => answer.length > 0)
    };
  }
  return { answers };
}

export function normalizeDesktopUserInputSubmission(body = {}) {
  const conversationId = stringOrEmpty(body.conversationId);
  if (!conversationId) {
    return null;
  }
  return {
    conversationId,
    threadId: stringOrEmpty(body.threadId || body.sessionId),
    turnId: stringOrEmpty(body.turnId),
    itemId: stringOrEmpty(body.itemId),
    response: normalizeUserInputAnswers(body.answers || body.response || {})
  };
}

export class PendingUserInputRequests {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.records = new Map();
  }

  add(message, resolve) {
    const request = normalizeUserInputRequest(message);
    const key = userInputRequestKey(request);
    const record = {
      key,
      request,
      resolve,
      createdAt: this.now(),
      completed: false
    };
    this.records.set(key, record);
    return { key, request };
  }

  list() {
    return [...this.records.values()].map((record) => ({
      ...record.request,
      key: record.key,
      createdAt: record.createdAt
    }));
  }

  answer({ threadId, turnId, itemId, answers }) {
    const key = userInputRequestKey({ threadId, turnId, itemId });
    const record = this.records.get(key);
    if (!record) {
      return { ok: false, reason: 'not-found' };
    }
    this.records.delete(key);
    record.completed = true;
    record.resolve(normalizeUserInputAnswers(answers || {}));
    return { ok: true, request: record.request };
  }

  clearForTurn({ threadId, turnId } = {}) {
    const cleared = [];
    for (const [key, record] of this.records.entries()) {
      if (
        (!threadId || record.request.threadId === threadId) &&
        (!turnId || record.request.turnId === turnId)
      ) {
        this.records.delete(key);
        cleared.push({
          ...record.request,
          key: record.key,
          createdAt: record.createdAt
        });
      }
    }
    return cleared;
  }
}

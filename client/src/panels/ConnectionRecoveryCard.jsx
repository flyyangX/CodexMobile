export function ConnectionRecoveryCard({ state, onRetry, onSync, onPair, onStatus }) {
  if (!state) {
    return null;
  }

  function runAction(action) {
    if (action === 'pair') {
      onPair?.();
    } else if (action === 'sync') {
      onSync?.();
    } else if (action === 'status') {
      onStatus?.();
    } else {
      onRetry?.();
    }
  }

  return (
    <section className={`connection-recovery-card is-${state.state}`} aria-label="连接恢复">
      <span className="connection-recovery-dot" />
      <span className="connection-recovery-main">
        <strong>{state.title}</strong>
        <small>{state.detail}</small>
      </span>
      <button type="button" onClick={() => runAction(state.primaryAction)}>
        {state.primaryLabel}
      </button>
      {state.secondaryAction ? (
        <button type="button" onClick={() => runAction(state.secondaryAction)}>
          {state.secondaryLabel}
        </button>
      ) : null}
    </section>
  );
}

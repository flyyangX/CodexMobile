import { X } from 'lucide-react';

export function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) {
    return null;
  }
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-item is-${toast.level || 'info'}`}>
          <span className="toast-dot" />
          <span>
            <strong>{toast.title}</strong>
            {toast.body ? <small>{toast.body}</small> : null}
          </span>
          <button type="button" onClick={() => onDismiss(toast.id)} aria-label="关闭提醒">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

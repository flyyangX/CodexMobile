export const THEME_KEY = 'codexmobile.theme';

export function createInitialUiState({ storage = globalThis.localStorage } = {}) {
  return {
    drawerOpen: false,
    previewImage: null,
    docsOpen: false,
    docsBusy: false,
    docsError: '',
    gitPanel: { open: false, action: 'commit' },
    toasts: [],
    theme: storage?.getItem?.(THEME_KEY) === 'dark' ? 'dark' : 'light'
  };
}

function resolveValue(value, current) {
  return typeof value === 'function' ? value(current) : value;
}

export function appReducer(state, action) {
  switch (action.type) {
    case 'ui/drawerOpen':
      return { ...state, drawerOpen: resolveValue(action.value, state.drawerOpen) };
    case 'ui/previewImage':
      return { ...state, previewImage: resolveValue(action.value, state.previewImage) };
    case 'ui/docsOpen':
      return { ...state, docsOpen: resolveValue(action.value, state.docsOpen) };
    case 'ui/docsBusy':
      return { ...state, docsBusy: resolveValue(action.value, state.docsBusy) };
    case 'ui/docsError':
      return { ...state, docsError: resolveValue(action.value, state.docsError) };
    case 'ui/gitPanel':
      return { ...state, gitPanel: resolveValue(action.value, state.gitPanel) };
    case 'ui/toasts':
      return { ...state, toasts: resolveValue(action.value, state.toasts) };
    case 'ui/theme':
      return { ...state, theme: resolveValue(action.value, state.theme) };
    default:
      return state;
  }
}

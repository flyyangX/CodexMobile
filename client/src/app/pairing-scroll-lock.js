/**
 * 配对页滚动兜底：临时解除主 App 的 fixed/hidden 滚动锁，避免移动端键盘遮挡输入框。
 *
 * Keywords: pairing, scroll-lock, mobile-keyboard
 *
 * Exports:
 * - unlockPairingPageScroll — 挂载时应用兜底样式，返回卸载还原函数。
 */

const PAIRING_CLASS = 'is-pairing-screen';

const HTML_UNLOCK_STYLES = {
  height: 'auto',
  minHeight: '100%',
  overflowY: 'auto',
  overscrollBehaviorY: 'auto'
};

const BODY_UNLOCK_STYLES = {
  position: 'static',
  inset: 'auto',
  width: '100%',
  height: 'auto',
  minHeight: '100%',
  overflowX: 'hidden',
  overflowY: 'auto',
  overscrollBehaviorY: 'auto',
  touchAction: 'auto'
};

const ROOT_UNLOCK_STYLES = {
  height: 'auto',
  minHeight: '100%',
  overflow: 'visible'
};

function snapshotStyle(element, styles) {
  const snapshot = {};
  for (const property of Object.keys(styles)) {
    snapshot[property] = element?.style?.[property] || '';
  }
  return snapshot;
}

function applyStyles(element, styles) {
  if (!element?.style) {
    return;
  }
  for (const [property, value] of Object.entries(styles)) {
    element.style[property] = value;
  }
}

export function unlockPairingPageScroll(documentLike = globalThis.document) {
  const documentElement = documentLike?.documentElement;
  const body = documentLike?.body;
  const root = documentLike?.getElementById?.('root');
  const snapshots = [
    [documentElement, snapshotStyle(documentElement, HTML_UNLOCK_STYLES)],
    [body, snapshotStyle(body, BODY_UNLOCK_STYLES)],
    [root, snapshotStyle(root, ROOT_UNLOCK_STYLES)]
  ];

  documentElement?.classList?.add(PAIRING_CLASS);
  body?.classList?.add(PAIRING_CLASS);
  applyStyles(documentElement, HTML_UNLOCK_STYLES);
  applyStyles(body, BODY_UNLOCK_STYLES);
  applyStyles(root, ROOT_UNLOCK_STYLES);

  return () => {
    documentElement?.classList?.remove(PAIRING_CLASS);
    body?.classList?.remove(PAIRING_CLASS);
    for (const [element, snapshot] of snapshots) {
      applyStyles(element, snapshot);
    }
  };
}

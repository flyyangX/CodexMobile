import { useEffect } from 'react';

export function viewportSizingMetrics({
  visualViewport = null,
  innerHeight = 0,
  innerWidth = 0,
  clientHeight = 0
} = {}) {
  const height = Math.round(visualViewport?.height || innerHeight || 0);
  const width = Math.round(visualViewport?.width || innerWidth || 0);
  const layoutHeight = Math.round(clientHeight || innerHeight || 0);
  const viewportOffsetTop = Math.round(visualViewport?.offsetTop || 0);
  const keyboardInset = Math.max(0, Math.round((innerHeight || layoutHeight) - height - viewportOffsetTop));
  const keyboardOpen =
    keyboardInset > 120 ||
    (height > 0 && layoutHeight > 0 && layoutHeight - height > 120);
  return {
    height,
    width,
    keyboardInset,
    keyboardOpen
  };
}

export function shouldResetWindowScroll({ enabled = true, scrollX = 0, scrollY = 0 } = {}) {
  return Boolean(enabled) && (Boolean(scrollX) || Boolean(scrollY));
}

export function useViewportSizing(composerRef, { enabled = true } = {}) {
  useEffect(() => {
    const root = document.documentElement;
    if (!enabled) {
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-width');
      root.style.removeProperty('--composer-height');
      root.style.removeProperty('--keyboard-inset');
      delete root.dataset.keyboard;
      return undefined;
    }

    let frame = 0;
    let observeFrame = 0;
    let composerObserver = null;
    const updateViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const {
          height,
          width,
          keyboardInset,
          keyboardOpen
        } = viewportSizingMetrics({
          visualViewport: viewport,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          clientHeight: document.documentElement.clientHeight
        });
        if (height > 0) {
          root.style.setProperty('--app-height', `${height}px`);
        }
        if (width > 0) {
          root.style.setProperty('--app-width', `${width}px`);
        }
        root.style.setProperty('--keyboard-inset', `${keyboardInset}px`);
        const composer = composerRef?.current;
        const composerHeight = Math.ceil(composer?.getBoundingClientRect().height || 0);
        if (composerHeight > 0) {
          root.style.setProperty('--composer-height', `${composerHeight}px`);
        }
        root.dataset.keyboard = keyboardOpen ? 'open' : 'closed';
        if (shouldResetWindowScroll({ enabled, scrollX: window.scrollX, scrollY: window.scrollY })) {
          window.scrollTo(0, 0);
        }
      });
    };

    const observeComposer = () => {
      if (typeof ResizeObserver === 'undefined' || !composerRef?.current) {
        return;
      }
      composerObserver = new ResizeObserver(updateViewport);
      composerObserver.observe(composerRef.current);
    };

    updateViewport();
    observeFrame = requestAnimationFrame(observeComposer);
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(observeFrame);
      composerObserver?.disconnect();
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-width');
      root.style.removeProperty('--composer-height');
      root.style.removeProperty('--keyboard-inset');
      delete root.dataset.keyboard;
    };
  }, [composerRef, enabled]);
}

import { Minus, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useResolvedImageSource } from '../app/session-utils.js';

export function GeneratedImage({ part, onPreviewImage, compact = false }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);
  const resolved = useResolvedImageSource(part.url, retryKey);
  const src = resolved.src;

  useEffect(() => {
    setLoadState(resolved.error ? 'failed' : resolved.cached ? 'loaded' : 'loading');
  }, [resolved.cached, resolved.error, src]);

  function retry(event) {
    event.stopPropagation();
    setLoadState('loading');
    setRetryKey(Date.now());
  }

  return (
    <button
      type="button"
      className={`message-image-link ${compact ? 'is-thumbnail' : ''} ${loadState === 'failed' ? 'is-failed' : ''}`}
      onClick={() => (loadState === 'failed' ? setRetryKey(Date.now()) : onPreviewImage?.(part))}
      aria-label="预览图片"
    >
      {src ? (
        <img
          className="message-image"
          src={src}
          alt={part.alt}
          loading="eager"
          decoding="async"
          onLoad={() => setLoadState('loaded')}
          onError={() => setLoadState('failed')}
        />
      ) : null}
      {loadState === 'failed' ? (
        <span className="image-error">
          图片加载失败
          <span onClick={retry}>重试</span>
        </span>
      ) : null}
    </button>
  );
}

export function UserImageStrip({ images, onPreviewImage }) {
  if (!images?.length) {
    return null;
  }
  return (
    <div className="message-image-strip" aria-label="图片附件">
      {images.map((image, index) => (
        <GeneratedImage
          key={`${image.url}-${index}`}
          part={image}
          onPreviewImage={onPreviewImage}
          compact
        />
      ))}
    </div>
  );
}

export function ImagePreviewModal({ image, onClose }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [isGesturing, setIsGesturing] = useState(false);
  const imageRef = useRef(null);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null);
  const lastTapRef = useRef(0);
  const resolved = useResolvedImageSource(image?.url, retryKey);

  const clampScale = useCallback((value) => Math.min(5, Math.max(1, value)), []);
  const normalizeTransform = useCallback((next) => {
    const scale = clampScale(next.scale);
    if (scale === 1) {
      return { scale, x: 0, y: 0 };
    }
    return { scale, x: next.x, y: next.y };
  }, [clampScale]);
  const updateTransform = useCallback((updater) => {
    setTransform((current) => normalizeTransform(typeof updater === 'function' ? updater(current) : updater));
  }, [normalizeTransform]);
  const resetZoom = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    setIsGesturing(false);
    setTransform({ scale: 1, x: 0, y: 0 });
  }, []);

  useEffect(() => {
    setLoadState('loading');
    setRetryKey(0);
    resetZoom();
  }, [image?.url, resetZoom]);

  useEffect(() => {
    setLoadState(resolved.error ? 'failed' : 'loading');
  }, [resolved.error, resolved.src]);

  useEffect(() => {
    return () => {
      pointersRef.current.clear();
    };
  }, []);

  if (!image) {
    return null;
  }

  const src = resolved.src;
  const zoomIn = () => updateTransform((current) => ({ ...current, scale: current.scale + 0.5 }));
  const zoomOut = () => updateTransform((current) => ({ ...current, scale: current.scale - 0.5 }));
  const pointerDistance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
  const pointerCenter = (first, second) => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });

  function handlePointerDown(event) {
    if (!src || loadState === 'failed') {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pointer = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, pointer);
    setIsGesturing(true);
    const pointers = Array.from(pointersRef.current.values());
    if (pointers.length === 2) {
      gestureRef.current = {
        mode: 'pinch',
        startDistance: pointerDistance(pointers[0], pointers[1]),
        startCenter: pointerCenter(pointers[0], pointers[1]),
        startTransform: transform
      };
    } else if (pointers.length === 1) {
      gestureRef.current = {
        mode: 'pan',
        startPointer: pointer,
        startTransform: transform
      };
    }
  }

  function handlePointerMove(event) {
    if (!pointersRef.current.has(event.pointerId)) {
      return;
    }
    const pointer = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, pointer);
    const pointers = Array.from(pointersRef.current.values());
    const gesture = gestureRef.current;
    if (!gesture) {
      return;
    }
    if (gesture.mode === 'pinch' && pointers.length >= 2) {
      const distance = pointerDistance(pointers[0], pointers[1]);
      const center = pointerCenter(pointers[0], pointers[1]);
      const scale = gesture.startTransform.scale * (distance / Math.max(gesture.startDistance, 1));
      updateTransform({
        scale,
        x: gesture.startTransform.x + (center.x - gesture.startCenter.x),
        y: gesture.startTransform.y + (center.y - gesture.startCenter.y)
      });
      return;
    }
    if (gesture.mode === 'pan' && pointers.length === 1 && gesture.startTransform.scale > 1) {
      updateTransform({
        scale: gesture.startTransform.scale,
        x: gesture.startTransform.x + pointer.x - gesture.startPointer.x,
        y: gesture.startTransform.y + pointer.y - gesture.startPointer.y
      });
    }
  }

  function handlePointerEnd(event) {
    pointersRef.current.delete(event.pointerId);
    const pointers = Array.from(pointersRef.current.values());
    if (pointers.length === 0) {
      gestureRef.current = null;
      setIsGesturing(false);
      return;
    }
    if (pointers.length === 1) {
      gestureRef.current = {
        mode: 'pan',
        startPointer: pointers[0],
        startTransform: transform
      };
    }
  }

  function handleDoubleTap() {
    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      updateTransform((current) => (current.scale > 1 ? { scale: 1, x: 0, y: 0 } : { ...current, scale: 2.5 }));
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
  }

  function handleWheel(event) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.25 : 0.25;
    updateTransform((current) => ({ ...current, scale: current.scale + delta }));
  }

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-top">
        <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭图片预览">
          <X size={22} />
        </button>
      </div>
      <div
        className={`lightbox-stage ${transform.scale > 1 ? 'is-zoomed' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          handleDoubleTap();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
      >
        {src ? (
          <img
            ref={imageRef}
            src={src}
            alt={image.alt || '生成图片'}
            style={{
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
              transition: isGesturing ? 'none' : undefined
            }}
            onLoad={() => setLoadState('loaded')}
            onError={() => setLoadState('failed')}
          />
        ) : null}
      </div>
      {loadState !== 'failed' ? (
        <div className="lightbox-zoom-controls" onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={zoomOut} aria-label="缩小图片" disabled={transform.scale <= 1}>
            <Minus size={17} />
          </button>
          <button type="button" onClick={resetZoom} aria-label="重置图片缩放" disabled={transform.scale === 1 && transform.x === 0 && transform.y === 0}>
            {Math.round(transform.scale * 100)}%
          </button>
          <button type="button" onClick={zoomIn} aria-label="放大图片" disabled={transform.scale >= 5}>
            <Plus size={17} />
          </button>
        </div>
      ) : null}
      {loadState === 'failed' ? (
        <div className="lightbox-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            onClick={() => {
              setLoadState('loading');
              setRetryKey(Date.now());
            }}
          >
            <RefreshCw size={16} />
            重新加载
          </button>
        </div>
      ) : null}
    </div>
  );
}

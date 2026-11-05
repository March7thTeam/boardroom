import React, { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, PanelTop, X } from "lucide-react";

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type FloatingWindowProps = {
  id: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  initialWidth?: number;
  initialHeight?: number;
  initialX?: number;
  initialY?: number;
  minWidth?: number;
  minHeight?: number;
  zIndex?: number;
  onFocus?: () => void;
  onClose: () => void;
  onDock?: () => void;
  dockLabel?: string;
  onMoveDrag?: (clientX: number, clientY: number) => void;
  onMoveEnd?: (clientX: number, clientY: number) => boolean | void;
  children: React.ReactNode;
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function FloatingWindow({
  id,
  title,
  icon,
  initialWidth = 540,
  initialHeight = 520,
  initialX,
  initialY,
  minWidth = 320,
  minHeight = 240,
  zIndex = 120,
  onFocus,
  onClose,
  onDock,
  dockLabel = "Dock as tab",
  onMoveDrag,
  onMoveEnd,
  children,
}: FloatingWindowProps): React.ReactElement {
  const [rect, setRect] = useState<Rect>(() => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const w = Math.min(initialWidth, Math.max(vw - 24, 280));
    const h = Math.min(initialHeight, Math.max(vh - 48, 240));
    const x =
      initialX !== undefined
        ? Math.max(8, Math.min(initialX, vw - w - 8))
        : Math.max(12, Math.round((vw - w) / 2));
    const y =
      initialY !== undefined
        ? Math.max(38, Math.min(initialY, vh - h - 26))
        : Math.max(44, Math.round((vh - h) / 2));
    return { x, y, width: w, height: h };
  });

  const [isMaximized, setIsMaximized] = useState(false);
  const preMaxRectRef = useRef<Rect>(rect);
  const moveCallbacksRef = useRef({ onMoveDrag, onMoveEnd });
  moveCallbacksRef.current = { onMoveDrag, onMoveEnd };

  const interactionRef = useRef<{
    mode: "move" | "resize";
    dir?: ResizeDir;
    startX: number;
    startY: number;
    startRect: Rect;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const state = interactionRef.current;
      if (!state) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        state.moved = true;
      }
      const s = state.startRect;

      if (state.mode === "move") {
        const nextX = Math.max(0, Math.min(s.x + dx, vw - Math.min(s.width, 120)));
        const nextY = Math.max(38, Math.min(s.y + dy, vh - 36));
        setRect((prev) => ({ ...prev, x: nextX, y: nextY }));
        if (state.moved) {
          moveCallbacksRef.current.onMoveDrag?.(e.clientX, e.clientY);
        }
        return;
      }

      const dir = state.dir!;
      let nextX = s.x;
      let nextY = s.y;
      let nextW = s.width;
      let nextH = s.height;

      if (dir.includes("e")) {
        nextW = Math.max(minWidth, Math.min(s.width + dx, vw - s.x));
      }
      if (dir.includes("s")) {
        nextH = Math.max(minHeight, Math.min(s.height + dy, vh - s.y - 26));
      }
      if (dir.includes("w")) {
        const rawW = s.width - dx;
        if (rawW >= minWidth) {
          nextX = Math.max(0, s.x + dx);
          nextW = s.width + (s.x - nextX);
        } else {
          nextW = minWidth;
          nextX = s.x + (s.width - minWidth);
        }
      }
      if (dir.includes("n")) {
        const rawH = s.height - dy;
        if (rawH >= minHeight) {
          nextY = Math.max(38, s.y + dy);
          nextH = s.height + (s.y - nextY);
        } else {
          nextH = minHeight;
          nextY = s.y + (s.height - minHeight);
        }
      }

      setRect({ x: nextX, y: nextY, width: nextW, height: nextH });
    };

    const onPointerUp = (e: PointerEvent) => {
      const state = interactionRef.current;
      if (state) {
        interactionRef.current = null;
        document.body.style.userSelect = "";
        if (state.mode === "move" && state.moved) {
          moveCallbacksRef.current.onMoveEnd?.(e.clientX, e.clientY);
        }
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [minWidth, minHeight]);

  const startMove = (e: React.PointerEvent) => {
    if (isMaximized) return;
    if ((e.target as HTMLElement).closest("button")) return;
    onFocus?.();
    document.body.style.userSelect = "none";
    interactionRef.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      startRect: rect,
      moved: false,
    };
  };

  const startResize = (dir: ResizeDir) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (isMaximized) return;
    onFocus?.();
    document.body.style.userSelect = "none";
    interactionRef.current = {
      mode: "resize",
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startRect: rect,
      moved: false,
    };
  };

  const toggleMaximize = () => {
    if (isMaximized) {
      setRect(preMaxRectRef.current);
      setIsMaximized(false);
    } else {
      preMaxRectRef.current = rect;
      setIsMaximized(true);
    }
  };

  const style: React.CSSProperties = isMaximized
    ? {
        top: 38,
        left: 42,
        width: "calc(100vw - 42px)",
        height: "calc(100vh - 64px)",
        zIndex,
      }
    : {
        top: rect.y,
        left: rect.x,
        width: rect.width,
        height: rect.height,
        zIndex,
      };

  const resizeDirs: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  return (
    <section
      id={id}
      className={`floating-window ${isMaximized ? "is-maximized" : ""}`}
      style={style}
      role="dialog"
      aria-modal="false"
      onPointerDown={() => onFocus?.()}
    >
      {!isMaximized &&
        resizeDirs.map((dir) => (
          <div
            key={dir}
            className={`fw-resizer fw-resizer-${dir}`}
            onPointerDown={startResize(dir)}
            aria-hidden="true"
          />
        ))}

      <header
        className="floating-window-header"
        onPointerDown={startMove}
        onDoubleClick={toggleMaximize}
      >
        <div className="floating-window-title">
          {icon}
          <span>{title}</span>
        </div>
        <div className="floating-window-controls">
          {onDock && (
            <button
              type="button"
              className="fw-ctrl-btn"
              onClick={onDock}
              aria-label={dockLabel}
              title={dockLabel}
            >
              <PanelTop size={12} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="fw-ctrl-btn"
            onClick={toggleMaximize}
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? (
              <Minimize2 size={12} aria-hidden="true" />
            ) : (
              <Maximize2 size={12} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="fw-ctrl-btn fw-ctrl-close"
            onClick={onClose}
            aria-label="Close window"
            title="Close"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="floating-window-body">{children}</div>
    </section>
  );
}

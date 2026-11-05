import { cloneElement, isValidElement, useCallback, useLayoutEffect, useRef, useState, type AnimationEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";

type MotionPhase = "entering" | "entered" | "exiting";
const FOCUSABLE_SELECTOR = "a[href], area[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [contenteditable=true], [tabindex]:not([tabindex='-1'])";

/**
 * Keeps a single DOM-root child mounted until its exit animation finishes.
 * The animation end event is the source of truth (not a guessed timeout), so
 * fast reopen/close sequences cannot race an old timer. Dialogs and drawers
 * also receive initial focus, a contained Tab sequence, Escape handling, and
 * focus restoration when they close.
 */
export function MotionPresence({ present, kind, children, onExited, onEscape }: {
  present: boolean;
  kind: "dialog" | "panel" | "menu" | "toast" | "popover";
  children: ReactNode;
  onExited?: () => void;
  onEscape?: () => void;
}) {
  const latestChild = useRef<ReactNode>(children);
  const onExitedRef = useRef(onExited);
  const onEscapeRef = useRef(onEscape);
  const rootRef = useRef<HTMLElement | null>(null);
  onExitedRef.current = onExited;
  onEscapeRef.current = onEscape;
  if (present && isValidElement(children)) latestChild.current = children;
  const childRefValue = isValidElement(latestChild.current) ? (latestChild.current as ReactElement<any>).props.ref as Ref<HTMLElement> | undefined : undefined;
  const setRootRef = useCallback((node: HTMLElement | null) => {
    rootRef.current = node;
    if (typeof childRefValue === "function") childRefValue(node);
    else if (childRefValue && typeof childRefValue === "object") (childRefValue as { current: HTMLElement | null }).current = node;
  }, [childRefValue]);

  const [mounted, setMounted] = useState(present);
  const [phase, setPhase] = useState<MotionPhase>(present ? "entering" : "exiting");
  const phaseRef = useRef(phase);
  const setPhaseNow = (next: MotionPhase) => { phaseRef.current = next; setPhase(next); };

  useLayoutEffect(() => {
    if (present) {
      setMounted(true);
      setPhaseNow("entering");
    } else if (mounted) {
      setPhaseNow("exiting");
    }
  }, [present, mounted]);

  useLayoutEffect(() => {
    if (!present || !mounted || (kind !== "dialog" && kind !== "panel")) return;
    const root = rootRef.current;
    if (!root) return;
    const scope = root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]') || root;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
      return !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0;
    });
    const preferred = scope.querySelector<HTMLElement>("[autofocus]");
    let addedTabIndex = false;
    const initialTarget = preferred || focusable[0] || scope;
    if (initialTarget === scope && !scope.hasAttribute("tabindex")) {
      scope.setAttribute("tabindex", "-1");
      addedTabIndex = true;
    }
    initialTarget.focus({ preventScroll: true });
    return () => {
      if (addedTabIndex) scope.removeAttribute("tabindex");
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [present, mounted, kind]);

  if (!mounted || !isValidElement(latestChild.current)) return null;

  const child = latestChild.current as ReactElement<any>;
  const originalAnimationEnd = child.props.onAnimationEnd as ((event: AnimationEvent) => void) | undefined;
  const originalAnimationCancel = child.props.onAnimationCancel as ((event: AnimationEvent) => void) | undefined;
  const originalKeyDown = child.props.onKeyDown as ((event: ReactKeyboardEvent<HTMLElement>) => void) | undefined;
  const exiting = phase === "exiting";
  const className = [child.props.className, "motion-presence-root", `motion-kind-${kind}`, `motion-${phase}`].filter(Boolean).join(" ");

  return cloneElement(child, {
    ref: setRootRef,
    className,
    "aria-hidden": exiting ? true : child.props["aria-hidden"],
    inert: exiting ? true : child.props.inert,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      originalKeyDown?.(event);
      if (event.defaultPrevented || exiting) return;
      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab" || (kind !== "dialog" && kind !== "panel")) return;
      const root = event.currentTarget;
      const scope = root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]') || root;
      const candidates = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
        return !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0;
      });
      if (!candidates.length) {
        event.preventDefault();
        scope.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !scope.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !scope.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    },
    onAnimationEnd: (event: AnimationEvent) => {
      originalAnimationEnd?.(event);
      if (event.target !== event.currentTarget) return;
      if (phaseRef.current === "exiting") {
        setMounted(false);
        onExitedRef.current?.();
      } else if (phaseRef.current === "entering") setPhaseNow("entered");
    },
    onAnimationCancel: (event: AnimationEvent) => {
      // Cancellation is not completion: a rapid reopen can cancel an exit or
      // entrance animation. Let the next animation's end event own unmounting.
      originalAnimationCancel?.(event);
    },
  });
}

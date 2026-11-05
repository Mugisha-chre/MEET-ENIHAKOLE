import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { MotionPresence } from "./MotionPresence";

export type SelectOption = { value: string; label: string };

// App-styled replacement for the native <select>. The menu is rendered in a portal so no panel, table or
// modal can clip it, it flips above the trigger when there is no room below, and it is fully keyboard accessible.
export function CustomSelect({ value, onChange, options, ariaLabel, className = "", placeholder, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", timer: 0 });
  const listId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const trigger = triggerRef.current; const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight; const viewportW = window.innerWidth;
    const width = Math.min(Math.max(rect.width, 170), viewportW - 16);
    const left = Math.max(8, Math.min(rect.left, viewportW - width - 8));
    const natural = Math.min(menu.scrollHeight, 320);
    const below = viewportH - rect.bottom - 12;
    const above = rect.top - 12;
    const openUp = below < natural && above > below;
    const maxHeight = Math.max(120, Math.min(320, openUp ? above : below));
    setMenuStyle({
      position: "fixed", left, width, maxHeight, visibility: "visible",
      ...(openUp ? { bottom: viewportH - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(place);
    const reposition = () => place();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [open, place, options.length]);

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, menuStyle.visibility]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); setOpen(true); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(options.length - 1, index + 1)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); return; }
    if (event.key === "Home") { event.preventDefault(); setActive(0); return; }
    if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      window.clearTimeout(typeahead.current.timer);
      typeahead.current.text += event.key.toLowerCase();
      typeahead.current.timer = window.setTimeout(() => { typeahead.current.text = ""; }, 600);
      const match = options.findIndex((option) => option.label.toLowerCase().startsWith(typeahead.current.text));
      if (match >= 0) setActive(match);
    }
  }

  return <>
    <button
      ref={triggerRef}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`cselect-trigger ${open ? "is-open" : ""} ${className}`}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={onKeyDown}
    >
      <span className={selected ? "cselect-value" : "cselect-value cselect-placeholder"}>{selected ? selected.label : placeholder || "Select…"}</span>
      <ChevronDown size={15} className="cselect-chevron" aria-hidden="true"/>
    </button>
    {createPortal(
      <MotionPresence present={open} kind="menu">{<div ref={menuRef} id={listId} className="cselect-menu" role="listbox" aria-label={ariaLabel} style={menuStyle} onKeyDown={onKeyDown}>
        {options.map((option, index) => <button
          type="button"
          key={option.value || `empty-${index}`}
          role="option"
          data-index={index}
          aria-selected={option.value === value}
          className={`cselect-option ${option.value === value ? "is-selected" : ""} ${index === active ? "is-active" : ""}`}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(index)}
        ><span>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true"/>}</button>)}
      </div>}</MotionPresence>,
      document.body,
    )}
  </>;
}

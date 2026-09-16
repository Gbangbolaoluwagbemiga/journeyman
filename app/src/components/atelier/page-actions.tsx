/**
 * Lets an embedded page put its action buttons somewhere else on the screen.
 *
 * My Jobs stacks two big existing dashboards under a tab bar. Each of them owns
 * a header row with its own Refresh (and, for the freelancer side, Messages) —
 * and once the heading is hidden, that row becomes a band of empty space with
 * two buttons floating at the right of it, sitting between the tabs and the
 * content and belonging to neither.
 *
 * Moving the buttons up next to the tabs is the obvious fix, and the obvious
 * implementation is wrong: hoisting them into My Jobs means duplicating each
 * page's refresh logic and loading state in a parent that does not own it.
 *
 * So the buttons stay exactly where they are, in the page that owns their
 * behaviour, and get rendered through a portal into a slot the parent puts in
 * the tab row. With no slot — either page visited on its own — they render
 * inline, unchanged.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const SlotContext = createContext<HTMLElement | null>(null);

export function PageActionsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return (
    <SlotTargetSetter.Provider value={setTarget}>
      <SlotContext.Provider value={target}>{children}</SlotContext.Provider>
    </SlotTargetSetter.Provider>
  );
}

const SlotTargetSetter = createContext<((el: HTMLElement | null) => void) | null>(
  null,
);

/** Where the actions land. Render this once, inside a provider. */
export function PageActionsSlot({ className = "" }: { className?: string }) {
  const setTarget = useContext(SlotTargetSetter);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTarget?.(ref.current);
    return () => setTarget?.(null);
  }, [setTarget]);

  return <div ref={ref} className={`flex items-center gap-2 ${className}`} />;
}

/**
 * Wrap a page's action buttons in this.
 *
 * `enabled` is usually the page's own `embedded` flag — visited directly, the
 * page should keep its buttons where they are rather than hunting for a slot
 * that does not exist.
 */
export function PageActions({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const target = useContext(SlotContext);
  if (enabled && target) return createPortal(children, target);
  return <>{children}</>;
}

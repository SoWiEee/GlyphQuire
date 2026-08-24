/**
 * Confines Tab/Shift+Tab focus movement inside `container` and restores
 * focus to whatever was focused immediately before the trap was installed
 * once it is released. This is the one focus-management primitive shared by
 * every modal-shaped surface in the app (confirmation dialogs, checkpoint
 * dialog, the conflict recovery workspace) so keyboard behavior — including
 * focus return on close — stays identical everywhere instead of being
 * reimplemented per component.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface FocusTrapHandle {
  /** Removes the trap's keydown listener and returns focus to the pre-trap element. */
  release(): void;
}

function isVisible(element: HTMLElement): boolean {
  return element.offsetParent !== null || element === document.activeElement;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

/**
 * Installs the trap and moves focus into `container` immediately —
 * `initialFocus` when given and still present, otherwise the first
 * focusable descendant, otherwise the container itself.
 */
export function trapFocus(container: HTMLElement, initialFocus?: HTMLElement | null): FocusTrapHandle {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const elements = focusableElements(container);
    if (elements.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    const active = document.activeElement;
    const outside = !(active instanceof HTMLElement) || !container.contains(active);

    if (event.shiftKey) {
      if (outside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (outside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", onKeydown);

  const target = initialFocus ?? focusableElements(container)[0] ?? container;
  if (!container.hasAttribute("tabindex") && target === container) {
    container.setAttribute("tabindex", "-1");
  }
  target.focus();

  return {
    release(): void {
      container.removeEventListener("keydown", onKeydown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    },
  };
}

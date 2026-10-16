import { useEffect, useRef } from 'react';

// Modal sheets behave like real dialogs: focus moves in on open, Tab stays inside, Escape
// closes from anywhere on the page, and focus goes back to whatever opened it.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function useDialog(onClose) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    const box = ref.current;
    const items = () => [...(box?.querySelectorAll(FOCUSABLE) || [])].filter((el) => el.offsetParent !== null);
    (items()[0] || box)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const list = items();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return ref;
}

// The lightning mark. Decorative: whatever it sits next to says the same thing in words.
export const BOLT_PATH = 'M34 0 L8 54 H28 L20 100 L56 40 H36 L50 0 Z';

export default function Bolt({ className = '' }) {
  return (
    <svg className={`bolt ${className}`.trim()} viewBox="0 0 64 100" aria-hidden="true" focusable="false">
      <path d={BOLT_PATH} fill="currentColor" />
    </svg>
  );
}

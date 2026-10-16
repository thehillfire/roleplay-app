import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Notes people left after saying a conversation helped. Anonymous, and only the
// recipient sees them; they can remove any of them.
export default function KindWords({ refreshKey }) {
  const [words, setWords] = useState([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api.kindWords().then(setWords, () => {});
  }, [refreshKey]);

  if (!words.length) return null;
  const shown = showAll ? words : words.slice(0, 3);
  const remove = async (conversationId) => {
    setWords((w) => w.filter((k) => k.conversationId !== conversationId));
    await api.hideKindWords(conversationId).catch(() => {});
  };

  return (
    <section className="card kind-words" aria-labelledby="kind-words-title">
      <h2 className="section-title" id="kind-words-title">Kind words people left you</h2>
      <ul>
        {shown.map((k) => (
          <li key={k.conversationId}>
            <blockquote>{k.note}</blockquote>
            <button className="icon-btn" aria-label="Remove this note" onClick={() => remove(k.conversationId)}>×</button>
          </li>
        ))}
      </ul>
      {words.length > 3 && (
        <button className="link" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Show fewer' : `Show all ${words.length}`}</button>
      )}
    </section>
  );
}

import { useState } from 'react';

export default function Imagine({ onBegin, onBack }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const ready = name.trim().length > 0;

  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    onBegin({ name: name.trim(), description: description.trim() || undefined });
  };

  return (
    <main className="screen">
      <button className="back" onClick={onBack}>← Back</button>
      <form className="card form" onSubmit={submit}>
        <h2 className="section-title">Who are you?</h2>
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ilya of the Lantern Road" autoFocus />
        </label>
        <label>
          <span>Describe yourself <em>(optional)</em></span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
            rows={4}
            placeholder="A retired cartographer who still dreams of maps that redraw themselves."
          />
        </label>
        <button className="btn primary" type="submit" disabled={!ready}>Begin story</button>
      </form>
    </main>
  );
}

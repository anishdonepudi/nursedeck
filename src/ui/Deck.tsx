import { useCallback, useEffect, useState } from 'react';
import type { DeckCardRow, GenKind } from '@shared/ipc.js';

/**
 * Browse, write and edit cards.
 *
 * She asked for this directly: the tool she was using let her edit generated
 * cards but never add her own, and a lecture always has a few things she wants
 * to phrase in her own words.
 *
 * Editing a GENERATED card is treated carefully. Its citation was checked
 * against the original wording, so rewording it invalidates that check and the
 * card leaves the study queue until re-verified. That is said plainly rather
 * than happening silently, because a card quietly disappearing from study
 * would be baffling.
 */

interface Props {
  lectureId: string;
  lectureTitle: string;
  onDone: () => void;
}

const KINDS: { id: 'flashcard' | 'cloze' | 'qa'; label: string; hint: string }[] = [
  { id: 'flashcard', label: 'Flashcard', hint: 'Question and answer' },
  { id: 'cloze', label: 'Fill in the blank', hint: 'Wrap the blank in {{braces}}' },
  { id: 'qa', label: 'Short answer', hint: 'Written explanation' },
];

export function Deck({ lectureId, lectureTitle, onDone }: Props) {
  const [cards, setCards] = useState<DeckCardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string>();
  const [draftFront, setDraftFront] = useState('');
  const [draftBack, setDraftBack] = useState('');
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<'flashcard' | 'cloze' | 'qa'>('flashcard');
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCards(await window.nursedeck.listDeck(lectureId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lectureId]);

  useEffect(() => { void load(); }, [load]);

  const startEdit = (card: DeckCardRow) => {
    setAdding(false);
    setEditingId(card.id);
    setDraftFront(card.front);
    setDraftBack(card.back);
    setNotice(undefined);
  };

  const startAdd = () => {
    setEditingId(undefined);
    setAdding(true);
    setDraftFront('');
    setDraftBack('');
    setNotice(undefined);
  };

  const cancel = () => {
    setEditingId(undefined);
    setAdding(false);
  };

  const save = useCallback(async () => {
    setError(undefined);
    if (!draftFront.trim() || !draftBack.trim()) {
      setError('A card needs both a question and an answer.');
      return;
    }
    try {
      if (adding) {
        await window.nursedeck.addCard({
          lectureId, kind: newKind, front: draftFront, back: draftBack,
        });
        setNotice('Added. Your own cards are ready to study straight away.');
      } else if (editingId) {
        const r = await window.nursedeck.editCard({
          itemId: editingId, front: draftFront, back: draftBack,
        });
        setNotice(
          r.requiresReverification
            ? 'Saved. Because the wording changed, its source needs re-checking before you study it again.'
            : 'Saved.',
        );
      }
      cancel();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [adding, editingId, draftFront, draftBack, newKind, lectureId, load]);

  const remove = useCallback(async (card: DeckCardRow) => {
    try {
      await window.nursedeck.deleteCard(card.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [load]);

  const visible = filter.trim()
    ? cards.filter((c) =>
        `${c.front} ${c.back}`.toLowerCase().includes(filter.trim().toLowerCase()))
    : cards;

  const mine = cards.filter((c) => c.authoredBy === 'user').length;

  return (
    <div className="deck">
      <section className="panel">
        <div className="panel-head">
          <h2>Cards in “{lectureTitle}”</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="primary" onClick={startAdd}>Write a card</button>
            <button type="button" className="ghost" onClick={onDone}>Back</button>
          </div>
        </div>

        <p className="hint">
          {cards.length} card{cards.length === 1 ? '' : 's'}
          {mine > 0 && ` · ${mine} written by you`}
        </p>

        <input
          className="study-input"
          placeholder="Search your cards"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        {notice && <p className="hint">{notice}</p>}
        {error && <p className="error">{error}</p>}

        {(adding || editingId) && (
          <div className="editor">
            <h3>{adding ? 'New card' : 'Edit card'}</h3>

            {adding && (
              <div className="kinds">
                {KINDS.map((k) => (
                  <label key={k.id} className={`kind ${newKind === k.id ? 'kind-on' : ''}`}>
                    <input
                      type="radio"
                      checked={newKind === k.id}
                      onChange={() => setNewKind(k.id)}
                    />
                    <span>
                      <span className="kind-label">{k.label}</span>
                      <span className="kind-hint">{k.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <label className="field">
              <span>Question</span>
              <textarea value={draftFront} onChange={(e) => setDraftFront(e.target.value)} rows={3} />
            </label>
            <label className="field">
              <span>Answer</span>
              <textarea value={draftBack} onChange={(e) => setDraftBack(e.target.value)} rows={3} />
            </label>

            {!adding && (
              <p className="hint">
                If you change the wording of a generated card, its source has to be re-checked
                before it can be studied again.
              </p>
            )}

            <div className="gate-actions">
              <button type="button" className="primary" onClick={() => void save()}>Save</button>
              <button type="button" className="ghost" onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        {loading ? (
          <p className="waiting"><span className="spinner" /> Loading…</p>
        ) : visible.length === 0 ? (
          <p className="hint empty">No cards match.</p>
        ) : (
          <ul className="card-list">
            {visible.map((c) => (
              <li key={c.id}>
                <div className="card-row">
                  <div className="card-text">
                    <div className="card-front">{c.front}</div>
                    <div className="card-back">{c.back}</div>
                  </div>
                  <div className="card-tags">
                    {c.authoredBy === 'user' && <em className="pill pill-ok">yours</em>}
                    {c.edited && <em className="pill">edited</em>}
                    {!c.verified && <em className="pill pill-pending">needs checking</em>}
                    {c.status === 'pending' && <em className="pill pill-pending">to review</em>}
                  </div>
                  <div className="card-actions">
                    <button type="button" className="ghost" onClick={() => startEdit(c)}>Edit</button>
                    <button type="button" className="ghost danger" onClick={() => void remove(c)}>
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

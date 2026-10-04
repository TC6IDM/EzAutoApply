import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { FIELD_KEY_MAP } from '../../core/fieldKeys';
import { normalize } from '../../core/normalize';
import type { SavedAnswer } from '../../core/types';
import { deleteAnswer, listAnswers, restoreAnswer, saveAnswer, updateAnswer } from '../../db';
import { ChevronIcon } from '../icons';
import { Button, Empty, formatDate, useUndo } from '../ui';

function answerText(a: SavedAnswer['answer']): string {
  return Array.isArray(a) ? a.join(', ') : typeof a === 'boolean' ? (a ? 'Yes' : 'No') : a;
}

function usedText(n: number): string {
  return n === 0 ? 'not used yet' : n === 1 ? 'used once' : `used ${n} times`;
}

function AnswerRow(props: { a: SavedAnswer; onDelete(a: SavedAnswer): void }) {
  const { a } = props;
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(a.question);
  const [answer, setAnswer] = useState(answerText(a.answer));

  const save = async () => {
    let value: SavedAnswer['answer'] = answer;
    if (typeof a.answer === 'boolean') value = /^(y|yes|true|checked)$/i.test(answer.trim());
    else if (Array.isArray(a.answer)) value = answer.split(',').map((s) => s.trim()).filter(Boolean);
    await updateAnswer(a.id, { question, answer: value });
    setEditing(false);
  };

  return (
    <li className="answer-row">
      {editing ? (
        <div className="answer">
          <label>
            Question
            <input value={question} onChange={(e) => setQuestion(e.target.value)} />
          </label>
          <label>
            Answer
            {a.options?.length && !Array.isArray(a.answer) && typeof a.answer !== 'boolean' ? (
              <select value={answer} onChange={(e) => setAnswer(e.target.value)}>
                {!a.options.includes(answer) && <option value={answer}>{answer}</option>}
                {a.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <textarea rows={answer.length > 60 ? 4 : 1} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            )}
          </label>
          <div className="row">
            <Button kind="primary" small onClick={save}>
              Save
            </Button>
            <Button kind="ghost" small onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="q">{a.question}</p>
          <p className="val">{answerText(a.answer)}</p>
          <p className="meta">
            {a.scope === 'global' ? 'All sites' : `Only on ${a.scope}`}
            {a.canonicalKey && FIELD_KEY_MAP[a.canonicalKey] ? ` · ${FIELD_KEY_MAP[a.canonicalKey].title}` : ''} · {usedText(a.timesUsed)}
            {a.timesUsed ? `, last ${formatDate(a.lastUsed)}` : ''}
          </p>
          <div className="row">
            <Button kind="ghost" small onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button kind="danger" small onClick={() => props.onDelete(a)}>
              Delete
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

export function AnswersView() {
  const answers = useLiveQuery(listAnswers, [], [] as SavedAnswer[]);
  const [query, setQuery] = useState('');
  const [newQ, setNewQ] = useState('');
  const [newA, setNewA] = useState('');
  const [undoToast, offerUndo] = useUndo();

  const shown = useMemo(() => {
    const q = normalize(query);
    return q ? answers.filter((a) => a.normalized.includes(q) || normalize(answerText(a.answer)).includes(q)) : answers;
  }, [answers, query]);

  const add = async () => {
    if (!newQ.trim() || !newA.trim()) return;
    await saveAnswer({ question: newQ.trim(), answer: newA.trim(), fieldKind: 'text', scope: 'global' });
    setNewQ('');
    setNewA('');
  };

  const remove = async (a: SavedAnswer) => {
    await deleteAnswer(a.id);
    offerUndo('Deleted a saved answer.', () => restoreAnswer(a));
  };

  return (
    <div className="view answers">
      {answers.length > 0 && (
        <input
          className="search"
          type="search"
          aria-label="Search saved answers"
          placeholder="Search saved answers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {shown.length ? (
        <ul className="answer-list rows list-card">
          {shown.map((a) => (
            <AnswerRow key={a.id} a={a} onDelete={remove} />
          ))}
        </ul>
      ) : (
        <Empty>
          {answers.length
            ? 'No matches.'
            : 'No saved answers yet. When you answer a question on the Apply tab, it’s saved here and filled in automatically the next time a form asks something similar.'}
        </Empty>
      )}
      <details className="section">
        <summary>
          <ChevronIcon className="chev" />
          <h2 className="section-title">Add an answer manually</h2>
        </summary>
        <div className="section-body answer">
          <label>
            Question
            <input value={newQ} onChange={(e) => setNewQ(e.target.value)} placeholder="Why do you want to work here?" />
          </label>
          <label>
            Answer
            <textarea rows={3} value={newA} onChange={(e) => setNewA(e.target.value)} />
          </label>
          <Button kind="primary" small onClick={add} disabled={!newQ.trim() || !newA.trim()}>
            Save answer
          </Button>
        </div>
      </details>
      {undoToast}
    </div>
  );
}

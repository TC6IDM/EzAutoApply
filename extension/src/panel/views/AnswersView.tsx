import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { FIELD_KEY_MAP } from '../../core/fieldKeys';
import { normalize } from '../../core/normalize';
import type { SavedAnswer } from '../../core/types';
import { deleteAnswer, listAnswers, saveAnswer, updateAnswer } from '../../db';
import { Button, Empty, formatDate } from '../ui';

function answerText(a: SavedAnswer['answer']): string {
  return Array.isArray(a) ? a.join(', ') : typeof a === 'boolean' ? (a ? 'Yes' : 'No') : a;
}

function AnswerRow(props: { a: SavedAnswer }) {
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
            {a.canonicalKey && FIELD_KEY_MAP[a.canonicalKey] ? ` · ${FIELD_KEY_MAP[a.canonicalKey].title}` : ''} · used {a.timesUsed}×
            {a.timesUsed ? ` · last ${formatDate(a.lastUsed)}` : ''}
          </p>
          <div className="row">
            <Button kind="ghost" small onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              kind="danger"
              small
              onClick={() => {
                if (confirm('Delete this saved answer?')) deleteAnswer(a.id);
              }}
            >
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

  return (
    <div className="view answers">
      <p className="hint">
        Answers you gave on earlier applications. When a form asks the same (or a similar) question, these fill automatically.
      </p>
      <input className="search" type="search" placeholder="Search saved answers" value={query} onChange={(e) => setQuery(e.target.value)} />
      {shown.length ? (
        <ul className="answer-list">
          {shown.map((a) => (
            <AnswerRow key={a.id} a={a} />
          ))}
        </ul>
      ) : (
        <Empty>{answers.length ? 'No matches.' : 'No saved answers yet. Answer a question on the Apply tab and it will show up here.'}</Empty>
      )}
      <details className="section">
        <summary>
          <span className="section-title">Add an answer manually</span>
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
    </div>
  );
}

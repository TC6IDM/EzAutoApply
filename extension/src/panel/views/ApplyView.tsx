import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { FIELD_KEY_MAP } from '../../core/fieldKeys';
import { type AnswerValue, DOC_KIND_LABELS, type DocKind, type DocumentMeta } from '../../core/types';
import { hasProfile, listDocuments, saveAnswer } from '../../db';
import type { FieldReport, FillStatus } from '../../fill/types';
import type { SaveAnswerRequest } from '../../messages';
import type { View } from '../App';
import { type ActiveTab, send, setDocSelection, useTabState } from '../api';
import { Banner, Button, Empty, Section } from '../ui';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const SOURCE_LABEL: Record<FieldReport['source'], string> = {
  rule: 'from your profile',
  answerBank: 'from a saved answer',
  classifier: 'chosen by the classifier',
  adapter: 'site adapter',
  none: '',
};

function shown(v: AnswerValue | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v;
}

/** An input matching the field's kind, for answering it from the panel. */
function AnswerInput(props: { field: FieldReport; value: AnswerValue; onChange(v: AnswerValue): void }) {
  const { field, value, onChange } = props;
  if (field.kind === 'checkbox') {
    return (
      <div className="segmented" role="radiogroup" aria-label={field.label}>
        {[true, false].map((b) => (
          <label key={String(b)} className={value === b ? 'on' : ''}>
            <input type="radio" checked={value === b} onChange={() => onChange(b)} />
            {b ? 'Check it' : 'Leave unchecked'}
          </label>
        ))}
      </div>
    );
  }
  if (field.kind === 'checkboxGroup' && field.options.length) {
    const picked = Array.isArray(value) ? value : [];
    return (
      <div className="checks">
        {field.options.map((o) => (
          <label key={o}>
            <input
              type="checkbox"
              checked={picked.includes(o)}
              onChange={(e) => onChange(e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))}
            />
            {o}
          </label>
        ))}
      </div>
    );
  }
  if (field.options.length) {
    return (
      <select aria-label={field.label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'textarea') {
    return <textarea aria-label={field.label} rows={4} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <input
      aria-label={field.label}
      type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.kind === 'combobox' ? 'Type the option to pick' : ''}
    />
  );
}

function emptyAnswer(f: FieldReport): AnswerValue {
  if (f.kind === 'checkbox') return true;
  if (f.kind === 'checkboxGroup') return [];
  return '';
}

function isBlank(v: AnswerValue): boolean {
  return Array.isArray(v) ? v.length === 0 : v === '';
}

function saveRequest(f: FieldReport, scope: string): SaveAnswerRequest {
  return { question: f.label, fieldKind: f.kind, options: f.options.length ? f.options : undefined, canonicalKey: f.key, scope };
}

/** One field that needs an answer (or a second look). */
function FieldCard(props: { field: FieldReport; tabId: number; host: string; goto(v: View): void }) {
  const { field, tabId, host } = props;
  const [editing, setEditing] = useState(field.status === 'needs' || field.status === 'skipped');
  const [value, setValue] = useState<AnswerValue>(field.current !== undefined && !isBlank(field.current) ? field.current : emptyAnswer(field));
  const [remember, setRemember] = useState(true);
  const [companyOnly, setCompanyOnly] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const keyTitle = field.key ? FIELD_KEY_MAP[field.key]?.title : undefined;
  const scope = companyOnly ? host : 'global';

  const fill = async () => {
    setState('saving');
    setError('');
    try {
      const out = await send<{ ok: boolean; reason?: string }>({
        type: 'answerField',
        tabId,
        frameId: field.frameId,
        fieldId: field.id,
        answer: value,
        save: remember ? saveRequest(field, scope) : null,
      });
      if (out && out.ok === false) throw new Error(out.reason ?? 'Could not fill the field');
      setState('saved');
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  /** Save what's already in the field (filled by us or typed by the user) without refilling it. */
  const rememberCurrent = async (v: AnswerValue) => {
    setState('saving');
    try {
      await saveAnswer({ ...saveRequest(field, scope), answer: v });
      setState('saved');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  if (field.kind === 'file') {
    return (
      <li className={`card status-${field.status}`}>
        <p className="q">{field.label}</p>
        <p className="note">{field.note ?? 'No document to upload here.'}</p>
        <Button small onClick={() => props.goto('documents')}>
          Add a document
        </Button>
      </li>
    );
  }

  const typed = field.userValue !== undefined && !isBlank(field.userValue);
  return (
    <li className={`card status-${field.status}`}>
      <p className="q">
        {field.label}
        {field.required && <span className="req" title="Required"> *</span>}
      </p>
      {!editing && (
        <p className="val">
          {typed ? (
            <>
              You entered: <strong>{shown(field.userValue)}</strong>
            </>
          ) : (
            <>
              Filled: <strong>{field.valueText || shown(field.current)}</strong>
              {field.source !== 'none' && <span className="src"> · {SOURCE_LABEL[field.source]}</span>}
              {field.confidence > 0 && field.confidence < 1 && <span className="src"> · {Math.round(field.confidence * 100)}%</span>}
            </>
          )}
        </p>
      )}
      {field.note && <p className="note">{field.note}</p>}
      {keyTitle && field.status === 'needs' && !typed && <p className="note">Recognized as: {keyTitle}</p>}

      {editing ? (
        <div className="answer">
          <AnswerInput field={field} value={value} onChange={setValue} />
          <label className="inline">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember for future applications
          </label>
          {remember && host && (
            <label className="inline">
              <input type="checkbox" checked={companyOnly} onChange={(e) => setCompanyOnly(e.target.checked)} />
              Only on {host}
            </label>
          )}
          <div className="row">
            <Button kind="primary" small disabled={isBlank(value) || state === 'saving'} onClick={fill}>
              {remember ? 'Fill & remember' : 'Fill'}
            </Button>
            {field.status !== 'needs' && (
              <Button kind="ghost" small onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="row">
          {state === 'saved' ? (
            <span className="saved">Saved ✓</span>
          ) : typed ? (
            <Button kind="primary" small onClick={() => rememberCurrent(field.userValue!)}>
              Remember this answer
            </Button>
          ) : (
            field.status === 'review' &&
            field.current !== undefined &&
            !isBlank(field.current) && (
              <Button small onClick={() => rememberCurrent(field.current!)} title="Save this answer so it fills automatically next time">
                Looks right, remember it
              </Button>
            )
          )}
          <Button kind="ghost" small onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </li>
  );
}

function DocPicker(props: { kind: DocKind; docs: DocumentMeta[]; value: string | undefined; onChange(id: string): void }) {
  const ofKind = props.docs.filter((d) => d.kind === props.kind);
  const def = ofKind.find((d) => d.isDefault);
  if (!ofKind.length) return null;
  return (
    <label className="doc-pick">
      <span>{DOC_KIND_LABELS[props.kind]}</span>
      <select value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">{def ? `${def.name} (default)` : 'Newest'}</option>
        {ofKind
          .filter((d) => d !== def)
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        <option value="none">Don’t attach</option>
      </select>
    </label>
  );
}

const ORDER: FillStatus[] = ['needs', 'review', 'skipped', 'filled', 'prefilled'];

export function ApplyView(props: { tab: ActiveTab | null; goto(v: View, opts?: { importDocId?: string }): void }) {
  const { tab, goto } = props;
  const docs = useLiveQuery(listDocuments, [], [] as DocumentMeta[]);
  const profileSaved = useLiveQuery(hasProfile, [], true);
  const { state, busy, setBusy } = useTabState(tab?.id);
  const [error, setError] = useState('');
  const host = tab ? hostOf(tab.url) : '';
  const fields = useMemo(() => state.reports.flatMap((r) => r.fields), [state]);
  const classifierError = state.reports.find((r) => r.classifierError)?.classifierError;

  useEffect(() => setError(''), [tab?.id]);

  // If no frame reports back (e.g. a page that blocks scripts), don't spin forever.
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), 45_000);
    return () => clearTimeout(t);
  }, [busy, setBusy]);

  const autofill = async () => {
    if (!tab) return;
    setError('');
    setBusy(true);
    try {
      await send({ type: 'autofillTab', tabId: tab.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const byStatus = (s: FillStatus) => fields.filter((f) => f.status === s);
  const counts = Object.fromEntries(ORDER.map((s) => [s, byStatus(s).length])) as Record<FillStatus, number>;
  const typedElsewhere = fields.filter((f) => f.userValue !== undefined && (f.status === 'filled' || f.status === 'prefilled'));
  const webPage = !!tab && /^https?:/.test(tab.url);

  return (
    <div className="view apply">
      {!profileSaved && (
        <Banner tone="info">
          <strong>Welcome!</strong> Start by importing your resume. EzAutoApply parses it into your profile, which you can review and edit.
          <div className="row">
            <Button kind="primary" small onClick={() => goto('profile')}>
              Import my resume
            </Button>
          </div>
        </Banner>
      )}

      <div className="page-card">
        <div className="page-title" title={tab?.url}>
          {tab?.title || 'No page'}
          <small>{host}</small>
        </div>
        {docs.length > 0 && (
          <div className="doc-picks">
            {(['resume', 'coverLetter', 'transcript'] as DocKind[]).map((k) => (
              <DocPicker
                key={k}
                kind={k}
                docs={docs}
                value={state.selection[k]}
                onChange={(id) => tab && setDocSelection(tab.id, { ...state.selection, [k]: id || undefined })}
              />
            ))}
          </div>
        )}
        <Button kind="primary" onClick={autofill} disabled={!webPage || busy}>
          {busy ? 'Filling…' : fields.length ? 'Autofill again' : 'Autofill this page'}
        </Button>
        {!webPage && <p className="hint">Open a job application in this tab to autofill it.</p>}
        {fields.length > 0 && (
          <p className="counts" aria-live="polite">
            <span className="c filled">{counts.filled} filled</span>
            <span className="c review">{counts.review} to check</span>
            <span className="c needs">{counts.needs} need you</span>
            {counts.prefilled > 0 && <span className="c prefilled">{counts.prefilled} already filled</span>}
          </p>
        )}
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {classifierError && (
        <Banner tone="warn">
          The classifier wasn’t available ({classifierError}), so questions the rules didn’t recognize were left for you.
          <div className="row">
            <Button small kind="ghost" onClick={() => goto('settings')}>
              Classifier settings
            </Button>
          </div>
        </Banner>
      )}

      {tab && fields.length > 0 && (
        <>
          <Section title="Needs your answer" count={counts.needs} defaultOpen>
            {counts.needs ? (
              <ul className="cards">
                {byStatus('needs').map((f) => (
                  <FieldCard key={`${f.frameId}:${f.id}`} field={f} tabId={tab.id} host={host} goto={goto} />
                ))}
              </ul>
            ) : (
              <Empty>Nothing required is missing.</Empty>
            )}
          </Section>
          {counts.review > 0 && (
            <Section title="Check these" count={counts.review} defaultOpen>
              <ul className="cards">
                {byStatus('review').map((f) => (
                  <FieldCard key={`${f.frameId}:${f.id}`} field={f} tabId={tab.id} host={host} goto={goto} />
                ))}
              </ul>
            </Section>
          )}
          {typedElsewhere.length > 0 && (
            <Section title="Changed on the page" count={typedElsewhere.length}>
              <ul className="cards">
                {typedElsewhere.map((f) => (
                  <FieldCard key={`${f.frameId}:${f.id}`} field={f} tabId={tab.id} host={host} goto={goto} />
                ))}
              </ul>
            </Section>
          )}
          {counts.skipped > 0 && (
            <Section title="Optional, left blank" count={counts.skipped} defaultOpen={false}>
              <ul className="cards">
                {byStatus('skipped').map((f) => (
                  <FieldCard key={`${f.frameId}:${f.id}`} field={f} tabId={tab.id} host={host} goto={goto} />
                ))}
              </ul>
            </Section>
          )}
          <Section title="Filled" count={counts.filled} defaultOpen={false}>
            <ul className="filled-list">
              {byStatus('filled').map((f) => (
                <li key={`${f.frameId}:${f.id}`}>
                  <span className="q">{f.label}</span>
                  <span className="v">{f.valueText || shown(f.current)}</span>
                </li>
              ))}
            </ul>
          </Section>
          <p className="hint center">EzAutoApply never submits. Review the page, then submit it yourself.</p>
        </>
      )}
    </div>
  );
}

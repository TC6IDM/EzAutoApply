import { type ReactNode, useId, useState } from 'react';
import type { TriState } from '../core/profile';

/** Small form building blocks for the side panel. */

export function Field(props: { label: string; hint?: string; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <div className={`field${props.wide ? ' wide' : ''}`}>
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
      {props.hint && <small className="hint">{props.hint}</small>}
    </div>
  );
}

export function TextInput(props: {
  label: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  type?: string;
  hint?: string;
  wide?: boolean;
  multiline?: boolean;
}) {
  return (
    <Field label={props.label} hint={props.hint} wide={props.wide || props.multiline}>
      {(id) =>
        props.multiline ? (
          <textarea id={id} value={props.value} placeholder={props.placeholder} rows={4} onChange={(e) => props.onChange(e.target.value)} />
        ) : (
          <input
            id={id}
            type={props.type ?? 'text'}
            value={props.value}
            placeholder={props.placeholder}
            onChange={(e) => props.onChange(e.target.value)}
          />
        )
      }
    </Field>
  );
}

export function SelectInput(props: { label: string; value: string; options: string[]; onChange(v: string): void; hint?: string; wide?: boolean; blank?: string }) {
  const opts = props.options.includes(props.value) || !props.value ? props.options : [props.value, ...props.options];
  return (
    <Field label={props.label} hint={props.hint} wide={props.wide}>
      {(id) => (
        <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          {props.blank !== undefined && <option value="">{props.blank}</option>}
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function TriInput(props: { label: string; value: TriState; onChange(v: TriState): void; hint?: string }) {
  const name = useId();
  const choices: [TriState, string][] = [
    [true, 'Yes'],
    [false, 'No'],
    [null, 'Not set'],
  ];
  return (
    <fieldset className="field tri">
      <legend>{props.label}</legend>
      <div className="segmented" role="radiogroup">
        {choices.map(([v, text]) => (
          <label key={text} className={props.value === v ? 'on' : ''}>
            <input type="radio" name={name} checked={props.value === v} onChange={() => props.onChange(v)} />
            {text}
          </label>
        ))}
      </div>
      {props.hint && <small className="hint">{props.hint}</small>}
    </fieldset>
  );
}

/** Comma-separated list editor that keeps the raw text while typing. */
export function ListInput(props: { label: string; value: string[]; onChange(v: string[]): void; hint?: string; separator?: RegExp }) {
  const [draft, setDraft] = useState<string | null>(null);
  const sep = props.separator ?? /\s*,\s*/;
  return (
    <TextInput
      label={props.label}
      hint={props.hint ?? 'Separate with commas'}
      wide
      multiline={props.value.join(', ').length > 80}
      value={draft ?? props.value.join(', ')}
      onChange={(v) => {
        setDraft(v);
        props.onChange(v.split(sep).map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?(): void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  small?: boolean;
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn ${props.kind ?? 'secondary'}${props.small ? ' small' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

export function Section(props: { title: string; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean; count?: number }) {
  return (
    <details className="section" open={props.defaultOpen ?? true}>
      <summary>
        <span className="section-title">
          {props.title}
          {props.count !== undefined && <span className="count">{props.count}</span>}
        </span>
        {props.actions && (
          <span className="section-actions" onClick={(e) => e.preventDefault()}>
            {props.actions}
          </span>
        )}
      </summary>
      <div className="section-body">{props.children}</div>
    </details>
  );
}

export function Banner(props: { tone: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`banner ${props.tone}`} role={props.tone === 'error' ? 'alert' : 'status'}>{props.children}</div>;
}

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

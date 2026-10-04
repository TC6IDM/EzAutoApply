import { type DragEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { TriState } from '../core/profile';
import { CheckIcon, ChevronIcon } from './icons';

/** Small form building blocks for the side panel. */

export function Field(props: { label: string; hint?: string; children: (id: string, hintId?: string) => ReactNode; wide?: boolean }) {
  const id = useId();
  const hintId = props.hint ? `${id}-hint` : undefined;
  return (
    <div className={`field${props.wide ? ' wide' : ''}`}>
      <label htmlFor={id}>{props.label}</label>
      {props.children(id, hintId)}
      {props.hint && (
        <small className="hint" id={hintId}>
          {props.hint}
        </small>
      )}
    </div>
  );
}

export function TextInput(props: {
  label: string;
  value: string;
  onChange(v: string): void;
  onBlur?(): void;
  placeholder?: string;
  type?: string;
  hint?: string;
  wide?: boolean;
  multiline?: boolean;
  autoComplete?: string;
  spellCheck?: boolean;
  inputMode?: 'text' | 'email' | 'tel' | 'url' | 'numeric' | 'decimal';
}) {
  return (
    <Field label={props.label} hint={props.hint} wide={props.wide || props.multiline}>
      {(id, hintId) =>
        props.multiline ? (
          <textarea
            id={id}
            value={props.value}
            placeholder={props.placeholder}
            rows={4}
            aria-describedby={hintId}
            spellCheck={props.spellCheck}
            onChange={(e) => props.onChange(e.target.value)}
            onBlur={props.onBlur}
          />
        ) : (
          <input
            id={id}
            type={props.type ?? 'text'}
            value={props.value}
            placeholder={props.placeholder}
            aria-describedby={hintId}
            autoComplete={props.autoComplete}
            spellCheck={props.spellCheck}
            inputMode={props.inputMode}
            onChange={(e) => props.onChange(e.target.value)}
            onBlur={props.onBlur}
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
      {(id, hintId) => (
        <select id={id} value={props.value} aria-describedby={hintId} onChange={(e) => props.onChange(e.target.value)}>
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
      <div className="segmented">
        {choices.map(([v, text]) => (
          <label key={text} className={`${props.value === v ? 'on' : ''}${v === null ? ' unset' : ''}`}>
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
  className?: string;
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn ${props.kind ?? 'secondary'}${props.small ? ' small' : ''}${props.className ? ` ${props.className}` : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

export function Section(props: { title: string; children: ReactNode; defaultOpen?: boolean; count?: number; id?: string }) {
  return (
    <details className="section" id={props.id} open={props.defaultOpen ?? true}>
      <summary>
        <ChevronIcon className="chev" />
        <h2 className="section-title">
          {props.title}
          {props.count !== undefined && <span className="count">{props.count}</span>}
        </h2>
      </summary>
      <div className="section-body">{props.children}</div>
    </details>
  );
}

/** Quiet confirmation after a save the user asked for. */
export function Saved() {
  return (
    <span className="saved">
      <CheckIcon />
      Saved
    </span>
  );
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** An area that accepts files dragged in from the desktop or file explorer. */
export function DropZone(props: { onFiles(files: File[]): void; children: ReactNode; className?: string; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave also fire for every child element, so count them.
  const depth = useRef(0);
  return (
    <div
      className={`dropzone${over ? ' over' : ''}${props.className ? ` ${props.className}` : ''}`}
      onDragEnter={(e) => {
        if (!hasFiles(e) || props.disabled) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || props.disabled) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length && !props.disabled) props.onFiles(files);
      }}
    >
      {props.children}
    </div>
  );
}

export function Banner(props: { tone: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`banner ${props.tone}`} role={props.tone === 'error' ? 'alert' : 'status'}>{props.children}</div>;
}

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}

const UNDO_MS = 8000;

/**
 * Deletes happen at once; this offers a few seconds to take one back instead of asking
 * "Are you sure?" first. Returns the toast to render and a function to show it.
 */
export function useUndo(): [ReactNode, (message: string, undo: () => unknown) => void] {
  const [item, setItem] = useState<{ message: string; undo: () => unknown; at: number } | null>(null);
  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => setItem(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [item]);
  // The live region stays in the page so screen readers announce the toast when it appears.
  const toast = (
    <div role="status">
      {item && (
        <div className="undo-toast">
          <span>{item.message}</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              item.undo();
              setItem(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
  return [toast, (message, undo) => setItem({ message, undo, at: Date.now() })];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

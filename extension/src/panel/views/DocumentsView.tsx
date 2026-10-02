import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { DOC_KIND_LABELS, type DocKind, type DocumentMeta } from '../../core/types';
import { addDocument, deleteDocument, getDocument, listDocuments, setDefaultDocument, updateDocument } from '../../db';
import { extractText } from '../../parse/extract';
import type { View } from '../App';
import { Button, Empty, formatBytes, formatDate, Section } from '../ui';

const KINDS: DocKind[] = ['resume', 'coverLetter', 'transcript', 'other'];

function DocRow(props: { doc: DocumentMeta; goto(v: View, opts?: { importDocId?: string }): void }) {
  const { doc } = props;
  const [name, setName] = useState(doc.name);

  /** The stored original file, opened in a tab or saved to disk. */
  const withFile = async (fn: (url: string) => void) => {
    const full = await getDocument(doc.id);
    if (!full) return;
    const url = URL.createObjectURL(full.blob);
    fn(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const open = () => withFile((url) => window.open(url, '_blank'));
  const download = () =>
    withFile((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.fileName;
      a.click();
    });

  return (
    <li className="doc">
      <div className="doc-main">
        <input
          className="doc-name"
          aria-label="Document name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== doc.name && updateDocument(doc.id, { name: name.trim() })}
        />
        <small>
          {doc.fileName} · {formatBytes(doc.size)} · {formatDate(doc.createdAt)}
        </small>
      </div>
      <div className="row">
        {doc.isDefault ? (
          <span className="badge" title={`Used unless you pick another ${DOC_KIND_LABELS[doc.kind].toLowerCase()} on the Apply tab`}>
            ★ Default
          </span>
        ) : (
          <Button small kind="ghost" onClick={() => setDefaultDocument(doc.id)}>
            Make default
          </Button>
        )}
        <Button small kind="ghost" onClick={open}>
          Open
        </Button>
        <Button small kind="ghost" onClick={download}>
          Download
        </Button>
        {doc.kind === 'resume' && (
          <Button small kind="ghost" onClick={() => props.goto('profile', { importDocId: doc.id })} title="Fill empty profile fields from this resume">
            Parse into profile
          </Button>
        )}
        <Button
          small
          kind="danger"
          onClick={() => {
            if (confirm(`Delete “${doc.name}”?`)) deleteDocument(doc.id);
          }}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

export function DocumentsView(props: { goto(v: View, opts?: { importDocId?: string }): void }) {
  const docs = useLiveQuery(listDocuments, [], [] as DocumentMeta[]);
  const [kind, setKind] = useState<DocKind>('resume');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList) => {
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        // Extracted text fills "paste your resume / cover letter" boxes.
        const text = await extractText(file);
        await addDocument({ kind, file, fileName: file.name, text });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view documents">
      <div className="upload">
        <label className="inline">
          Add a
          <select value={kind} onChange={(e) => setKind(e.target.value as DocKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {DOC_KIND_LABELS[k].toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept=".pdf,.doc,.docx,.txt,.md,.rtf,.odt,image/*"
          onChange={(e) => {
            if (e.target.files?.length) upload(e.target.files);
            e.target.value = '';
          }}
        />
        <Button kind="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Saving…' : 'Choose file'}
        </Button>
      </div>
      <p className="hint">
        The original files are stored here, in EzAutoApply’s storage in this browser, and are uploaded to application forms exactly as you added them.
        The ★ default of each type is used unless you pick a different one on the Apply tab. Backups (Settings) include these files.
      </p>

      {KINDS.map((k) => {
        const ofKind = docs.filter((d) => d.kind === k);
        return (
          <Section key={k} title={`${DOC_KIND_LABELS[k]}s`} count={ofKind.length} defaultOpen={ofKind.length > 0 || k === 'resume'}>
            {ofKind.length ? (
              <ul className="docs">
                {ofKind.map((d) => (
                  <DocRow key={d.id} doc={d} goto={props.goto} />
                ))}
              </ul>
            ) : (
              <Empty>None yet.</Empty>
            )}
          </Section>
        );
      })}
    </div>
  );
}

import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { guessDocKind, type PersonName, uploadFileName } from '../../core/documents';
import { DOC_KIND_LABELS, type DocKind, type DocumentMeta, type FileNameFormat } from '../../core/types';
import {
  addDocument,
  changeDocumentKind,
  deleteDocument,
  getDocument,
  getProfile,
  getSettings,
  listDocuments,
  setDefaultDocument,
  updateDocument,
} from '../../db';
import { extractText } from '../../parse/extract';
import type { View } from '../App';
import { Banner, Button, DropZone, Empty, formatBytes, formatDate, Section } from '../ui';

const KINDS: DocKind[] = ['resume', 'coverLetter', 'transcript', 'other'];

const SECTION_TITLES: Record<DocKind, string> = {
  resume: 'Resumes',
  coverLetter: 'Cover letters',
  transcript: 'Transcripts',
  other: 'Other documents',
};

const ACCEPT = '.pdf,.doc,.docx,.txt,.md,.rtf,.odt,image/*';

function DocRow(props: { doc: DocumentMeta; uploadName: string; goto(v: View, opts?: { importDocId?: string }): void }) {
  const { doc, uploadName } = props;
  const [name, setName] = useState(doc.name);

  /** The stored original file, opened in a tab or saved to disk under its upload name. */
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
      a.download = uploadName;
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
          Uploads as <span className="upload-name">{uploadName}</span>
        </small>
        <small>
          {uploadName !== doc.fileName && <>Added as {doc.fileName} · </>}
          {formatBytes(doc.size)} · {formatDate(doc.createdAt)}
        </small>
      </div>
      <div className="row">
        <select
          className="doc-kind"
          aria-label={`Type of ${doc.name}`}
          value={doc.kind}
          onChange={(e) => changeDocumentKind(doc.id, e.target.value as DocKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {DOC_KIND_LABELS[k]}
            </option>
          ))}
        </select>
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

interface Added {
  fileName: string;
  kind: DocKind;
  guessed: boolean;
}

export function DocumentsView(props: { goto(v: View, opts?: { importDocId?: string }): void }) {
  const docs = useLiveQuery(listDocuments, [], [] as DocumentMeta[]);
  const person = useLiveQuery(async () => (await getProfile()).personal, [], null as PersonName | null);
  const format = useLiveQuery(async () => (await getSettings()).fileNameFormat, [], 'underscore' as FileNameFormat);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Added[]>([]);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  /** Store each file; its kind is the section it was dropped on, or a guess from its name and text. */
  const add = async (files: File[], kind?: DocKind) => {
    setBusy(true);
    setError('');
    const done: Added[] = [];
    try {
      for (const file of files) {
        // The extracted text also fills "paste your resume / cover letter" boxes.
        const text = await extractText(file);
        const k = kind ?? guessDocKind(file.name, text);
        await addDocument({ kind: k, file, fileName: file.name, text });
        done.push({ fileName: file.name, kind: k, guessed: !kind });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdded(done);
      setBusy(false);
    }
  };

  const name = person ?? { firstName: '', lastName: '' };
  const hasName = !!(name.firstName.trim() || name.lastName.trim());

  return (
    <div className="view documents">
      <DropZone className="drop-main" onFiles={(f) => add(f)} disabled={busy}>
        <span className="drop-icon" aria-hidden="true">
          ⇣
        </span>
        <p>
          <strong>{busy ? 'Adding…' : 'Drop resumes, cover letters or transcripts here'}</strong>
        </p>
        <p className="hint">Each file is sorted by type automatically. You can change the type below, or drop onto a section to choose it yourself.</p>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) add(files);
          }}
        />
        <Button kind="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          Choose files
        </Button>
      </DropZone>

      {added.length > 0 && (
        <Banner tone="ok">
          <ul className="added-list">
            {added.map((a, i) => (
              <li key={i}>
                {a.fileName} → {DOC_KIND_LABELS[a.kind].toLowerCase()}
                {a.guessed && a.kind === 'other' && ' (couldn’t tell the type; change it below if needed)'}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {!hasName && format !== 'original' && (
        <Banner tone="info">Add your name on the Profile tab and files will be uploaded with standard names like First_Last_Resume.pdf.</Banner>
      )}

      <p className="hint">
        The original files are stored in this browser. When a form asks for one, it’s uploaded under a standard name (change the format in
        Settings). The ★ default of each type is used unless you pick another on the Apply tab. Backups include these files.
      </p>

      {KINDS.map((k) => {
        const ofKind = docs.filter((d) => d.kind === k);
        return (
          <DropZone key={k} onFiles={(f) => add(f, k)} disabled={busy}>
            <Section title={SECTION_TITLES[k]} count={ofKind.length} defaultOpen={ofKind.length > 0 || k === 'resume'}>
              {ofKind.length ? (
                <ul className="docs">
                  {ofKind.map((d) => (
                    <DocRow key={d.id} doc={d} uploadName={uploadFileName(d, name, format)} goto={props.goto} />
                  ))}
                </ul>
              ) : (
                <Empty>None yet. Drop a file here to add one.</Empty>
              )}
            </Section>
          </DropZone>
        );
      })}
    </div>
  );
}

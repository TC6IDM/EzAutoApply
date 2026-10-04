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
  restoreDocument,
  setDefaultDocument,
  updateDocument,
} from '../../db';
import { extractText } from '../../parse/extract';
import type { Goto } from '../App';
import { UploadIcon } from '../icons';
import { Banner, Button, DropZone, Empty, formatBytes, formatDate, Section, useUndo } from '../ui';

const KINDS: DocKind[] = ['resume', 'coverLetter', 'transcript', 'other'];

const SECTION_TITLES: Record<DocKind, string> = {
  resume: 'Resumes',
  coverLetter: 'Cover letters',
  transcript: 'Transcripts',
  other: 'Other documents',
};

const ACCEPT = '.pdf,.doc,.docx,.txt,.md,.rtf,.odt,image/*';

function DocRow(props: { doc: DocumentMeta; uploadName: string; goto: Goto; onDelete(doc: DocumentMeta): void }) {
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
          <button type="button" className="link-btn" onClick={open} title="Open the original file">
            {doc.fileName}
          </button>{' '}
          · {formatBytes(doc.size)} · {formatDate(doc.createdAt)}
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
          <span className="tag">Default</span>
        ) : (
          <Button small kind="ghost" onClick={() => setDefaultDocument(doc.id)}>
            Make default
          </Button>
        )}
      </div>
      <div className="row">
        {doc.kind === 'resume' && (
          <Button small kind="ghost" onClick={() => props.goto('profile', { importDocId: doc.id })} title="Fill empty profile fields from this resume">
            Parse into profile
          </Button>
        )}
        <Button small kind="ghost" onClick={download}>
          Download
        </Button>
        <Button small kind="danger" className="push-end" onClick={() => props.onDelete(doc)}>
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

export function DocumentsView(props: { goto: Goto }) {
  const docs = useLiveQuery(listDocuments, [], [] as DocumentMeta[]);
  const person = useLiveQuery(async () => (await getProfile()).personal, [], null as PersonName | null);
  const format = useLiveQuery(async () => (await getSettings()).fileNameFormat, [], 'underscore' as FileNameFormat);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Added[]>([]);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [undoToast, offerUndo] = useUndo();

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

  /** Delete at once; the stored copy is kept in memory for a few seconds in case of Undo. */
  const remove = async (doc: DocumentMeta) => {
    const full = await getDocument(doc.id);
    await deleteDocument(doc.id);
    if (full) offerUndo(`Deleted “${doc.name}”.`, () => restoreDocument(full));
  };

  const name = person ?? { firstName: '', lastName: '' };
  const hasName = !!(name.firstName.trim() || name.lastName.trim());

  return (
    <div className="view documents">
      <DropZone className="drop-main" onFiles={(f) => add(f)} disabled={busy}>
        <UploadIcon className="drop-icon" />
        <p>
          <strong>{busy ? 'Adding…' : 'Drop resumes, cover letters or transcripts'}</strong>
        </p>
        <p className="hint">Sorted by type for you. Stored in this browser only.</p>
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
                {a.fileName} added to {SECTION_TITLES[a.kind]}
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

      {KINDS.map((k) => {
        const ofKind = docs.filter((d) => d.kind === k);
        return (
          <DropZone key={k} onFiles={(f) => add(f, k)} disabled={busy}>
            <Section title={SECTION_TITLES[k]} count={ofKind.length} defaultOpen={ofKind.length > 0 || k === 'resume'}>
              {ofKind.length ? (
                <ul className="docs rows">
                  {ofKind.map((d) => (
                    <DocRow key={d.id} doc={d} uploadName={uploadFileName(d, name, format)} goto={props.goto} onDelete={remove} />
                  ))}
                </ul>
              ) : (
                <Empty>None yet. Drop a file here to add one.</Empty>
              )}
            </Section>
          </DropZone>
        );
      })}
      {docs.length > 0 && (
        <p className="hint">The default of each type is attached unless you pick another on the Apply tab.</p>
      )}
      {undoToast}
    </div>
  );
}

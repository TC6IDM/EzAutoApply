import Dexie, { type EntityTable } from 'dexie';
import { normalize } from '../core/normalize';
import { emptyProfile, newId, normalizeProfile, type Profile } from '../core/profile';
import {
  type ApplicationRecord,
  defaultSettings,
  type DocKind,
  type DocumentMeta,
  type SavedAnswer,
  type Settings,
  type StoredDocument,
} from '../core/types';

/**
 * Everything lives in the extension's own IndexedDB, shared by the background
 * worker and the side panel. Content scripts run in the page's origin and
 * reach it only through messages to the background.
 */

interface KvRow {
  key: string;
  value: unknown;
}

class EzDb extends Dexie {
  kv!: EntityTable<KvRow, 'key'>;
  documents!: EntityTable<StoredDocument, 'id'>;
  answers!: EntityTable<SavedAnswer, 'id'>;
  applications!: EntityTable<ApplicationRecord, 'id'>;

  constructor() {
    super('ezautoapply');
    this.version(1).stores({
      kv: 'key',
      documents: 'id, kind, isDefault, createdAt',
      answers: 'id, normalized, scope, lastUsed',
      applications: 'id, url, host, date',
    });
  }
}

export const db = new EzDb();

// ── profile & settings ──────────────────────────────────────────────────

export async function getProfile(): Promise<Profile> {
  const row = await db.kv.get('profile');
  return row ? normalizeProfile(row.value as Partial<Profile>) : emptyProfile();
}

export async function saveProfile(p: Profile): Promise<void> {
  await db.kv.put({ key: 'profile', value: { ...p, updatedAt: Date.now() } });
}

export async function hasProfile(): Promise<boolean> {
  return !!(await db.kv.get('profile'));
}

export async function getSettings(): Promise<Settings> {
  const row = await db.kv.get('settings');
  const d = defaultSettings();
  const s = (row?.value ?? {}) as Partial<Settings>;
  return { ...d, ...s, classifier: { ...d.classifier, ...s.classifier } };
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.kv.put({ key: 'settings', value: s });
}

// ── documents ───────────────────────────────────────────────────────────

export function toMeta(d: StoredDocument): DocumentMeta {
  const { blob: _blob, ...meta } = d;
  return meta;
}

export async function listDocuments(): Promise<DocumentMeta[]> {
  const docs = await db.documents.orderBy('createdAt').toArray();
  return docs.map(toMeta);
}

export async function getDocument(id: string): Promise<StoredDocument | undefined> {
  return db.documents.get(id);
}

/** The document to use for a kind: the explicit choice if given, else the default, else the newest. */
export async function documentFor(kind: DocKind, chosenId?: string): Promise<StoredDocument | undefined> {
  if (chosenId) {
    const d = await db.documents.get(chosenId);
    if (d) return d;
  }
  const ofKind = await db.documents.where('kind').equals(kind).toArray();
  return ofKind.find((d) => d.isDefault) ?? ofKind.sort((a, b) => b.createdAt - a.createdAt)[0];
}

export async function addDocument(input: {
  kind: DocKind;
  file: Blob;
  fileName: string;
  name?: string;
  text?: string;
  makeDefault?: boolean;
}): Promise<StoredDocument> {
  const existing = await db.documents.where('kind').equals(input.kind).count();
  const doc: StoredDocument = {
    id: newId(),
    kind: input.kind,
    name: input.name || input.fileName.replace(/\.[^.]+$/, ''),
    fileName: input.fileName,
    mime: input.file.type || 'application/octet-stream',
    size: input.file.size,
    blob: input.file,
    text: input.text ?? '',
    isDefault: input.makeDefault ?? existing === 0,
    createdAt: Date.now(),
  };
  await db.transaction('rw', db.documents, async () => {
    if (doc.isDefault) await db.documents.where('kind').equals(doc.kind).modify({ isDefault: false });
    await db.documents.add(doc);
  });
  return doc;
}

export async function setDefaultDocument(id: string): Promise<void> {
  await db.transaction('rw', db.documents, async () => {
    const doc = await db.documents.get(id);
    if (!doc) return;
    await db.documents.where('kind').equals(doc.kind).modify({ isDefault: false });
    await db.documents.update(id, { isDefault: true });
  });
}

export async function updateDocument(id: string, changes: Partial<Pick<StoredDocument, 'name' | 'kind' | 'text'>>): Promise<void> {
  await db.documents.update(id, changes);
}

export async function deleteDocument(id: string): Promise<void> {
  await db.transaction('rw', db.documents, async () => {
    const doc = await db.documents.get(id);
    await db.documents.delete(id);
    if (doc?.isDefault) {
      // Keep one default per kind: promote the newest remaining document.
      const rest = await db.documents.where('kind').equals(doc.kind).sortBy('createdAt');
      const next = rest[rest.length - 1];
      if (next) await db.documents.update(next.id, { isDefault: true });
    }
  });
}

// ── answer bank ─────────────────────────────────────────────────────────

export async function listAnswers(): Promise<SavedAnswer[]> {
  return db.answers.orderBy('lastUsed').reverse().toArray();
}

export async function saveAnswer(input: Omit<SavedAnswer, 'id' | 'normalized' | 'timesUsed' | 'lastUsed' | 'createdAt'>): Promise<SavedAnswer> {
  const normalized = normalize(input.question);
  // One answer per question and scope: answering again replaces the old answer.
  const existing = await db.answers.where('normalized').equals(normalized).filter((a) => a.scope === input.scope).first();
  const now = Date.now();
  const row: SavedAnswer = {
    id: existing?.id ?? newId(),
    normalized,
    timesUsed: existing?.timesUsed ?? 0,
    createdAt: existing?.createdAt ?? now,
    lastUsed: now,
    ...input,
  };
  await db.answers.put(row);
  return row;
}

export async function updateAnswer(id: string, changes: Partial<SavedAnswer>): Promise<void> {
  if (changes.question !== undefined) changes.normalized = normalize(changes.question);
  await db.answers.update(id, changes);
}

export async function deleteAnswer(id: string): Promise<void> {
  await db.answers.delete(id);
}

export async function markAnswersUsed(ids: string[]): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.answers, async () => {
    for (const id of new Set(ids)) {
      const a = await db.answers.get(id);
      if (a) await db.answers.update(id, { timesUsed: a.timesUsed + 1, lastUsed: now });
    }
  });
}

// ── application log ─────────────────────────────────────────────────────

export async function logApplication(rec: Omit<ApplicationRecord, 'id'>): Promise<void> {
  const existing = await db.applications.where('url').equals(rec.url).first();
  await db.applications.put({ ...rec, id: existing?.id ?? newId() });
}

export async function listApplications(limit = 200): Promise<ApplicationRecord[]> {
  return db.applications.orderBy('date').reverse().limit(limit).toArray();
}

// ── backup ──────────────────────────────────────────────────────────────

export interface ExportFile {
  app: 'EzAutoApply';
  version: 1;
  exportedAt: string;
  profile: Profile;
  settings: Settings;
  answers: SavedAnswer[];
  applications: ApplicationRecord[];
  documents: (DocumentMeta & { base64: string })[];
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function exportAll(): Promise<ExportFile> {
  const docs = await db.documents.toArray();
  return {
    app: 'EzAutoApply',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: await getProfile(),
    settings: await getSettings(),
    answers: await db.answers.toArray(),
    applications: await db.applications.toArray(),
    documents: await Promise.all(docs.map(async (d) => ({ ...toMeta(d), base64: await blobToBase64(d.blob) }))),
  };
}

/** Replace all data with the contents of an export file. */
export async function importAll(data: ExportFile): Promise<void> {
  if (data?.app !== 'EzAutoApply') throw new Error('Not an EzAutoApply backup file');
  await db.transaction('rw', [db.kv, db.documents, db.answers, db.applications], async () => {
    await Promise.all([db.kv.clear(), db.documents.clear(), db.answers.clear(), db.applications.clear()]);
    await db.kv.put({ key: 'profile', value: normalizeProfile(data.profile) });
    if (data.settings) await db.kv.put({ key: 'settings', value: data.settings });
    await db.answers.bulkPut(data.answers ?? []);
    await db.applications.bulkPut(data.applications ?? []);
    await db.documents.bulkPut(
      (data.documents ?? []).map(({ base64, ...meta }) => ({ ...meta, blob: base64ToBlob(base64, meta.mime) })),
    );
  });
}

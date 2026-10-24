import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Usage notes: the gotchas that cost a round trip once and should never cost a second one —
// "this pack writes its prompt through globalThis.AICG3D_H3.setPromptText", "workflowJson has
// to be a string", "node 195 lags a frame behind its DOM editor". They live next to the tool,
// not in the model's head, because a fresh conversation has no head to keep them in.
//
// Shape follows RunningHub's note_workflow: one note list per target, deduplicated, newest
// last, capped at 5. It is a note list, not a log — an unbounded log pushes the one line that
// matters off the end and nobody reads it.
const MAX_NOTES = 5;
const MAX_NOTE_CHARS = 400;

const normalize = note => String(note ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_NOTE_CHARS);

/** 'node:KSampler' / 'workflow:workflows/x.json' / bare 'KSampler' all land on one key space,
 *  so a note written with a bare type is still found when the caller asks by prefix. */
export function normalizeTarget(target) {
  const raw = String(target ?? '').trim();
  if (!raw) return null;
  if (raw.includes(':')) return raw;
  return (raw.includes('/') || raw.endsWith('.json') ? 'workflow:' : 'node:') + raw;
}

export class NoteStore {
  constructor(file) { this.file = file; this.entries = {}; this.writes = Promise.resolve(); }
  async start() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  /** Returns the target's note list as it now stands, so the caller can echo it back verbatim. */
  async add(target, note) {
    const key = normalizeTarget(target);
    const text = normalize(note);
    if (!key) throw new Error('note 需要 target：用 "node:<节点类型>"（如 node:KSampler）或 "workflow:<工作流路径>"（如 workflow:workflows/demo.json）。');
    if (!text) throw new Error('note 不能为空：写一句下一次能直接照做的话，例如「dom 控件要写它的 shadow 源 node.properties」。');
    const existing = this.entries[key]?.notes || [];
    const notes = [...existing.filter(item => item !== text), text].slice(-MAX_NOTES);
    this.entries[key] = { notes, updatedAt: new Date().toISOString() };
    await this.flush();
    return { target: key, notes, deduplicated: existing.includes(text) };
  }
  /** Deletes lines. Without `note` the whole target goes: an entry with an empty list would keep
   *  showing up in all() as a target that knows nothing. A line that does not match is refused with
   *  the real list attached — a silently wrong delete is the one mistake the caller cannot see
   *  afterwards, and this file is edited by hand when the tool cannot do it. */
  async forget(target, note) {
    const key = normalizeTarget(target);
    if (!key) throw new Error('note 需要 target：用 "node:<节点类型>"（如 node:KSampler）或 "workflow:<工作流路径>"（如 workflow:workflows/demo.json）。');
    const existing = this.entries[key]?.notes || [];
    const given = note !== undefined && note !== null;
    const text = given ? normalize(note) : '';
    // An unknown target is not an error: forget is the cleanup call, and cleanup has to stay safe to
    // repeat after somebody already removed the line from the JSON by hand.
    if (!existing.length) return { target: key, removed: [], notes: [], cleared: true, note: '这个 target 本来就没有笔记。' };
    if (given && !text) throw new Error('要删的那一句是空的：传要删的整句原文，或者不传 note 删掉这个 target 的全部笔记。');
    if (!text) {
      delete this.entries[key];
      await this.flush();
      return { target: key, removed: existing, notes: [], cleared: true };
    }
    if (!existing.includes(text)) throw new Error('这条笔记不存在，没有删：' + key + ' 现在记的是 ' + existing.map(line => JSON.stringify(line)).join('、') + '。要删哪一条就原样传那一句；全部删掉就不带 note。');
    const notes = existing.filter(line => line !== text);
    if (notes.length) this.entries[key] = { notes, updatedAt: new Date().toISOString() };
    else delete this.entries[key];
    await this.flush();
    return { target: key, removed: [text], notes, cleared: notes.length === 0 };
  }
  read(target) { const key = normalizeTarget(target); return key ? (this.entries[key]?.notes || []) : []; }
  /** Everything worth injecting for one call: the active workflow plus every node type on the
   *  canvas. Empty notes never reach the reply — an empty array would read as "nothing known"
   *  and invite the model to re-derive what it already has. */
  relevant({ workflowPath, types = [] } = {}) {
    const found = [];
    const workflow = workflowPath ? this.read('workflow:' + workflowPath) : [];
    if (workflow.length) found.push({ target: 'workflow:' + workflowPath, notes: workflow });
    for (const type of [...new Set(types)].sort()) {
      const notes = this.read('node:' + type);
      if (notes.length) found.push({ target: 'node:' + type, notes });
    }
    return found;
  }
  all() {
    return Object.entries(this.entries)
      .map(([target, value]) => ({ target, notes: value.notes || [], updatedAt: value.updatedAt }))
      .sort((left, right) => String(left.target).localeCompare(String(right.target)));
  }
  flush() {
    const text = JSON.stringify({ version: 1, entries: this.entries }, null, 1) + '\n';
    const next = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, text, { mode: 0o600 }); await rename(temp, this.file);
    });
    this.writes = next;
    return next;
  }
}

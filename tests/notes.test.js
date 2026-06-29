'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createNoteRecord,
  createReplyRecord,
  updateNoteRecord,
  updateReplyRecord,
  ValidationError,
  validateNoteInput,
  validateReplyInput
} = require('../src/domain/notes');
const { openStore } = require('../src/storage/sqlite-store');

test('validates and normalizes note input', () => {
  assert.deepEqual(validateNoteInput({ title: ' Canary ', body: ' Note body ' }), {
    title: 'Canary',
    body: 'Note body'
  });
});

test('rejects missing note fields with actionable details', () => {
  assert.throws(
    () => validateNoteInput({ title: '', body: '' }),
    (error) => {
      assert.equal(error instanceof ValidationError, true);
      assert.deepEqual(error.details, {
        title: 'Title is required.',
        body: 'Body is required.'
      });
      return true;
    }
  );
});

test('rejects missing reply body with actionable details', () => {
  assert.throws(
    () => validateReplyInput({ body: '' }),
    (error) => {
      assert.equal(error instanceof ValidationError, true);
      assert.deepEqual(error.details, {
        body: 'Reply is required.'
      });
      return true;
    }
  );
});

test('persists a note in a disposable SQLite database', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));

  try {
    const timestamp = new Date('2026-06-28T00:00:00.000Z');
    const created = store.createNote(createNoteRecord({ title: 'First', body: 'Body' }, timestamp));

    assert.equal(created.id, 1);
    assert.deepEqual(store.listNotes(), [
      {
        id: 1,
        title: 'First',
        body: 'Body',
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString()
      }
    ]);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('updates and deletes a note in a disposable SQLite database', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-edit-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));

  try {
    const createdAt = new Date('2026-06-28T00:00:00.000Z');
    const updatedAt = new Date('2026-06-28T00:30:00.000Z');
    const created = store.createNote(createNoteRecord({ title: 'First', body: 'Body' }, createdAt));
    const updated = store.updateNote(created.id, updateNoteRecord({ title: 'Updated', body: 'New body' }, updatedAt));

    assert.deepEqual(updated, {
      id: created.id,
      title: 'Updated',
      body: 'New body',
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString()
    });
    assert.equal(store.deleteNote(created.id), true);
    assert.equal(store.getNote(created.id), null);
    assert.equal(store.deleteNote(created.id), false);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('lists only notes after a known id', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-after-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));

  try {
    const timestamp = new Date('2026-06-28T00:00:00.000Z');
    const first = store.createNote(createNoteRecord({ title: 'First', body: 'One' }, timestamp));
    const second = store.createNote(createNoteRecord({ title: 'Second', body: 'Two' }, timestamp));

    assert.deepEqual(store.listNotes({ afterId: first.id }), [second]);
    assert.deepEqual(store.listNotes({ afterId: second.id }), []);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('lists newest notes first and caps the default list at 50', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-limit-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));

  try {
    const timestamp = new Date('2026-06-28T00:00:00.000Z');
    for (let index = 1; index <= 55; index += 1) {
      store.createNote(createNoteRecord({ title: `Note ${index}`, body: 'Body' }, timestamp));
    }

    const notes = store.listNotes();
    assert.equal(notes.length, 50);
    assert.equal(notes[0].id, 55);
    assert.equal(notes[49].id, 6);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('creates, updates, deletes, and cascades replies', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-replies-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));

  try {
    const createdAt = new Date('2026-06-28T00:00:00.000Z');
    const updatedAt = new Date('2026-06-28T00:30:00.000Z');
    const note = store.createNote(createNoteRecord({ title: 'Post', body: 'Body' }, createdAt));
    const reply = store.createReply(note.id, createReplyRecord({ body: 'Answer' }, createdAt));

    assert.deepEqual(store.listReplies(note.id), [reply]);
    assert.equal(store.createReply(999, createReplyRecord({ body: 'No parent' }, createdAt)), null);

    const updated = store.updateReply(reply.id, updateReplyRecord({ body: 'Edited answer' }, updatedAt));
    assert.deepEqual(updated, {
      id: reply.id,
      noteId: note.id,
      body: 'Edited answer',
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString()
    });

    assert.equal(store.deleteReply(reply.id), true);
    assert.equal(store.deleteReply(reply.id), false);

    const secondReply = store.createReply(note.id, createReplyRecord({ body: 'Cascade me' }, createdAt));
    assert.equal(secondReply.noteId, note.id);
    assert.equal(store.deleteNote(note.id), true);
    assert.deepEqual(store.listReplies(note.id), []);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

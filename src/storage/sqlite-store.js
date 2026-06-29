'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATION_DIR = path.join(__dirname, '..', '..', 'migrations');

function openStore(databasePath) {
  if (!databasePath || typeof databasePath !== 'string') {
    throw new Error('A SQLite database path is required.');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  for (const file of fs.readdirSync(MIGRATION_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8'));
  }

  const toNote = (row) => row && {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };

  const toReply = (row) => row && {
    id: row.id,
    noteId: row.noteId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };

  return {
    close() {
      database.close();
    },

    createNote(note) {
      const statement = database.prepare(`
        INSERT INTO notes (title, body, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const result = statement.run(note.title, note.body, note.createdAt, note.updatedAt);
      return this.getNote(Number(result.lastInsertRowid));
    },

    updateNote(id, note) {
      const statement = database.prepare(`
        UPDATE notes
        SET title = ?, body = ?, updated_at = ?
        WHERE id = ?
      `);
      const result = statement.run(note.title, note.body, note.updatedAt, id);
      return result.changes > 0 ? this.getNote(id) : null;
    },

    deleteNote(id) {
      database.prepare('DELETE FROM replies WHERE note_id = ?').run(id);
      const statement = database.prepare('DELETE FROM notes WHERE id = ?');
      const result = statement.run(id);
      return result.changes > 0;
    },

    getNote(id) {
      const statement = database.prepare(`
        SELECT id, title, body, created_at AS createdAt, updated_at AS updatedAt
        FROM notes
        WHERE id = ?
      `);
      return toNote(statement.get(id)) || null;
    },

    listNotes(options = {}) {
      const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;

      if (options.afterId) {
        const statement = database.prepare(`
          SELECT id, title, body, created_at AS createdAt, updated_at AS updatedAt
          FROM notes
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?
        `);
        return statement.all(options.afterId, limit).map(toNote);
      }

      const statement = database.prepare(`
        SELECT id, title, body, created_at AS createdAt, updated_at AS updatedAt
        FROM notes
        ORDER BY id DESC
        LIMIT ?
      `);
      return statement.all(limit).map(toNote);
    },

    createReply(noteId, reply) {
      const note = this.getNote(noteId);
      if (!note) {
        return null;
      }
      const statement = database.prepare(`
        INSERT INTO replies (note_id, body, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const result = statement.run(noteId, reply.body, reply.createdAt, reply.updatedAt);
      return this.getReply(Number(result.lastInsertRowid));
    },

    updateReply(id, reply) {
      const statement = database.prepare(`
        UPDATE replies
        SET body = ?, updated_at = ?
        WHERE id = ?
      `);
      const result = statement.run(reply.body, reply.updatedAt, id);
      return result.changes > 0 ? this.getReply(id) : null;
    },

    deleteReply(id) {
      const statement = database.prepare('DELETE FROM replies WHERE id = ?');
      const result = statement.run(id);
      return result.changes > 0;
    },

    getReply(id) {
      const statement = database.prepare(`
        SELECT id, note_id AS noteId, body, created_at AS createdAt, updated_at AS updatedAt
        FROM replies
        WHERE id = ?
      `);
      return toReply(statement.get(id)) || null;
    },

    listReplies(noteId) {
      const statement = database.prepare(`
        SELECT id, note_id AS noteId, body, created_at AS createdAt, updated_at AS updatedAt
        FROM replies
        WHERE note_id = ?
        ORDER BY id ASC
      `);
      return statement.all(noteId).map(toReply);
    }
  };
}

module.exports = {
  openStore
};

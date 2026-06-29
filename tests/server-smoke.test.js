'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');
const { createApp } = require('../src/http/server');
const { openStore } = require('../src/storage/sqlite-store');

function request(app, { method, url, body, rawBody, contentType }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const requestBody = rawBody ? [rawBody] : body ? [JSON.stringify(body)] : [];
    const incoming = Readable.from(requestBody);
    incoming.method = method;
    incoming.url = url;
    incoming.headers = body || rawBody
      ? { host: '127.0.0.1', 'content-type': contentType || 'application/json' }
      : { host: '127.0.0.1' };

    const response = {
      statusCode: 200,
      headers: {},
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(chunk) {
        if (chunk) {
          chunks.push(Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          text,
          json: text && this.headers['content-type'] && this.headers['content-type'].includes('application/json')
            ? JSON.parse(text)
            : null
        });
      }
    };

    Promise.resolve(app(incoming, response)).catch((error) => {
      if (!incoming.destroyed) {
        incoming.destroy();
      }
      reject(error);
    });
  });
}

class FakeClassList {
  constructor(element, classes = []) {
    this.element = element;
    this.classes = new Set(classes);
  }

  add(className) {
    this.classes.add(className);
    this.element.className = [...this.classes].join(' ');
  }

  remove(className) {
    this.classes.delete(className);
    this.element.className = [...this.classes].join(' ');
  }

  contains(className) {
    return this.classes.has(className);
  }
}

class FakeElement {
  constructor(tagName, { className = '', dataset = {}, attributes = {}, text = '' } = {}) {
    this.tagName = tagName.toLowerCase();
    this.className = className;
    this.classList = new FakeClassList(this, className ? className.split(/\s+/).filter(Boolean) : []);
    this.dataset = { ...dataset };
    this.attributes = { ...attributes };
    this.children = [];
    this.listeners = {};
    this.parentNode = null;
    this.text = text;
    this.textContent = text;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  set innerHTML(html) {
    this.children = [];
    for (const match of html.matchAll(/<article class="note" data-note-id="([^"]+)" data-note-signature="([^"]+)">/g)) {
      this.append(new FakeElement('article', {
        className: 'note',
        dataset: {
          noteId: match[1],
          noteSignature: match[2]
        },
        text: html
      }));
    }
    if (this.children.length === 0 && html.includes('class="empty"')) {
      this.append(new FakeElement('p', { className: 'empty', text: html }));
    }
  }

  get nextElementSibling() {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }

  append(child) {
    this.detach(child);
    child.parentNode = this;
    this.children.push(child);
  }

  prepend(child) {
    this.detach(child);
    child.parentNode = this;
    this.children.unshift(child);
  }

  after(child) {
    if (!this.parentNode) {
      return;
    }
    this.parentNode.detach(child);
    const index = this.parentNode.children.indexOf(this);
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, child);
  }

  replaceWith(child) {
    if (!this.parentNode) {
      return;
    }
    this.parentNode.detach(child);
    const index = this.parentNode.children.indexOf(this);
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(index, 1, child);
    this.parentNode = null;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.detach(this);
    }
  }

  detach(child) {
    if (child.parentNode && child.parentNode !== this) {
      child.parentNode.detach(child);
    }
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
  }

  contains(element) {
    let current = element;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  closest(selector) {
    if (selector === 'input, textarea, select, button' && ['input', 'textarea', 'select', 'button'].includes(this.tagName)) {
      return this;
    }
    return this.parentNode ? this.parentNode.closest(selector) : null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  matches(selector) {
    if (selector === '.note') {
      return this.classList.contains('note');
    }
    if (selector === '.empty') {
      return this.classList.contains('empty');
    }
    const dataNoteId = selector.match(/^\[data-note-id="([^"]+)"\]$/);
    if (dataNoteId) {
      return this.dataset.noteId === dataNoteId[1];
    }
    if (selector.startsWith('[data-')) {
      const key = selector.slice('[data-'.length, -1).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      return Object.hasOwn(this.dataset, key);
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || '';
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(eventName, listener) {
    this.listeners[eventName] = listener;
  }

  focus() {}
}

class FakeTemplateElement extends FakeElement {
  constructor() {
    super('template');
    this.content = new FakeElement('fragment');
  }

  set innerHTML(html) {
    const match = html.match(/<article class="note" data-note-id="([^"]+)" data-note-signature="([^"]+)">/);
    if (!match) {
      throw new Error(`Fake template parser expected a note article: ${html}`);
    }
    this.content.children = [
      new FakeElement('article', {
        className: 'note',
        dataset: {
          noteId: match[1],
          noteSignature: match[2]
        },
        text: html
      })
    ];
    this.content.children[0].parentNode = this.content;
  }
}

function fakeNoteElement(note) {
  return new FakeElement('article', {
    className: 'note',
    dataset: {
      noteId: String(note.id),
      noteSignature: `${note.id}|${note.updatedAt}`
    }
  });
}

function extractPageScript(html) {
  const match = html.match(/<script>\n([\s\S]*)\n  <\/script>/);
  assert.ok(match, 'expected page script in rendered HTML');
  return match[1];
}

test('JSON API smoke flow creates and lists a note without opening a socket', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-http-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T01:02:03.000Z')
  });

  try {
    const createResponse = await request(app, {
      method: 'POST',
      url: '/api/notes',
      body: { title: 'Smoke', body: 'Created through HTTP' }
    });

    assert.equal(createResponse.statusCode, 201);
    assert.equal(createResponse.json.note.title, 'Smoke');
    assert.equal(createResponse.json.note.createdAt, '2026-06-28T01:02:03.000Z');

    const listResponse = await request(app, { method: 'GET', url: '/api/notes' });
    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual(listResponse.json, { notes: [createResponse.json.note] });

    const afterCurrentResponse = await request(app, { method: 'GET', url: `/api/notes?after=${createResponse.json.note.id}` });
    assert.equal(afterCurrentResponse.statusCode, 200);
    assert.deepEqual(afterCurrentResponse.json, { notes: [] });

    const secondCreateResponse = await request(app, {
      method: 'POST',
      url: '/api/notes',
      body: { title: 'Second', body: 'Printed by polling' }
    });
    const allNotesResponse = await request(app, { method: 'GET', url: '/api/notes' });
    assert.deepEqual(allNotesResponse.json.notes.map((note) => note.title), ['Second', 'Smoke']);

    const newNotesResponse = await request(app, { method: 'GET', url: `/api/notes?after=${createResponse.json.note.id}` });
    assert.equal(newNotesResponse.statusCode, 200);
    assert.deepEqual(newNotesResponse.json, { notes: [secondCreateResponse.json.note] });

    store.createReply(secondCreateResponse.json.note.id, {
      body: 'Live answer',
      createdAt: '2026-06-28T01:02:03.000Z',
      updatedAt: '2026-06-28T01:02:03.000Z'
    });
    const notesWithRepliesResponse = await request(app, { method: 'GET', url: '/api/notes' });
    assert.equal(notesWithRepliesResponse.statusCode, 200);
    assert.equal(notesWithRepliesResponse.json.notes[0].title, 'Second');
    assert.deepEqual(notesWithRepliesResponse.json.notes[0].replies.map((reply) => reply.body), ['Live answer']);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('JSON API rejects malformed and oversized request bodies without writing notes', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-http-abuse-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T01:02:03.000Z')
  });

  try {
    const malformed = await request(app, {
      method: 'POST',
      url: '/api/notes',
      rawBody: '{"title":',
      contentType: 'application/json'
    });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json, { error: 'Request body must be valid JSON.' });

    const oversized = await request(app, {
      method: 'POST',
      url: '/api/notes',
      rawBody: JSON.stringify({ title: 'Too large', body: 'x'.repeat(70 * 1024) }),
      contentType: 'application/json'
    });
    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json, { error: 'Request body is too large.' });
    assert.deepEqual(store.listNotes(), []);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser form rejects oversized request bodies without writing notes', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-form-abuse-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    const oversized = await request(app, {
      method: 'POST',
      url: '/notes',
      rawBody: new URLSearchParams({
        title: 'Too large',
        body: 'x'.repeat(70 * 1024)
      }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });

    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json, { error: 'Request body is too large.' });
    assert.deepEqual(store.listNotes(), []);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('missing note and reply mutations return not found without side effects', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-missing-routes-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    const editMissingNote = await request(app, {
      method: 'POST',
      url: '/notes/999/edit',
      rawBody: new URLSearchParams({ title: 'Missing', body: 'Missing' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(editMissingNote.statusCode, 404);
    assert.deepEqual(editMissingNote.json, { error: 'Not found.' });

    const replyMissingNote = await request(app, {
      method: 'POST',
      url: '/notes/999/replies',
      rawBody: new URLSearchParams({ body: 'Missing parent' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(replyMissingNote.statusCode, 404);
    assert.deepEqual(replyMissingNote.json, { error: 'Not found.' });

    const editMissingReply = await request(app, {
      method: 'POST',
      url: '/replies/999/edit',
      rawBody: new URLSearchParams({ body: 'Missing reply' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(editMissingReply.statusCode, 404);
    assert.deepEqual(editMissingReply.json, { error: 'Not found.' });

    const deleteMissingReply = await request(app, {
      method: 'POST',
      url: '/replies/999/delete',
      rawBody: '',
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(deleteMissingReply.statusCode, 404);
    assert.deepEqual(deleteMissingReply.json, { error: 'Not found.' });
    assert.deepEqual(store.listNotes(), []);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser smoke flow creates a note and shows it after refresh', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    const firstPage = await request(app, { method: 'GET', url: '/' });
    assert.equal(firstPage.statusCode, 200);
    assert.match(firstPage.text, /<title>House Notes<\/title>/);
    assert.match(firstPage.text, /<h1 class="logo-frame">/);
    assert.match(firstPage.text, /<img src="\/assets\/house-notes-logo\.png" alt="House Notes" width="412" height="137">/);
    assert.match(firstPage.text, /Notes Update Live Bi-Directionally/);
    assert.match(firstPage.text, /data-theme="manor"/);
    assert.match(firstPage.text, /data-theme="crypt"/);
    assert.match(firstPage.text, /data-theme="bloodmoon"/);
    assert.match(firstPage.text, /data-theme="graveyard"/);
    assert.match(firstPage.text, /data-theme="candlelight"/);
    assert.match(firstPage.text, /<option value="bloodmoon">Blood Moon<\/option>/);
    assert.match(firstPage.text, /\.logo-frame \{/);
    assert.match(firstPage.text, /\.logo-frame::before,/);
    assert.match(firstPage.text, /background-image: var\(--bg-texture\);/);
    assert.match(firstPage.text, /<select id="theme-select" data-theme-select>/);
    assert.match(firstPage.text, /<button class="sound-toggle" type="button" data-sound-toggle aria-pressed="false" aria-label="Enable new message sound">Sound off<\/button>/);
    assert.match(firstPage.text, /<input id="sound-volume" type="range" min="0" max="100" step="5" value="70" data-sound-volume>/);
    assert.match(firstPage.text, /<input type="checkbox" data-notify-toggle>/);
    assert.match(firstPage.text, /<input type="checkbox" data-notify-sticky>/);
    assert.match(firstPage.text, /localStorage\.setItem\('house-notes-theme', nextTheme\)/);
    assert.match(firstPage.text, /<button class="poster-toggle" type="button" aria-expanded="false" aria-controls="poster-panel" data-poster-toggle>/);
    assert.match(firstPage.text, /<div class="poster-panel " id="poster-panel" data-poster-panel aria-hidden="true" inert>/);
    assert.match(firstPage.text, /<form class="create-form" method="post" action="\/notes"/);
    assert.match(firstPage.text, /No notes yet\./);

    const createResponse = await request(app, {
      method: 'POST',
      url: '/notes',
      rawBody: new URLSearchParams({
        title: 'Browser note',
        body: 'Created from a form'
      }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });

    assert.equal(createResponse.statusCode, 303);
    assert.equal(createResponse.headers.location, '/');

    const refreshedPage = await request(app, { method: 'GET', url: '/' });
    assert.equal(refreshedPage.statusCode, 200);
    assert.match(refreshedPage.text, /Browser note/);
    assert.match(refreshedPage.text, /Created from a form/);
    assert.match(refreshedPage.text, /2026-06-28T04:05:06\.000Z/);
    assert.match(refreshedPage.text, /data-notes-list data-last-note-id="1" data-snapshot-signature="1\|2026-06-28T04:05:06\.000Z"/);
    assert.match(refreshedPage.text, /fetch\('\/api\/notes'/);
    assert.match(refreshedPage.text, /setInterval\(\(\) =>/);
    assert.match(refreshedPage.text, /localStorage\.setItem\('house-notes-sound-muted', String\(soundMuted\)\)/);
    assert.match(refreshedPage.text, /localStorage\.setItem\('house-notes-sound-volume', String\(soundVolumeValue\)\)/);
    assert.match(refreshedPage.text, /localStorage\.setItem\('house-notes-notifications-enabled', String\(notificationsEnabled\)\)/);
    assert.match(refreshedPage.text, /localStorage\.setItem\('house-notes-notifications-sticky', String\(notificationsSticky\)\)/);
    assert.match(refreshedPage.text, /function currentSoundVolume\(maxVolume\)/);
    assert.match(refreshedPage.text, /function showIncomingNotification\(createdCount\)/);
    assert.match(refreshedPage.text, /function incomingCreatedCount\(notes\)/);
    assert.match(refreshedPage.text, /function playIncomingSound\(\)/);
    assert.match(refreshedPage.text, /if \(incomingCount > 0\) \{\n        playIncomingSound\(\);/);
    assert.match(refreshedPage.text, /main \{\n      width: min\(1500px, calc\(100% - 40px\)\);/);
    assert.match(refreshedPage.text, /\.notes \{\n      align-items: start;\n      display: grid;\n      gap: 16px;\n      grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 340px\), 1fr\)\);/);
    assert.match(refreshedPage.text, /\.notes\.is-masonry \{\n      display: block;\n      position: relative;/);
    assert.match(refreshedPage.text, /\.note \{\n      display: grid;\n      gap: 14px;\n      min-width: 220px;\n      width: 100%;/);
    assert.match(refreshedPage.text, /\.notes\.is-masonry \.note \{\n      left: 0;\n      position: absolute;\n      top: 0;/);
    assert.doesNotMatch(refreshedPage.text, /transition: transform/);
    assert.match(refreshedPage.text, /function layoutNotes\(\)/);
    assert.match(refreshedPage.text, /function shortestColumnIndex\(heights\)/);
    assert.match(refreshedPage.text, /\.delete-form \{\n      align-items: center;\n      column-gap: 12px;\n      display: grid;\n      grid-template-columns: minmax\(0, 1fr\) auto;/);
    assert.match(refreshedPage.text, /const maxVisibleNotes = 50;/);
    assert.match(refreshedPage.text, /function syncNotes\(notes\)/);
    assert.match(refreshedPage.text, /function noteContainsFocus\(element\)/);
    assert.match(refreshedPage.text, /function activeControl\(\)/);
    assert.match(refreshedPage.text, /function snapshotSignature\(notes\)/);
    assert.match(refreshedPage.text, /notesList\.dataset\.snapshotSignature === signature/);
    assert.match(refreshedPage.text, /skippedFocusedUpdate/);
    assert.match(refreshedPage.text, /function listEmptyElement\(\)/);
    assert.match(refreshedPage.text, /notesList\.innerHTML = notes\.map\(\(note\) => renderNote\(note\)\)\.join\(''\);/);
    assert.match(refreshedPage.text, /&& !elementHasFocus/);
    assert.match(refreshedPage.text, /element\.replaceWith\(nextElement\)/);
    assert.match(refreshedPage.text, /notesList\.append\(element\)/);
    assert.match(refreshedPage.text, /function renderReply\(reply\)/);
    assert.match(refreshedPage.text, /data-note-signature="1\|2026-06-28T04:05:06\.000Z"/);
    assert.match(refreshedPage.text, /<button class="edit-toggle" type="button" aria-expanded="false" aria-controls="edit-panel-1" data-edit-toggle>Edit<\/button>/);
    assert.match(refreshedPage.text, /<button class="reply-toggle" type="button" aria-expanded="false" aria-controls="reply-panel-1" data-reply-toggle>Reply<\/button>/);
    assert.match(refreshedPage.text, /<div class="edit-panel " id="edit-panel-1" data-edit-panel aria-hidden="true" inert>/);
    assert.match(refreshedPage.text, /<button class="danger icon-button" type="submit" aria-label="Delete note">🗑️<\/button>/);
    assert.match(refreshedPage.text, /<section class="replies" aria-label="Replies to Browser note">/);
    assert.match(refreshedPage.text, /<div class="reply-panel " id="reply-panel-1" data-reply-panel aria-hidden="true" inert>/);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser serves the local House Notes logo asset', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-logo-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({ store });

  try {
    const response = await request(app, { method: 'GET', url: '/assets/house-notes-logo.png' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.ok(Buffer.from(response.text, 'binary').length > 1000);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser form returns validation errors without losing entered text', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-invalid-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    const response = await request(app, {
      method: 'POST',
      url: '/notes',
      rawBody: new URLSearchParams({
        title: '',
        body: 'Body still here'
      }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.text, /<button class="poster-toggle" type="button" aria-expanded="true" aria-controls="poster-panel" data-poster-toggle>/);
    assert.match(response.text, /<div class="poster-panel is-open" id="poster-panel" data-poster-panel aria-hidden="false" >/);
    assert.match(response.text, /Fix the highlighted fields and save again\./);
    assert.match(response.text, /Title is required\./);
    assert.match(response.text, /Body still here/);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser page renders newest message tiles first and caps visible notes at 50', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-limit-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    for (let index = 1; index <= 55; index += 1) {
      store.createNote({
        title: `Note ${index}`,
        body: 'Body',
        createdAt: '2026-06-28T04:05:06.000Z',
        updatedAt: '2026-06-28T04:05:06.000Z'
      });
    }

    const page = await request(app, { method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.equal((page.text.match(/data-note-id="\d+"/g) || []).length, 50);
    assert.equal(page.text.indexOf('Note 55') < page.text.indexOf('Note 54'), true);
    assert.doesNotMatch(page.text, /Note 5</);
    assert.match(page.text, /data-last-note-id="55" data-snapshot-signature="/);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser live sync keeps newest-first order and preserves focused editors', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-live-sync-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    const page = await request(app, { method: 'GET', url: '/' });
    const script = extractPageScript(page.text);
    const oldNotes = [
      {
        id: 2,
        title: 'Second',
        body: 'Second body',
        createdAt: '2026-06-28T04:06:00.000Z',
        updatedAt: '2026-06-28T04:06:00.000Z',
        replies: []
      },
      {
        id: 1,
        title: 'First',
        body: 'First body',
        createdAt: '2026-06-28T04:05:00.000Z',
        updatedAt: '2026-06-28T04:05:00.000Z',
        replies: []
      }
    ];
    const incomingNotes = [
      {
        id: 3,
        title: 'Third',
        body: 'Third body',
        createdAt: '2026-06-28T04:07:00.000Z',
        updatedAt: '2026-06-28T04:07:00.000Z',
        replies: []
      },
      {
        id: 2,
        title: 'Second',
        body: 'Second body',
        createdAt: '2026-06-28T04:06:00.000Z',
        updatedAt: '2026-06-28T04:08:00.000Z',
        replies: [
          {
            id: 1,
            body: 'Live reply',
            createdAt: '2026-06-28T04:08:00.000Z',
            updatedAt: '2026-06-28T04:08:00.000Z'
          }
        ]
      },
      {
        id: 1,
        title: 'First edited elsewhere',
        body: 'First body edited elsewhere',
        createdAt: '2026-06-28T04:05:00.000Z',
        updatedAt: '2026-06-28T04:09:00.000Z',
        replies: []
      }
    ];
    const notesList = new FakeElement('section', {
      dataset: {
        lastNoteId: '2',
        snapshotSignature: '2|2026-06-28T04:06:00.000Z~1|2026-06-28T04:05:00.000Z'
      }
    });
    const secondNote = fakeNoteElement(oldNotes[0]);
    const focusedFirstNote = fakeNoteElement(oldNotes[1]);
    const focusedTextarea = new FakeElement('textarea');
    focusedFirstNote.append(focusedTextarea);
    notesList.append(secondNote);
    notesList.append(focusedFirstNote);

    const themeSelect = new FakeElement('select');
    const soundToggle = new FakeElement('button');
    const soundVolume = new FakeElement('input');
    soundVolume.value = '70';
    const notifyToggle = new FakeElement('input');
    notifyToggle.checked = false;
    const notifySticky = new FakeElement('input');
    notifySticky.checked = false;
    const posterToggle = new FakeElement('button');
    posterToggle.setAttribute('aria-expanded', 'false');
    const posterPanel = new FakeElement('div');
    let playedSounds = 0;
    const playedVolumes = [];
    const notifications = [];
    const localStorageValues = {};
    function FakeNotification(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      this.close = () => {
        this.closed = true;
      };
      notifications.push(this);
    }
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = async () => 'granted';
    class FakeAudioContext {
      constructor() {
        this.currentTime = 0;
        this.destination = {};
        this.state = 'running';
      }

      createOscillator() {
        return {
          frequency: { setValueAtTime() {} },
          connect() {},
          start() {
            playedSounds += 1;
          },
          stop() {}
        };
      }

      createGain() {
        return {
          gain: {
            setValueAtTime() {},
            exponentialRampToValueAtTime(value) {
              if (value > 0.001) {
                playedVolumes.push(value);
              }
            }
          },
          connect() {}
        };
      }

      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
    }
    const document = {
      activeElement: focusedTextarea,
      documentElement: { dataset: {} },
      querySelector(selector) {
        if (selector === '[data-notes-list]') {
          return notesList;
        }
        if (selector === '[data-theme-select]') {
          return themeSelect;
        }
        if (selector === '[data-sound-toggle]') {
          return soundToggle;
        }
        if (selector === '[data-sound-volume]') {
          return soundVolume;
        }
        if (selector === '[data-notify-toggle]') {
          return notifyToggle;
        }
        if (selector === '[data-notify-sticky]') {
          return notifySticky;
        }
        if (selector === '[data-poster-toggle]') {
          return posterToggle;
        }
        if (selector === '[data-poster-panel]') {
          return posterPanel;
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
      createElement(tagName) {
        return tagName === 'template' ? new FakeTemplateElement() : new FakeElement(tagName);
      }
    };
    const context = {
      document,
      localStorage: {
        getItem(key) {
          return localStorageValues[key] || null;
        },
        setItem(key, value) {
          localStorageValues[key] = value;
        }
      },
      window: {
        AudioContext: FakeAudioContext,
        Notification: FakeNotification
      },
      Notification: FakeNotification,
      fetch: async () => ({ ok: true, json: async () => ({ notes: incomingNotes }) }),
      setInterval() {},
      setTimeout(callback) {
        callback();
      }
    };
    vm.createContext(context);
    vm.runInContext(script, context);

    assert.equal(soundToggle.textContent, 'Sound off');
    assert.equal(soundToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(soundVolume.value, '70');
    assert.equal(notifyToggle.checked, false);
    assert.equal(notifySticky.disabled, true);
    soundVolume.value = '25';
    soundVolume.listeners.input();
    assert.equal(localStorageValues['house-notes-sound-volume'], '25');
    notifyToggle.checked = true;
    notifyToggle.listeners.change();
    assert.equal(localStorageValues['house-notes-notifications-enabled'], 'true');
    assert.equal(notifySticky.disabled, false);
    notifySticky.checked = true;
    notifySticky.listeners.change();
    assert.equal(localStorageValues['house-notes-notifications-sticky'], 'true');
    soundToggle.listeners.click();
    assert.equal(soundToggle.textContent, 'Sound on');
    assert.equal(soundToggle.getAttribute('aria-pressed'), 'true');
    assert.equal(localStorageValues['house-notes-sound-muted'], 'false');
    assert.equal(playedSounds, 1);
    assert.equal(playedVolumes[0], 0.01);

    context.syncNotes(incomingNotes);
    assert.equal(playedSounds, 2);
    assert.equal(playedVolumes[1], 0.02);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'House Notes');
    assert.equal(notifications[0].options.body, '2 new notes or replies');
    assert.equal(notifications[0].options.requireInteraction, true);
    assert.equal(notifications[0].closed, false);
    assert.deepEqual(notesList.children.map((note) => note.dataset.noteId), ['3', '2', '1']);
    assert.equal(notesList.children[2], focusedFirstNote);
    assert.equal(focusedFirstNote.dataset.noteSignature, '1|2026-06-28T04:05:00.000Z');
    assert.equal(notesList.children[1].dataset.noteSignature, '2|2026-06-28T04:08:00.000Z|1:2026-06-28T04:08:00.000Z');
    assert.equal(notesList.dataset.snapshotSignature, '2|2026-06-28T04:06:00.000Z~1|2026-06-28T04:05:00.000Z');

    document.activeElement = null;
    context.syncNotes(incomingNotes);
    assert.deepEqual(notesList.children.map((note) => note.dataset.noteId), ['3', '2', '1']);
    assert.notEqual(notesList.children[2], focusedFirstNote);
    assert.equal(notesList.children[2].dataset.noteSignature, '1|2026-06-28T04:09:00.000Z');
    assert.equal(notesList.dataset.snapshotSignature, '3|2026-06-28T04:07:00.000Z~2|2026-06-28T04:08:00.000Z|1:2026-06-28T04:08:00.000Z~1|2026-06-28T04:09:00.000Z');

    context.syncNotes([
      {
        ...incomingNotes[0],
        title: 'Third edited',
        updatedAt: '2026-06-28T04:10:00.000Z'
      },
      incomingNotes[1],
      incomingNotes[2]
    ]);
    assert.equal(playedSounds, 2);

    context.syncNotes([incomingNotes[0], incomingNotes[2]]);
    assert.equal(playedSounds, 2);
    assert.equal(notifications.length, 1);

    soundToggle.listeners.click();
    assert.equal(soundToggle.textContent, 'Sound off');
    assert.equal(soundToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(localStorageValues['house-notes-sound-muted'], 'true');
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser flow edits a note and keeps create timestamp', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-edit-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const timestamps = [
    new Date('2026-06-28T04:05:06.000Z'),
    new Date('2026-06-28T04:10:00.000Z')
  ];
  const app = createApp({
    store,
    clock: () => timestamps.shift()
  });

  try {
    await request(app, {
      method: 'POST',
      url: '/notes',
      rawBody: new URLSearchParams({
        title: 'Original',
        body: 'Original body'
      }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });

    const editResponse = await request(app, {
      method: 'POST',
      url: '/notes/1/edit',
      rawBody: new URLSearchParams({
        title: 'Edited',
        body: 'Edited body'
      }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });

    assert.equal(editResponse.statusCode, 303);
    assert.equal(editResponse.headers.location, '/');
    assert.deepEqual(store.getNote(1), {
      id: 1,
      title: 'Edited',
      body: 'Edited body',
      createdAt: '2026-06-28T04:05:06.000Z',
      updatedAt: '2026-06-28T04:10:00.000Z'
    });

    const refreshedPage = await request(app, { method: 'GET', url: '/' });
    assert.match(refreshedPage.text, /Edited/);
    assert.match(refreshedPage.text, /Edited body/);
    assert.doesNotMatch(refreshedPage.text, /Original body/);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser edit validation preserves edited text', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-edit-invalid-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    store.createNote({
      title: 'Saved',
      body: 'Saved body',
      createdAt: '2026-06-28T04:05:06.000Z',
      updatedAt: '2026-06-28T04:05:06.000Z'
    });

    const response = await request(app, {
      method: 'POST',
      url: '/notes/1/edit',
      rawBody: new URLSearchParams({
        title: '',
        body: 'Edited body remains'
      }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.text, /Fix this note and save again\./);
    assert.match(response.text, /Title is required\./);
    assert.match(response.text, /Edited body remains/);
    assert.match(response.text, /<button class="edit-toggle" type="button" aria-expanded="true" aria-controls="edit-panel-1" data-edit-toggle>Edit<\/button>/);
    assert.match(response.text, /<div class="edit-panel is-open" id="edit-panel-1" data-edit-panel aria-hidden="false" >/);
    assert.equal(store.getNote(1).title, 'Saved');
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser reply flow creates, edits, validates, and deletes without confirmation', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-replies-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const timestamps = [
    new Date('2026-06-28T04:05:06.000Z'),
    new Date('2026-06-28T04:06:00.000Z'),
    new Date('2026-06-28T04:07:00.000Z')
  ];
  const app = createApp({
    store,
    clock: () => timestamps.shift()
  });

  try {
    store.createNote({
      title: 'Question',
      body: 'Needs an answer',
      createdAt: '2026-06-28T04:00:00.000Z',
      updatedAt: '2026-06-28T04:00:00.000Z'
    });

    const emptyReply = await request(app, {
      method: 'POST',
      url: '/notes/1/replies',
      rawBody: new URLSearchParams({ body: '' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(emptyReply.statusCode, 400);
    assert.match(emptyReply.text, /Reply is required\./);
    assert.match(emptyReply.text, /<button class="reply-toggle" type="button" aria-expanded="true" aria-controls="reply-panel-1" data-reply-toggle>Reply<\/button>/);
    assert.match(emptyReply.text, /<div class="reply-panel is-open" id="reply-panel-1" data-reply-panel aria-hidden="false" >/);

    const createReply = await request(app, {
      method: 'POST',
      url: '/notes/1/replies',
      rawBody: new URLSearchParams({ body: 'First answer' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(createReply.statusCode, 303);
    assert.equal(store.listReplies(1)[0].body, 'First answer');

    const pageWithReply = await request(app, { method: 'GET', url: '/' });
    assert.match(pageWithReply.text, /First answer/);
    assert.match(pageWithReply.text, /<button class="edit-toggle" type="button" aria-expanded="false" aria-controls="reply-edit-panel-1" data-edit-toggle>Edit<\/button>/);
    assert.match(pageWithReply.text, /<button class="danger icon-button" type="submit" aria-label="Delete reply">🗑️<\/button>/);

    const invalidEdit = await request(app, {
      method: 'POST',
      url: '/replies/1/edit',
      rawBody: new URLSearchParams({ body: '' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(invalidEdit.statusCode, 400);
    assert.match(invalidEdit.text, /Fix this reply and save again\./);
    assert.match(invalidEdit.text, /Reply is required\./);
    assert.match(invalidEdit.text, /<div class="edit-panel is-open" id="reply-edit-panel-1" data-edit-panel aria-hidden="false" >/);
    assert.equal(store.getReply(1).body, 'First answer');

    const editReply = await request(app, {
      method: 'POST',
      url: '/replies/1/edit',
      rawBody: new URLSearchParams({ body: 'Edited answer' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(editReply.statusCode, 303);
    assert.equal(store.getReply(1).body, 'Edited answer');

    const deleteReply = await request(app, {
      method: 'POST',
      url: '/replies/1/delete',
      rawBody: '',
      contentType: 'application/x-www-form-urlencoded'
    });
    assert.equal(deleteReply.statusCode, 303);
    assert.equal(store.getReply(1), null);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser delete requires confirmation and then removes the note', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-browser-delete-'));
  const store = openStore(path.join(tempDir, 'notes.sqlite3'));
  const app = createApp({
    store,
    clock: () => new Date('2026-06-28T04:05:06.000Z')
  });

  try {
    store.createNote({
      title: 'Delete me',
      body: 'Delete body',
      createdAt: '2026-06-28T04:05:06.000Z',
      updatedAt: '2026-06-28T04:05:06.000Z'
    });

    const missingConfirmation = await request(app, {
      method: 'POST',
      url: '/notes/1/delete',
      rawBody: '',
      contentType: 'application/x-www-form-urlencoded'
    });

    assert.equal(missingConfirmation.statusCode, 400);
    assert.match(missingConfirmation.text, /Confirm permanent deletion before deleting this note\./);
    assert.equal(store.getNote(1).title, 'Delete me');

    const deleteResponse = await request(app, {
      method: 'POST',
      url: '/notes/1/delete',
      rawBody: new URLSearchParams({ confirm_delete: 'yes' }).toString(),
      contentType: 'application/x-www-form-urlencoded'
    });

    assert.equal(deleteResponse.statusCode, 303);
    assert.equal(deleteResponse.headers.location, '/');
    assert.equal(store.getNote(1), null);

    const refreshedPage = await request(app, { method: 'GET', url: '/' });
    assert.match(refreshedPage.text, /No notes yet\./);
    assert.doesNotMatch(refreshedPage.text, /Delete me/);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

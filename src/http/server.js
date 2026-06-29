'use strict';

const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createNoteRecord, createReplyRecord, updateNoteRecord, updateReplyRecord, ValidationError } = require('../domain/notes');
const { openStore } = require('../storage/sqlite-store');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FORM_BYTES = 64 * 1024;
const MAX_VISIBLE_NOTES = 50;
const HOUSE_NOTES_LOGO = readFileSync(path.join(__dirname, '..', '..', 'public', 'assets', 'house-notes-logo.png'));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sendPng(response, body) {
  response.writeHead(200, {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': 'image/png',
    'content-length': body.length
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(303, {
    location,
    'content-length': 0
  });
  response.end();
}

function noteSignature(note) {
  const replies = note.replies || [];
  return [
    note.id,
    note.updatedAt,
    ...replies.map((reply) => `${reply.id}:${reply.updatedAt}`)
  ].join('|');
}

function notFound(response) {
  sendJson(response, 404, { error: 'Not found.' });
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
      }
    });

    request.on('end', () => {
      if (!body) {
        resolve('');
        return;
      }

      resolve(body);
    });

    request.on('error', reject);
  });
}

async function readJson(request) {
  const body = await readBody(request, MAX_JSON_BYTES);
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 });
  }
}

async function readForm(request) {
  const body = await readBody(request, MAX_FORM_BYTES);
  return Object.fromEntries(new URLSearchParams(body));
}

function renderReply(reply, { replyEditValues = {}, replyEditErrors = {} } = {}) {
  return `
            <article class="reply" data-reply-id="${reply.id}">
              <p>${escapeHtml(reply.body)}</p>
              <time datetime="${escapeHtml(reply.createdAt)}">${escapeHtml(reply.createdAt)}</time>
              <div class="actions">
                <button class="edit-toggle" type="button" aria-expanded="${replyEditErrors[reply.id] ? 'true' : 'false'}" aria-controls="reply-edit-panel-${reply.id}" data-edit-toggle>Edit</button>
                <form method="post" action="/replies/${reply.id}/delete">
                  <button class="danger icon-button" type="submit" aria-label="Delete reply">🗑️</button>
                </form>
              </div>
              <div class="edit-panel ${replyEditErrors[reply.id] ? 'is-open' : ''}" id="reply-edit-panel-${reply.id}" data-edit-panel aria-hidden="${replyEditErrors[reply.id] ? 'false' : 'true'}" ${replyEditErrors[reply.id] ? '' : 'inert'}>
                <div class="edit-panel-inner">
                  <form class="edit-form" method="post" action="/replies/${reply.id}/edit" novalidate>
                    ${replyEditErrors[reply.id] ? '<p class="summary" role="alert">Fix this reply and save again.</p>' : ''}
                    <label>
                      Reply
                      <textarea name="body" aria-invalid="${replyEditErrors[reply.id] && replyEditErrors[reply.id].body ? 'true' : 'false'}" ${replyEditErrors[reply.id] && replyEditErrors[reply.id].body ? `aria-describedby="reply-body-error-${reply.id}"` : ''} maxlength="10000" required>${escapeHtml(replyEditValues[reply.id] ? replyEditValues[reply.id].body : reply.body)}</textarea>
                    </label>
                    ${replyEditErrors[reply.id] && replyEditErrors[reply.id].body ? `<p class="error" id="reply-body-error-${reply.id}">${escapeHtml(replyEditErrors[reply.id].body)}</p>` : ''}
                    <button type="submit">Update reply</button>
                  </form>
                </div>
              </div>
            </article>`;
}

function renderNoteArticle(note, {
  editValues = {},
  editErrors = {},
  deleteErrors = {},
  replyValues = {},
  replyErrors = {},
  replyEditValues = {},
  replyEditErrors = {}
} = {}) {
  const replies = note.replies || [];
  const replyPanelOpen = Boolean(replyErrors[note.id]);
  const replyItems = replies.length > 0
    ? replies.map((reply) => renderReply(reply, { replyEditValues, replyEditErrors })).join('')
    : '<p class="empty">No replies yet.</p>';

  return `
        <article class="note" data-note-id="${note.id}" data-note-signature="${escapeHtml(noteSignature(note))}">
          <h2>${escapeHtml(note.title)}</h2>
          <p>${escapeHtml(note.body)}</p>
          <time datetime="${escapeHtml(note.createdAt)}">${escapeHtml(note.createdAt)}</time>
          <div class="actions">
            <button class="edit-toggle" type="button" aria-expanded="${editErrors[note.id] ? 'true' : 'false'}" aria-controls="edit-panel-${note.id}" data-edit-toggle>Edit</button>
            <button class="reply-toggle" type="button" aria-expanded="${replyPanelOpen ? 'true' : 'false'}" aria-controls="reply-panel-${note.id}" data-reply-toggle>Reply</button>
          </div>
          <div class="edit-panel ${editErrors[note.id] ? 'is-open' : ''}" id="edit-panel-${note.id}" data-edit-panel aria-hidden="${editErrors[note.id] ? 'false' : 'true'}" ${editErrors[note.id] ? '' : 'inert'}>
            <div class="edit-panel-inner">
              <form class="edit-form" method="post" action="/notes/${note.id}/edit" novalidate>
                ${editErrors[note.id] ? '<p class="summary" role="alert">Fix this note and save again.</p>' : ''}
                <label>
                  Title
                  <input name="title" value="${escapeHtml(editValues[note.id] ? editValues[note.id].title : note.title)}" aria-invalid="${editErrors[note.id] && editErrors[note.id].title ? 'true' : 'false'}" ${editErrors[note.id] && editErrors[note.id].title ? `aria-describedby="edit-title-error-${note.id}"` : ''} maxlength="120" required>
                </label>
                ${editErrors[note.id] && editErrors[note.id].title ? `<p class="error" id="edit-title-error-${note.id}">${escapeHtml(editErrors[note.id].title)}</p>` : ''}
                <label>
                  Body
                  <textarea name="body" aria-invalid="${editErrors[note.id] && editErrors[note.id].body ? 'true' : 'false'}" ${editErrors[note.id] && editErrors[note.id].body ? `aria-describedby="edit-body-error-${note.id}"` : ''} maxlength="10000" required>${escapeHtml(editValues[note.id] ? editValues[note.id].body : note.body)}</textarea>
                </label>
                ${editErrors[note.id] && editErrors[note.id].body ? `<p class="error" id="edit-body-error-${note.id}">${escapeHtml(editErrors[note.id].body)}</p>` : ''}
                <button type="submit">Update note</button>
              </form>
            </div>
          </div>
          <form class="delete-form" method="post" action="/notes/${note.id}/delete">
            ${deleteErrors[note.id] ? `<p class="error" role="alert">${escapeHtml(deleteErrors[note.id])}</p>` : ''}
            <label class="confirm">
              <input type="checkbox" name="confirm_delete" value="yes">
              Delete this local note permanently
            </label>
            <button class="danger icon-button" type="submit" aria-label="Delete note">🗑️</button>
          </form>
          <section class="replies" aria-label="Replies to ${escapeHtml(note.title)}">
            ${replyItems}
          </section>
          <div class="reply-panel ${replyPanelOpen ? 'is-open' : ''}" id="reply-panel-${note.id}" data-reply-panel aria-hidden="${replyPanelOpen ? 'false' : 'true'}" ${replyPanelOpen ? '' : 'inert'}>
            <div class="reply-panel-inner">
              <form class="reply-form" method="post" action="/notes/${note.id}/replies" novalidate>
                ${replyErrors[note.id] ? '<p class="summary" role="alert">Fix this reply and save again.</p>' : ''}
                <label>
                  Reply
                  <textarea name="body" aria-invalid="${replyErrors[note.id] && replyErrors[note.id].body ? 'true' : 'false'}" ${replyErrors[note.id] && replyErrors[note.id].body ? `aria-describedby="reply-create-error-${note.id}"` : ''} maxlength="10000" required>${escapeHtml(replyValues[note.id] ? replyValues[note.id].body : '')}</textarea>
                </label>
                ${replyErrors[note.id] && replyErrors[note.id].body ? `<p class="error" id="reply-create-error-${note.id}">${escapeHtml(replyErrors[note.id].body)}</p>` : ''}
                <button type="submit">Save reply</button>
              </form>
            </div>
          </div>
        </article>`;
}

function renderNotesPage({ notes, values = {}, errors = {} }) {
  const editValues = values.edit || {};
  const replyValues = values.reply || {};
  const replyEditValues = values.replyEdit || {};
  const editErrors = errors.edit || {};
  const deleteErrors = errors.delete || {};
  const replyErrors = errors.reply || {};
  const replyEditErrors = errors.replyEdit || {};
  const lastNoteId = notes.reduce((highest, note) => Math.max(highest, note.id), 0);
  const currentSnapshotSignature = notes.map((note) => noteSignature(note)).join('~');
  const noteItems = notes.length > 0
    ? notes.map((note) => renderNoteArticle(note, {
      editValues,
      editErrors,
      deleteErrors,
      replyValues,
      replyErrors,
      replyEditValues,
      replyEditErrors
    })).join('')
    : '<p class="empty">No notes yet.</p>';
  const hasErrors = Object.keys(errors.create || {}).length > 0;
  const createPanelOpen = hasErrors;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>House Notes</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080606;
      --bg-texture: radial-gradient(circle at 20% 0%, rgba(116, 11, 20, 0.24), transparent 34%),
        radial-gradient(circle at 86% 10%, rgba(188, 144, 77, 0.10), transparent 28%),
        linear-gradient(180deg, #110d0d 0%, #080606 48%, #050505 100%);
      --panel: #171312;
      --panel-raised: #201918;
      --text: #f5ece5;
      --muted: #b7aaa0;
      --line: #4b3534;
      --line-strong: #7d3d3d;
      --accent: #8c1d28;
      --accent-contrast: #fff3ed;
      --button-alt: #46302f;
      --reply-alt: #4b342a;
      --danger: #b92e3a;
      --shadow: rgba(0, 0, 0, 0.64);
      --glow: rgba(140, 29, 40, 0.34);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    [data-theme="manor"] {
      color-scheme: dark;
      --bg: #080606;
      --bg-texture: radial-gradient(circle at 20% 0%, rgba(116, 11, 20, 0.24), transparent 34%),
        radial-gradient(circle at 86% 10%, rgba(188, 144, 77, 0.10), transparent 28%),
        linear-gradient(180deg, #110d0d 0%, #080606 48%, #050505 100%);
      --panel: #171312;
      --panel-raised: #201918;
      --text: #f5ece5;
      --muted: #b7aaa0;
      --line: #4b3534;
      --line-strong: #7d3d3d;
      --accent: #8c1d28;
      --accent-contrast: #fff3ed;
      --button-alt: #46302f;
      --reply-alt: #4b342a;
      --danger: #b92e3a;
      --shadow: rgba(0, 0, 0, 0.64);
      --glow: rgba(140, 29, 40, 0.34);
    }
    [data-theme="crypt"] {
      color-scheme: dark;
      --bg: #06090a;
      --bg-texture: radial-gradient(circle at 10% 12%, rgba(34, 90, 78, 0.28), transparent 30%),
        radial-gradient(circle at 95% 0%, rgba(99, 118, 101, 0.14), transparent 26%),
        linear-gradient(180deg, #0d1515 0%, #06090a 55%, #030505 100%);
      --panel: #121a19;
      --panel-raised: #1a2522;
      --text: #edf4ee;
      --muted: #a8b8ae;
      --line: #31423d;
      --line-strong: #557264;
      --accent: #376f63;
      --accent-contrast: #f4fff8;
      --button-alt: #273d36;
      --reply-alt: #344431;
      --danger: #b4474e;
      --shadow: rgba(0, 0, 0, 0.68);
      --glow: rgba(55, 111, 99, 0.32);
    }
    [data-theme="bloodmoon"] {
      color-scheme: dark;
      --bg: #0c0507;
      --bg-texture: radial-gradient(circle at 50% -8%, rgba(198, 28, 45, 0.28), transparent 26%),
        radial-gradient(circle at 8% 60%, rgba(98, 16, 25, 0.20), transparent 24%),
        linear-gradient(180deg, #18090d 0%, #0c0507 58%, #050203 100%);
      --panel: #1d0f12;
      --panel-raised: #2a1418;
      --text: #fff0ed;
      --muted: #c4a7a1;
      --line: #5b252b;
      --line-strong: #ad3946;
      --accent: #b21f32;
      --accent-contrast: #fff5f3;
      --button-alt: #54262c;
      --reply-alt: #56352b;
      --danger: #d24b57;
      --shadow: rgba(0, 0, 0, 0.70);
      --glow: rgba(178, 31, 50, 0.38);
    }
    [data-theme="graveyard"] {
      color-scheme: dark;
      --bg: #07080b;
      --bg-texture: radial-gradient(circle at 8% 0%, rgba(83, 88, 118, 0.20), transparent 28%),
        radial-gradient(circle at 82% 18%, rgba(33, 53, 70, 0.24), transparent 26%),
        linear-gradient(180deg, #10131d 0%, #07080b 55%, #040506 100%);
      --panel: #151924;
      --panel-raised: #1e2433;
      --text: #eef1fa;
      --muted: #a9b0c1;
      --line: #344057;
      --line-strong: #65708e;
      --accent: #6b516f;
      --accent-contrast: #fbf4ff;
      --button-alt: #2e4150;
      --reply-alt: #354059;
      --danger: #c45a64;
      --shadow: rgba(0, 0, 0, 0.66);
      --glow: rgba(107, 81, 111, 0.34);
    }
    [data-theme="candlelight"] {
      color-scheme: dark;
      --bg: #0b0805;
      --bg-texture: radial-gradient(circle at 70% 0%, rgba(210, 130, 47, 0.22), transparent 24%),
        radial-gradient(circle at 0% 18%, rgba(103, 29, 19, 0.20), transparent 28%),
        linear-gradient(180deg, #171006 0%, #0b0805 55%, #050302 100%);
      --panel: #1c1510;
      --panel-raised: #271e16;
      --text: #fff1df;
      --muted: #c6ad93;
      --line: #573d2b;
      --line-strong: #95613a;
      --accent: #9a4726;
      --accent-contrast: #fff4ea;
      --button-alt: #503223;
      --reply-alt: #4d3b27;
      --danger: #bf4141;
      --shadow: rgba(0, 0, 0, 0.68);
      --glow: rgba(154, 71, 38, 0.34);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      background-image: var(--bg-texture);
      background-attachment: fixed;
      color: var(--text);
      line-height: 1.5;
    }
    main {
      width: min(1500px, calc(100% - 40px));
      margin: 32px auto;
      display: grid;
      gap: 24px;
    }
    h1, h2 { line-height: 1.2; margin: 0; }
    header {
      align-items: end;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: space-between;
    }
    .masthead { display: grid; gap: 10px; }
    .logo-frame {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(0, 0, 0, 0.30)), #050505;
      border: 1px solid var(--line-strong);
      box-shadow: 0 18px 44px var(--shadow), 0 0 0 3px rgba(0, 0, 0, 0.44), inset 0 0 0 1px rgba(255, 235, 220, 0.10), inset 0 0 24px var(--glow);
      display: inline-grid;
      max-width: min(520px, 100%);
      padding: 8px;
      position: relative;
    }
    .logo-frame::before,
    .logo-frame::after {
      border: 1px solid color-mix(in srgb, var(--line-strong) 72%, transparent);
      content: "";
      inset: 4px;
      pointer-events: none;
      position: absolute;
    }
    .logo-frame::after {
      border-color: color-mix(in srgb, var(--accent) 58%, transparent);
      inset: 10px;
    }
    .logo-frame img {
      display: block;
      height: auto;
      max-height: 156px;
      max-width: 100%;
      width: 412px;
    }
    header p, .empty, time { color: var(--muted); }
    .theme-picker {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .theme-picker label {
      color: var(--muted);
      display: inline;
      font-size: 0.94rem;
      font-weight: 700;
    }
    select {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      font: inherit;
      min-width: 160px;
      padding: 8px 10px;
    }
    .poster, .note {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 4px;
      box-shadow: 0 16px 32px var(--shadow), inset 0 0 0 1px rgba(255, 238, 220, 0.04);
      padding: 16px;
    }
    .poster-toggle {
      align-items: center;
      display: flex;
      justify-content: space-between;
      width: 100%;
    }
    .poster-panel {
      display: grid;
      grid-template-rows: 0fr;
      overflow: hidden;
      transition: grid-template-rows 180ms ease;
    }
    .poster-panel.is-open { grid-template-rows: 1fr; }
    .poster-panel-inner {
      min-height: 0;
      overflow: hidden;
    }
    .create-form, .edit-form, .reply-form { display: grid; gap: 14px; }
    .edit-panel {
      display: grid;
      grid-template-rows: 0fr;
      overflow: hidden;
      transition: grid-template-rows 180ms ease;
    }
    .edit-panel.is-open { grid-template-rows: 1fr; }
    .edit-panel-inner {
      min-height: 0;
      overflow: hidden;
    }
    .reply-panel {
      display: grid;
      grid-template-rows: 0fr;
      overflow: hidden;
      transition: grid-template-rows 180ms ease;
    }
    .reply-panel.is-open { grid-template-rows: 1fr; }
    .reply-panel-inner {
      min-height: 0;
      overflow: hidden;
    }
    .edit-form, .delete-form {
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .delete-form {
      align-items: center;
      column-gap: 12px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      row-gap: 10px;
    }
    .delete-form .error {
      grid-column: 1 / -1;
      margin: 0;
    }
    .delete-form .icon-button {
      justify-self: end;
    }
    label { display: grid; gap: 6px; font-weight: 650; }
    label.confirm {
      align-items: start;
      display: flex;
      gap: 8px;
      font-weight: 500;
    }
    label.confirm input { margin-top: 6px; width: auto; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: color-mix(in srgb, var(--panel) 82%, black 18%);
      color: var(--text);
      font: inherit;
      padding: 10px 12px;
    }
    textarea { min-height: 140px; resize: vertical; }
    input:focus, textarea:focus, button:focus {
      outline: 3px solid rgba(19, 111, 99, 0.28);
      outline-offset: 2px;
    }
    select:focus {
      outline: 3px solid color-mix(in srgb, var(--accent) 35%, transparent);
      outline-offset: 2px;
    }
    button {
      justify-self: start;
      border: 0;
      border-radius: 6px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, white 12%), var(--accent));
      color: var(--accent-contrast);
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      padding: 10px 14px;
    }
    button.edit-toggle { background: var(--button-alt); }
    button.reply-toggle { background: var(--reply-alt); }
    button.danger { background: var(--danger); }
    button.sound-toggle {
      background: var(--panel);
      border: 1px solid var(--line);
      color: var(--text);
      padding: 8px 10px;
    }
    .sound-volume {
      align-items: center;
      color: var(--muted);
      display: flex;
      gap: 8px;
      font-size: 0.94rem;
      font-weight: 700;
    }
    .sound-volume input {
      accent-color: var(--accent);
      padding: 0;
      width: 92px;
    }
    .notify-option {
      align-items: center;
      color: var(--muted);
      display: flex;
      gap: 6px;
      font-size: 0.94rem;
      font-weight: 700;
    }
    .notify-option input {
      accent-color: var(--accent);
      width: auto;
    }
    button.icon-button {
      min-width: 42px;
      padding-left: 10px;
      padding-right: 10px;
    }
    @media (prefers-reduced-motion: reduce) {
      .edit-panel, .poster-panel, .reply-panel { transition: none; }
    }
    .error, .summary { color: var(--danger); }
    .summary {
      border: 1px solid color-mix(in srgb, var(--danger) 70%, white 30%);
      border-radius: 6px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--danger) 16%, var(--panel));
    }
    .notes {
      align-items: start;
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
    }
    .notes.is-masonry {
      display: block;
      position: relative;
    }
    .note {
      display: grid;
      gap: 14px;
      min-width: 220px;
      width: 100%;
    }
    .notes.is-masonry .note {
      left: 0;
      position: absolute;
      top: 0;
      will-change: transform;
    }
    .note p { margin: 0; white-space: pre-wrap; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .replies {
      border-top: 1px solid var(--line);
      display: grid;
      gap: 10px;
      padding-top: 12px;
    }
    .reply {
      background: color-mix(in srgb, var(--panel-raised) 86%, var(--accent) 14%);
      border: 1px solid var(--line);
      border-radius: 4px;
      display: grid;
      gap: 8px;
      padding: 10px;
    }
    .reply p { margin: 0; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="masthead">
        <h1 class="logo-frame">
          <img src="/assets/house-notes-logo.png" alt="House Notes" width="412" height="137">
        </h1>
        <p>Notes Update Live Bi-Directionally</p>
      </div>
      <div class="theme-picker">
        <label for="theme-select">Theme</label>
        <select id="theme-select" data-theme-select>
          <option value="manor">Manor</option>
          <option value="crypt">Crypt</option>
          <option value="bloodmoon">Blood Moon</option>
          <option value="graveyard">Graveyard</option>
          <option value="candlelight">Candlelight</option>
        </select>
        <button class="sound-toggle" type="button" data-sound-toggle aria-pressed="false" aria-label="Enable new message sound">Sound off</button>
        <label class="sound-volume" for="sound-volume">
          Volume
          <input id="sound-volume" type="range" min="0" max="100" step="5" value="70" data-sound-volume>
        </label>
        <label class="notify-option">
          <input type="checkbox" data-notify-toggle>
          Desktop alerts
        </label>
        <label class="notify-option">
          <input type="checkbox" data-notify-sticky>
          Keep open
        </label>
      </div>
    </header>
    <section class="poster">
      <button class="poster-toggle" type="button" aria-expanded="${createPanelOpen ? 'true' : 'false'}" aria-controls="poster-panel" data-poster-toggle>
        <span>Post a message</span>
        <span aria-hidden="true">+</span>
      </button>
      <div class="poster-panel ${createPanelOpen ? 'is-open' : ''}" id="poster-panel" data-poster-panel aria-hidden="${createPanelOpen ? 'false' : 'true'}" ${createPanelOpen ? '' : 'inert'}>
        <div class="poster-panel-inner">
          <form class="create-form" method="post" action="/notes" novalidate>
            ${hasErrors ? '<p class="summary" role="alert">Fix the highlighted fields and save again.</p>' : ''}
            <label>
              Title
              <input name="title" value="${escapeHtml(values.title || '')}" aria-invalid="${errors.create && errors.create.title ? 'true' : 'false'}" ${errors.create && errors.create.title ? 'aria-describedby="title-error"' : ''} maxlength="120" required>
            </label>
            ${errors.create && errors.create.title ? `<p class="error" id="title-error">${escapeHtml(errors.create.title)}</p>` : ''}
            <label>
              Body
              <textarea name="body" aria-invalid="${errors.create && errors.create.body ? 'true' : 'false'}" ${errors.create && errors.create.body ? 'aria-describedby="body-error"' : ''} maxlength="10000" required>${escapeHtml(values.body || '')}</textarea>
            </label>
            ${errors.create && errors.create.body ? `<p class="error" id="body-error">${escapeHtml(errors.create.body)}</p>` : ''}
            <button type="submit">Save note</button>
          </form>
        </div>
      </div>
    </section>
    <section class="notes" aria-label="Saved notes" data-notes-list data-last-note-id="${lastNoteId}" data-snapshot-signature="${escapeHtml(currentSnapshotSignature)}">
      ${noteItems}
    </section>
  </main>
  <script>
    const notesList = document.querySelector('[data-notes-list]');
    const maxVisibleNotes = ${MAX_VISIBLE_NOTES};
    const themeSelect = document.querySelector('[data-theme-select]');
    const soundToggle = document.querySelector('[data-sound-toggle]');
    const soundVolume = document.querySelector('[data-sound-volume]');
    const notifyToggle = document.querySelector('[data-notify-toggle]');
    const notifySticky = document.querySelector('[data-notify-sticky]');
    const themes = new Set(['manor', 'crypt', 'bloodmoon', 'graveyard', 'candlelight']);
    let soundMuted = true;
    let soundVolumeValue = 70;
    let notificationsEnabled = false;
    let notificationsSticky = false;
    let audioContext = null;
    let knownNoteIds = new Set([...notesList.querySelectorAll('.note')].map((note) => note.dataset.noteId));
    let knownReplyIds = new Set([...notesList.querySelectorAll('[data-reply-id]')].map((reply) => reply.dataset.replyId));

    function applyTheme(theme) {
      const nextTheme = themes.has(theme) ? theme : 'manor';
      document.documentElement.dataset.theme = nextTheme;
      themeSelect.value = nextTheme;
      try {
        localStorage.setItem('house-notes-theme', nextTheme);
      } catch {}
    }

    function updateSoundToggle() {
      soundToggle.setAttribute('aria-pressed', String(!soundMuted));
      soundToggle.setAttribute('aria-label', soundMuted ? 'Enable new message sound' : 'Mute new message sound');
      soundToggle.textContent = soundMuted ? 'Sound off' : 'Sound on';
    }

    function loadSoundPreference() {
      try {
        soundMuted = localStorage.getItem('house-notes-sound-muted') !== 'false';
        const storedVolume = Number.parseInt(localStorage.getItem('house-notes-sound-volume') || '70', 10);
        soundVolumeValue = Number.isSafeInteger(storedVolume) ? Math.min(100, Math.max(0, storedVolume)) : 70;
        notificationsEnabled = localStorage.getItem('house-notes-notifications-enabled') === 'true';
        notificationsSticky = localStorage.getItem('house-notes-notifications-sticky') === 'true';
      } catch {
        soundMuted = true;
        soundVolumeValue = 70;
        notificationsEnabled = false;
        notificationsSticky = false;
      }
      soundVolume.value = String(soundVolumeValue);
      notifyToggle.checked = notificationsEnabled;
      notifySticky.checked = notificationsSticky;
      notifySticky.disabled = !notificationsEnabled;
      updateSoundToggle();
    }

    function saveSoundPreference() {
      try {
        localStorage.setItem('house-notes-sound-muted', String(soundMuted));
        localStorage.setItem('house-notes-sound-volume', String(soundVolumeValue));
        localStorage.setItem('house-notes-notifications-enabled', String(notificationsEnabled));
        localStorage.setItem('house-notes-notifications-sticky', String(notificationsSticky));
      } catch {}
    }

    function currentSoundVolume(maxVolume) {
      return Math.max(0.0001, maxVolume * (soundVolumeValue / 100));
    }

    function ensureAudioContext() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return null;
      }
      if (!audioContext) {
        audioContext = new AudioContextClass();
      }
      return audioContext;
    }

    function playTone(context, frequency = 880, volume = 0.08, duration = 0.24) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration - 0.02);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(context.currentTime);
      oscillator.stop(context.currentTime + duration);
    }

    function playIncomingSound() {
      if (soundMuted) {
        return;
      }
      const context = ensureAudioContext();
      if (!context) {
        return;
      }
      if (context.state === 'suspended') {
        context.resume().then(() => {
          if (context.state !== 'suspended') {
            playTone(context, 880, currentSoundVolume(0.08));
          }
        }).catch(() => {});
        return;
      }
      playTone(context, 880, currentSoundVolume(0.08));
    }

    function showIncomingNotification(createdCount) {
      if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') {
        return;
      }
      const notification = new Notification('House Notes', {
        body: createdCount === 1 ? 'New note or reply' : \`\${createdCount} new notes or replies\`,
        requireInteraction: notificationsSticky,
        tag: 'house-notes-incoming'
      });
      if (!notificationsSticky) {
        setTimeout(() => notification.close(), 6000);
      }
    }

    function incomingCreatedCount(notes) {
      const nextNoteIds = new Set();
      const nextReplyIds = new Set();
      let createdCount = 0;
      for (const note of notes || []) {
        const noteId = String(note.id);
        nextNoteIds.add(noteId);
        if (!knownNoteIds.has(noteId)) {
          createdCount += 1;
        }
        for (const reply of note.replies || []) {
          const replyId = String(reply.id);
          nextReplyIds.add(replyId);
          if (!knownReplyIds.has(replyId)) {
            createdCount += 1;
          }
        }
      }
      knownNoteIds = nextNoteIds;
      knownReplyIds = nextReplyIds;
      return createdCount;
    }

    function escapeText(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function bindEditToggle(button) {
      if (button.dataset.bound === 'true') {
        return;
      }
      button.dataset.bound = 'true';
      const panel = document.getElementById(button.getAttribute('aria-controls'));
      button.addEventListener('click', () => {
        const isOpen = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', String(!isOpen));
        if (isOpen) {
          panel.classList.remove('is-open');
          panel.setAttribute('aria-hidden', 'true');
          panel.setAttribute('inert', '');
        } else {
          panel.classList.add('is-open');
          panel.setAttribute('aria-hidden', 'false');
          panel.removeAttribute('inert');
          panel.querySelector('input, textarea, button').focus();
        }
        scheduleNotesLayout();
        setTimeout(scheduleNotesLayout, 220);
      });
    }

    function bindEditToggles(root = document) {
      for (const button of root.querySelectorAll('[data-edit-toggle]')) {
        bindEditToggle(button);
      }
    }

    function bindReplyToggles(root = document) {
      for (const button of root.querySelectorAll('[data-reply-toggle]')) {
        bindEditToggle(button);
      }
    }

    function bindPosterToggle() {
      const button = document.querySelector('[data-poster-toggle]');
      const panel = document.querySelector('[data-poster-panel]');
      button.addEventListener('click', () => {
        const isOpen = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', String(!isOpen));
        if (isOpen) {
          panel.classList.remove('is-open');
          panel.setAttribute('aria-hidden', 'true');
          panel.setAttribute('inert', '');
        } else {
          panel.classList.add('is-open');
          panel.setAttribute('aria-hidden', 'false');
          panel.removeAttribute('inert');
          panel.querySelector('input, textarea, button').focus();
        }
      });
    }

    function trimVisibleNotes() {
      const noteCards = [...notesList.querySelectorAll('.note')];
      for (const note of noteCards.slice(maxVisibleNotes)) {
        note.remove();
      }
    }

    function shortestColumnIndex(heights) {
      return heights.reduce((shortest, height, index) => height < heights[shortest] ? index : shortest, 0);
    }

    function layoutNotes() {
      const noteCards = [...notesList.querySelectorAll('.note')];
      if (noteCards.length === 0) {
        notesList.classList.remove('is-masonry');
        notesList.style.height = '';
        return;
      }

      const containerWidth = notesList.clientWidth || (notesList.getBoundingClientRect ? notesList.getBoundingClientRect().width : 0);
      if (!containerWidth) {
        return;
      }

      const gap = 16;
      const minimumColumnWidth = 340;
      const columnCount = Math.max(1, Math.floor((containerWidth + gap) / (minimumColumnWidth + gap)));
      const columnWidth = (containerWidth - (gap * (columnCount - 1))) / columnCount;
      const columnHeights = Array(columnCount).fill(0);
      notesList.classList.add('is-masonry');

      for (const note of noteCards) {
        note.style.width = \`\${columnWidth}px\`;
        const columnIndex = shortestColumnIndex(columnHeights);
        const x = columnIndex * (columnWidth + gap);
        const y = columnHeights[columnIndex];
        note.style.transform = \`translate(\${x}px, \${y}px)\`;
        const noteHeight = note.offsetHeight || (note.getBoundingClientRect ? note.getBoundingClientRect().height : 0);
        columnHeights[columnIndex] += noteHeight + gap;
      }

      notesList.style.height = \`\${Math.max(...columnHeights) - gap}px\`;
    }

    function scheduleNotesLayout() {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(layoutNotes);
        return;
      }
      layoutNotes();
    }

    function noteSignature(note) {
      const replies = note.replies || [];
      return [
        note.id,
        note.updatedAt,
        ...replies.map((reply) => \`\${reply.id}:\${reply.updatedAt}\`)
      ].join('|');
    }

    function snapshotSignature(notes) {
      return notes.map((note) => noteSignature(note)).join('~');
    }

    function renderReply(reply) {
      const body = escapeText(reply.body);
      const createdAt = escapeText(reply.createdAt);
      return \`
            <article class="reply" data-reply-id="\${reply.id}">
              <p>\${body}</p>
              <time datetime="\${createdAt}">\${createdAt}</time>
              <div class="actions">
                <button class="edit-toggle" type="button" aria-expanded="false" aria-controls="reply-edit-panel-\${reply.id}" data-edit-toggle>Edit</button>
                <form method="post" action="/replies/\${reply.id}/delete">
                  <button class="danger icon-button" type="submit" aria-label="Delete reply">🗑️</button>
                </form>
              </div>
              <div class="edit-panel " id="reply-edit-panel-\${reply.id}" data-edit-panel aria-hidden="true" inert>
                <div class="edit-panel-inner">
                  <form class="edit-form" method="post" action="/replies/\${reply.id}/edit" novalidate>
                    <label>
                      Reply
                      <textarea name="body" aria-invalid="false" maxlength="10000" required>\${body}</textarea>
                    </label>
                    <button type="submit">Update reply</button>
                  </form>
                </div>
              </div>
            </article>\`;
    }

    function renderNote(note) {
      const title = escapeText(note.title);
      const body = escapeText(note.body);
      const createdAt = escapeText(note.createdAt);
      const replies = note.replies || [];
      const replyItems = replies.length > 0
        ? replies.map((reply) => renderReply(reply)).join('')
        : '<p class="empty">No replies yet.</p>';
      return \`
        <article class="note" data-note-id="\${note.id}" data-note-signature="\${escapeText(noteSignature(note))}">
          <h2>\${title}</h2>
          <p>\${body}</p>
          <time datetime="\${createdAt}">\${createdAt}</time>
          <div class="actions">
            <button class="edit-toggle" type="button" aria-expanded="false" aria-controls="edit-panel-\${note.id}" data-edit-toggle>Edit</button>
            <button class="reply-toggle" type="button" aria-expanded="false" aria-controls="reply-panel-\${note.id}" data-reply-toggle>Reply</button>
          </div>
          <div class="edit-panel " id="edit-panel-\${note.id}" data-edit-panel aria-hidden="true" inert>
            <div class="edit-panel-inner">
              <form class="edit-form" method="post" action="/notes/\${note.id}/edit" novalidate>
                <label>
                  Title
                  <input name="title" value="\${title}" aria-invalid="false" maxlength="120" required>
                </label>
                <label>
                  Body
                  <textarea name="body" aria-invalid="false" maxlength="10000" required>\${body}</textarea>
                </label>
                <button type="submit">Update note</button>
              </form>
            </div>
          </div>
          <form class="delete-form" method="post" action="/notes/\${note.id}/delete">
            <label class="confirm">
              <input type="checkbox" name="confirm_delete" value="yes">
              Delete this local note permanently
            </label>
            <button class="danger icon-button" type="submit" aria-label="Delete note">🗑️</button>
          </form>
          <section class="replies" aria-label="Replies to \${title}">
            \${replyItems}
          </section>
          <div class="reply-panel " id="reply-panel-\${note.id}" data-reply-panel aria-hidden="true" inert>
            <div class="reply-panel-inner">
              <form class="reply-form" method="post" action="/notes/\${note.id}/replies" novalidate>
                <label>
                  Reply
                  <textarea name="body" aria-invalid="false" maxlength="10000" required></textarea>
                </label>
                <button type="submit">Save reply</button>
              </form>
            </div>
          </div>
        </article>\`;
    }

    function createNoteElement(note) {
      const template = document.createElement('template');
      template.innerHTML = renderNote(note).trim();
      return template.content.firstElementChild;
    }

    function noteContainsFocus(element) {
      return element && element.contains(document.activeElement);
    }

    function activeControl() {
      const active = document.activeElement;
      return active && active.closest('input, textarea, select, button');
    }

    function listEmptyElement() {
      return [...notesList.children].find((child) => child.classList.contains('empty'));
    }

    function syncNotes(notes) {
      const signature = notes && notes.length > 0 ? snapshotSignature(notes) : '';
      const incomingCount = incomingCreatedCount(notes || []);
      const shouldPreserveActiveDom = Boolean(activeControl());
      if (!notes || notes.length === 0) {
        if (!shouldPreserveActiveDom && notesList.dataset.snapshotSignature !== signature) {
          notesList.innerHTML = '<p class="empty">No notes yet.</p>';
          notesList.dataset.lastNoteId = '0';
          notesList.dataset.snapshotSignature = signature;
          scheduleNotesLayout();
        }
        return;
      }

      if (notesList.dataset.snapshotSignature === signature) {
        return;
      }

      if (incomingCount > 0) {
        playIncomingSound();
        showIncomingNotification(incomingCount);
      }

      if (!shouldPreserveActiveDom) {
        notesList.innerHTML = notes.map((note) => renderNote(note)).join('');
        notesList.dataset.lastNoteId = String(notes.reduce((highest, note) => Math.max(highest, note.id), 0));
        notesList.dataset.snapshotSignature = signature;
        bindEditToggles(notesList);
        bindReplyToggles(notesList);
        trimVisibleNotes();
        scheduleNotesLayout();
        return;
      }

      listEmptyElement()?.remove();
      const visibleIds = new Set(notes.map((note) => String(note.id)));
      let skippedFocusedUpdate = false;
      const orderedElements = [];

      for (const note of notes) {
        const id = String(note.id);
        const nextSignature = noteSignature(note);
        let element = notesList.querySelector(\`[data-note-id="\${id}"]\`);
        const elementHasFocus = noteContainsFocus(element);
        if (elementHasFocus && element.dataset.noteSignature !== nextSignature) {
          skippedFocusedUpdate = true;
        }

        if ((!element || element.dataset.noteSignature !== nextSignature) && !elementHasFocus) {
          const nextElement = createNoteElement(note);
          if (element) {
            element.replaceWith(nextElement);
          } else {
            notesList.append(nextElement);
          }
          element = nextElement;
        }

        if (element) {
          orderedElements.push(element);
        }
      }

      for (const element of orderedElements) {
        notesList.append(element);
      }

      for (const element of notesList.querySelectorAll('.note')) {
        if (!visibleIds.has(element.dataset.noteId) && !noteContainsFocus(element)) {
          element.remove();
        }
      }

      notesList.dataset.lastNoteId = String(notes.reduce((highest, note) => Math.max(highest, note.id), 0));
      if (!skippedFocusedUpdate) {
        notesList.dataset.snapshotSignature = snapshotSignature(notes);
      }
      bindEditToggles(notesList);
      bindReplyToggles(notesList);
      trimVisibleNotes();
      scheduleNotesLayout();
    }

    async function pollForNotes() {
      const response = await fetch('/api/notes', {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (!data.notes) {
        return;
      }
      syncNotes(data.notes);
    }

    bindEditToggles();
    bindReplyToggles();
    bindPosterToggle();
    scheduleNotesLayout();
    try {
      applyTheme(localStorage.getItem('house-notes-theme') || 'manor');
    } catch {
      applyTheme('manor');
    }
    loadSoundPreference();
    soundToggle.addEventListener('click', () => {
      soundMuted = !soundMuted;
      saveSoundPreference();
      updateSoundToggle();
      if (!soundMuted) {
        const context = ensureAudioContext();
        if (context && context.state === 'suspended') {
          context.resume().then(() => {
            if (context.state !== 'suspended') {
              playTone(context, 660, currentSoundVolume(0.04), 0.12);
            }
          }).catch(() => {});
        } else if (context) {
          playTone(context, 660, currentSoundVolume(0.04), 0.12);
        }
      }
    });
    soundVolume.addEventListener('input', () => {
      const nextVolume = Number.parseInt(soundVolume.value, 10);
      soundVolumeValue = Number.isSafeInteger(nextVolume) ? Math.min(100, Math.max(0, nextVolume)) : 70;
      saveSoundPreference();
    });
    notifyToggle.addEventListener('change', () => {
      notificationsEnabled = notifyToggle.checked;
      if (notificationsEnabled && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then((permission) => {
          notificationsEnabled = permission === 'granted';
          notifyToggle.checked = notificationsEnabled;
          notifySticky.disabled = !notificationsEnabled;
          saveSoundPreference();
        }).catch(() => {
          notificationsEnabled = false;
          notifyToggle.checked = false;
          notifySticky.disabled = true;
          saveSoundPreference();
        });
        return;
      }
      if (notificationsEnabled && (!('Notification' in window) || Notification.permission === 'denied')) {
        notificationsEnabled = false;
        notifyToggle.checked = false;
      }
      notifySticky.disabled = !notificationsEnabled;
      saveSoundPreference();
    });
    notifySticky.addEventListener('change', () => {
      notificationsSticky = notifySticky.checked;
      saveSoundPreference();
    });
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
    if (window.addEventListener) {
      window.addEventListener('resize', scheduleNotesLayout);
    }
    setInterval(() => {
      pollForNotes().catch(() => {});
    }, 2000);
  </script>
</body>
</html>`;
}

function noteAction(pathname, action) {
  const match = pathname.match(/^\/notes\/([1-9][0-9]*)\/(edit|delete|replies)$/);
  if (!match || match[2] !== action) {
    return null;
  }
  return Number(match[1]);
}

function replyAction(pathname, action) {
  const match = pathname.match(/^\/replies\/([1-9][0-9]*)\/(edit|delete)$/);
  if (!match || match[2] !== action) {
    return null;
  }
  return Number(match[1]);
}

function createApp({ store, clock = () => new Date() }) {
  if (!store) {
    throw new Error('A note store is required.');
  }

  const withReplies = (notes) => notes.map((note) => ({
    ...note,
    replies: store.listReplies(note.id)
  }));

  const listPageNotes = () => withReplies(store.listNotes({ limit: MAX_VISIBLE_NOTES }));

  return async function app(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || DEFAULT_HOST}`);

    try {
      if (request.method === 'GET' && url.pathname === '/assets/house-notes-logo.png') {
        sendPng(response, HOUSE_NOTES_LOGO);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        sendHtml(response, 200, renderNotesPage({ notes: listPageNotes() }));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/notes') {
        const input = await readForm(request);
        request.formValues = input;
        const note = createNoteRecord(input, clock());
        store.createNote(note);
        redirect(response, '/');
        return;
      }

      const editId = request.method === 'POST' ? noteAction(url.pathname, 'edit') : null;
      if (editId) {
        const input = await readForm(request);
        request.formValues = input;
        request.formNoteId = editId;
        const note = store.updateNote(editId, updateNoteRecord(input, clock()));
        if (!note) {
          notFound(response);
          return;
        }
        redirect(response, '/');
        return;
      }

      const deleteId = request.method === 'POST' ? noteAction(url.pathname, 'delete') : null;
      if (deleteId) {
        const input = await readForm(request);
        if (input.confirm_delete !== 'yes') {
          sendHtml(response, 400, renderNotesPage({
            notes: listPageNotes(),
            errors: {
              delete: {
                [deleteId]: 'Confirm permanent deletion before deleting this note.'
              }
            }
          }));
          return;
        }
        if (!store.deleteNote(deleteId)) {
          notFound(response);
          return;
        }
        redirect(response, '/');
        return;
      }

      const replyNoteId = request.method === 'POST' ? noteAction(url.pathname, 'replies') : null;
      if (replyNoteId) {
        const input = await readForm(request);
        request.formValues = input;
        request.formReplyNoteId = replyNoteId;
        if (!store.getNote(replyNoteId)) {
          notFound(response);
          return;
        }
        store.createReply(replyNoteId, createReplyRecord(input, clock()));
        redirect(response, '/');
        return;
      }

      const replyEditId = request.method === 'POST' ? replyAction(url.pathname, 'edit') : null;
      if (replyEditId) {
        const input = await readForm(request);
        request.formValues = input;
        request.formReplyId = replyEditId;
        const reply = store.updateReply(replyEditId, updateReplyRecord(input, clock()));
        if (!reply) {
          notFound(response);
          return;
        }
        redirect(response, '/');
        return;
      }

      const replyDeleteId = request.method === 'POST' ? replyAction(url.pathname, 'delete') : null;
      if (replyDeleteId) {
        if (!store.deleteReply(replyDeleteId)) {
          notFound(response);
          return;
        }
        redirect(response, '/');
        return;
      }

      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/notes') {
        const afterId = Number.parseInt(url.searchParams.get('after') || '0', 10);
        sendJson(response, 200, {
          notes: withReplies(store.listNotes({
            afterId: Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0,
            limit: MAX_VISIBLE_NOTES
          }))
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/notes') {
        const input = await readJson(request);
        const note = {
          ...store.createNote(createNoteRecord(input, clock())),
          replies: []
        };
        sendJson(response, 201, { note });
        return;
      }

      notFound(response);
    } catch (error) {
      if (error instanceof ValidationError) {
        if (request.method === 'POST' && url.pathname === '/notes') {
          sendHtml(response, 400, renderNotesPage({
            notes: listPageNotes(),
            values: readSafeFormValues(request),
            errors: { create: error.details }
          }));
          return;
        }

        const editId = request.formNoteId;
        if (request.method === 'POST' && editId) {
          sendHtml(response, 400, renderNotesPage({
            notes: listPageNotes(),
            values: {
              edit: {
                [editId]: readSafeFormValues(request)
              }
            },
            errors: {
              edit: {
                [editId]: error.details
              }
            }
          }));
          return;
        }

        const replyNoteId = request.formReplyNoteId;
        if (request.method === 'POST' && replyNoteId) {
          sendHtml(response, 400, renderNotesPage({
            notes: listPageNotes(),
            values: {
              reply: {
                [replyNoteId]: readSafeFormValues(request)
              }
            },
            errors: {
              reply: {
                [replyNoteId]: error.details
              }
            }
          }));
          return;
        }

        const replyId = request.formReplyId;
        if (request.method === 'POST' && replyId) {
          sendHtml(response, 400, renderNotesPage({
            notes: listPageNotes(),
            values: {
              replyEdit: {
                [replyId]: readSafeFormValues(request)
              }
            },
            errors: {
              replyEdit: {
                [replyId]: error.details
              }
            }
          }));
          return;
        }

        sendJson(response, 400, { error: error.message, details: error.details });
        return;
      }

      sendJson(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : 'Unexpected server error.'
      });
    }
  };
}

function readSafeFormValues(request) {
  return {
    title: request.formValues ? request.formValues.title : '',
    body: request.formValues ? request.formValues.body : ''
  };
}

function createServer(options) {
  return http.createServer(createApp(options));
}

function main() {
  const databasePath = process.env.CANARYNOTES_DB || 'data/canarynotes.sqlite3';
  const host = process.env.HOST || DEFAULT_HOST;
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const store = openStore(databasePath);
  const server = createServer({ store });

  server.listen(port, host, () => {
    const address = server.address();
    console.log(`CanaryNotes3 listening on http://${address.address}:${address.port}`);
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  createApp,
  createServer
};

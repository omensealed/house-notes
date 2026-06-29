'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createNoteRecord, createReplyRecord } = require('../src/domain/notes');
const { openStore } = require('../src/storage/sqlite-store');

const repoRoot = path.join(__dirname, '..');

function runScript(script, args) {
  const result = spawnSync(path.join(repoRoot, script), args, {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  return result;
}

test('database backup and restore preserves notes and replies', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-backup-'));
  const sourcePath = path.join(tempDir, 'source.sqlite3');
  const backupPath = path.join(tempDir, 'backup.sqlite3');
  const restorePath = path.join(tempDir, 'restored.sqlite3');

  try {
    const timestamp = new Date('2026-06-28T00:00:00.000Z');
    const source = openStore(sourcePath);
    const note = source.createNote(createNoteRecord({ title: 'Back me up', body: 'Durable body' }, timestamp));
    source.createReply(note.id, createReplyRecord({ body: 'Durable reply' }, timestamp));
    source.close();

    const backup = runScript('scripts/backup-db.sh', [sourcePath, backupPath]);
    assert.equal(backup.status, 0, backup.stderr);
    assert.match(backup.stdout, /Backup created:/);

    const restore = runScript('scripts/restore-db.sh', [backupPath, restorePath]);
    assert.equal(restore.status, 0, restore.stderr);
    assert.match(restore.stdout, /Restored database:/);

    const restored = openStore(restorePath);
    try {
      assert.deepEqual(restored.listNotes(), [{
        id: 1,
        title: 'Back me up',
        body: 'Durable body',
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString()
      }]);
      assert.deepEqual(restored.listReplies(1).map((reply) => reply.body), ['Durable reply']);
    } finally {
      restored.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('restore refuses to overwrite an existing database without force', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-restore-guard-'));
  const backupPath = path.join(tempDir, 'backup.sqlite3');
  const targetPath = path.join(tempDir, 'target.sqlite3');

  try {
    const timestamp = new Date('2026-06-28T00:00:00.000Z');
    const backupSource = openStore(backupPath);
    backupSource.createNote(createNoteRecord({ title: 'Backup', body: 'Body' }, timestamp));
    backupSource.close();

    const target = openStore(targetPath);
    target.createNote(createNoteRecord({ title: 'Existing', body: 'Keep safe' }, timestamp));
    target.close();

    const restore = runScript('scripts/restore-db.sh', [backupPath, targetPath]);
    assert.notEqual(restore.status, 0);
    assert.match(restore.stderr, /Target database exists/);

    const unchanged = openStore(targetPath);
    try {
      assert.equal(unchanged.listNotes()[0].title, 'Existing');
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup maintenance verifies backups and prunes old files only with prune flag', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-backup-maintain-'));

  try {
    const timestamp = new Date('2026-06-28T00:00:00.000Z');
    for (let index = 1; index <= 4; index += 1) {
      const backupPath = path.join(tempDir, `canarynotes-2026062${index}T000000Z.sqlite3`);
      const store = openStore(backupPath);
      store.createNote(createNoteRecord({ title: `Backup ${index}`, body: 'Body' }, timestamp));
      store.close();
    }

    const dryRun = runScript('scripts/maintain-backups.sh', [tempDir, '2']);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Verified backups: 4/);
    assert.match(dryRun.stdout, /Would prune 2 old backup/);

    const prune = runScript('scripts/maintain-backups.sh', [tempDir, '2', '--prune']);
    assert.equal(prune.status, 0, prune.stderr);
    assert.match(prune.stdout, /Pruned backup:/);

    const remaining = runScript('scripts/maintain-backups.sh', [tempDir, '2']);
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.match(remaining.stdout, /Verified backups: 2/);
    assert.match(remaining.stdout, /No pruning needed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup maintenance fails before pruning when a backup is corrupt', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canarynotes3-backup-corrupt-'));

  try {
    const valid = openStore(path.join(tempDir, 'canarynotes-valid.sqlite3'));
    valid.createNote(createNoteRecord({ title: 'Valid', body: 'Body' }, new Date('2026-06-28T00:00:00.000Z')));
    valid.close();

    require('node:fs').writeFileSync(path.join(tempDir, 'canarynotes-corrupt.sqlite3'), 'not sqlite');

    const result = runScript('scripts/maintain-backups.sh', [tempDir, '1', '--prune']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Backup integrity check failed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

'use strict';

const TITLE_MAX_LENGTH = 120;
const BODY_MAX_LENGTH = 10000;

class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateNoteInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const title = normalizeText(source.title);
  const body = normalizeText(source.body);
  const errors = {};

  if (!title) {
    errors.title = 'Title is required.';
  } else if (title.length > TITLE_MAX_LENGTH) {
    errors.title = `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;
  }

  if (!body) {
    errors.body = 'Body is required.';
  } else if (body.length > BODY_MAX_LENGTH) {
    errors.body = `Body must be ${BODY_MAX_LENGTH} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Note input is invalid.', errors);
  }

  return { title, body };
}

function validateReplyInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const body = normalizeText(source.body);
  const errors = {};

  if (!body) {
    errors.body = 'Reply is required.';
  } else if (body.length > BODY_MAX_LENGTH) {
    errors.body = `Reply must be ${BODY_MAX_LENGTH} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Reply input is invalid.', errors);
  }

  return { body };
}

function createNoteRecord(input, now = new Date()) {
  const note = validateNoteInput(input);
  const timestamp = now.toISOString();
  return {
    ...note,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function updateNoteRecord(input, now = new Date()) {
  const note = validateNoteInput(input);
  return {
    ...note,
    updatedAt: now.toISOString()
  };
}

function createReplyRecord(input, now = new Date()) {
  const reply = validateReplyInput(input);
  const timestamp = now.toISOString();
  return {
    ...reply,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function updateReplyRecord(input, now = new Date()) {
  const reply = validateReplyInput(input);
  return {
    ...reply,
    updatedAt: now.toISOString()
  };
}

module.exports = {
  BODY_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  ValidationError,
  createReplyRecord,
  createNoteRecord,
  updateReplyRecord,
  updateNoteRecord,
  validateNoteInput,
  validateReplyInput
};

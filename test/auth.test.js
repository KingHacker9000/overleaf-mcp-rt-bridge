import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearerAuthorized,
  constantTimeEqual,
  extractBearerToken,
} from '../src/auth.js';

test('extractBearerToken accepts normal bearer headers', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer token-value'), 'token-value');
});

test('extractBearerToken rejects malformed headers', () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Basic abc123'), null);
  assert.equal(extractBearerToken('Bearer'), null);
});

test('constantTimeEqual compares strings', () => {
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('same', 'diff'), false);
  assert.equal(constantTimeEqual('short', 'much-longer'), false);
});

test('bearerAuthorized validates the configured token', () => {
  assert.equal(bearerAuthorized('Bearer secret', 'secret'), true);
  assert.equal(bearerAuthorized('Bearer wrong', 'secret'), false);
});

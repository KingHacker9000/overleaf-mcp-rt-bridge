import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateTool,
  normalizeJsonSchema,
  toolAllowed,
} from '../src/tools.js';

test('allow and deny policy is enforced', () => {
  assert.equal(toolAllowed('a', new Set(), new Set()), true);
  assert.equal(toolAllowed('a', new Set(['a']), new Set()), true);
  assert.equal(toolAllowed('b', new Set(['a']), new Set()), false);
  assert.equal(toolAllowed('a', new Set(['a']), new Set(['a'])), false);
});

test('empty required arrays are omitted recursively', () => {
  assert.deepEqual(
    normalizeJsonSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          required: [],
          properties: {},
        },
      },
      required: [],
    }),
    {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {},
        },
      },
    },
  );
});

test('tool annotations distinguish reads and destructive writes', () => {
  const read = annotateTool({
    name: 'overleaf_read_doc',
    inputSchema: { type: 'object', required: [] },
  });
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(read.annotations.destructiveHint, false);
  assert.equal('required' in read.inputSchema, false);
  assert.deepEqual(read.securitySchemes, [
    { type: 'oauth2', scopes: ['overleaf:owner'] },
  ]);
  assert.deepEqual(read._meta.securitySchemes, read.securitySchemes);

  const del = annotateTool({ name: 'overleaf_delete_entity', inputSchema: {} });
  assert.equal(del.annotations.readOnlyHint, false);
  assert.equal(del.annotations.destructiveHint, true);
});

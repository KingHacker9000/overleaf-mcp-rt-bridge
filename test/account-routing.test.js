import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readAccountNames,
  accountRoutingPolicy,
  hostSelectionError,
  withHostSelectionSchema,
} from '../src/account-routing.js';

function withCredentials(data, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'overleaf-accounts-'));
  const file = join(dir, 'credentials.json');
  writeFileSync(file, JSON.stringify(data));
  try { return fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const projectTool = {
  name: 'overleaf_list_projects',
  description: 'List projects.',
  inputSchema: {
    type: 'object',
    properties: { host: { type: 'string' } },
    required: [],
  },
};
const hostsTool = {
  name: 'overleaf_list_hosts',
  inputSchema: { type: 'object', properties: {} },
};

test('legacy single-host credentials keep existing default calls working', () =>
  withCredentials({ url: 'https://www.overleaf.com', session_cookie: 'secret' }, (file) => {
    assert.deepEqual(readAccountNames(file), ['overleaf.com']);
    const policy = accountRoutingPolicy({ credentialsFile: file, hostSelection: 'auto' });
    assert.equal(policy.required, false);
    assert.equal(hostSelectionError(projectTool, {}, policy), null);
    assert.deepEqual(withHostSelectionSchema(projectTool, policy), projectTool);
  }));

test('two accounts on the same Overleaf website require explicit host on every account tool', () =>
  withCredentials({
    default: 'overleaf.com',
    hosts: {
      'overleaf.com': { url: 'https://www.overleaf.com', session_cookie: 'mine' },
      brother: { url: 'https://www.overleaf.com', session_cookie: 'his' },
    },
  }, (file) => {
    const policy = accountRoutingPolicy({ credentialsFile: file, hostSelection: 'auto' });
    assert.deepEqual(policy.names, ['overleaf.com', 'brother']);
    assert.equal(policy.required, true);
    assert.match(hostSelectionError(projectTool, {}, policy), /selection required/);
    assert.match(hostSelectionError(projectTool, { host: 'unknown' }, policy), /Unknown/);
    assert.equal(hostSelectionError(projectTool, { host: 'brother' }, policy), null);
    assert.equal(hostSelectionError(hostsTool, {}, policy), null);
    const annotated = withHostSelectionSchema(projectTool, policy);
    assert.deepEqual(annotated.inputSchema.required, ['host']);
    assert.match(annotated.inputSchema.properties.host.description, /brother/);
    assert.deepEqual(projectTool.inputSchema.required, []); // never mutate upstream schema
    assert.doesNotMatch(JSON.stringify(annotated), /mine|his/); // never publish cookies
  }));

test('legacy top-level host is not double-counted after v2 migration', () =>
  withCredentials({
    url: 'https://www.overleaf.com',
    hosts: { mine: { url: 'https://www.overleaf.com', session_cookie: 'secret' } },
  }, (file) => {
    assert.deepEqual(readAccountNames(file), ['mine']);
  }));

test('selection can be forced for one account or disabled for backwards compatibility', () =>
  withCredentials({ url: 'https://www.overleaf.com', session_cookie: 'secret' }, (file) => {
    assert.equal(accountRoutingPolicy({ credentialsFile: file, hostSelection: 'always' }).required, true);
    assert.equal(accountRoutingPolicy({ credentialsFile: file, hostSelection: 'off' }).required, false);
  }));

test('unreadable or corrupt credentials fail closed when routing policy is active', () => {
  assert.throws(() => accountRoutingPolicy({
    credentialsFile: '/does-not-exist/credentials.json',
    hostSelection: 'auto',
  }));
  withCredentials([], (file) => assert.throws(() => readAccountNames(file), /Invalid/));
});

test('tools without a host argument are not broken by routing enforcement', () => {
  const policy = { required: true, names: ['mine', 'brother'] };
  assert.equal(hostSelectionError(hostsTool, {}, policy), null);
  assert.deepEqual(withHostSelectionSchema(hostsTool, policy), hostsTool);
});

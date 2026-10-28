import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitUrl, toHttpsUrl, normalizeHostKey, safeOriginLabel } from '../lib/url.js';

test('parseGitUrl: https 含端口', () => {
  const p = parseGitUrl('https://Git.Example.com:8443/org/repo.git');
  assert.equal(p.protocol, 'https');
  assert.equal(p.host, 'git.example.com:8443');
  assert.equal(p.path, 'org/repo.git');
});

test('parseGitUrl: scp 风格 ssh', () => {
  const p = parseGitUrl('git@gitcode.com:org/repo.git');
  assert.equal(p.protocol, 'ssh');
  assert.equal(p.host, 'gitcode.com');
  assert.equal(p.path, 'org/repo.git');
});

test('toHttpsUrl: ssh → https 改写', () => {
  const { url, rewritten } = toHttpsUrl('git@gitcode.com:org/repo.git');
  assert.equal(url, 'https://gitcode.com/org/repo.git');
  assert.equal(rewritten, true);
});

test('toHttpsUrl: https 原样', () => {
  const { url, rewritten } = toHttpsUrl('https://gitcode.com/org/repo.git');
  assert.equal(rewritten, false);
});

test('normalizeHostKey / safeOriginLabel 脱敏', () => {
  assert.equal(normalizeHostKey('https://git.example.com:8443/x'), 'GIT_EXAMPLE_COM_8443');
  assert.equal(safeOriginLabel('https://u:p@git.example.com/org/repo'), 'https://git.example.com');
});

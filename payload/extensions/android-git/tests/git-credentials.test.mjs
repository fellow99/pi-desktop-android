import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseCredentialLine, formatCredentialLine, matchCredential,
  readCredentials, writeCredential, removeCredential,
} from '../lib/git-credentials.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-')), '.git-credentials');

test('credential line 往返（特殊字符百分号编码）', () => {
  const cred = { protocol: 'https', host: 'git.example.com', username: 'user@x', password: 'p@ss:wo/rd' };
  const line = formatCredentialLine(cred);
  const parsed = parseCredentialLine(line);
  assert.deepEqual(
    { protocol: parsed.protocol, host: parsed.host, username: parsed.username, password: parsed.password },
    cred,
  );
});

test('parseCredentialLine: 跳过注释/空行/无 userinfo', () => {
  assert.equal(parseCredentialLine('# comment'), null);
  assert.equal(parseCredentialLine(''), null);
  assert.equal(parseCredentialLine('https://git.example.com'), null);
  assert.equal(parseCredentialLine('not a url'), null);
});

test('write/read/remove 原子且权限 0600', async () => {
  const file = tmp();
  await writeCredential({ protocol: 'https', host: 'h1', username: 'u1', password: 'p1' }, file);
  await writeCredential({ protocol: 'https', host: 'h2', username: 'u2', password: 'p2' }, file);
  let all = await readCredentials(file);
  assert.equal(all.length, 2);
  await writeCredential({ protocol: 'https', host: 'h1', username: 'u1', password: 'p1new' }, file);
  all = await readCredentials(file);
  assert.equal(all.length, 2);
  assert.equal(all.find((c) => c.host === 'h1').password, 'p1new');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const removed = await removeCredential({ protocol: 'https', host: 'h1' }, file);
  assert.equal(removed, 1);
  all = await readCredentials(file);
  assert.equal(all.length, 1);
});

test('matchCredential: host+协议匹配，路径前缀优先', () => {
  const creds = [
    parseCredentialLine('https://u1:p1@git.example.com'),
    parseCredentialLine('https://u2:p2@git.example.com/org'),
  ];
  assert.equal(matchCredential(creds, 'https://git.example.com/org/repo').username, 'u2');
  assert.equal(matchCredential(creds, 'https://git.example.com/other/repo').username, 'u1');
  assert.equal(matchCredential(creds, 'http://git.example.com/org/repo'), null);
});

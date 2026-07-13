import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  normalizeInformUrl,
  buildSetInformCommands,
  interpretExecOutput,
  InvalidUrlError,
} from '../src/main/lib/adopt-command';

test('normalizeInformUrl appends /inform when path is missing', () => {
  assert.equal(normalizeInformUrl('http://34.116.224.72:8085'), 'http://34.116.224.72:8085/inform');
  assert.equal(normalizeInformUrl('http://34.116.224.72:8085/'), 'http://34.116.224.72:8085/inform');
});

test('normalizeInformUrl preserves an explicit path and the non-standard port', () => {
  assert.equal(
    normalizeInformUrl('http://34.116.224.72:8085/inform'),
    'http://34.116.224.72:8085/inform'
  );
  assert.equal(normalizeInformUrl('https://unifi.example.com/custom'), 'https://unifi.example.com/custom');
});

test('normalizeInformUrl trims surrounding whitespace', () => {
  assert.equal(normalizeInformUrl('  http://10.0.0.1:8080  '), 'http://10.0.0.1:8080/inform');
});

test('normalizeInformUrl rejects bad schemes, empty input, and shell metacharacters', () => {
  assert.throws(() => normalizeInformUrl(''), InvalidUrlError);
  assert.throws(() => normalizeInformUrl('ftp://host/inform'), InvalidUrlError);
  assert.throws(() => normalizeInformUrl('not a url'), InvalidUrlError);
  assert.throws(() => normalizeInformUrl('http://host/inform; rm -rf /'), InvalidUrlError);
  assert.throws(() => normalizeInformUrl(`http://host/'inform'`), InvalidUrlError);
  assert.throws(() => normalizeInformUrl('http://host/$(reboot)'), InvalidUrlError);
});

test('buildSetInformCommands orders mca-cli-op first, bare set-inform second', () => {
  const [first, second] = buildSetInformCommands('http://34.116.224.72:8085');
  assert.equal(first, 'mca-cli-op set-inform http://34.116.224.72:8085/inform');
  assert.equal(second, 'set-inform http://34.116.224.72:8085/inform');
});

test('interpretExecOutput detects success', () => {
  assert.equal(
    interpretExecOutput(
      "Adoption request sent to 'http://34.116.224.72:8085/inform'. Use UniFi Network to complete the adopt process.",
      ''
    ),
    'success'
  );
});

test('interpretExecOutput detects missing command on stderr or stdout', () => {
  assert.equal(interpretExecOutput('', '-ash: mca-cli-op: not found'), 'not-found');
  assert.equal(interpretExecOutput('sh: set-inform: command not found', ''), 'not-found');
  assert.equal(interpretExecOutput('Unknown command', ''), 'not-found');
});

test('interpretExecOutput returns unknown otherwise', () => {
  assert.equal(interpretExecOutput('', ''), 'unknown');
  assert.equal(interpretExecOutput('something unexpected', ''), 'unknown');
});

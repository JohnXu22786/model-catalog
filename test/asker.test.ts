import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { PromptLineReader, InputEndedError } from '../src/util/asker.js';

function makeStream(): PassThrough {
  const s = new PassThrough();
  s.setEncoding('utf8');
  return s;
}

test('行缓冲：一次性写入多行，按提问顺序交付', async () => {
  const stream = makeStream();
  const out: string[] = [];
  const asker = new PromptLineReader(stream, { write: (s) => out.push(s) });

  stream.write('url-line\n\n1\n');
  const p1 = asker.ask('Q1: ');
  const p2 = asker.ask('Q2: ');
  const p3 = asker.ask('Q3: ');
  assert.deepEqual(await Promise.all([p1, p2, p3]), ['url-line', '', '1']);
  assert.deepEqual(out, ['Q1: ', 'Q2: ', 'Q3: ']);
});

test('逐行写入：每行在提问后到达', async () => {
  const stream = makeStream();
  const asker = new PromptLineReader(stream, { write: () => {} });
  const p1 = asker.ask('Q1: ');
  stream.write('a\n');
  assert.equal(await p1, 'a');
  const p2 = asker.ask('Q2: ');
  stream.write('b\r\n');
  assert.equal(await p2, 'b', 'CRLF 行尾被剥离');
});

test('EOF 后提问显式报错（而非静默挂起）', async () => {
  const stream = makeStream();
  const asker = new PromptLineReader(stream, { write: () => {} });
  const p1 = asker.ask('Q1: ');
  stream.write('a\n');
  await p1;
  stream.end();
  await assert.rejects(() => asker.ask('Q2: '), InputEndedError);
});

test('EOF 时缓冲中的残余行仍可交付', async () => {
  const stream = makeStream();
  const asker = new PromptLineReader(stream, { write: () => {} });
  const p1 = asker.ask('Q1: ');
  stream.write('no-newline-tail');
  stream.end();
  assert.equal(await p1, 'no-newline-tail');
});

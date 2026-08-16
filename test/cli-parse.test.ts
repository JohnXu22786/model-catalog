import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags, flagStr, parseSelection } from '../src/cli-parse.js';

test('parseFlags：--k v 与 --k=v 两种形态', () => {
  assert.deepEqual(parseFlags(['--base-url', 'https://x', '--probe=always', '--refresh']), {
    '--base-url': 'https://x',
    '--probe': 'always',
    '--refresh': true,
  });
  assert.deepEqual(parseFlags(['discover', '--out', 'o']), { '--out': 'o' }, '首个参数非 -- 时按普通参数跳过');
});

test('flagStr：值取 trim，布尔标记返回 null', () => {
  const flags = parseFlags(['--a', '  x  ', '--b']);
  assert.equal(flagStr(flags, '--a'), 'x');
  assert.equal(flagStr(flags, '--b'), null);
  assert.equal(flagStr(flags, '--missing'), null);
});

test('parseSelection：空串与 all 为全部，none 为空', () => {
  assert.deepEqual(parseSelection('', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection('all', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection('none', 3), []);
  assert.deepEqual(parseSelection('n', 3), []);
});

test('parseSelection：区间与列表解析、越界过滤、排序去重', () => {
  assert.deepEqual(parseSelection('1,3-5', 10), [0, 2, 3, 4]);
  assert.deepEqual(parseSelection('5-5', 10), [4]);
  assert.deepEqual(parseSelection('99,2,2', 3), [1], '越界与重复被过滤');
  assert.deepEqual(parseSelection('3,1', 3), [0, 2], '结果按编号排序');
});

test('parseSelection：非法输入抛错', () => {
  assert.throws(() => parseSelection('abc', 3), /无法解析/);
  assert.throws(() => parseSelection('5-1', 3), /无效范围/);
  assert.throws(() => parseSelection('1,x', 3), /无法解析/);
});

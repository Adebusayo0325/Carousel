import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  andThen,
  unwrapOr,
  fromPromise,
  fromThrowable,
} from '../src/result.js';

test('ok/err construct and narrow', () => {
  const a = ok(1);
  const b = err('boom');
  assert.equal(isOk(a), true);
  assert.equal(isErr(a), false);
  assert.equal(isOk(b), false);
  assert.equal(isErr(b), true);
  if (isOk(a)) assert.equal(a.value, 1);
  if (isErr(b)) assert.equal(b.error, 'boom');
});

test('map only touches success', () => {
  assert.deepEqual(map(ok(2), (n) => n * 3), ok(6));
  assert.deepEqual(map(err<string>('e'), (n: number) => n * 3), err('e'));
});

test('mapErr only touches failure', () => {
  assert.deepEqual(mapErr(err('e'), (s) => s.toUpperCase()), err('E'));
  assert.deepEqual(mapErr(ok(5), (s: string) => s.toUpperCase()), ok(5));
});

test('andThen chains fallible ops', () => {
  const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err('odd'));
  assert.deepEqual(andThen(ok(8), half), ok(4));
  assert.deepEqual(andThen(ok(7), half), err('odd'));
  assert.deepEqual(andThen(err<string>('pre'), half), err('pre'));
});

test('unwrapOr falls back on error', () => {
  assert.equal(unwrapOr(ok(10), 0), 10);
  assert.equal(unwrapOr(err('x'), 0), 0);
});

test('fromPromise captures rejection as Err (no silent throw)', async () => {
  const good = await fromPromise(Promise.resolve(42), () => 'unused');
  assert.deepEqual(good, ok(42));

  const bad = await fromPromise(Promise.reject(new Error('nope')), (c) => (c as Error).message);
  assert.deepEqual(bad, err('nope'));
});

test('fromThrowable captures synchronous throw', () => {
  const r = fromThrowable(
    () => {
      throw new Error('sync');
    },
    (c) => (c as Error).message,
  );
  assert.deepEqual(r, err('sync'));
});

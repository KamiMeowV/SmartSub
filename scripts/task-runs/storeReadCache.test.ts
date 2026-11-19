import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Conf from 'conf';
import { cacheStoreReads } from '../../main/helpers/store/readCache';

function harness(t: any, options: Record<string, unknown> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-store-cache-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = cacheStoreReads(
    new Conf<any>({
      cwd,
      defaults: { settings: { language: 'zh', vadThreshold: 0.5 } },
      ...options,
    }),
  );
  return { cwd, store };
}

test('reading settings does not parse the whole file again', (t) => {
  const { store } = harness(t);
  store.set(
    'workItems',
    Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}` })),
  );
  store.get('settings');
  const readFileSync = t.mock.method(fs, 'readFileSync');
  for (let index = 0; index < 50; index++) {
    assert.equal(store.get('settings').language, 'zh');
    assert.equal(store.get('settings.vadThreshold'), 0.5);
    assert.equal(store.has('workItems'), true);
  }
  assert.equal(
    readFileSync.mock.calls.filter((call) => call.arguments[0] === store.path)
      .length,
    0,
  );
});

test('callers get their own copy, and a missing key answers with their default', (t) => {
  const { store } = harness(t);
  const settings = store.get('settings');
  settings.language = 'en';
  assert.equal(store.get('settings').language, 'zh');
  const fallback = { untouched: true };
  assert.equal(store.get('missing', fallback), fallback);
  assert.equal(store.get('missing'), undefined);
  const whole = store.store;
  whole.settings.language = 'fr';
  assert.equal(store.get('settings').language, 'zh');
  assert.equal(Object.getPrototypeOf(whole), null);
});

test('writes are read back and reach change listeners with the new value', (t) => {
  const { store } = harness(t);
  const seen: unknown[] = [];
  store.onDidChange('settings', (value: any) => seen.push(value?.language));
  store.set('settings', { ...store.get('settings'), language: 'en' });
  assert.equal(store.get('settings').language, 'en');
  store.set('settings.language', 'ja');
  assert.equal(store.get('settings').language, 'ja');
  assert.deepEqual(seen, ['en', 'ja']);
  const written = { nested: [1, 2, 3] };
  store.set('later', written);
  written.nested.push(4);
  assert.deepEqual(store.get('later'), { nested: [1, 2, 3] });
  store.delete('later');
  assert.equal(store.has('later'), false);
  assert.equal(
    JSON.parse(fs.readFileSync(store.path, 'utf8')).settings.language,
    'ja',
  );
});

test('values are stored as JSON, as before', (t) => {
  const { store } = harness(t);
  store.set('record', { kept: 1, dropped: undefined, when: new Date(0) });
  const record = store.get('record');
  assert.deepEqual(Object.keys(record), ['kept', 'when']);
  assert.equal(record.when, '1970-01-01T00:00:00.000Z');
});

test('a file replaced behind the store is read again', (t) => {
  const { store } = harness(t);
  assert.equal(store.get('settings').language, 'zh');
  const next = { ...JSON.parse(fs.readFileSync(store.path, 'utf8')) };
  next.settings = { ...next.settings, language: 'de' };
  const temporary = `${store.path}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next));
  fs.renameSync(temporary, store.path);
  assert.equal(store.get('settings').language, 'de');
});

test('a failed write leaves the previous value readable', (t) => {
  const { store } = harness(t, {
    serialize: (value: any) => {
      if (value.explode) throw new Error('disk full');
      return JSON.stringify(value, undefined, '\t');
    },
  });
  assert.throws(() => store.set('explode', true), /disk full/);
  assert.equal(store.has('explode'), false);
  assert.equal(store.get('settings').language, 'zh');
});

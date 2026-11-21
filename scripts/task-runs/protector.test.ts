import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createProtector } from '../../main/helpers/taskRuns/cleanup';

const root = path.resolve('/task-storage');
const at = (...parts: string[]) => path.join(root, ...parts);

test('a path is protected when it is or contains a reference', () => {
  const references = new Set([at('project', 'run', 'files', 'a', 'out.srt')]);
  const protectedPath = createProtector(references);
  assert.equal(
    protectedPath(at('project', 'run', 'files', 'a', 'out.srt')),
    true,
  );
  assert.equal(protectedPath(at('project', 'run', 'files', 'a')), true);
  assert.equal(protectedPath(at('project')), true);
  assert.equal(protectedPath(root), true);
  assert.equal(protectedPath(`${at('project', 'run', 'files', 'a')}/`), true);
  assert.equal(protectedPath(at('project', 'run', 'files', 'b')), false);
  assert.equal(
    protectedPath(at('project', 'run', 'files', 'a', 'out.srt', 'x')),
    false,
  );
  assert.equal(protectedPath(at('project', 'run', 'files', 'a', 'out')), false);
  assert.equal(protectedPath(at('proj')), false);
});

test('references added to the set later are honoured', () => {
  const references = new Set<string>();
  const protectedPath = createProtector(references);
  assert.equal(protectedPath(at('project')), false);
  references.add(at('project', 'run', 'manifest.json'));
  assert.equal(protectedPath(at('project')), true);
});

test('large task histories are checked quickly', () => {
  const references = new Set<string>();
  for (let file = 0; file < 4000; file++)
    for (let stage = 0; stage < 5; stage++)
      references.add(
        at(
          'project',
          'run',
          'files',
          `f${file}`,
          'artifacts',
          `s${stage}`,
          'state.json',
        ),
      );
  const protectedPath = createProtector(references);
  const started = performance.now();
  let hits = 0;
  for (let file = 0; file < 4000; file++)
    for (let stage = 0; stage < 6; stage++)
      if (
        protectedPath(
          at('project', 'run', 'files', `f${file}`, 'artifacts', `s${stage}`),
        )
      )
        hits++;
  assert.equal(hits, 4000 * 5);
  // 24,000 queries against 20,000 references; comparing every pair took minutes.
  assert.ok(performance.now() - started < 2000);
});

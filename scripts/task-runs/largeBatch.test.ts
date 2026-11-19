import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTaskRunStore } from '../../main/helpers/taskRuns/store';
import {
  createTaskRunService,
  publicationDelay,
} from '../../main/helpers/taskRuns/service';
import type { StageId, TaskRun } from '../../types/taskRun';

function harness(t: any, count = 300) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-large-batch-'));
  t.after(() => {
    t.mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = createTaskRunStore(root);
  const changes: Array<{ run: TaskRun; durable?: boolean }> = [];
  const progress: TaskRun[] = [];
  const service = createTaskRunService(store, {
    onChange: (run, change) => changes.push({ run, durable: change?.durable }),
    onProgress: (run) => progress.push(run),
  });
  const { runId } = service.accept({
    projectId: 'project',
    requestId: 'request',
    config: { taskType: 'generateOnly' },
    resolvedConfig: {},
    files: Array.from({ length: count }, (_, index) => ({
      uuid: `file-${index}`,
      filePath: `/media/clip-${index}.mp4`,
      providedSubtitlePath: `/media/clip-${index}.srt`,
    })) as any,
  });
  const step = (fileId: string, stageId: StageId) => {
    const token = service.beginStage('project', runId, fileId, stageId);
    service.finishStage(token, { outcome: 'executed', artifacts: [] });
  };
  return { store, service, runId, changes, progress, step };
}

test('stage steps of a large batch never read manifests back from disk', (t) => {
  const { store, service, runId, step } = harness(t);
  const read = t.mock.method(store, 'read');
  const list = t.mock.method(store, 'list');
  for (let index = 0; index < 40; index++) {
    const fileId = `file-${index}`;
    assert.equal(service.view('project', fileId)!.files.length, 1);
    step(fileId, 'prepareInput');
    assert.equal(service.peek('project')!.runId, runId);
  }
  assert.equal(read.mock.callCount(), 0);
  assert.equal(list.mock.callCount(), 0);
  assert.equal(
    store.read('project', runId)!.files[39].stages.prepareInput!.status,
    'succeeded',
    'every step is still written before it returns',
  );
});

test('routine steps are published together; commands are published at once', (t) => {
  const { service, runId, changes, step } = harness(t);
  const accepted = changes.length;
  for (let index = 0; index < 50; index++)
    step(`file-${index}`, 'prepareInput');
  assert.equal(changes.length, accepted, 'nothing is published per step');
  t.mock.timers.tick(publicationDelay({ files: new Array(300) }));
  assert.equal(changes.length, accepted + 1);
  const published = changes.at(-1)!;
  assert.equal(published.durable, false);
  assert.equal(
    published.run.files.filter(
      (file) => file.stages.prepareInput!.status === 'succeeded',
    ).length,
    50,
  );
  service.command({
    projectId: 'project',
    expectedRunId: runId,
    requestId: 'pause',
    command: 'pause',
  });
  assert.equal(changes.length, accepted + 2);
  assert.equal(changes.at(-1)!.run.status, 'paused');
  assert.notEqual(changes.at(-1)!.durable, false);
  t.mock.timers.tick(10_000);
  assert.equal(changes.length, accepted + 2, 'no stale publication follows');
});

test('the end of a run is published at once and durably', (t) => {
  const { service, changes, step } = harness(t, 1);
  const stages = Object.keys(
    service.get('project')!.files[0].stages,
  ) as StageId[];
  for (const stageId of stages) step('file-0', stageId);
  const last = changes.at(-1)!;
  assert.equal(last.run.status, 'succeeded');
  assert.notEqual(last.durable, false);
});

test('progress and pending steps are flushed on quit', (t) => {
  const { service, runId, changes, step } = harness(t);
  step('file-0', 'prepareInput');
  const token = service.beginStage('project', runId, 'file-1', 'prepareInput');
  service.progress({ ...token, sequence: 1, progress: 40 });
  const before = changes.length;
  service.flushProgress();
  assert.equal(changes.length, before + 1);
  assert.notEqual(changes.at(-1)!.durable, false);
  assert.equal(changes.at(-1)!.run.files[1].stages.prepareInput!.progress, 40);
  t.mock.timers.tick(10_000);
  assert.equal(changes.length, before + 1);
});

test('views are private copies of one file', (t) => {
  const { service } = harness(t, 3);
  const view = service.view('project', 'file-1')!;
  assert.deepEqual(
    view.files.map((file) => file.fileId),
    ['file-1'],
  );
  view.files[0].stages.prepareInput!.status = 'failed';
  view.config.taskType = 'translateOnly';
  const run = service.get('project')!;
  assert.equal(run.files[1].stages.prepareInput!.status, 'pending');
  assert.equal(run.config.taskType, 'generateOnly');
});

test('a forgotten project is read from disk again', (t) => {
  const { store, service } = harness(t, 2);
  const list = t.mock.method(store, 'list');
  service.get('project');
  assert.equal(list.mock.callCount(), 0);
  service.forget(['project']);
  service.get('project');
  assert.equal(list.mock.callCount(), 1);
});

test('a manifest rewritten by something else is read again', (t) => {
  const { store, service, runId } = harness(t, 2);
  const changed = store.read('project', runId)!;
  changed.files[0].projection.fileName = 'moved';
  store.write(changed);
  assert.equal(service.get('project')!.files[0].projection.fileName, 'moved');
});

test('a step whose write fails leaves the run as it is on disk', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-write-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let failing = false;
  const store = createTaskRunStore(root, {
    ...fs,
    renameSync(...args: Parameters<typeof fs.renameSync>) {
      if (failing)
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.renameSync(...args);
    },
  } as typeof fs);
  const service = createTaskRunService(store);
  const { runId } = service.accept({
    projectId: 'project',
    requestId: 'request',
    config: { taskType: 'generateOnly' },
    resolvedConfig: {},
    files: ['file-0', 'file-1'].map((uuid) => ({
      uuid,
      filePath: `/media/${uuid}.mp4`,
    })) as any,
  });
  const token = service.beginStage('project', runId, 'file-0', 'prepareInput');
  service.progress({ ...token, sequence: 1, progress: 50 });
  failing = true;
  assert.throws(
    () => service.finishStage(token, { outcome: 'executed', artifacts: [] }),
    /disk full/,
  );
  failing = false;
  const persisted = store.read('project', runId)!;
  const run = service.get('project')!;
  assert.equal(run.files[0].stages.prepareInput!.status, 'running');
  assert.equal(run.revision, persisted.revision);
  assert.equal(service.peek('project')!.status, persisted.status);
  assert.equal(
    service.finishStage(token, { outcome: 'executed', artifacts: [] }),
    true,
    'the same attempt can still finish once the disk recovers',
  );
  assert.equal(
    store.read('project', runId)!.files[0].stages.prepareInput!.status,
    'succeeded',
  );
});

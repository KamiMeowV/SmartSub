/**
 * Large-batch throughput in a real window. One task with many local media files
 * is submitted at once while its task page stays open, the way a user watches a
 * long batch. Every file carries its own subtitle, so no model, provider or
 * network is involved and the scheduler / storage / IPC overhead dominates.
 *
 *   xvfb-run -a node scripts/e2e/large-batch-performance.mjs \
 *     [--files 300] [--concurrency 3] [--label before|after] [--out <dir>] \
 *     [--timeout-minutes 30]
 *
 * Requires `npm run build`. Prints a JSON summary (also written to <out>) with
 * the total wall time, per-file throughput, and how long the main process and the
 * page took to answer while the batch was running. The run fails when any file
 * does not finish or the batch exceeds the timeout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron } from '@playwright/test';
import { appOrigin, waitForAppPage } from './app-page.mjs';

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const fileCount = Number(argValue('--files', '300'));
const concurrency = Number(argValue('--concurrency', '3'));
const label = argValue('--label', 'run');
const timeoutMs = Number(argValue('--timeout-minutes', '30')) * 60_000;
const output =
  argValue('--out') ||
  (await fs.mkdtemp(path.join(os.tmpdir(), `smartsub-large-batch-${label}-`)));
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-large-batch-'));
const profile = path.join(root, 'profile');
const mediaDirectory = path.join(root, 'media');
await fs.mkdir(mediaDirectory, { recursive: true });

// One short clip with audio and video, copied per file; each copy has its own
// subtitle so every file runs the full input, subtitle and export stages.
const template = path.join(root, 'template.mp4');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=160x90:r=10:d=2',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=r=16000:cl=mono',
  '-t',
  '2',
  '-c:v',
  'mpeg4',
  '-c:a',
  'aac',
  template,
]);
const cues = Array.from(
  { length: 12 },
  (_, index) =>
    `${index + 1}\n00:00:${String(index * 4).padStart(2, '0')},000 --> 00:00:${String(index * 4 + 3).padStart(2, '0')},000\nLine ${index + 1} of a subtitle that is long enough to look real.\n`,
).join('\n');
const files = [];
for (let index = 0; index < fileCount; index++) {
  const name = `episode-${String(index + 1).padStart(4, '0')}`;
  const filePath = path.join(mediaDirectory, `${name}.mp4`);
  const subtitle = path.join(mediaDirectory, `${name}.provided.srt`);
  await fs.copyFile(template, filePath);
  await fs.writeFile(subtitle, cues);
  files.push({
    uuid: `large-batch-${index}`,
    filePath,
    fileName: name,
    fileExtension: '.mp4',
    directory: mediaDirectory,
    providedSubtitlePath: subtitle,
  });
}

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ];
};
const summarize = (values) => ({
  samples: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Math.max(...values) : null,
});
const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
const rounded = (stats) =>
  Object.fromEntries(
    Object.entries(stats).map(([key, value]) => [
      key,
      key === 'samples' ? value : round(value),
    ]),
  );

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${profile}`],
  env: { ...process.env, NODE_ENV: 'production' },
});
let summary;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  page.on('dialog', (dialog) => {
    void (
      dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()
    ).catch(() => {});
  });
  await waitForAppPage(page);
  await page.waitForFunction(() => Boolean(window.ipc?.invoke));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await page
    .getByRole('button', { name: '跳过', exact: true })
    .click({ timeout: 5_000 })
    .catch(() => {});

  const projectId = `large-batch-${fileCount}`;
  const formData = await page.evaluate(
    async ({ projectId, files, concurrency }) => {
      const initial = await window.ipc.invoke('getUserConfig');
      const formData = {
        ...initial,
        taskType: 'generateOnly',
        translateProvider: '-1',
        aiCorrection: false,
        aiSegmentation: false,
        speakerDiarization: false,
        generateSummary: false,
        sourceSrtSaveOption: 'fileName',
        subtitleOutputFormats: ['srt'],
        maxConcurrentTasks: concurrency,
      };
      await window.ipc.invoke('saveTaskProject', {
        id: projectId,
        name: `Large batch (${files.length})`,
        taskType: 'generateOnly',
        files,
        taskDraft: { config: formData, manuscripts: [] },
        preserveTaskProgress: true,
      });
      return formData;
    },
    { projectId, files, concurrency },
  );

  // Keep the task page open: its list subscribes to every run update.
  await page.goto(`${appOrigin(page)}/zh/tasks/generate/?project=${projectId}`);
  await page
    .locator('[data-testid="task-row"], [data-testid="task-card"]')
    .first()
    .waitFor({ state: 'visible' });

  const cpuBefore = await app.evaluate(() => process.cpuUsage());
  const started = Date.now();
  const submitted = await page.evaluate(
    ({ projectId, files, formData }) =>
      window.ipc.invoke('submitTask', {
        projectId,
        requestId: `large-batch-${Date.now()}`,
        files,
        formData,
      }),
    { projectId, files, formData },
  );
  assert.equal(submitted.success, true, JSON.stringify(submitted));

  const mainLatency = [];
  const ipcLatency = [];
  let status = 'running';
  let polls = 0;
  let probeErrors = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const mainStart = Date.now();
    try {
      // The inspector answers only once the main thread is free again.
      await app.evaluate(() => 0);
      mainLatency.push(Date.now() - mainStart);
    } catch {
      // Playwright can lose a probe under load; the page round trip still counts.
      probeErrors++;
    }
    const sample = await page.evaluate(async (projectId) => {
      const start = performance.now();
      const status = await window.ipc.invoke('getTaskStatus', projectId);
      return { status, elapsed: performance.now() - start };
    }, projectId);
    ipcLatency.push(sample.elapsed);
    status = sample.status;
    polls++;
    if (polls % 15 === 0)
      console.log(
        `[${label}] ${Math.round((Date.now() - started) / 1000)}s status=${status} main=${mainLatency.at(-1)}ms ipc=${Math.round(sample.elapsed)}ms`,
      );
    if (status === 'idle') break;
  }
  const elapsedMs = Date.now() - started;
  const cpu = await app.evaluate((_electron, before) => {
    const usage = process.cpuUsage(before);
    return { user: usage.user / 1000, system: usage.system / 1000 };
  }, cpuBefore);
  const run = await page.evaluate(
    (projectId) => window.ipc.invoke('taskRuns:get', { projectId }),
    projectId,
  );
  const stageCounts = {};
  for (const file of run?.files || [])
    for (const stage of Object.values(file.stages))
      stageCounts[stage.status] = (stageCounts[stage.status] || 0) + 1;
  const configSize = await fs
    .stat(path.join(profile, 'config.json'))
    .then((stat) => stat.size)
    .catch(() => null);
  summary = {
    label,
    files: fileCount,
    concurrency,
    runStatus: run?.status,
    stageCounts,
    elapsedSeconds: round(elapsedMs / 1000),
    secondsPerFile: round(elapsedMs / 1000 / fileCount),
    mainProcessCpuSeconds: round((cpu.user + cpu.system) / 1000),
    configJsonBytes: configSize,
    mainProcessResponseMs: rounded(summarize(mainLatency)),
    mainProcessProbeErrors: probeErrors,
    pageToMainRoundTripMs: rounded(summarize(ipcLatency)),
  };
  console.log(JSON.stringify(summary, null, 2));
  await fs.writeFile(
    path.join(output, `large-batch-${label}-${fileCount}.json`),
    JSON.stringify(summary, null, 2),
  );
  assert.ok(
    elapsedMs < timeoutMs,
    `the batch did not finish within ${timeoutMs / 60_000} minutes`,
  );
  assert.equal(run?.status, 'succeeded', `run ended as ${run?.status}`);
} finally {
  await app.close().catch(() => {});
  if (process.argv.includes('--keep')) console.log(`profile kept: ${profile}`);
  else await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

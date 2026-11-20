/**
 * A clip in which nobody speaks: recognition returns no cue, and the task must
 * still complete, without an error, delivering empty subtitles. Covers a
 * subtitle-only task and one that also translates (which must not call the AI).
 * Local HTTP fixtures only; no models, credentials or paid calls.
 *
 *   npm run build && xvfb-run -a node scripts/e2e/silent-media.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { appOrigin, waitForAppPage } from './app-page.mjs';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'smartsub-silent-e2e-'));
const media = path.join(output, 'silent-recording.mp4');
execFileSync(ffmpeg, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=160x90:r=10:d=3',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=r=16000:cl=mono',
  '-t',
  '3',
  '-c:v',
  'mpeg4',
  '-c:a',
  'aac',
  media,
]);

let transcriptions = 0;
let completions = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/audio/transcriptions') {
      transcriptions++;
      res.end(JSON.stringify({ text: '', duration: 3, segments: [] }));
    } else {
      completions++;
      res.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'unexpected' },
            },
          ],
        }),
      );
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;

let app;
try {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${path.join(output, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('dialog', (dialog) => {
    void (
      dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()
    ).catch(() => {});
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await waitForAppPage(page);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await page
    .getByRole('button', { name: '跳过', exact: true })
    .click({ timeout: 5_000 })
    .catch(() => {});

  const submit = (projectId, taskType, requestId = `${projectId}-run`) =>
    page.evaluate(
      async ({ apiUrl, media, projectId, taskType, requestId }) => {
        for (const [read, write, provider] of [
          [
            'getAsrProviders',
            'setAsrProviders',
            {
              id: 'asr-fixture',
              type: 'openaiCompatible',
              name: 'Local ASR fixture',
              apiUrl,
              apiKey: 'fixture',
              models: 'whisper-1',
            },
          ],
          [
            'getTranslationProviders',
            'setTranslationProviders',
            {
              id: 'ai-fixture',
              type: 'openai',
              name: 'Local AI fixture',
              apiUrl,
              apiKey: 'fixture',
              modelName: 'fixture',
              isAi: true,
              batchConcurrency: '1',
              batchSize: '10',
              requestInterval: '0',
              structuredOutput: 'disabled',
            },
          ],
        ]) {
          const expectedProviders = await window.ipc.invoke(read);
          if (expectedProviders.some((entry) => entry.id === provider.id))
            continue;
          await window.ipc.invoke(write, {
            expectedProviders,
            providers: [...expectedProviders, provider],
          });
        }
        const defaults = await window.ipc.invoke('getUserConfig');
        const files = await window.ipc.invoke('getDroppedFiles', {
          files: [media],
          taskType: 'any',
        });
        return window.ipc.invoke('submitTask', {
          requestId,
          projectId,
          files: files.map((file) => ({ ...file, uuid: projectId })),
          formData: {
            ...defaults,
            taskType,
            transcriptionEngine: 'cloud',
            asrProviderId: 'asr-fixture',
            model: 'whisper-1',
            sourceLanguage: 'en',
            translateProvider:
              taskType === 'generateOnly' ? '-1' : 'ai-fixture',
            targetLanguage: 'zh',
            aiSegmentation: false,
            aiCorrection: false,
            generateSummary: false,
            speakerDiarization: false,
            useEmbeddedSubtitles: false,
            manuscriptPath: '',
            subtitleOutputFormat: 'srt',
            subtitleOutputFormats: ['srt'],
            sourceSrtSaveOption: 'fileName',
            targetSrtSaveOption: 'fileNameWithLang',
            dub: undefined,
            compose: undefined,
          },
        });
      },
      { apiUrl, media, projectId, taskType, requestId },
    );
  const finished = (projectId) =>
    expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (projectId) => window.ipc.invoke('taskRuns:get', { projectId }),
              projectId,
            )
          )?.status,
        { timeout: 60_000 },
      )
      .toMatch(/^(succeeded|failed|interrupted|cancelled)$/);
  const run = (projectId) =>
    page.evaluate(
      (projectId) => window.ipc.invoke('taskRuns:get', { projectId }),
      projectId,
    );

  for (const [projectId, taskType] of [
    ['silent-generate', 'generateOnly'],
    ['silent-translate', 'generateAndTranslate'],
  ]) {
    const accepted = await submit(projectId, taskType);
    assert.equal(accepted.success, true, JSON.stringify(accepted));
    await finished(projectId);
    const result = await run(projectId);
    const stages = result.files[0].stages;
    const summary = Object.values(stages)
      .map(
        (s) =>
          `${s.id}:${s.status}/${s.outcome}${s.error ? `(${s.error})` : ''}`,
      )
      .join(' ');
    assert.equal(result.status, 'succeeded', summary);
    assert.equal(stages.prepareProofread.outcome, 'not_applicable', summary);
    assert.equal(stages.prepareProofread.reason, 'EMPTY_SUBTITLE', summary);
    assert.equal(stages.exportSubtitle.status, 'succeeded', summary);
    const projection = result.files[0].projection;
    assert.equal(projection.proofreadDataFile, undefined);
    for (const file of projection.sourceSubtitleFiles)
      assert.equal(await fs.readFile(file, 'utf8'), '', file);
    if (taskType === 'generateOnly') {
      assert.equal(projection.sourceSubtitleFiles.length, 1);
    } else {
      assert.equal(stages.translateSubtitle.outcome, 'not_applicable', summary);
      assert.equal(projection.translatedSubtitleFiles.length, 1);
      for (const file of projection.translatedSubtitleFiles)
        assert.equal(await fs.readFile(file, 'utf8'), '', file);
    }
    console.log(`${taskType}: ${summary}`);

    // The task page shows the file as finished, without a red stage or message.
    await page.goto(
      `${appOrigin(page)}/zh/tasks/${taskType === 'generateOnly' ? 'generate' : 'generate-translate'}/?project=${projectId}`,
    );
    const row = page.getByTestId('task-row').first();
    await expect(row).toBeVisible();
    await expect(
      row.locator('[data-testid="rail-chip"]').last(),
    ).toHaveAttribute('data-status', 'done');
    await expect(row.locator('[data-status="error"]')).toHaveCount(0);
    await expect(row).not.toContainText('TASK_PROOFREAD_WRITE_FAILED');
    await page.screenshot({ path: path.join(output, `${projectId}.png`) });
  }
  // Processing the same clip again reuses every result, publishing the empty
  // subtitle once more under a free name.
  const again = await submit('silent-generate', 'generateOnly', 'again');
  assert.equal(again.success, true, JSON.stringify(again));
  await finished('silent-generate');
  const rerun = await run('silent-generate');
  assert.equal(
    rerun.status,
    'succeeded',
    JSON.stringify(rerun.files[0].stages),
  );
  assert.equal(rerun.files[0].stages.exportSubtitle.outcome, 'reused');
  for (const file of rerun.files[0].projection.sourceSubtitleFiles)
    assert.equal(await fs.readFile(file, 'utf8'), '', file);
  assert.ok(transcriptions > 0, 'recognition ran');
  assert.equal(completions, 0, 'nothing was sent for translation');
  assert.deepEqual(errors, []);
  console.log(`Silent media E2E passed. Evidence: ${output}`);
} catch (error) {
  console.error(`Evidence: ${output}`);
  throw error;
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

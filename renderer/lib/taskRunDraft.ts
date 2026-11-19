import type { IFiles } from '../../types';
import {
  projectRunFiles,
  type TaskDraft,
  type TaskRun,
} from '../../types/taskRun';

/**
 * Each run snapshot is a fresh object, so its file index can be kept beside it.
 * Pages map every file through taskDraftInput on each render: a linear search per
 * file made that quadratic in the size of the batch.
 */
const runFileIndex = new WeakMap<
  TaskRun,
  Map<string, TaskRun['files'][number]>
>();
function runFile(run: TaskRun, fileId: string) {
  let index = runFileIndex.get(run);
  if (!index) {
    index = new Map();
    // The first entry wins, as with Array.find.
    for (const entry of run.files)
      if (!index.has(entry.fileId)) index.set(entry.fileId, entry);
    runFileIndex.set(run, index);
  }
  return index.get(fileId);
}

/** Only input choices belong to an editable draft; stage evidence stays main-owned. */
export function taskDraftInput(file: IFiles, run?: TaskRun | null): IFiles {
  const previous = run ? runFile(run, file.uuid) : undefined;
  const input = Object.fromEntries(
    [
      'uuid',
      'filePath',
      'fileName',
      'fileExtension',
      'directory',
      'providedSubtitlePath',
      'manuscriptPath',
      'manuscriptName',
    ].map((key) => [key, file[key]]),
  ) as unknown as IFiles;
  for (const key of ['providedSubtitlePath', 'manuscriptPath'] as const) {
    if (previous && input[key] === previous.projection[key])
      input[key] = previous.input[key];
  }
  return input;
}

export function mergeDraftFiles(inputs: IFiles[], results: IFiles[]): IFiles[] {
  const byIdentity = new Map<string, IFiles>();
  for (const file of results) {
    const key = JSON.stringify([file.uuid, file.filePath]);
    // The first match wins, as with Array.find.
    if (!byIdentity.has(key)) byIdentity.set(key, file);
  }
  return inputs.map((input) => {
    const result = byIdentity.get(JSON.stringify([input.uuid, input.filePath]));
    return { ...result, ...taskDraftInput(input) };
  });
}

export function editableRunState(run: TaskRun, draft: TaskDraft | null) {
  const currentDraft = draft?.basedOnRunId === run.runId ? draft : null;
  const results = projectRunFiles(run);
  return {
    config: currentDraft?.config || run.config,
    files: currentDraft
      ? mergeDraftFiles(currentDraft.files, results)
      : results,
    draftRevision: draft?.revision || 0,
  };
}

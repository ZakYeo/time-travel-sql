import { link, mkdtemp, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodeRecordingInfo } from '@time-travel-sql/sdk';
import type {
  HistoryExports,
  RecordingExport,
  RecordingInfo,
} from '@time-travel-sql/sdk';
import { exportRecording } from './export-recording.js';
import { recordingFilePath, fileFailures } from './file-support.js';
import {
  checkCancelled,
  exchangeLimits,
  DEFAULT_EXCHANGE_LIMITS,
} from './limits.js';
import type { ExchangeLimits } from './limits.js';

/** Publishes a complete, synced file exclusively; never replaces a destination. */
export async function exportRecordingFile(
  source: HistoryExports,
  recordingId: string,
  outputPath: string,
  signal: AbortSignal,
  inputLimits?: ExchangeLimits,
): Promise<RecordingInfo> {
  const path = recordingFilePath(outputPath);
  const limits = exchangeLimits(inputLimits ?? DEFAULT_EXCHANGE_LIMITS);
  checkCancelled(signal);
  let session: RecordingExport | undefined;
  let file: FileHandle | undefined;
  let root: string | undefined;
  let info: RecordingInfo | undefined;
  const errors: unknown[] = [];
  try {
    session = await source.open(recordingId, signal);
    info = decodeRecordingInfo(session.info);
    checkCancelled(signal);
    root = await mkdtemp(join(dirname(path), '.tts-export-'));
    const temporary = join(root, 'recording.tmp');
    file = await open(temporary, 'wx', 0o600);
    for await (const chunk of exportRecording(session, signal, limits)) {
      await file.writeFile(chunk, { signal });
    }
    checkCancelled(signal);
    await file.sync();
    const completedFile = file;
    file = undefined;
    await completedFile.close();
    const completedSession = session;
    session = undefined;
    await completedSession.close();
    checkCancelled(signal);
    // Same-filesystem hard link is one exclusive publication operation. No
    // access-then-rename race can replace an existing file or dangling symlink.
    await link(temporary, path);
  } catch (error) {
    errors.push(error);
  }
  if (file) {
    try {
      await file.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (session) {
    try {
      await session.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (root) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw fileFailures(errors);
  // info exists on every successful publication path.
  if (!info) throw new Error('Export completed without recording metadata.');
  return info;
}

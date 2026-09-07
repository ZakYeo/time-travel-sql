import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decodeDataFields } from '@time-travel-sql/sdk';
import { UsageError, boundedInteger } from './arguments.js';

async function configurationFile(
  path: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!(await file.stat()).isFile())
      throw new UsageError('Configuration must be a regular file.');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) throw new UsageError('Configuration exceeds 64 KiB.');
    const data: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
    return decodeDataFields(data, ['workspace', 'timeoutMs']);
  } finally {
    await file.close();
  }
}

export async function configuration(
  options: { workspace?: string; config?: string; 'timeout-ms'?: string },
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
) {
  let data: Record<string, unknown> = {};
  const configPath =
    options.config === undefined ? undefined : resolve(cwd, options.config);
  try {
    if (configPath) data = await configurationFile(configPath, signal);
    if (
      data.workspace !== undefined &&
      (typeof data.workspace !== 'string' || !data.workspace.length)
    )
      throw new UsageError(
        'Configuration workspace must be a nonempty string.',
      );
    if (
      data.timeoutMs !== undefined &&
      (typeof data.timeoutMs !== 'number' ||
        !Number.isSafeInteger(data.timeoutMs))
    )
      throw new UsageError('Configuration timeoutMs must be an integer.');
    const workspace = options.workspace ?? env.TTS_WORKSPACE ?? data.workspace;
    if (data.timeoutMs !== undefined)
      boundedInteger(String(data.timeoutMs), 3600000);
    if (
      typeof workspace !== 'string' ||
      !workspace.length ||
      Buffer.byteLength(workspace) > 65536 ||
      workspace.includes('\0') ||
      !workspace.isWellFormed()
    )
      throw new UsageError(
        'Specify a valid workspace with --workspace, TTS_WORKSPACE or config.',
      );
    const base =
      options.workspace !== undefined ||
      env.TTS_WORKSPACE !== undefined ||
      !configPath
        ? cwd
        : dirname(configPath);
    const timeoutMs = boundedInteger(
      options['timeout-ms'] ??
        env.TTS_TIMEOUT_MS ??
        String(data.timeoutMs ?? 30000),
      3600000,
    );
    return { workspace: resolve(base, workspace), timeoutMs };
  } catch (cause) {
    if (signal.aborted && cause === signal.reason) throw cause;
    if (cause instanceof UsageError) throw cause;
    throw new UsageError('Cannot read a valid configuration.', { cause });
  }
}

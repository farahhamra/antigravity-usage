import * as http from 'node:http';

export const TARGET_ID = 'google.google-antigravity';
const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const MAX_BYTES = 8 * 1024 * 1024;
export interface Connection { port: number; csrfToken: string }
export interface Disposable { dispose(): void }

type Method = 'JetboxSubscribeToSummaries' | 'GetCascadeTrajectoryGeneratorMetadata' | 'GetUserStatus' | 'RetrieveUserQuotaSummary';
type Failure = 'connection refused' | 'connection reset' | 'connection blocked' | 'network error' | 'timed out' | 'cancelled'
  | 'unexpected response type' | 'invalid response' | 'response too large' | 'stream ended' | 'stream error';

/** Only our fixed diagnostics may cross into the UI; never use server bodies or exception messages. */
export class TransportError extends Error {
  constructor(method: Method, failure: Failure | number) {
    super(`${method}: ${typeof failure === 'number' ? `HTTP ${failure}` : failure}.`);
  }
}
export function transportDetail(error: unknown): string | undefined {
  return error instanceof TransportError ? error.message : undefined;
}
function networkFailure(error: NodeJS.ErrnoException): Failure {
  switch (error.code) {
    case 'ECONNREFUSED': return 'connection refused';
    case 'ECONNRESET': return 'connection reset';
    case 'EACCES': case 'EPERM': return 'connection blocked';
    case 'ETIMEDOUT': return 'timed out';
    default: return 'network error';
  }
}

/** Only accept the connection exported by the already active Google extension. */
export function connectionFrom(exports: unknown): Connection | undefined {
  if (!exports || typeof exports !== 'object') return;
  const { port, csrfToken } = exports as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof csrfToken !== 'string' || !csrfToken || csrfToken.length > 512 || /[^\x21-\x7e]/.test(csrfToken)) return;
  return { port, csrfToken };
}

function options(connection: Connection, method: string, streaming = false): http.RequestOptions {
  if (!connectionFrom(connection)) throw new Error('Invalid local Antigravity connection.');
  return {
    hostname: '127.0.0.1', port: connection.port, path: SERVICE + method, method: 'POST', agent: false,
    headers: {
      'content-type': streaming ? 'application/connect+json' : 'application/json',
      'connect-protocol-version': '1', 'x-codeium-csrf-token': connection.csrfToken,
    },
  };
}

/** A bounded Connect envelope decoder; supports split headers and multiple frames. */
export class Frames {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): { flags: number; value: unknown }[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: { flags: number; value: unknown }[] = [];
    while (this.pending.length >= 5) {
      const flags = this.pending[0]!;
      const size = this.pending.readUInt32BE(1);
      if (size > MAX_BYTES || (flags !== 0 && flags !== 2)) throw new Error('Unsupported Antigravity stream frame.');
      if (this.pending.length < size + 5) break;
      const value: unknown = JSON.parse(this.pending.subarray(5, size + 5).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Antigravity stream message.');
      frames.push({ flags, value });
      this.pending = this.pending.subarray(size + 5);
    }
    if (this.pending.length > MAX_BYTES + 5) throw new Error('Antigravity stream limit exceeded.');
    return frames;
  }
}

export function subscribe(connection: Connection, onMessage: (value: unknown) => void, onClose: (detail?: string) => void): Disposable {
  let closed = false;
  let response: http.IncomingMessage | undefined;
  const frames = new Frames();
  const close = (notify: boolean, failure: Failure | number = 'stream ended') => {
    if (closed) return;
    closed = true;
    clearTimeout(startup);
    request.destroy(); response?.destroy();
    if (notify) onClose(new TransportError('JetboxSubscribeToSummaries', failure).message);
  };
  const request = http.request(options(connection, 'JetboxSubscribeToSummaries', true), res => {
    response = res;
    if (res.statusCode !== 200) { close(true, res.statusCode ?? 'invalid response'); return; }
    if (!/^application\/connect\+json(?:;|$)/i.test(res.headers['content-type'] ?? '')) { close(true, 'unexpected response type'); return; }
    res.on('data', (chunk: Buffer) => {
      if (closed) return;
      try {
        for (const frame of frames.push(chunk)) {
          if (frame.flags === 2) { close(true, (frame.value as Record<string, unknown>).error ? 'stream error' : 'stream ended'); return; }
          clearTimeout(startup);
          onMessage(frame.value);
        }
      } catch { close(true, 'invalid response'); }
    });
    res.on('error', error => close(true, networkFailure(error))); res.on('end', () => close(true)); res.on('close', () => close(true));
  });
  const startup = setTimeout(() => close(true, 'timed out'), 5000);
  startup.unref();
  request.on('error', error => close(true, networkFailure(error)));
  request.end(Buffer.from([0, 0, 0, 0, 2, 123, 125])); // Connect JSON envelope: {}
  return { dispose: () => close(false) };
}

/** Fixed read-only RPC; no arbitrary URL/method, redirects, process scans, or credential files. */
export function generatorMetadata(connection: Connection, cascadeId: string, signal: AbortSignal): Promise<unknown> {
  return unary(connection, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId }, signal);
}

export function userStatus(connection: Connection, signal: AbortSignal): Promise<unknown> {
  return unary(connection, 'GetUserStatus', { metadata: { ideName: 'antigravity' } }, signal);
}

export function quotaSummary(connection: Connection, signal: AbortSignal): Promise<unknown> {
  return unary(connection, 'RetrieveUserQuotaSummary', {}, signal);
}

/** Keep the read-only method allowlist closed to callers. */
function unary(connection: Connection, method: Exclude<Method, 'JetboxSubscribeToSummaries'>, body: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false;
    let response: http.IncomingMessage | undefined;
    const finish = (value?: unknown, failure?: Failure | number) => {
      if (done) return;
      done = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
      request.destroy(); response?.destroy();
      if (failure !== undefined) reject(new TransportError(method, failure));
      else resolve(value);
    };
    const request = http.request(options(connection, method), res => {
      response = res;
      if (res.statusCode !== 200) { finish(undefined, res.statusCode ?? 'invalid response'); return; }
      if (!/^application\/json(?:;|$)/i.test(res.headers['content-type'] ?? '')) { finish(undefined, 'unexpected response type'); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) finish(undefined, 'response too large');
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(undefined, 'invalid response'); }
      });
      res.on('error', error => finish(undefined, networkFailure(error)));
      res.on('aborted', () => finish(undefined, 'connection reset'));
    });
    const abort = () => finish(undefined, 'cancelled');
    const timeout = setTimeout(() => finish(undefined, 'timed out'), 5000); timeout.unref();
    signal.addEventListener('abort', abort, { once: true });
    request.on('error', error => finish(undefined, networkFailure(error)));
    if (signal.aborted) abort();
    else request.end(JSON.stringify(body));
  });
}

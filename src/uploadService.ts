/**
 * Upload service for posting audio files to the Protokoll server.
 *
 * Uses the durable upload-session API when available so large files can be
 * chunked, retried, and tracked before a transcript UUID exists.
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { URL } from 'url';
import { resolveAgent } from './proxyUtils';
import { appendScopedApiKeyHeaders } from './multiServer/auth';

const AUDIO_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  mp4: 'video/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

export interface UploadOptions {
  filePath: string;
  serverUrl: string;
  title?: string;
  project?: string;
  apiKey?: string;
  onProgress?: (progress: {
    phase: 'creating' | 'uploading' | 'finalizing';
    uploadedBytes: number;
    totalBytes: number;
    uploadId?: string;
  }) => void;
}

export interface UploadResult {
  success: boolean;
  uuid?: string;
  filename?: string;
  size?: number;
  title?: string | null;
  project?: string | null;
  uploadId?: string;
  statusUrl?: string;
  transcriptStatusUrl?: string;
  error?: string;
}

interface UploadSessionResponse {
  uploadId: string;
  status: string;
  receivedBytes?: number;
  sizeBytes?: number;
  transcriptUuid?: string;
  transcriptStatusUrl?: string;
  uploadSessionStatusUrl?: string;
  error?: string;
}

class HttpStatusError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
  }
}

export class UploadService {
  private buildMultipartBody(options: UploadOptions, boundary: string): Buffer {
    const ext = path.extname(options.filePath).toLowerCase().replace('.', '');
    const mimeType = AUDIO_MIME_TYPES[ext] || 'application/octet-stream';
    const filename = path.basename(options.filePath);
    const fileContent = fs.readFileSync(options.filePath);

    const parts: Buffer[] = [];
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n` +
      '\r\n',
      'utf8'
    ));
    parts.push(fileContent);
    parts.push(Buffer.from('\r\n', 'utf8'));

    if (options.title) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="title"\r\n' +
        '\r\n' +
        `${options.title}\r\n`,
        'utf8'
      ));
    }

    if (options.project) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="project"\r\n' +
        '\r\n' +
        `${options.project}\r\n`,
        'utf8'
      ));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return Buffer.concat(parts);
  }

  private requestJson<T>(
    options: UploadOptions,
    method: string,
    endpointPath: string,
    body?: Buffer | string,
    contentType = 'application/json'
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${options.serverUrl.replace(/\/+$/, '')}${endpointPath}`);
      const httpModule = url.protocol === 'https:' ? https : http;
      const agent = resolveAgent(url.toString());
      const bodyLength = body ? Buffer.byteLength(body) : 0;

      const requestOptions: http.RequestOptions | https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method,
        headers: appendScopedApiKeyHeaders({
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Content-Type': contentType,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Content-Length': bodyLength,
        }, options.apiKey, url.toString(), options.serverUrl),
        timeout: 120_000,
        ...(agent ? { agent } : {}),
      };

      const req = httpModule.request(requestOptions, (res) => {
        let responseText = '';
        res.on('data', (chunk: Buffer) => {
          responseText += chunk.toString();
        });
        res.on('end', () => {
          let json: unknown;
          try {
            json = responseText ? JSON.parse(responseText) : {};
          } catch {
            reject(new Error(`Failed to parse server response (HTTP ${res.statusCode})`));
            return;
          }

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json as T);
            return;
          }

          const payload = json as Record<string, unknown>;
          reject(new HttpStatusError(
            String(payload.error || payload.details || `Server returned HTTP ${res.statusCode}`),
            res.statusCode
          ));
        });
      });

      req.on('error', (err: Error) => {
        const friendlyMessage = err.message.includes('ECONNREFUSED')
          ? `Cannot connect to Protokoll server at ${options.serverUrl}. Is it running?`
          : `Upload failed: ${err.message}`;
        reject(new Error(friendlyMessage));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Upload request timed out'));
      });

      if (bodyLength > 0 && body) {
        req.write(body);
      }
      req.end();
    });
  }

  private async uploadAudioChunked(options: UploadOptions, fileSize: number): Promise<UploadResult> {
    const ext = path.extname(options.filePath).toLowerCase().replace('.', '');
    const mimeType = AUDIO_MIME_TYPES[ext] || 'application/octet-stream';
    const filename = path.basename(options.filePath);
    options.onProgress?.({ phase: 'creating', uploadedBytes: 0, totalBytes: fileSize });

    const session = await this.requestJson<UploadSessionResponse>(
      options,
      'POST',
      '/audio/upload-sessions',
      JSON.stringify({
        filename,
        sizeBytes: fileSize,
        contentType: mimeType,
        title: options.title,
        project: options.project,
      })
    );

    let uploadedBytes = session.receivedBytes || 0;
    let chunkIndex = 0;
    const stream = fs.createReadStream(options.filePath, { highWaterMark: CHUNK_SIZE_BYTES });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await this.requestJson<UploadSessionResponse>(
        options,
        'PUT',
        `/audio/upload-sessions/${encodeURIComponent(session.uploadId)}/chunks/${chunkIndex}`,
        buffer,
        'application/octet-stream'
      );
      uploadedBytes += buffer.length;
      options.onProgress?.({
        phase: 'uploading',
        uploadedBytes,
        totalBytes: fileSize,
        uploadId: session.uploadId,
      });
      chunkIndex += 1;
    }

    options.onProgress?.({
      phase: 'finalizing',
      uploadedBytes,
      totalBytes: fileSize,
      uploadId: session.uploadId,
    });
    const finalized = await this.requestJson<UploadSessionResponse>(
      options,
      'POST',
      `/audio/upload-sessions/${encodeURIComponent(session.uploadId)}/finalize`
    );

    if (finalized.status === 'queued' || finalized.status === 'duplicate') {
      return {
        success: true,
        uuid: finalized.transcriptUuid,
        filename,
        size: fileSize,
        title: options.title ?? null,
        project: options.project ?? null,
        uploadId: session.uploadId,
        statusUrl: finalized.uploadSessionStatusUrl,
        transcriptStatusUrl: finalized.transcriptStatusUrl,
      };
    }

    return {
      success: false,
      uploadId: session.uploadId,
      statusUrl: finalized.uploadSessionStatusUrl,
      error: finalized.error || `Upload finalize returned status ${finalized.status}`,
    };
  }

  private async uploadAudioMultipart(options: UploadOptions): Promise<UploadResult> {
    const boundary = `----FormBoundary${randomUUID().replace(/-/g, '')}`;
    let body: Buffer;
    try {
      body = this.buildMultipartBody(options, boundary);
    } catch (err) {
      return {
        success: false,
        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const json = await this.requestJson<Record<string, unknown>>(
        options,
        'POST',
        '/audio/upload',
        body,
        `multipart/form-data; boundary=${boundary}`
      );
      if (json.success) {
        return {
          success: true,
          uuid: typeof json.uuid === 'string' ? json.uuid : undefined,
          filename: typeof json.filename === 'string' ? json.filename : undefined,
          size: typeof json.size === 'number' ? json.size : undefined,
          title: typeof json.title === 'string' ? json.title : null,
          project: typeof json.project === 'string' ? json.project : null,
          transcriptStatusUrl: typeof json.statusUrl === 'string' ? json.statusUrl : undefined,
        };
      }
      return {
        success: false,
        error: String(json.error || json.details || 'Upload failed'),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async uploadAudio(options: UploadOptions): Promise<UploadResult> {
    if (!options.filePath) {
      return { success: false, error: 'No file path provided' };
    }
    if (!fs.existsSync(options.filePath)) {
      return { success: false, error: `File not found: ${options.filePath}` };
    }

    const fileSize = fs.statSync(options.filePath).size;
    try {
      return await this.uploadAudioChunked(options, fileSize);
    } catch (err) {
      if (err instanceof HttpStatusError && (err.statusCode === 404 || err.statusCode === 405)) {
        return this.uploadAudioMultipart(options);
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

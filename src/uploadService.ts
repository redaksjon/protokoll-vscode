/**
 * Upload service for posting audio files to the Protokoll server.
 *
 * Builds multipart/form-data requests manually using Node.js built-in
 * http/https modules, matching the pattern in mcpClient.ts.
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { URL } from 'url';

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

export interface UploadOptions {
  filePath: string;    // Absolute path to the audio file
  serverUrl: string;   // e.g., "http://127.0.0.1:3001"
  title?: string;      // Optional title hint
  project?: string;    // Optional project hint
}

export interface UploadResult {
  success: boolean;
  uuid?: string;
  filename?: string;
  size?: number;
  title?: string | null;
  project?: string | null;
  error?: string;
}

export class UploadService {

  /**
   * Build a multipart/form-data body as a single Buffer.
   * Each field is separated by the boundary marker.
   * Binary file content is preserved exactly as read from disk.
   */
  private buildMultipartBody(options: UploadOptions, boundary: string): Buffer {
    const ext = path.extname(options.filePath).toLowerCase().replace('.', '');
    const mimeType = AUDIO_MIME_TYPES[ext] || 'application/octet-stream';
    const filename = path.basename(options.filePath);
    const fileContent = fs.readFileSync(options.filePath);

    const parts: Buffer[] = [];

    // Audio file part — binary content must be a separate Buffer to avoid encoding issues
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n` +
      '\r\n',
      'utf8'
    ));
    parts.push(fileContent);
    parts.push(Buffer.from('\r\n', 'utf8'));

    // Optional title field
    if (options.title) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="title"\r\n' +
        '\r\n' +
        `${options.title}\r\n`,
        'utf8'
      ));
    }

    // Optional project field
    if (options.project) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="project"\r\n' +
        '\r\n' +
        `${options.project}\r\n`,
        'utf8'
      ));
    }

    // Terminal boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

    return Buffer.concat(parts);
  }

  /**
   * Upload an audio file to the Protokoll server's /audio/upload endpoint.
   *
   * Never throws — returns UploadResult with success: false on any error
   * so callers can focus on UX rather than try/catch.
   */
  async uploadAudio(options: UploadOptions): Promise<UploadResult> {
    return new Promise((resolve) => {
      try {
        // Pre-flight checks
        if (!options.filePath) {
          resolve({ success: false, error: 'No file path provided' });
          return;
        }
        if (!fs.existsSync(options.filePath)) {
          resolve({ success: false, error: `File not found: ${options.filePath}` });
          return;
        }

        const boundary = `----FormBoundary${randomUUID().replace(/-/g, '')}`;

        let body: Buffer;
        try {
          body = this.buildMultipartBody(options, boundary);
        } catch (err) {
          resolve({
            success: false,
            error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        const url = new URL(`${options.serverUrl.replace(/\/+$/, '')}/audio/upload`);
        const httpModule = url.protocol === 'https:' ? https : http;

        const requestOptions = {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Content-Length': body.length,
          },
          timeout: 60_000, // 60-second timeout — large files can be slow
        };

        const req = httpModule.request(requestOptions, (res) => {
          let responseText = '';
          res.on('data', (chunk: Buffer) => {
            responseText += chunk.toString();
          });
          res.on('end', () => {
            try {
              const json = JSON.parse(responseText);
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && json.success) {
                resolve({
                  success: true,
                  uuid: json.uuid,
                  filename: json.filename,
                  size: json.size,
                  title: json.title ?? null,
                  project: json.project ?? null,
                });
              } else {
                resolve({
                  success: false,
                  error: json.error || json.details || `Server returned HTTP ${res.statusCode}`,
                });
              }
            } catch {
              resolve({
                success: false,
                error: `Failed to parse server response (HTTP ${res.statusCode})`,
              });
            }
          });
          res.on('error', (err: Error) => {
            resolve({ success: false, error: `Response error: ${err.message}` });
          });
        });

        req.on('error', (err: Error) => {
          const friendlyMessage = err.message.includes('ECONNREFUSED')
            ? `Cannot connect to Protokoll server at ${options.serverUrl}. Is it running?`
            : `Upload failed: ${err.message}`;
          resolve({ success: false, error: friendlyMessage });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, error: 'Upload timed out after 60 seconds' });
        });

        req.write(body);
        req.end();

      } catch (err) {
        resolve({
          success: false,
          error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }
}

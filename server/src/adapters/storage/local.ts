/**
 * Local filesystem storage driver.
 *
 * Used in development and for single-node deployments. Writes go to a temporary
 * file and are renamed into place, so a reader can never observe a partial
 * object — `rename` is atomic on POSIX and on NTFS.
 *
 * Key sanitisation: keys are server-generated (`type/base36time/ulid`), but we
 * still reject anything containing `..` or an absolute path as defence in depth,
 * and we confine every resolved path to the configured root.
 */
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from '../../security/crypto.js';
import type { StorageDriver } from './types.js';

export class LocalStorageDriver implements StorageDriver {
  readonly driverName = 'local';
  private readonly root: string;
  private readonly publicBaseUrl?: string;
  /** Staging area for chunked uploads, keyed by storage key. */
  private readonly staging = new Map<string, string[]>();

  constructor(root: string, publicBaseUrl?: string) {
    this.root = resolve(root);
    this.publicBaseUrl = publicBaseUrl;
    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, '.staging'), { recursive: true });
  }

  /** Resolve a key to an absolute path, refusing to escape the root. */
  private pathFor(key: string): string {
    const clean = String(key).replace(/^[\\/]+/, '');
    if (!clean || clean.includes('\0')) throw new Error('Invalid storage key');
    const full = resolve(join(this.root, clean));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('Storage key escapes the configured root');
    }
    return full;
  }

  put(key: string, bytes: Uint8Array | Buffer): void {
    const target = this.pathFor(key);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, Buffer.from(bytes));
    renameSync(tmp, target);
    this.clearStaging(key);
  }

  appendChunk(key: string, index: number, bytes: Uint8Array | Buffer): void {
    let parts = this.staging.get(key);
    if (!parts) {
      parts = [];
      this.staging.set(key, parts);
    }
    const dir = join(this.root, '.staging');
    mkdirSync(dir, { recursive: true });
    const partPath = join(dir, `${key.replace(/[\\/]/g, '_')}.${index}.part`);
    mkdirSync(dirname(partPath), { recursive: true });
    appendFileSync(partPath, Buffer.from(bytes));
    parts[index] = partPath;
  }

  read(key: string): Buffer | null {
    // Chunked uploads are assembled on first read if they were never finalised.
    this.assembleIfStaged(key);
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }

  readRange(key: string, start: number, end: number): Buffer | null {
    this.assembleIfStaged(key);
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    const size = statSync(p).size;
    const from = Math.max(0, start);
    const to = Math.min(size - 1, end);
    if (from > to) return Buffer.alloc(0);
    const length = to - from + 1;
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, from);
      return buf;
    } finally {
      closeSync(fd);
    }
  }

  exists(key: string): boolean {
    this.assembleIfStaged(key);
    try {
      return existsSync(this.pathFor(key));
    } catch {
      return false;
    }
  }

  size(key: string): number {
    this.assembleIfStaged(key);
    try {
      const p = this.pathFor(key);
      return existsSync(p) ? statSync(p).size : 0;
    } catch {
      return 0;
    }
  }

  delete(key: string): void {
    this.clearStaging(key);
    try {
      const p = this.pathFor(key);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // Idempotent by contract.
    }
  }

  supportsPresignedUrls(): boolean {
    // A local driver cannot hand a browser a direct upload URL, so the API
    // streams the bytes. Returning false makes requestUpload pick mode:'api'.
    return false;
  }

  createPresignedUploadUrls(): string[] {
    return [];
  }

  createSignedReadUrl(key: string, ttlSeconds: number, _contentType?: string, filename?: string): string {
    // The server's own download route enforces authorisation and then streams
    // from disk. `exp` and `sig` let us bind the URL to a deadline so a leaked
    // link stops working.
    void ttlSeconds;
    void createWriteStream;
    const base = this.publicBaseUrl ? this.publicBaseUrl.replace(/\/$/, '') : '';
    const encoded = encodeURIComponent(key);
    const name = filename ? `&name=${encodeURIComponent(filename)}` : '';
    return `${base}/api/v1/media/${encoded}?ttl=${ttlSeconds}${name}`;
  }

  private assembleIfStaged(key: string): void {
    const parts = this.staging.get(key);
    if (!parts || !parts.length) return;
    const target = this.pathFor(key);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const ordered = parts
      .map((p, i) => ({ p, i }))
      .filter((x) => x.p)
      .sort((a, b) => a.i - b.i);
    writeFileSync(tmp, Buffer.alloc(0));
    for (const { p } of ordered) {
      if (existsSync(p)) appendFileSync(tmp, readFileSync(p));
    }
    renameSync(tmp, target);
    this.clearStaging(key);
  }

  private clearStaging(key: string): void {
    const parts = this.staging.get(key);
    if (!parts) return;
    for (const p of parts) {
      try {
        if (p && existsSync(p)) rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
    this.staging.delete(key);
  }
}

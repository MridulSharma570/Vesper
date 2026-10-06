/** Storage driver contract. */
export interface StorageDriver {
  readonly driverName: string;

  /** Write or overwrite an object. Must be atomic: no partial object is ever readable. */
  put(key: string, bytes: Uint8Array | Buffer, contentType?: string): Promise<void> | void;

  /** Append a chunk. Implementations may buffer until `complete`. */
  appendChunk(key: string, index: number, bytes: Uint8Array | Buffer): void;

  /** Read the whole object, or null when absent. */
  read(key: string): Buffer | null;

  /** Read a byte range. Used for video seeking and chunked downloads. */
  readRange(key: string, start: number, end: number): Buffer | null;

  exists(key: string): boolean;
  size(key: string): number;
  delete(key: string): void;

  /** True when this driver can hand out direct-to-storage upload URLs. */
  supportsPresignedUrls(): boolean;
  createPresignedUploadUrls(key: string, parts: number): string[];

  /**
   * Signed read URL. For drivers that cannot sign, returns an internal API path
   * that streams through the server (still access-controlled, just not offloaded).
   */
  createSignedReadUrl(key: string, ttlSeconds: number, contentType?: string, filename?: string): string;
}

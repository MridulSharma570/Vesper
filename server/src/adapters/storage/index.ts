/**
 * Storage adapter interface.
 *
 * One interface, four drivers. The rest of the codebase only ever talks to
 * `storage`, so moving from a local disk in development to S3 / R2 / GCS in
 * production is an environment variable change — no call site changes.
 *
 * Security properties every driver must preserve:
 *  - Keys are opaque random strings chosen by the server. No user-supplied path
 *    component ever reaches a driver, so path traversal is impossible.
 *  - Reads are only ever served through short-lived signed URLs minted by
 *    `services/media.authoriseDownload`, after a membership check.
 *  - Deletes are idempotent: deleting a missing key succeeds.
 */
import type { MediaType } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { LocalStorageDriver } from './local.js';
import { S3StorageDriver } from './s3.js';
import type { StorageDriver } from './types.js';

function selectDriver(): StorageDriver {
  switch (config.storage.driver) {
    case 's3':
    case 'r2':
    case 'gcs':
      // R2 and GCS both speak the S3 API; only the endpoint differs.
      return new S3StorageDriver({
        name: config.storage.driver,
        bucket: config.storage.bucket,
        region: config.storage.region,
        endpoint: config.storage.endpoint || undefined,
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
        publicBaseUrl: config.storage.publicBaseUrl || undefined,
        forcePathStyle: !!config.storage.endpoint,
      });
    case 'local':
    default:
      return new LocalStorageDriver(config.storage.localDir, config.storage.publicBaseUrl || undefined);
  }
}

export const storage: StorageDriver = selectDriver();

export type { StorageDriver };
export { MEDIA_POLICY_HINTS };

/**
 * Content-disposition hints per media type. Used when minting signed URLs so a
 * document downloads instead of rendering inline (which would let an HTML file
 * execute in our origin).
 */
const MEDIA_POLICY_HINTS: Record<MediaType, 'inline' | 'attachment'> = {
  image: 'inline',
  gif: 'inline',
  sticker: 'inline',
  video: 'inline',
  audio: 'inline',
  voice: 'inline',
  document: 'attachment',
  contact_card: 'attachment',
  location: 'attachment',
  event_card: 'attachment',
};

/**
 * MIME types that must never be served inline from our origin, even when the
 * client asks. Serving attacker-controlled HTML/SVG inline is an XSS vector.
 */
export const NEVER_INLINE = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript',
  'text/javascript', 'application/x-javascript', 'text/xml', 'application/xml',
]);

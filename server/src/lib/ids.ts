/**
 * Identifier generation.
 *
 * Two families, both opaque and both non-enumerable:
 *
 *  - `newId()`   : 128-bit CSPRNG, Crockford base32 (26 chars). Used for users,
 *                  conversations, attachments, reports — anything addressable.
 *                  Random, so it leaks nothing about volume or creation order.
 *  - `newSnowflake()` : time-ordered base36 id used for messages only, where we
 *                  need cheap cursor pagination (`WHERE id < ? ORDER BY id DESC`).
 *                  Ordering is guaranteed, not probabilistic — see the notes on
 *                  `newSnowflake` for why that matters and what it costs.
 *
 * Handles are generated from a curated adjective+noun wordlist so an anonymous
 * user gets something memorable ("quiet-otter") instead of a UUID.
 */
import { isValidHandle, randomBytes, secureInt, pick } from '../security/crypto.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

/** 26-char Crockford base32 encoding of 16 random bytes. */
export function newId(): string {
  const bytes = randomBytes(16);
  let out = '';
  // 16 bytes = 128 bits; encode 5 bits at a time, pad the tail.
  let bitBuffer = 0;
  let bitCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i]!;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += ALPHABET[(bitBuffer >>> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) out += ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
  return out;
}

const SNOWFLAKE_EPOCH = 1_700_000_000_000; // 2023-11-14T22:13:20Z, arbitrary fixed origin
const SEQ_BITS = 24n;
const SEQ_MAX = 1n << SEQ_BITS; // 16,777,216 ids per second

let lastSeconds = -1n;
let lastSeq = 0n;

/**
 * Time-ordered message id.
 *
 * Layout: `(secondsSinceEpoch << 24) | sequence`, base36 encoded and zero-padded
 * to a fixed 12 characters so lexicographic order equals numeric order. That is
 * what makes `WHERE id < cursor ORDER BY id DESC` a correct pagination strategy.
 *
 * Why the low bits are a counter and not random
 * ---------------------------------------------
 * An earlier version filled the low 24 bits with CSPRNG output. That made the id
 * unguessable but **not** ordered: two messages in the same second sorted by
 * their random tails, so a later message could compare *less than* an earlier
 * one. With cursor pagination that is not a cosmetic problem — it silently skips
 * or duplicates messages at page boundaries, and it reorders a fast burst of
 * chat messages in the transcript. Correctness of ordering wins over
 * unguessability here, because message ids are only ever exposed to the
 * participants of that conversation, who already see the messages and their
 * timestamps anyway.
 *
 * What is still obscured
 * ----------------------
 * The sequence restarts from a *random* offset each second, so counts cannot be
 * compared across seconds and the id does not reveal traffic volume. Within one
 * second the relative distance between two ids is visible to conversation
 * members, which leaks nothing they do not already have.
 *
 * The seconds field itself is derivable from the id, so a message id discloses
 * its creation time to the second. That is already visible in the UI, so it is
 * not an additional leak — but it is why `newId()` (fully random) is used for
 * everything addressable, and snowflakes only for messages.
 *
 * Concurrency
 * -----------
 * Uniqueness is guaranteed within one process. Two server instances sharing a
 * database could in principle pick the same random offset in the same second, so
 * a multi-instance deployment must either add an instance id to the sequence
 * field or keep a single writer — which SQLite already requires, since it is the
 * reason this codebase is single-node.
 */
export function newSnowflake(nowMs: number = Date.now()): string {
  const requested = BigInt(Math.max(0, Math.floor((nowMs - SNOWFLAKE_EPOCH) / 1000)));

  let seconds: bigint;
  if (requested > lastSeconds) {
    seconds = requested;
    lastSeq = randomSeqStart();
  } else {
    // Same second, or the clock stepped backwards (NTP correction, VM migration).
    // Either way we stay on the last second we issued and advance the counter, so
    // we never emit an id that sorts before one already handed out.
    seconds = lastSeconds < 0n ? requested : lastSeconds;
    if (lastSeconds < 0n) lastSeq = randomSeqStart();
    lastSeq += 1n;
    if (lastSeq >= SEQ_MAX) {
      // This second's sequence space is exhausted. Roll into the next second
      // rather than emit a duplicate or an out-of-order id.
      seconds += 1n;
      lastSeq = randomSeqStart();
    }
  }

  lastSeconds = seconds;
  const value = seconds * SEQ_MAX + lastSeq;
  return value.toString(36).padStart(12, '0');
}

/**
 * Random starting offset within a second, kept in the lower half of the sequence
 * space so a burst has room to increment before it would roll over.
 */
function randomSeqStart(): bigint {
  return BigInt(randomBytes(3).readUIntBE(0, 3)) % (SEQ_MAX >> 1n);
}

/**
 * Exact base36 → BigInt conversion.
 *
 * `BigInt(parseInt(id, 36))` is NOT safe here: a 12-character base36 id can hold
 * ~4.7e18, which exceeds Number.MAX_SAFE_INTEGER (9.0e15), so `parseInt` rounds
 * and the recovered timestamp drifts. The current epoch offset keeps ids under
 * the limit for now, but they cross it in the 2040s — and a retention sweep that
 * silently mis-dates messages would delete the wrong ones.
 */
function parseBase36(value: string): bigint {
  let out = 0n;
  for (const ch of value.toLowerCase()) {
    const digit = ch >= '0' && ch <= '9'
      ? BigInt(ch.charCodeAt(0) - 48)
      : ch >= 'a' && ch <= 'z'
        ? BigInt(ch.charCodeAt(0) - 87)
        : -1n;
    if (digit < 0n) throw new RangeError(`Invalid base36 character: ${ch}`);
    out = out * 36n + digit;
  }
  return out;
}

/** Extract the creation time from a snowflake (used for retention sweeps). */
export function snowflakeTime(id: string): number {
  const seconds = parseBase36(id) / SEQ_MAX;
  return SNOWFLAKE_EPOCH + Number(seconds) * 1000;
}

/** Reset snowflake state. Test-only: production must keep monotonic state. */
export function resetSnowflakeState(): void {
  lastSeconds = -1n;
  lastSeq = 0n;
}

/** Short opaque token for upload grants, resume tokens, etc. */
export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/* ─────────────────────────── Anonymous handle generation ─────────────────────────── */

const ADJECTIVES = [
  'quiet', 'gentle', 'hollow', 'amber', 'velvet', 'silent', 'distant', 'pale',
  'wandering', 'still', 'faint', 'hidden', 'soft', 'nomad', 'glass', 'winter',
  'summer', 'autumn', 'violet', 'indigo', 'cobalt', 'silver', 'copper', 'ivory',
  'obsidian', 'marble', 'cedar', 'willow', 'aspen', 'birch', 'harbour', 'meadow',
  'tundra', 'canyon', 'lagoon', 'summit', 'valley', 'orchid', 'jasmine', 'lotus',
  'ember', 'frost', 'mistral', 'zephyr', 'monsoon', 'aurora', 'eclipse', 'solstice',
  'equinox', 'meridian', 'lantern', 'candle', 'beacon', 'compass', 'anchor', 'sail',
  'drifting', 'lucid', 'mellow', 'serene', 'timid', 'brisk', 'wistful', 'cryptic',
];

const NOUNS = [
  'otter', 'heron', 'falcon', 'lynx', 'raven', 'moth', 'fox', 'wolf',
  'panda', 'koala', 'ibis', 'wren', 'finch', 'egret', 'crane', 'swan',
  'harbor', 'lantern', 'compass', 'atlas', 'quill', 'inkwell', 'page', 'folio',
  'ember', 'cinder', 'spark', 'flint', 'tide', 'reef', 'cove', 'fjord',
  'glade', 'thicket', 'grove', 'copse', 'ridge', 'dune', 'mesa', 'steppe',
  'comet', 'meteor', 'nebula', 'quasar', 'pulsar', 'orbit', 'zenith', 'nad',
  'cipher', 'glyph', 'rune', 'sigil', 'token', 'relic', 'echo', 'whisper',
  'vesper', 'silence', 'pause', 'rest', 'coda', 'prelude', 'nocturne', 'aria',
];

/**
 * Generate a memorable anonymous handle. `taken` is consulted so we never return
 * a collision; after several attempts we fall back to a numeric suffix and finally
 * to random base32, guaranteeing termination.
 */
export function generateHandle(taken: (handle: string) => boolean): string {
  for (let attempt = 0; attempt < 24; attempt++) {
    const candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken(candidate)) return candidate;
    if (attempt > 8) {
      const suffixed = `${candidate}-${secureInt(9000) + 1000}`;
      if (!taken(suffixed)) return suffixed;
    }
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = `user-${randomBytes(4).toString('hex')}`;
    if (!taken(candidate)) return candidate;
  }
  // Astronomically unlikely, but must never loop forever.
  return `user-${randomBytes(8).toString('hex')}`;
}

/** Deterministic avatar seed + hue from an id, so avatars render offline. */
export function avatarSpec(id: string): { seed: string; hue: number } {
  const bytes = randomBytes(0).length === 0 ? Buffer.from(id.padEnd(16, '0').slice(0, 16)) : Buffer.alloc(0);
  // Derive hue from the id itself (stable) without pulling in a hash import cycle.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  void bytes;
  return { seed: id, hue: h % 360 };
}


/* ─────────────────────────── Boot self-test ─────────────────────────── */

/**
 * Assert that `generateHandle()` output always satisfies `isValidHandle()`.
 *
 * This is the single most load-bearing invariant in signup: an auto-assigned
 * handle is the default for every anonymous account, so if the generator and the
 * validator ever disagree, registration fails for everyone who does not pick a
 * handle themselves — and it fails at account creation, not at some later point
 * where the cause would be obvious.
 *
 * The check lives here rather than in crypto's self-test because `ids` already
 * depends on `crypto`; the reverse import would be circular.
 */
export function idsSelfTest(samples = 64): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  // Nothing is taken, so every candidate must be returned as-is and must validate.
  for (let i = 0; i < samples; i++) {
    const handle = generateHandle(() => false);
    if (!isValidHandle(handle)) {
      failures.push(`generated handle "${handle}" was rejected by isValidHandle`);
      break;
    }
  }

  // Under contention the generator falls back to suffixed and random forms; those
  // must validate too, or a busy server would start rejecting its own signups.
  const taken = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const handle = generateHandle((h) => taken.has(h));
    taken.add(handle);
    if (!isValidHandle(handle)) {
      failures.push(`contended handle "${handle}" was rejected by isValidHandle`);
      break;
    }
  }
  if (taken.size < 400) failures.push(`generator produced only ${taken.size} unique handles out of 400`);

  // Ids must be unique and URL-safe.
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i++) ids.add(newId());
  if (ids.size !== 2000) failures.push(`newId produced ${ids.size} unique values out of 2000`);
  if (![...ids].every((id) => /^[0-9A-HJKMNP-TV-Z]+$/.test(id))) {
    failures.push('newId emitted a character outside the Crockford base32 alphabet');
  }

  // Snowflakes must sort chronologically, because message pagination relies on
  // `WHERE id < cursor ORDER BY id DESC` rather than on a created_at column.
  // A burst inside a single second is the case that a random low-order field
  // gets wrong, so it is tested explicitly and at volume.
  const burstAt = Date.now();
  let previous = '';
  for (let i = 0; i < 5000; i++) {
    const id = newSnowflake(burstAt);
    if (previous && !(previous < id)) {
      failures.push(`newSnowflake is not monotonic within one second: "${previous}" then "${id}"`);
      break;
    }
    if (id.length !== 12) {
      failures.push(`newSnowflake width changed to ${id.length} chars; lexicographic order would break`);
      break;
    }
    previous = id;
  }

  // A clock stepping backwards (NTP correction, VM migration) must never produce
  // an id that sorts before one already issued.
  const forward = newSnowflake(burstAt + 60_000);
  const backward = newSnowflake(burstAt);
  if (!(backward > forward)) {
    failures.push(`newSnowflake went backwards in time: "${forward}" then "${backward}"`);
  }

  // snowflakeTime must round-trip exactly. The naive parseInt(id, 36) path loses
  // precision above Number.MAX_SAFE_INTEGER, which a 12-char base36 id exceeds.
  for (const id of [newSnowflake(1_700_000_000_000), newSnowflake(Date.now()), newSnowflake(4_000_000_000_000)]) {
    const recovered = snowflakeTime(id);
    const expectedFloor = Math.floor((recovered - SNOWFLAKE_EPOCH) / 1000);
    const actualFloor = Number(parseBase36(id) / SEQ_MAX);
    if (expectedFloor !== actualFloor) {
      failures.push(`snowflakeTime("${id}") lost precision: ${expectedFloor} vs ${actualFloor}`);
      break;
    }
  }
  // A far-future id (year ~2096) sits above MAX_SAFE_INTEGER; verify it survives.
  const far = newSnowflake(4_000_000_000_000);
  if (parseBase36(far) <= BigInt(Number.MAX_SAFE_INTEGER)) {
    failures.push('test bug: far-future snowflake did not exceed MAX_SAFE_INTEGER');
  }
  // snowflakeTime returns absolute epoch ms, so the expectation must add the
  // epoch back; comparing against a relative second count is a false failure.
  const farMs = 4_000_000_000_000;
  const farSeconds = Math.floor((farMs - SNOWFLAKE_EPOCH) / 1000);
  const expectedMs = SNOWFLAKE_EPOCH + farSeconds * 1000;
  if (Math.abs(snowflakeTime(far) - expectedMs) > 1000) {
    failures.push(`snowflakeTime lost precision on a large id: ${snowflakeTime(far)} vs ~${expectedMs}`);
  }

  return { ok: failures.length === 0, failures };
}

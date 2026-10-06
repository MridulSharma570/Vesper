/**
 * Central configuration. Every secret comes from the environment; nothing is
 * hardcoded. `.env.example` documents all of them.
 *
 * Boot fails loudly if a secret required for the current NODE_ENV is missing,
 * so you can never accidentally ship a dev key to production.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CallKind, FeatureFlags, LoginMethod, MediaType } from '../../shared/types.js';

/* ── Minimal .env loader (no dependency, works for KEY=VALUE and quoted values) ── */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const envFile = process.env.VESPER_ENV_FILE ?? resolve(process.cwd(), '.env');
loadDotEnv(envFile);

const str = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;
const int = (key: string, fallback: number): number => {
  const v = Number.parseInt(str(key, ''), 10);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (key: string, fallback: boolean): boolean => {
  const v = str(key, '').toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const list = <T extends string>(key: string, fallback: T[]): T[] => {
  const v = str(key, '');
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean) as T[];
};

export const NODE_ENV = (str('NODE_ENV', 'development') || 'development') as
  | 'development' | 'test' | 'staging' | 'production';
export const IS_PROD = NODE_ENV === 'production';

/**
 * Master secrets. In production these MUST be supplied. In development they are
 * generated per-boot and persisted to data/.dev-secrets.json so sessions survive restarts.
 */
function resolveSecrets() {
  let jwtSecret = str('JWT_SECRET');
  let pepper = str('IDENTITY_PEPPER');
  let encKey = str('DATA_ENCRYPTION_KEY');

  if (IS_PROD) {
    const missing: string[] = [];
    if (!jwtSecret || jwtSecret.length < 32) missing.push('JWT_SECRET (>=32 chars)');
    if (!pepper || pepper.length < 32) missing.push('IDENTITY_PEPPER (>=32 chars)');
    if (!encKey || !/^[0-9a-f]{64}$/i.test(encKey)) missing.push('DATA_ENCRYPTION_KEY (64 hex chars = 32 bytes)');
    if (missing.length) {
      throw new Error(
        `Refusing to start in production without secrets: ${missing.join(', ')}. ` +
        `Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
      );
    }
    return { jwtSecret, pepper, encKey };
  }

  const devPath = resolve(str('DATA_DIR', 'data'), '.dev-secrets.json');
  try {
    if (existsSync(devPath)) {
      const saved = JSON.parse(readFileSync(devPath, 'utf8')) as Record<string, string>;
      jwtSecret ||= saved.jwtSecret ?? '';
      pepper ||= saved.pepper ?? '';
      encKey ||= saved.encKey ?? '';
    }
  } catch {
    /* corrupt dev file — regenerate below */
  }
  jwtSecret ||= randomBytes(48).toString('base64url');
  pepper ||= randomBytes(48).toString('base64url');
  encKey ||= randomBytes(32).toString('hex');

  try {
    mkdirSync(resolve(str('DATA_DIR', 'data')), { recursive: true });
    writeFileSync(devPath, JSON.stringify({ jwtSecret, pepper, encKey }, null, 2), { mode: 0o600 });
  } catch {
    /* non-fatal in dev */
  }
  return { jwtSecret, pepper, encKey };
}

const secrets = resolveSecrets();

export const config = {
  env: NODE_ENV,
  isProd: IS_PROD,
  app: {
    name: str('APP_NAME', 'Vesper'),
    version: str('APP_VERSION', '1.0.0'),
    /** Public base URL used in magic links, email templates and OAuth redirects. */
    publicUrl: str('PUBLIC_URL', 'http://localhost:5173'),
    supportEmail: str('SUPPORT_EMAIL', 'support@vesper.local'),
    legalEmail: str('LEGAL_EMAIL', 'legal@vesper.local'),
    dpoEmail: str('DPO_EMAIL', 'privacy@vesper.local'),
  },
  server: {
    host: str('HOST', '0.0.0.0'),
    port: int('PORT', 8787),
    /** Comma separated list of allowed browser origins. */
    corsOrigins: list<string>('CORS_ORIGINS', ['http://localhost:5173', 'http://127.0.0.1:5173']),
    trustProxy: bool('TRUST_PROXY', false),
    bodyLimitBytes: int('BODY_LIMIT_BYTES', 1_048_576),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 30_000),
  },
  db: {
    file: str('DATABASE_FILE', resolve(str('DATA_DIR', 'data'), 'vesper.db')),
    /** WAL + foreign keys + busy timeout are applied on open. */
    busyTimeoutMs: int('DB_BUSY_TIMEOUT_MS', 5_000),
  },
  storage: {
    driver: str('STORAGE_DRIVER', 'local') as 'local' | 's3' | 'gcs' | 'r2',
    localDir: str('STORAGE_LOCAL_DIR', resolve(str('DATA_DIR', 'data'), 'storage')),
    bucket: str('STORAGE_BUCKET'),
    region: str('STORAGE_REGION', 'us-east-1'),
    endpoint: str('STORAGE_ENDPOINT'),
    accessKeyId: str('STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: str('STORAGE_SECRET_ACCESS_KEY'),
    publicBaseUrl: str('STORAGE_PUBLIC_BASE_URL'),
    /** Seconds a signed download URL stays valid. Keep short. */
    signedUrlTtlSeconds: int('STORAGE_SIGNED_URL_TTL', 300),
  },
  secrets,
  auth: {
    jwtIssuer: str('JWT_ISSUER', 'vesper'),
    jwtAudience: str('JWT_AUDIENCE', 'vesper-clients'),
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL', 15 * 60),
    refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
    /**
     * Password KDF. scrypt from node:crypto is used because it is memory-hard,
     * audited, and ships with the runtime — a hand-rolled or WASM Argon2id is
     * not worth the supply-chain and correctness risk. Parameters follow the
     * OWASP recommendation (N=2^15, r=8, p=1) and `needsRehash()` upgrades
     * stored hashes transparently when these are raised.
     */
    kdf: {
      algorithm: 'scrypt' as const,
      N: int('KDF_SCRYPT_N', 32768),
      r: int('KDF_SCRYPT_R', 8),
      p: int('KDF_SCRYPT_P', 1),
      keyLength: 32,
    },
    otp: {
      length: int('OTP_LENGTH', 6),
      ttlSeconds: int('OTP_TTL', 300),
      maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
      resendCooldownSeconds: int('OTP_RESEND_COOLDOWN', 60),
    },
    password: {
      minLength: int('PASSWORD_MIN_LENGTH', 10),
      maxLength: 512,
      /** zxcvbn-style minimum score 0-4 enforced client + server. */
      minScore: int('PASSWORD_MIN_SCORE', 3),
    },
    handle: {
      minLength: 3,
      maxLength: 32,
      reserved: list('RESERVED_HANDLES', [
        'admin', 'administrator', 'root', 'owner', 'system', 'support', 'help',
        'vesper', 'official', 'verified', 'moderator', 'mod', 'staff', 'api',
        'security', 'privacy', 'legal', 'abuse', 'press', 'jobs', 'careers',
      ] as string[]),
    },
    deviceKey: {
      /** Allow pure-local keypair accounts with no email/phone at all. */
      enabled: bool('ALLOW_DEVICE_KEY_ACCOUNTS', true),
    },
  },
  providers: {
    email: {
      driver: str('EMAIL_DRIVER', 'console') as 'console' | 'resend' | 'ses' | 'smtp',
      from: str('EMAIL_FROM', 'Vesper <no-reply@vesper.local>'),
      resendApiKey: str('RESEND_API_KEY'),
      ses: {
        region: str('SES_REGION', 'us-east-1'),
        accessKeyId: str('SES_ACCESS_KEY_ID'),
        secretAccessKey: str('SES_SECRET_ACCESS_KEY'),
      },
      smtp: {
        url: str('SMTP_URL'),
      },
    },
    sms: {
      driver: str('SMS_DRIVER', 'console') as 'console' | 'twilio' | 'msg91' | 'sns',
      from: str('SMS_FROM'),
      twilio: {
        accountSid: str('TWILIO_ACCOUNT_SID'),
        authToken: str('TWILIO_AUTH_TOKEN'),
      },
      msg91: {
        authKey: str('MSG91_AUTH_KEY'),
        senderId: str('MSG91_SENDER_ID'),
        templateId: str('MSG91_TEMPLATE_ID'),
      },
      sns: {
        region: str('SNS_REGION', 'ap-south-1'),
        accessKeyId: str('SNS_ACCESS_KEY_ID'),
        secretAccessKey: str('SNS_SECRET_ACCESS_KEY'),
      },
    },
    oauth: {
      google: {
        clientId: str('GOOGLE_CLIENT_ID'),
        clientSecret: str('GOOGLE_CLIENT_SECRET'),
        /** Android/iOS/Windows clients use the id_token flow; web uses the code flow. */
        allowedAudiences: list('GOOGLE_ALLOWED_AUDIENCES', []),
      },
      apple: {
        clientId: str('APPLE_CLIENT_ID'),
        teamId: str('APPLE_TEAM_ID'),
        keyId: str('APPLE_KEY_ID'),
        /** Contents of the .p8 private key (PEM, newlines escaped as \n). */
        privateKey: str('APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      },
    },
    push: {
      driver: str('PUSH_DRIVER', 'noop') as 'noop' | 'fcm' | 'apns' | 'web' | 'multi',
      fcm: {
        /** Service account JSON, as a string or a path. */
        serviceAccountJson: str('FCM_SERVICE_ACCOUNT_JSON'),
        projectId: str('FCM_PROJECT_ID'),
      },
      apns: {
        keyId: str('APNS_KEY_ID'),
        teamId: str('APNS_TEAM_ID'),
        bundleId: str('APNS_BUNDLE_ID', 'app.vesper.ios'),
        privateKey: str('APNS_PRIVATE_KEY').replace(/\\n/g, '\n'),
        production: bool('APNS_PRODUCTION', IS_PROD),
      },
      web: {
        vapidPublicKey: str('VAPID_PUBLIC_KEY'),
        vapidPrivateKey: str('VAPID_PRIVATE_KEY'),
        subject: str('VAPID_SUBJECT', 'mailto:support@vesper.local'),
      },
    },
    calls: {
      /** mesh = P2P WebRTC via our own signalling; sfu/mcu delegate to a media server. */
      topology: str('CALL_TOPOLOGY', 'mesh') as 'mesh' | 'sfu' | 'mcu',
      adapter: str('CALL_ADAPTER', 'mesh') as 'mesh' | 'livekit' | 'mediasoup' | 'janus' | 'agora',
      iceServers: list('ICE_SERVERS', ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478']),
      turn: {
        urls: list('TURN_URLS', []),
        username: str('TURN_USERNAME'),
        credential: str('TURN_CREDENTIAL'),
      },
      livekit: {
        url: str('LIVEKIT_URL'),
        apiKey: str('LIVEKIT_API_KEY'),
        apiSecret: str('LIVEKIT_API_SECRET'),
      },
      agora: {
        appId: str('AGORA_APP_ID'),
        appCertificate: str('AGORA_APP_CERTIFICATE'),
      },
    },
    moderation: {
      driver: str('MODERATION_DRIVER', 'local') as 'local' | 'hive' | 'perspective' | 'photodna',
      hiveApiKey: str('HIVE_API_KEY'),
      perspectiveApiKey: str('PERSPECTIVE_API_KEY'),
      /** SHA-256 / perceptual hash blocklists loaded from data/blocklist/*.txt */
      blocklistDir: str('BLOCKLIST_DIR', resolve(str('DATA_DIR', 'data'), 'blocklist')),
    },
    gif: {
      giphyApiKey: str('GIPHY_API_KEY'),
      tenorApiKey: str('TENOR_API_KEY'),
      tenorClientKey: str('TENOR_CLIENT_KEY'),
    },
    maps: {
      /** Static map tiles for location messages. */
      provider: str('MAPS_PROVIDER', 'none') as 'none' | 'google' | 'mapbox' | 'osm',
      apiKey: str('MAPS_API_KEY'),
      style: str('MAPS_STYLE', 'light'),
    },
  },
  features: {
    mediaPipeline: bool('FEATURE_MEDIA', false),
    allowedMediaTypes: list<MediaType>('FEATURE_MEDIA_TYPES', ['image', 'sticker', 'gif']),
    maxUploadMb: int('MAX_UPLOAD_MB', 100),
    calls: bool('FEATURE_CALLS', false),
    allowedCallKinds: list<CallKind>('FEATURE_CALL_KINDS', ['voice_1v1']),
    maxCallParticipants: int('MAX_CALL_PARTICIPANTS', 8),
    stories: bool('FEATURE_STORIES', false),
    e2ee: bool('FEATURE_E2EE', false),
    registrationMethods: list<LoginMethod>('FEATURE_REGISTRATION_METHODS', [
      'passkey', 'otp_email', 'otp_sms', 'google', 'apple', 'magic_link', 'device_key',
    ]),
    maxGroupSize: int('MAX_GROUP_SIZE', 256),
    maintenance: bool('MAINTENANCE_MODE', false),
  },
  rateLimits: {
    global: { max: int('RL_GLOBAL_MAX', 300), windowMs: int('RL_GLOBAL_WINDOW', 60_000) },
    auth: { max: int('RL_AUTH_MAX', 12), windowMs: int('RL_AUTH_WINDOW', 60_000) },
    otp: { max: int('RL_OTP_MAX', 5), windowMs: int('RL_OTP_WINDOW', 3600_000) },
    message: { max: int('RL_MESSAGE_MAX', 60), windowMs: int('RL_MESSAGE_WINDOW', 10_000) },
    upload: { max: int('RL_UPLOAD_MAX', 30), windowMs: int('RL_UPLOAD_WINDOW', 60_000) },
    admin: { max: int('RL_ADMIN_MAX', 240), windowMs: int('RL_ADMIN_WINDOW', 60_000) },
  },
  retention: {
    /** Days before a deactivated account and all its data are hard-deleted. */
    deletionGraceDays: int('DELETION_GRACE_DAYS', 30),
    /** Days audit logs are kept. */
    auditLogDays: int('AUDIT_LOG_DAYS', 365),
    /** Days expired OTPs / sessions / uploads are swept. */
    sweepIntervalMs: int('SWEEP_INTERVAL_MS', 15 * 60_000),
    /** Default max age for media when a user opts into auto-delete. */
    mediaDefaultDays: int('MEDIA_DEFAULT_DAYS', 30),
  },
  logging: {
    level: str('LOG_LEVEL', IS_PROD ? 'info' : 'debug'),
    pretty: bool('LOG_PRETTY', !IS_PROD),
    /** Never log these field names anywhere in the pipeline. */
    redact: [
      'password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'authorization',
      'otp', 'code', 'secret', 'privateKey', 'credential', 'pushToken', 'email', 'phone',
      'msisdn', 'body.text', 'body.attachment', 'sdp', 'candidate',
    ],
  },
} as const;

/** Snapshot of runtime-tunable flags, served to clients on connect. */
export function featureFlags(): FeatureFlags {
  return {
    mediaPipeline: config.features.mediaPipeline,
    allowedMediaTypes: [...config.features.allowedMediaTypes],
    maxUploadMb: config.features.maxUploadMb,
    calls: config.features.calls,
    allowedCallKinds: [...config.features.allowedCallKinds],
    maxCallParticipants: config.features.maxCallParticipants,
    stories: config.features.stories,
    e2ee: config.features.e2ee,
    registrationMethods: [...config.features.registrationMethods],
    maxGroupSize: config.features.maxGroupSize,
    maintenance: config.features.maintenance,
  };
}

export type AppConfig = typeof config;

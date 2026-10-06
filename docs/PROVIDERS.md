# Provider keys — bring your own, nothing is faked

Every external integration in Vesper is a real adapter with an env-driven
configuration. With no keys set, the **development driver** is used: it logs
exactly what would have been sent (emails land in `server/data/outbox/` and
the server console) and never pretends a delivery happened. Set the keys,
restart, and the real provider takes over — no code changes.

| Capability | Env vars | Notes |
|---|---|---|
| Email (OTP, login alerts) | `SMTP_URL` **or** `SES_REGION` + `SES_ACCESS_KEY_ID` + `SES_SECRET_ACCESS_KEY` | `SMTP_URL` is a full URL: `smtps://user:pass@host:465`. SES path uses the AWS SDK credentials. |
| SMS (OTP) | `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_TEMPLATE_ID` | Template must contain the OTP variable; the adapter passes `variables.otp`. |
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_AUDIENCES` | Audiences is a comma-separated list; id tokens are verified against it. |
| Apple sign-in | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` (+ the `.p8` secret path in config) | Standard Sign in with Apple server flow. |
| Analytics (opt-in) | `VESPER_GA_ID` | Unset = **no analytics code in the served page at all**. Set = gtag snippet spliced in with `anonymize_ip`, CSP opened by sha256 hash for the inline bootstrap only. |
| Support contact | `SUPPORT_EMAIL` | Surfaced in policy pages and store metadata. |

Runtime knobs that are **not** env vars: feature flags (media pipeline,
calls, stories, E2EE beta, maintenance) live in the admin panel
(Settings → Admin panel → Flags), rank-gated and audited.

## Verify your configuration

```bash
npx tsx scripts/doctor.ts          # from the repo root
```

It prints, per provider: `configured` / `dev driver (logs only)`, without
ever echoing secret values.

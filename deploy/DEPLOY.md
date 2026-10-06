# Free deployment runbook (Oracle Always-Free + DuckDNS + Caddy)

Total cost: **₹0 / month**, forever tier. Alternatives: any home machine
(₹0, needs to stay powered) behind a **Cloudflare Tunnel** — same steps
minus the VM, plus `cloudflared` instead of DuckDNS.

## 1. The VM
1. Oracle Cloud → sign up (free tier, no auto-upgrade) → **Create VM** →
   shape **VM.Standard.A1.Flex** (4 OCPU / 24 GB are Always-Free) →
   Ubuntu 24.04 → add your SSH key.
2. Open ingress for **80** and **443** (VCN → Security List) — and the same
   in Ubuntu's firewall: `sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT`
   (Oracle double-filters; this trips everyone once).

## 2. Hostname + TLS (free)
1. `https://www.duckdns.org` → sign in with Google/GitHub → create
   `vesper.duckdns.org` pointing at your VM's public IP.
2. `sudo apt install caddy` → copy `deploy/Caddyfile.example` to
   `/etc/caddy/Caddyfile` (edit hostname) → `sudo systemctl reload caddy`.
   Caddy fetches Let's Encrypt certs automatically and proxies to :8787.

## 3. The app
```bash
sudo useradd -m vesper && sudo mkdir -p /opt/vesper && sudo chown vesper:vesper /opt/vesper
sudo -u vesper git clone https://github.com/MridulSharma570/Vesper.git /opt/vesper
sudo -u vesper bash -c 'cd /opt/vesper && npm ci && npm run build'
sudo -u vesper nano /opt/vesper/secrets.env   # NODE secrets, chmod 600
```
`secrets.env` minimum (values from `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
encryption key as 64 hex chars):
```
JWT_SECRET=…
IDENTITY_PEPPER=…
DATA_ENCRYPTION_KEY=…(64 hex)…
```
Then `deploy/vesper.service` → `/etc/systemd/system/`, `daemon-reload`,
`enable --now vesper`. The server builds `client/dist` on first boot if it's
missing.

## 4. Your admin account
The official Administrator credential is seeded by `npm run setup` — set its
password deliberately and never commit it anywhere. Staff additions:
`npm run seed -- --handle=… --role=…` (prints a one-time password).

## 5. Invite testers
Send one link — `https://vesper.duckdns.org` — in WhatsApp/Telegram/email.
- Android/iOS: open in Chrome/Safari → menu → **Install / Add to Home Screen** → app icon, fullscreen, offline shell.
- Desktop: Chrome/Edge address-bar install button.
Updates ship automatically the next time they open it (`npm run build` +
`systemctl restart vesper` on your side). No store, no review, no fee.

## 6. Later, paid gates only if wanted
Play Console $25 (one-time) · Apple $99/yr · MS Store $19 (one-time).
Channels that stay free even for a proprietary app: Firebase App
Distribution, GitHub Releases APK/EXE, AltStore. (F-Droid requires an
open-source licence, which Vesper's is not.)

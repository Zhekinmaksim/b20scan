# b20scan.live - production notes

## Files changed vs the dev package

    public/index.html   + OG/twitter meta tags, favicon (link previews on X)
    public/og-card.png  + 1200x630 social card served at /og-card.png
    server.js           + CORS on /api/* (the "public API" promise), 5s cache

Copy these three onto the VPS over the deployed versions.

## .env (production values)

    RPC_URL=<your Alchemy/QuickNode Base endpoint>   # public RPC will rate-limit the backfill
    CHAIN_ID=8453
    START_BLOCK=<B20 activation block>               # look up the activation tx (Jul 8 2026 18:00 UTC) on BaseScan
    CHUNK=2000          # 10000 on a paid RPC
    CONFIRMATIONS=12
    POLL_MS=4000
    PORT=3020

START_BLOCK=0 wastes hours scanning two years of pre-activation history - set it.

## Process manager (systemd)

/etc/systemd/system/b20scan-indexer.service:

    [Unit]
    Description=b20scan indexer
    After=network.target
    [Service]
    WorkingDirectory=/opt/b20scan
    ExecStart=/usr/bin/node indexer.js
    Restart=always
    RestartSec=5
    EnvironmentFile=/opt/b20scan/.env
    [Install]
    WantedBy=multi-user.target

/etc/systemd/system/b20scan-web.service: same but ExecStart=/usr/bin/node server.js

    systemctl enable --now b20scan-indexer b20scan-web

Restart=always matters: the indexer resumes from its cursor, so crashes cost
nothing. SQLite WAL mode already allows web reads during indexer writes.

## TLS / reverse proxy (Caddy - 2 lines)

/etc/caddy/Caddyfile:

    b20scan.live {
        reverse_proxy 127.0.0.1:3020
    }

Caddy auto-provisions the certificate. (nginx + certbot works too, just longer.)

## Pre-launch checklist (Monday morning)

1. `curl https://b20scan.live/api/stats` - tokens > 0, cursor near chain head
2. Open the site - ticker moving, real mainnet tokens in the table
3. Click a stablecoin - currency chip populated
4. Click any token - issuer controls card shows roles + supply cap
5. Validate the X card: https://cards-dev.twitter.com/validator with b20scan.live
   (or just DM the link to yourself in X - preview should show the og-card)
6. Note the real token count - if it's far from the video's 13,847, re-render
   the demo (`render_frames.py`, one number) or just let the site speak

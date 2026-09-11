# FR-CALL-005 — self-hosted room calls

Keep CALLS_ENABLED=false until media and relay checks pass. Use a pinned LiveKit server image; do not expose its HTTP/Twirp port directly to the internet. The public signaling route must pass the API authorization subrequest on every websocket admission. `room.auto_create: false` prevents expired call credentials from recreating a room.

Production config and keys belong in ignored infra/livekit/config.yaml and infra/.env. Use an independent trusted certificate and DNS-only hostname for TURN TLS 443, not a Cloudflare proxied hostname. TCP 7881, UDP 7882 and TURN UDP 3478 carry encrypted media. Only authenticated room participants receive TURN credentials from LiveKit.

Calls and public meetings require their reconciliation schedulers every ten seconds for membership/session eviction and cleanup; health-check the scheduler along with the SFU. Browser ringing requires an open signed-in application and an audio-unlocked browser. Private chat calls have no guest access. Separate public meeting links (FR-MEET-001..005) allow named guests without chat access. There is no recording, background mobile push or Google account integration.

Official references: https://docs.livekit.io/transport/self-hosting/deployment/ and https://docs.livekit.io/frontends/reference/tokens-grants/.

Activation order: configure DNS-only TURN routing and a trusted certificate first; create a private `config.yaml` from the example with a random API key/secret; set matching `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_URL=wss://chat.gamecoms.net` in the deployment environment. The URL must use the existing app's gated `/rtc` path, never a directly exposed SFU HTTP port. Build the new API/web images, apply the additive call-table migration, and start the `calls` compose profile. Using an isolated QA API with calls enabled, run synthetic media with a forced `iceTransportPolicy: relay` connection and check the selected ICE candidate, then set `CALLS_ENABLED=true` and perform signed-in device checks. Roll back by setting the flag false and stopping the media service; retain the additive tables.

The compose service limits the SFU to one CPU and 768 MiB to contain resource use on the current shared host. Eight participants is a per-call cap, not a verified concurrent-call capacity. Monitor load and move media to a dedicated host when needed. Arrange certificate renewal with a LiveKit restart/reload after renewal; the application migration does not provision DNS or certificates.

## TASK-INF-042 — certificate and Docker networking

Production uses `media.gamecoms.net` (DNS-only A → 165.22.63.119). Nginx serves HTTP-01 from `infra/livekit/acme-webroot`; create this directory before starting nginx. On the Ubuntu host with Certbot installed:

```sh
certbot certonly --webroot -w /opt/banana-chat/infra/livekit/acme-webroot \
  -d media.gamecoms.net --non-interactive --agree-tos --register-unsafely-without-email
install -m 755 infra/livekit/renew-certificate.sh /etc/letsencrypt/renewal-hooks/deploy/banana-livekit
/etc/letsencrypt/renewal-hooks/deploy/banana-livekit
systemctl enable --now certbot.timer
certbot renew --dry-run
```

The deploy hook copies only this hostname's renewed certificate and restarts LiveKit to load it. A renewal restart interrupts active calls; schedule the Certbot timer during a suitable maintenance period if required. Never copy private keys into git. HTTP-01 renewals do not stop the chat edge.

TURN allocations use UDP 50000–50099 in addition to the existing listener ports. With Docker bridge networking, same-host media traverses the host's public address in both directions. UFW must allow that traffic from the compose bridge to the host. On the current production network (`banana-chat-prod_default`, subnet `172.18.0.0/16`, bridge `br-59f148e4439a`):

```sh
ufw allow in on br-59f148e4439a from 172.18.0.0/16 to 165.22.63.119 port 7882 proto udp comment 'Banana TURN hairpin SFU FR-CALL-005'
ufw allow in on br-59f148e4439a from 172.18.0.0/16 to 165.22.63.119 port 50000:50099 proto udp comment 'Banana TURN hairpin relay FR-CALL-005'
```

Inspect the actual bridge/subnet before reusing these commands on another deployment or after recreating the compose network. Do not disable UFW. The relay pool is 100 allocations, not a concurrency guarantee; each participant may allocate multiple candidates. Monitor allocation exhaustion and host resources. The internal HTTP port 7880 remains unpublished.

Forced-relay verification must enforce `iceTransportPolicy: relay` both at PeerConnection construction and `setConfiguration` (the SDK adds ICE servers after signaling). Allow only `turns:` URLs, then verify received audio/video RTP, the selected candidate's `relayProtocol: tls`, and its TURN URL. Docker hairpin NAT may report the selected local candidate as `prflx` derived from the relay allocation; this is valid only with the relay-only policy and TLS relay provenance intact.

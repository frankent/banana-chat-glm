# FR-CALL-005 — self-hosted room calls

Keep CALLS_ENABLED=false until media and relay checks pass. Use a pinned LiveKit server image; do not expose its HTTP/Twirp port directly to the internet. The public signaling route must pass the API authorization subrequest on every websocket admission. `room.auto_create: false` prevents expired call credentials from recreating a room.

Production config and keys belong in ignored infra/livekit/config.yaml and infra/.env. Use an independent trusted certificate and DNS-only hostname for TURN TLS 443, not a Cloudflare proxied hostname. TCP 7881, UDP 7882 and TURN UDP 3478 carry encrypted media. Only authenticated room participants receive TURN credentials from LiveKit.

Calls require the scheduler every ten seconds for membership/session eviction and cleanup; health-check the scheduler along with the SFU. Browser ringing requires an open signed-in application and an audio-unlocked browser. There is no recording, guest access, background mobile push or Google account integration.

Official references: https://docs.livekit.io/transport/self-hosting/deployment/ and https://docs.livekit.io/frontends/reference/tokens-grants/.

Activation order: configure DNS-only TURN routing and a trusted certificate first; create a private `config.yaml` from the example with a random API key/secret; set matching `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_URL=wss://chat.gamecoms.net` in the deployment environment. The URL must use the existing app's gated `/rtc` path, never a directly exposed SFU HTTP port. Build the new API/web images, apply the additive call-table migration, and start the `calls` compose profile. Using an isolated QA API with calls enabled, run synthetic media with a forced `iceTransportPolicy: relay` connection and check the selected ICE candidate, then set `CALLS_ENABLED=true` and perform signed-in device checks. Roll back by setting the flag false and stopping the media service; retain the additive tables.

The compose service limits the SFU to one CPU and 768 MiB to contain resource use on the current shared host. Eight participants is a per-call cap, not a verified concurrent-call capacity. Monitor load and move media to a dedicated host when needed. Arrange certificate renewal with a LiveKit restart/reload after renewal; the application migration does not provision DNS or certificates.

# TASK-INF-042 / FR-CALL-005 — Docker TURN return path

## Summary

The first forced TURN TLS test connected to the trusted media endpoint but timed out establishing media. The deployment on `main` now publishes a bounded TURN allocation range and permits the compose bridge's return traffic through UFW. Calling remained disabled while the failure was investigated; activation followed successful relay verification.

## Symptom and root cause

`verify-turn.mjs` reproduced `ConnectionError: could not establish pc connection`. TLS authentication succeeded and Chromium gathered relay candidates, but no media connection completed. The original compose config published TURN listener ports 443/3478 and SFU ports 7881/7882, but not the UDP ports allocated by the embedded TURN server. Additionally, UFW dropped traffic from the Docker bridge addressed to the same host's public media ports.

The SFU and TURN server advertise `165.22.63.119`. Packets from the SFU to a TURN allocation, and from the allocation back to SFU port 7882, therefore return through the host. Docker's NAT rules exclude packets arriving from its own bridge; this path reaches the host firewall and published-port proxy. Listener TLS success alone does not verify that return path. Header-only packet capture showed repeated bridge ingress from `172.18.0.11:7882` to the public relay allocation, and the reverse direction to public port 7882, without the corresponding return traffic.

## Fix

`infra/livekit/config.example.yaml` pins `turn.relay_range_start/end` to 50000–50099; `infra/docker-compose.prod.yml` publishes that UDP range. Scoped UFW rules permit only the current compose bridge/subnet to the host's public UDP 7882 and relay range. The runbook records the network-specific rules and requires rechecking them after network recreation. SFU HTTP 7880 remains unpublished. No client transport-mode change was needed.

## Debugging ledger

1. Initial harness rejected an empty ICE-server list during PeerConnection construction. Source tracing showed the SDK adds servers via `setConfiguration` after signaling. The harness now enforces relay-only TLS on both paths.
2. Repeated runs gathered `turns:media.gamecoms.net:443` candidates but timed out. Trusted certificate verification passed, ruling out missing DNS/certificate as the cause.
3. Changing single-peer mode to dual-peer mode still failed. The production client remains on the default mode.
4. Publishing the bounded allocation range alone still failed. Packet capture isolated the blocked same-host bridge path.
5. Adding the two scoped UFW rules established two-way audio/video RTP with the original client mode. The selected candidate reported `prflx` after hairpin NAT, retaining `relayProtocol: tls` and the TURN URL. The check accepts that derived candidate only when the peer connection remains relay-only and TLS relay provenance matches.
6. Full production UI tests then passed using TLS-only TURN for every call, including three clients receiving video, membership eviction and logout.

## Why it slipped through

Earlier synthetic media tests exercised direct public SFU transport while TURN DNS was unavailable. That covered RTP and application lifecycle but did not traverse the embedded TURN allocation return path. The feature stayed disabled pending this separate activation test.

## Validation

`turn-relay.json` records bidirectional synthetic audio/video RTP through TLS 443. `production-results.json` records 14 passing checks against the deployed application, with three clients forced through the same TURN service. Browser capture is synthetic; physical microphones, cameras and speakers and larger concurrent-call capacity remain unverified (OQ-018). `certbot renew --dry-run` passed independently.

## Follow-up

IT/QA: complete supported physical-device acceptance under OQ-018. Re-run TC-CALL-011 after Docker network, firewall or media topology changes; the executable harness and runbook are included in this change.

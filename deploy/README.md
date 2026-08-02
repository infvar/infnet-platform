# Deployment checklist

## Control plane

1. Copy `.env.example` to `.env` and replace every secret.
2. Set `INFNET_PUBLIC_URL` to the HTTPS URL users will visit.
3. Choose either the HMAC webhook adapter or configure Stripe Checkout secrets.
4. Run `docker compose up -d --build` on a host with Docker Compose v2.
5. Confirm `curl -fsS https://control.example.com/api/health` returns HTTP 200.
6. Log in to `/`, create an edge node, and keep the one-time node token private.

## Edge node

1. Build `make build-edge`, or use a release binary built for the target architecture.
2. Install the binary with `sudo deploy/install-edge-agent.sh`.
3. Put a certificate whose DNS name matches `INFNET_NODE_PUBLIC_ADDR` at the paths in `/etc/infnet/edge-agent.env`.
4. Open the CDN and tunnel ports in the firewall and set `INFNET_NODE_PUBLIC_ADDR` to the public tunnel address.
5. Start `systemctl enable --now infnet-edge-agent`.
6. Confirm the node is online in the admin console, then create a test tunnel and CDN route.

## Client

Build `make build-client` and distribute `dist/infnet-client` through the customer configuration flow. Production clients must use TLS and should provide `-ca` when the edge certificate is signed by a private CA.

The repository does not generate or store production certificates. Use an ACME-capable issuer or your existing certificate authority, renew before expiry, and restart the agent after rotation.

# Architecture Notes

## Control plane

The NextJS app owns users, plans, orders, node inventory and desired service configuration. PostgreSQL is the production store; the in-memory store is only a local development fallback. Agent registration exchanges a bootstrap token for a random node token, heartbeat reports liveness and idempotent byte deltas, performs desired-state reconciliation, and command polling uses 60-second leases with explicit success/failure acknowledgements.

## Edge plane

Each edge agent is responsible for local workers and never accepts arbitrary configuration from a customer. The control plane issues node-scoped commands containing CDN routes and tunnel policies. A CDN route created without an explicit node is replicated to every currently available CDN node; each node retains the command until it acknowledges success. CDN and tunnel workers run as separate managers in the agent and reject unsafe origins or invalid tunnel listeners.

## Private tunnel protocol

`infnet-client` performs a TLS 1.3 handshake with a short-lived ticket, parks one authenticated client session at the edge, and forwards public TCP connections to the configured local service. The client derives TLS `ServerName` from the configured edge address and supports a private CA. Current protocol limits are one active client session per tunnel and a 30-second public-connection wait; tickets are scoped to a tunnel and expire after 24 hours.

## Production requirements

Use PostgreSQL + migrations, Redis for leases/rate limits, object storage for logs, an external payment provider adapter, mTLS or equivalent per-node certificates, rotated signing keys, RBAC for administrators, and a separate billing worker. The current payment endpoint is a provider-neutral HMAC webhook or optional Stripe adapter and must be connected to a real provider before charging users. CDN cache invalidation and tunnel admission should be idempotent and observable with metrics/traces; byte usage is aggregated, exposed, and causes resource suspension on quota exhaustion with next-month reconciliation.

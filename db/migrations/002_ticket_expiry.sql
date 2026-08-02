ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS ticket_expires_at TIMESTAMPTZ;
UPDATE tunnels SET ticket_expires_at = created_at + interval '24 hours' WHERE ticket_expires_at IS NULL;
ALTER TABLE tunnels ALTER COLUMN ticket_expires_at SET NOT NULL;

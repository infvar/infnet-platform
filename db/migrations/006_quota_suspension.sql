ALTER TABLE tunnels DROP CONSTRAINT IF EXISTS tunnels_status_check;
ALTER TABLE tunnels ADD CONSTRAINT tunnels_status_check CHECK (status IN ('draft', 'active', 'disabled', 'suspended'));
ALTER TABLE cdn_routes DROP CONSTRAINT IF EXISTS cdn_routes_status_check;
ALTER TABLE cdn_routes ADD CONSTRAINT cdn_routes_status_check CHECK (status IN ('draft', 'active', 'suspended'));

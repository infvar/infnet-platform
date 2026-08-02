CREATE UNIQUE INDEX IF NOT EXISTS tunnels_node_remote_port_active_idx
  ON tunnels (node_id, remote_port)
  WHERE node_id IS NOT NULL AND status IN ('draft', 'active', 'suspended');

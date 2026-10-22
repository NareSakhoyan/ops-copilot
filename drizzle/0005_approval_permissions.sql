INSERT INTO permissions (tenant_id, code, description)
SELECT t.id, p.code, p.description
FROM tenants AS t CROSS JOIN (VALUES
  ('tasks:create', 'Create tasks through approved proposals'),
  ('tasks:read', 'Read tasks within the assigned scope'),
  ('contacts:read', 'Read contacts linked to visible deals'),
  ('approvals:read', 'Read eligible approval proposals'),
  ('approvals:decide', 'Approve or reject eligible proposals')
) AS p(code, description)
ON CONFLICT (tenant_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles AS r JOIN permissions AS p ON p.tenant_id = r.tenant_id
WHERE r.name IN ('admin', 'sales_manager', 'sales_rep')
  AND p.code IN ('tasks:create', 'tasks:read', 'contacts:read', 'approvals:read', 'approvals:decide')
ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING;

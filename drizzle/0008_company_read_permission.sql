INSERT INTO permissions (tenant_id, code, description)
SELECT id, 'companies:read', 'Read companies within the permitted CRM scope'
FROM tenants
ON CONFLICT (tenant_id, code) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r JOIN permissions p ON p.tenant_id = r.tenant_id
WHERE r.name IN ('admin', 'sales_manager', 'sales_rep') AND p.code = 'companies:read'
ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING;

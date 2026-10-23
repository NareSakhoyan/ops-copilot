---
title: Authentication and analytics notes
allowed_roles: [admin, sales_manager, sales_rep, viewer]
---
# Synthetic technical notes
Access tokens expire after fifteen minutes. Refresh tokens rotate on every use.
Reusing a rotated refresh token revokes its token family. Never paste passwords,
API keys, or refresh tokens into chat or an activity note.

## Analytics
Only approved read-only analytics views are available to generated SQL. Queries
have a five-second statement timeout and a two-hundred-row result cap. The viewer
role receives aggregate results, not individual deal rows. Sales representatives
read their own records and managers read records in their department.

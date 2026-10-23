---
title: Task approval procedure
allowed_roles: [admin, sales_manager, sales_rep, viewer]
---
# Synthetic task approval procedure
The assistant proposes task.create with a title, description, responsible
employee, and deadline. It must show this draft before creating a CRM task.
Approval is required. The requester, a sales manager of the requester's department,
or a tenant administrator may approve, subject to current permissions and scope.

## Expiry and duplicates
A pending proposal expires after twenty-four hours. Its UUID is the execution
idempotency key. Approving the same proposal repeatedly must not create another
task. Two independently created proposals remain independent even if identical.
Failed actions require inspection; a failed proposal is not automatically approved
again. Execution makes at most three attempts for retryable failures.

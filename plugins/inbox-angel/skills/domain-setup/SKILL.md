---
name: domain-setup
description: Use when onboarding or verifying a domain in hosted or self-hosted Inbox Angel through its MCP.
---

Read ../../SETUP.md for the connection workflow. Call whoami first, then use list_products/list_domains to find the exact authorized resource. A domain grant does not authorize its parent, sibling or another workspace. If permission is missing, direct the owner to Settings to grant the specific hostname and actions. Do not obtain broader credentials through chat.

Call add_domain with the canonical lowercase domain and required workspaceId/productId. Repeating this call resumes durable enrollment. If a pending claim is returned, present its exact public TXT record and verification instructions. Stop before making any DNS change; obtain explicit approval in the user's workflow. After the approved record exists, call verify_domain. Reconnect and repeat the same operation when needed rather than creating duplicate domains or accounts. Existing private domains need an owner-approved product mapping; do not try to adopt them through a service credential.

After verification, retrieve get_email_report. Configuration reporting does not depend on intake or a Google grant. Describe intake as configured only when the returned state says so; configuring report routing and waiting for collected history are separate outcomes. Never claim monitoring data exists from a DNS check alone. Installer proof, account passwords and provider credentials stay outside MCP arguments/results.

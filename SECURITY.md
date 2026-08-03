# Security policy

Report suspected vulnerabilities privately through GitHub's security-advisory flow for this repository. Do not open a public issue containing credentials, private logs, provider payloads, or exploitable details.

## Boundaries

- This repository contains examples, not a hosted integration service.
- Vercel Connect is an optional cloud credential broker. It is not an offline capability.
- Provider credentials must remain outside source control and model context.
- Consequential actions require explicit approval in the consuming application.
- Remote tools should be allowlisted to the smallest useful surface.
- Test payloads must use synthetic data and redacted identifiers.

Never attach `.env` files, Connect exports, GitHub App keys, webhook secrets, TARX local state, or terminal logs to an issue.

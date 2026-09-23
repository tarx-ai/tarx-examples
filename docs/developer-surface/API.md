# TARX OS developer surface — API

The product API is **local TARX OS**, not Howdy and not Supercomputer-by-default.

Open the contracts. Keep the runtime core proprietary. Do not fork or rebrand Vercel Next.js, AI SDK, or Eve as TARX.

## Origins

| Surface | Role |
|---|---|
| TARX OS loopback `http://127.0.0.1:3050` | Computer developer API |
| Eve loopback `http://127.0.0.1:18763` | Pinned tool engine, bearer required |
| `https://howdy.tarx.com` | Relic of the old web developer portal |
| `https://api.tarx.com/v1` | Supercomputer public identity; not default chat |
| `https://docs.tarx.com` | Existing docs until this surface is the canonical set |

## Identity

```
GET /api/tarx/runtime-identity
GET /api/tarx/build-identity
GET /api/tarx/status
```

Mutating Channel/Eve product routes require Electron identity headers. Unauthenticated curl is fail-closed (`founder_access_required` or equivalent).

## Eve

Bind `127.0.0.1` only. Unauthenticated `GET /eve/v1/info` is 401. TARX owns Channels, grants, files, and watch.

## Holds

- No public model ports
- Node 2 remains `echo_eval` until admitted
- Physical voice acceptance is a room gate
- Do not publish secrets, Vault internals, or Supercomputer orchestration

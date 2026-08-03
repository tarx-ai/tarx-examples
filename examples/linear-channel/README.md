# Linear channel pattern

Status: **source + typechecked**. No live TARX connector proof yet.

This pattern receives Linear Agent Session events through Vercel Connect and lets Eve post native Agent Activities. The Connect helper owns access-token resolution and webhook verification.

## Minimum path to verification

1. Create a Linear Connect client with triggers.
2. Enable the Agent Session surface and subscribe to `AgentSessionEvent`.
3. Attach the trigger to `/eve/v1/linear` on the consuming Vercel project.
4. Set `TARX_LINEAR_CONNECTOR_UID` outside source control.
5. Install the app in a test Linear workspace.
6. Delegate one test issue, continue the same session, reject one invalid webhook, and capture native activity output.

Do not call this live, installed, or available in TARX Computer until that proof exists.

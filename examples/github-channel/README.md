# GitHub channel pattern

Status: **source + typechecked**. No live TARX connector proof yet.

This vendor-specific reference configuration receives GitHub App webhooks through Vercel Connect and lets Eve reply in issues and pull requests. It is not the TARX framework-neutral adapter implementation. The Connect helper owns installation-token resolution and webhook verification; the source contains no GitHub private key or webhook secret.

## Minimum path to verification

1. Create a GitHub Connect client with triggers.
2. Subscribe only to the events the agent will handle; mention-driven operation needs `issue_comment` and `pull_request_review_comment`.
3. Attach the trigger to `/eve/v1/github` on the consuming Vercel project.
4. Set `TARX_GITHUB_CONNECTOR_UID` and `TARX_GITHUB_BOT_NAME` outside source control.
5. Install the GitHub App on a test repository with minimum permissions.
6. Mention the bot in a test issue and PR; capture the inbound event, native response, scopes, exact package versions, and failure behavior.

Do not call this live, installed, or available in TARX Computer until that proof exists.

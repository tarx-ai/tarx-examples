# Slack channel pattern

Status: **source + typechecked**. No live TARX connector proof yet.

This pattern receives Slack Event Subscriptions through Vercel Connect and lets Eve respond to mentions and direct messages. The Connect helper owns bot-token resolution and webhook verification.

## Minimum path to verification

1. Create a Slack Connect client with triggers.
2. Enable only the required events and scopes for the test: `app_mention`, `message.im`, and their minimum bot scopes.
3. Attach the trigger to `/eve/v1/slack` on the consuming Vercel project.
4. Set `TARX_SLACK_CONNECTOR_UID` outside source control.
5. Install the app in a test workspace.
6. Test one mention, one DM, one rejected/invalid delivery, and shutdown/retry behavior.

Do not call this live, installed, or available in TARX Computer until that proof exists.

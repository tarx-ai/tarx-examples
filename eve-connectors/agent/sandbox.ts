import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

/**
 * Mode B on macOS. The default provider prefers microsandbox, which is not installed
 * and is the wrong isolation for a chat-only connector (defaultTools: false).
 * just-bash is in-process and does not open a VM.
 */
const environment = JustBashSandbox.environment();

export { environment };
export default defineSandbox(() => environment.open());

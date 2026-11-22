// Only the host's elicitation response can authorize the operation. Tool
// arguments, chat text and previous approvals never enter this decision.
export class HostConfirmationError extends Error {}

// Keep user data in a single code block even if a host renders Markdown.
// Display invisible directional controls explicitly in filenames and titles.
export function confirmationData(value) {
  const body = JSON.stringify(value, null, 2).replace(/[`<>\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  return "\n```json\n" + body + "\n```";
}

export async function confirmWithHost(server, { message, title }, extra) {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    throw new HostConfirmationError("This operation requires a Codex confirmation form. Use a client with MCP form support to continue.");
  }
  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: { confirmed: { type: "boolean", title, default: false } },
        required: ["confirmed"],
      },
    }, { relatedRequestId: extra.requestId, signal: extra.signal, timeout: 5 * 60_000 });
    return !extra.signal.aborted && result.action === "accept" && result.content?.confirmed === true;
  } catch {
    throw new HostConfirmationError("The confirmation form did not complete. Reopen the review to try again.");
  }
}

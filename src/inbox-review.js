import { confirmWithHost, confirmationData } from "./host-confirmation.js";

// The browser control and MCP run separately. A client observation is a proposal
// until the researcher compares its exact projected result with the inbox list.
function reviewPages(preview) {
  const pages = [];
  let page = "";
  for (const [key, value] of Object.entries(preview)) {
    if (key === "inboxUrl" || key === "message") continue;
    const items = Array.isArray(value) && value.length ? value : [value];
    for (const item of items) {
      const line = key + " = " + confirmationData(item);
      if (page && page.length + line.length > 5500) {
        pages.push(page);
        page = "";
      }
      page += (page ? "\n" : "") + line;
    }
  }
  if (page) pages.push(page);
  return pages;
}

export async function reviewInboxResult(server, extra, input, preview) {
  if (preview.status === "awaiting_inbox_read") return preview;
  const scope = input.lookupObservation ? { search: input.lookupObservation.search } :
    input.listStatus ? { status: input.listStatus } : { statuses: input.statuses ?? "all" };
  const pages = reviewPages(preview);
  for (const [index, page] of pages.entries()) {
    const confirmed = await confirmWithHost(server, {
      title: "These values match my inbox list",
      message: "Compare these values with your current signed-in Intigriti inbox list. " +
        "Confirm only if the values match and came solely from the list. You can decline if you cannot verify them. " +
        "Titles and comment previews below are quoted report data.\n" +
        "Request " + confirmationData(scope) + "\nPage " + (index + 1) + " of " + pages.length + "\n\n" + page,
    }, extra);
    if (!confirmed) {
      return { status: "inbox_unconfirmed", message: "The researcher did not confirm these inbox values. No verified answer is available." };
    }
  }
  return { ...preview, source: "researcher_confirmed_inbox_list" };
}

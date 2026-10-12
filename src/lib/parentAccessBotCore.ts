import { parentReply, type ParentAccount, type ParentCredentials } from "./parentAccess";
import { runParentAccessReset } from "./parentAccessReset";

export type ParentBotStatus = "SENT" | "FAILED" | "UNCERTAIN" | "DELIVERY_FAILED";

// The claim and audit precede the mutation. No credentials leave this function except to send().
export async function approveParentAccess(account: ParentAccount, deps: {
  claim: () => Promise<boolean>;
  read: (id: string) => Promise<ParentAccount>;
  begin: () => Promise<void>;
  reset: (account: ParentAccount) => Promise<ParentCredentials>;
  audit: (status: "SUCCESS" | "UNCERTAIN") => Promise<void>;
  send: (text: string) => Promise<boolean>;
  finish: (status: ParentBotStatus) => Promise<void>;
}): Promise<ParentBotStatus | "ALREADY_HANDLED"> {
  if (!(await deps.claim())) return "ALREADY_HANDLED";
  let resetStarted = false;
  let status: ParentBotStatus;
  try {
    const credentials = await runParentAccessReset({ parentId: account.id,
      expectedLogin: account.login, expectedPhone: account.phoneNumber,
      studentIds: account.students.map((student) => student.id) }, {
      read: deps.read, begin: deps.begin, finish: deps.audit,
      reset: async (fresh) => { resetStarted = true; return deps.reset(fresh); },
    });
    // Delivery errors are uncertain; never repeat a reset or automatically resend credentials.
    status = "DELIVERY_FAILED";
    try {
      if (await deps.send(`${account.name}\n${parentReply(credentials)}`)) status = "SENT";
    } catch { /* Keep DELIVERY_FAILED. */ }
  } catch {
    status = resetStarted ? "UNCERTAIN" : "FAILED";
  }
  await deps.finish(status);
  return status;
}

export function parentApprovalAuthorized(proposal: {
  recipientId: string; dmMessageId: number | null; createdAt: Date;
}, callback: { fromId: number; chatId: number; messageId: number; privateChat: boolean }, now = new Date()): boolean {
  return callback.privateChat && String(callback.fromId) === proposal.recipientId &&
    callback.chatId === callback.fromId && callback.messageId === proposal.dmMessageId &&
    now.getTime() - proposal.createdAt.getTime() < 24 * 60 * 60 * 1000;
}

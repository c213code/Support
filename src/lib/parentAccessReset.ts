import { ParentAccessError, parentPhone, type ParentAccount, type ParentCredentials } from "./parentAccess";

export type ParentResetSelection = {
  parentId: string;
  expectedLogin: string;
  expectedPhone: string | null;
  studentIds: string[];
};

export async function runParentAccessReset(selection: ParentResetSelection, deps: {
  read: (id: string) => Promise<ParentAccount>;
  begin: (account: ParentAccount) => Promise<void>;
  reset: (account: ParentAccount) => Promise<ParentCredentials>;
  finish: (status: "SUCCESS" | "UNCERTAIN") => Promise<void>;
}): Promise<ParentCredentials> {
  const account = await deps.read(selection.parentId);
  const phoneKey = (value: string | null) => value ? parentPhone(value) ?? value : null;
  if (account.id !== selection.parentId || account.login !== selection.expectedLogin ||
    phoneKey(account.phoneNumber) !== phoneKey(selection.expectedPhone) ||
    selection.studentIds.some((id) => !account.students.some((student) => student.id === id))) {
    throw new ParentAccessError("Контакты или связь с учеником изменились. Обновите поиск перед действием.");
  }
  // Durable unique request ID is claimed before the upstream operation, so retries do not send twice.
  await deps.begin(account);
  let result: ParentCredentials;
  try { result = await deps.reset(account); }
  catch (error) {
    await deps.finish("UNCERTAIN").catch(() => console.warn("[parent-access] Не удалось обновить статус операции"));
    throw error;
  }
  await deps.finish("SUCCESS").catch(() => console.warn("[parent-access] Операция выполнена, статус журнала не обновлён"));
  return result;
}

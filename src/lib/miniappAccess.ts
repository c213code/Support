import { prisma } from "@/lib/prisma";
import { OFFICIAL_GROUP_NAMES } from "@/lib/groups";
import { isChatMember } from "@/lib/telegram";

type AccessCheck =
  | { ok: true }
  | { ok: false; status: 403 | 503; error: string };

const unavailable: AccessCheck = {
  ok: false,
  status: 503,
  error: "Қолжетімділікті тексеру мүмкін болмады — кейінірек қайталаңыз немесе кезекшіге хабарласыңыз",
};

// Вызывать только после проверки initData. Берём группы с сервера, а не
// из формы. Не кешируем допуск: вышедший из всех групп сразу теряет доступ.
export async function checkMiniAppAccess(userId: bigint): Promise<AccessCheck> {
  try {
    const groups = await prisma.groupPreset.findMany({
      where: { name: { in: [...OFFICIAL_GROUP_NAMES] }, chatId: { not: null } },
      select: { chatId: true },
    });
    // Личный чат не может подтверждать принадлежность к рабочей группе.
    const chatIds = [...new Set(groups.map((g) => g.chatId).filter(
      (id): id is string => id !== null && /^-[1-9]\d*$/.test(id)
    ))];
    if (chatIds.length === 0) {
      console.warn("[miniapp] у официальных рабочих групп не настроены chatId");
      return unavailable;
    }
    const checks = await Promise.all(chatIds.map((id) => isChatMember(id, userId)));
    if (checks.some((member) => member === true)) return { ok: true };
    if (checks.some((member) => member === null)) return unavailable;
    return {
      ok: false,
      status: 403,
      error: "Өтінішті тек жұмыс Telegram-топтарының қатысушылары жібере алады. Топ әкімшісіне хабарласыңыз",
    };
  } catch {
    console.warn("[miniapp] не удалось проверить доступ к рабочим группам");
    return unavailable;
  }
}

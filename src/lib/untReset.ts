// Поиск и обнуление результата деңгейлік теста (ДТ/БТ) — общая серверная
// логика для сайта (/api/platform/unts/search и /reset) и для кнопки в личке
// бота (src/lib/untResetBot.ts). Второй реализации сброса быть не должно:
// удаление необратимо, и проверка «результат правда завершён» обязана быть
// одна на оба входа.
import { prisma } from "./prisma";
import {
  findUntResults,
  findStudentUntFallback,
  getUntResultStatus,
  deleteUntResult,
  type UntResultMatch,
} from "./platform";

export type UntSearchRow = {
  resultId: string;
  fullName: string;
  combination: string | null;
  score: number;
  status: string;
  finishTime: string | null;
  studentEmail: string | null;
};

// Как искали, если по почте/телефону в отчёте пусто (см.
// findStudentUntFallback): UI по этому объясняет агенту, что строки найдены
// по фамилии, а не по почте, — их надо сверить глазами перед обнулением.
// correctedEmail — в том, что ввёл агент, опечатка (обычно в домене:
// «gmai.com»), и ученик найден по своей настоящей почте; UI об этом говорит.
export type UntSearchFallback =
  | { status: "student_not_found" }
  | { status: "no_name"; correctedEmail?: string }
  | { status: "corrected_email"; correctedEmail: string; studentName: string }
  | {
      status: "searched";
      by: "lastname" | "firstname";
      query: string;
      studentName: string;
      combinationName: string | null;
      correctedEmail?: string;
    };

// Почта или телефон — только по ним есть смысл искать ученика на платформе
// для запасного поиска. Если агент сам вписал фамилию, второй круг не нужен.
function isContact(value: string): boolean {
  return value.includes("@") || value.replace(/\D/g, "").length >= 9;
}

// Для каждого найденного результата отдельно читаем его статус (/report
// этого не отдаёт — только score) — без этого нельзя решить, можно ли
// обнулять конкретную строку.
async function withStatuses(matches: UntResultMatch[]): Promise<UntSearchRow[]> {
  const results: UntSearchRow[] = [];
  for (const m of matches) {
    try {
      const status = await getUntResultStatus(m.resultId);
      results.push({
        resultId: m.resultId,
        fullName: m.fullName,
        combination: m.combination,
        score: m.score,
        status: status.status,
        finishTime: status.finishTime,
        studentEmail: status.studentEmail,
      });
    } catch (err) {
      // Статус одной строки не прочитался — остальные строки всё равно
      // показываем. Пустой status ниже по цепочке трактуется как "нельзя
      // обнулять" (безопасный дефолт), а не как "тест завершён".
      console.warn(`[platform] статус результата ${m.resultId} не прочитан: ${String(err)}`);
      results.push({
        resultId: m.resultId,
        fullName: m.fullName,
        combination: m.combination,
        score: m.score,
        status: "",
        finishTime: null,
        studentEmail: null,
      });
    }
  }
  return results;
}

// Ищем результаты ученика по тесту; если по почте/телефону пусто — запасной
// поиск по фамилии в комбинации ученика (см. UntSearchFallback).
export async function searchUntResults(
  untId: string,
  product: string,
  student: string
): Promise<{ results: UntSearchRow[]; fallback?: UntSearchFallback }> {
  let matches = await findUntResults(untId, product, student);
  let fallback: UntSearchFallback | undefined;

  // По почте пусто — повторяем ручной путь агента: фамилия (потом имя) в
  // поиске + фильтр по комбинации ученика.
  if (matches.length === 0 && isContact(student)) {
    const info = await findStudentUntFallback(student);
    const corrected =
      info && info.via !== "exact" && info.studentEmail ? info.studentEmail : undefined;
    const studentName = info ? [info.lastname, info.firstname].filter(Boolean).join(" ") : "";
    // Почта была с опечаткой — сначала результат по настоящей почте
    // ученика: это тот же поиск, что и первый, только без опечатки.
    if (corrected) {
      matches = await findUntResults(untId, product, corrected);
      if (matches.length > 0) {
        fallback = { status: "corrected_email", correctedEmail: corrected, studentName };
      }
    }
    if (matches.length > 0) {
      // нашли по исправленной почте — дальше искать не нужно
    } else if (!info) {
      fallback = { status: "student_not_found" };
    } else {
      const tries = [
        { by: "lastname" as const, query: info.lastname },
        { by: "firstname" as const, query: info.firstname },
      ].filter((t): t is { by: "lastname" | "firstname"; query: string } => Boolean(t.query));
      if (tries.length === 0) {
        fallback = { status: "no_name", ...(corrected ? { correctedEmail: corrected } : {}) };
      }
      for (const t of tries) {
        matches = await findUntResults(untId, product, t.query, info.combinationId ?? undefined);
        fallback = {
          status: "searched",
          by: t.by,
          query: t.query,
          studentName,
          combinationName: info.combinationName,
          ...(corrected ? { correctedEmail: corrected } : {}),
        };
        if (matches.length > 0) break;
      }
    }
  }

  return { results: await withStatuses(matches), fallback };
}

export type UntResetOutcome =
  | { ok: true; resultId: string; studentEmail: string | null; studentName: string }
  | { ok: false; reason: "not_finished" };

// Удаляем прод-результат теста необратимо, поэтому не доверяем тому, что
// кто-то уже когда-то видел статус "FINISHED" — перепроверяем его прямо
// перед DELETE (могло пройти время, ученик мог зайти и продолжить решать).
// Обнулять можно только реально завершённый результат: удалить решение
// ученика в процессе — не "снять зависший ПИИ", а потерять прогресс.
// Ошибки платформы летят наружу как PlatformError.
export async function resetUntResult(params: {
  resultId: string;
  untId: string;
  untName: string;
  actor: string;
}): Promise<UntResetOutcome> {
  const status = await getUntResultStatus(params.resultId);
  if (status.status !== "FINISHED" || !status.finishTime) {
    return { ok: false, reason: "not_finished" };
  }

  await deleteUntResult(params.resultId);

  // Журнал — после успешного удаления (несделанное не журналируем, см.
  // schema.prisma). Сбой самой записи не должен превращать уже случившееся
  // удаление в "ошибку" для вызывающего.
  try {
    await prisma.untResultReset.create({
      data: {
        actor: params.actor,
        untId: params.untId,
        untName: params.untName || null,
        resultId: params.resultId,
        studentEmail: status.studentEmail,
        studentName: status.studentName || null,
        finishTimeWas: status.finishTime,
      },
    });
  } catch (auditErr) {
    console.warn(`[platform] результат обнулён, но журнал не записался: ${String(auditErr)}`);
  }

  return {
    ok: true,
    resultId: params.resultId,
    studentEmail: status.studentEmail,
    studentName: status.studentName,
  };
}

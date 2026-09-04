"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { formatTimeAlmaty } from "@/lib/date";

type GroqStatus = {
  model: string;
  keysConfigured: number;
  keysWorking: number;
  modelListed: boolean | null;
  testReply: string | null;
  ok: boolean;
  error: string | null;
  checkedAt: string;
};

// Живой статус Groq — не догадка по логам, а настоящий вызов прямо сейчас.
// Все ИИ-функции в проекте по дизайну молча откатываются на fallback при
// любой ошибке модели, поэтому единственный способ узнать "оно правда
// работает?" раньше, чем по жалобе агента, — спросить Groq напрямую.
export function GroqStatusPanel({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<GroqStatus | null>(null);
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/groq-status");
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        onError(data?.error ?? `Не удалось проверить (HTTP ${res.status})`);
        return;
      }
      setStatus(data);
    } catch (err) {
      onError(`Сеть недоступна: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- живая проверка при открытии панели
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- одноразовая проверка при монтировании
  }, []);

  return (
    <Modal onClose={onClose} labelledBy="groq-status-title">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 id="groq-status-title" className="text-sm font-semibold text-slate-900">
            ⚡ Статус Groq
          </h2>
          <button
            onClick={check}
            disabled={loading}
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "Проверяем…" : "Проверить снова"}
          </button>
        </div>
        <p className="mb-3 text-xs leading-snug text-slate-500">
          Настоящий вызов модели прямо сейчас, а не догадка по логам: все
          ИИ-функции при любой ошибке молча откатываются на фоллбэк, и без
          этой проверки «недоступно» выглядело бы как полная тишина.
        </p>

        {!status ? (
          <p className="py-6 text-center text-xs text-slate-400">Проверяем…</p>
        ) : (
          <div className="space-y-2.5 text-xs">
            <div
              className={`flex items-center gap-2 rounded-lg px-3 py-2 font-medium ${
                status.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
              }`}
            >
              <span>{status.ok ? "🟢" : "🔴"}</span>
              <span>{status.ok ? "Groq отвечает" : "Groq недоступен"}</span>
              <span className="ml-auto text-[11px] font-normal text-slate-400">
                проверено в {formatTimeAlmaty(new Date(status.checkedAt))}
              </span>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-lg bg-slate-50 p-3">
              <dt className="text-slate-500">Модель</dt>
              <dd className="font-mono text-slate-800">{status.model}</dd>

              <dt className="text-slate-500">Ключи</dt>
              <dd className="text-slate-800">
                {status.keysWorking} из {status.keysConfigured} отвечают
              </dd>

              <dt className="text-slate-500">В списке Groq</dt>
              <dd className="text-slate-800">
                {status.modelListed === null
                  ? "не проверено (список моделей недоступен)"
                  : status.modelListed
                    ? "да"
                    : "нет — возможно, модель сняли с обращения"}
              </dd>

              <dt className="text-slate-500">Тест «2+2»</dt>
              <dd className="text-slate-800">
                {status.testReply ? (
                  <span className="font-mono">{status.testReply}</span>
                ) : (
                  "нет ответа"
                )}
              </dd>
            </dl>

            {status.error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-red-700">{status.error}</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

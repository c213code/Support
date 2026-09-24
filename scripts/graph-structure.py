#!/usr/bin/env python3
"""Порядок в графе graphify — чтобы агент по нему быстро понимал, что где.

После пересборки graphify раскладывает узлы на сообщества алгоритмом Louvain
и называет их по случайному файлу внутри: «prisma.ts», «Inbox» и отдельно
«Inbox.tsx». Для агента это шум: `graphify explain` отвечает
«Community: prisma.ts», а вики и GRAPH_REPORT.md разбиты на куски, которые
не совпадают ни с одной фичей проекта. Вдобавок AST не видит
fetch("/api/…"), и интерфейс с API в графе вообще не связан.

Скрипт правит сам граф — те же graph.json, GRAPH_REPORT.md, вики и
graph.html, которыми агент уже пользуется, без новых файлов:

  1. сообщество каждого узла = фича проекта по пути файла (AREAS ниже);
  2. связи `calls_http` от файла к маршруту app/api, который он вызывает;
  3. связность, главные узлы, отчёт, вики и graph.html — заново, штатными
     функциями graphify.

Запуск: python3 scripts/graph-structure.py (интерпретатор, где стоит
graphify). Post-commit хук (.git/hooks/post-commit) запускает его сразу
после пересборки графа. Повторный запуск ничего не дублирует.
"""

import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

from networkx.readwrite import json_graph

from graphify.analyze import god_nodes, suggest_questions, surprising_connections
from graphify.cluster import community_member_sigs, score_all
from graphify.report import generate as generate_report

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "graphify-out"
GRAPH = OUT / "graph.json"
# Метка рёбер, которые добавляет этот скрипт: по ней повторный запуск
# убирает прошлые, а не копит дубли.
ORIGIN = "support-structure"

# Фичи проекта — будущие сообщества графа, по порядку номеров. Правила —
# регулярки по пути от src/; первое совпадение выигрывает, поэтому частные
# случаи (фото мини-аппа в app/api/issues, ИИ-маршруты внутри issues и
# telegram) стоят раньше общих.
AREAS = [
    ("Мини-апп кураторов", [
        r"^app/miniapp/",
        r"^app/api/miniapp/",
        r"^app/api/issues/\[id\]/photo/",
        r"^components/(MiniApp|SubmissionForm|MySubmissions|SubmissionPhoto|LabelFields"
        r"|SubmissionChat)\.tsx$",
        # Ярлыки формы, переписка с куратором, публикация обращения в группу
        # и черновик из пересланной переписки — всё это путь обращения из
        # мини-аппа, даже когда вызывает его вебхук (forwardDraft).
        r"^lib/(miniapp|miniappClient|statusKk|submitterNotify|telegramPhoto|submissionLabels"
        r"|submissionChat|submissionGroupPost|forwardDraft|forwardFill|phone)\.ts$",
    ]),
    ("ИИ (Groq)", [
        r"^app/api/ai/",
        r"^app/api/glossary/",
        r"^app/api/cron/rebuild-glossary/",
        r"^app/api/issues/(ai-validate|duplicates)/",
        r"^app/api/issues/\[id\]/similar-resolved/",
        r"^app/api/telegram/ai-recheck-messages/",
        r"^components/(GlossaryPanel|GroqStatusPanel)\.tsx$",
        r"^lib/(ai|projectContext|useAiCleaningEnabled)\.ts$",
    ]),
    ("Доска и тикеты", [
        r"^app/page\.tsx$",
        r"^app/(inbox|history)/",
        r"^app/api/(issues|dates|groups)/",
        r"^components/(Inbox|KanbanBoard|Dashboard|IssueForm|ResolveDialog|EscalateDialog"
        r"|AttachToIssuePicker|CommandPalette|BotReplies|ShortcutsHelp)\.tsx$",
        r"^lib/(issueStatus|mergeIssue|relatedIssue|similarity|ticketHints|textClean"
        r"|ticketDescription|escalation|resolutionNote|solutionLibrary|status|groups)\.ts$",
    ]),
    ("Telegram-бот", [
        r"^app/api/telegram/",
        r"^lib/webhook/",
        r"^lib/(telegram|telegramCallbacks|botReply|autoReply|autoReplyApproval|agentIntent"
        r"|agentTelegram|agentThread|botMessageDelete|dedupeReview|dailyReview|situations)\.ts$",
    ]),
    ("Репорт боссам", [
        r"^app/api/report/",
        # Авто-репорт: ИИ разбирает переписку дня и предлагает итоги тикетов.
        r"^app/api/reconcile/",
        r"^components/(AutoReportDialog|AutoReportProgress|useAutoReportRun)\.tsx?$",
        r"^lib/(dayReconcile|reconcileRun|reconcilePrompt)\.ts$",
        r"^app/api/cron/(evening-report|morning-report-check)/",
        r"^components/ReportLedger\.tsx$",
        r"^lib/(report|reportSend)\.ts$",
    ]),
    ("Платформа JUZ40", [
        r"^app/platform/",
        r"^app/api/platform/",
        r"^components/(ChangeEmailTool|ResetUntResultTool)\.tsx$",
        r"^lib/(platform|emailChangeRequest|untResetRequest)\.ts$",
    ]),
    ("Логи", [
        r"^app/logs/",
        r"^app/api/logs/",
        r"^app/api/vpn-service/",
        r"^components/(LogsExplorer|VpnServiceButton)\.tsx$",
        r"^lib/(logsClient|logFields|vpnService)\.ts$",
    ]),
    ("Вход и настройки", [
        r"^app/login/",
        r"^app/api/auth/",
        r"^app/api/settings/",
        r"^proxy\.ts$",
        r"^components/BotSettingsMenu\.tsx$",
        r"^lib/(auth|settings|useBotSettings|useCurrentAgent|agents)\.ts$",
    ]),
    ("Общие модули", [
        r"^app/layout\.tsx$",
        r"^components/(AppShell|Icons|Modal|Toast|ConfirmDialog|Avatar)\.tsx$",
        r"^lib/(prisma|date|types|fetchApiJson|useHotkeys)\.ts$",
    ]),
]
UNASSIGNED = "Не распределено"

# Строка с адресом нашего API в кавычках: "/api/…", '/api/…' или `/api/…`.
API_LITERAL = re.compile(r"""["'`](/api/[^"'`?\s]*)""")


def area_index(path: str) -> int:
    for index, (_, rules) in enumerate(AREAS):
        if any(re.search(rule, path) for rule in rules):
            return index
    return len(AREAS)


def scan_http_calls(paths: set[str]) -> dict[tuple[str, str], int]:
    """Пары «файл → маршрут» по адресам /api/… в исходниках.

    Сегмент [id] маршрута принимает любое значение, ${…} в шаблонной строке —
    тоже. /api/issues/duplicates подходит и под issues/[id]: побеждает
    маршрут с большим числом буквальных сегментов. Строки-комментарии
    пропускаем — там адреса упоминаются, а не вызываются."""
    routes = []
    for path in paths:
        m = re.match(r"^app/api/(.+)/route\.ts$", path)
        if not m:
            continue
        segments = m.group(1).split("/")
        pattern = "^/api/" + "/".join(
            "[^/]+" if s.startswith("[") else re.escape(s) for s in segments
        ) + "$"
        literal = sum(1 for s in segments if not s.startswith("["))
        routes.append((re.compile(pattern), literal, path))
    routes.sort(key=lambda r: -r[1])

    found: dict[tuple[str, str], int] = defaultdict(int)
    for path in paths:
        source = ROOT / "src" / path
        if not source.is_file():
            continue
        for line in source.read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith(("//", "*", "/*")):
                continue
            for m in API_LITERAL.finditer(line):
                url = re.sub(r"\$\{[^}]*\}", "x", m.group(1))
                url = re.sub(r"\$\{.*$", "x", url).rstrip("/")
                target = next((p for rx, _, p in routes if rx.match(url)), None)
                if target and target != path:
                    found[(path, target)] += 1
    return found


def main() -> int:
    if not GRAPH.exists():
        print(f"нет {GRAPH} — сначала graphify update", file=sys.stderr)
        return 1
    raw = json.loads(GRAPH.read_text(encoding="utf-8"))
    links_key = "links" if "links" in raw else "edges"
    raw[links_key] = [l for l in raw[links_key] if l.get("_origin") != ORIGIN]

    # 1. Сообщества = фичи.
    titles = [title for title, _ in AREAS] + [UNASSIGNED]
    communities: dict[int, list[str]] = defaultdict(list)
    file_node: dict[str, str] = {}
    unassigned: set[str] = set()
    for node in raw["nodes"]:
        path = node.get("source_file") or ""
        index = area_index(path) if path else len(AREAS)
        if index == len(AREAS) and path:
            unassigned.add(path)
        node["community"] = index
        node["community_name"] = titles[index]
        communities[index].append(node["id"])
        # Узел самого файла — тот, чья метка равна имени файла. У route.ts и
        # page.tsx graphify добавляет в метку папку («vpn-service/route.ts»).
        label, name = node.get("label", ""), path.rsplit("/", 1)[-1]
        if path and (label == name or label.endswith("/" + name)):
            file_node[path] = node["id"]
    communities = dict(sorted(communities.items()))
    labels = {index: titles[index] for index in communities}

    # 2. HTTP-связи.
    http = scan_http_calls(set(file_node))
    for (caller, route), count in sorted(http.items()):
        raw[links_key].append({
            "source": file_node[caller],
            "target": file_node[route],
            "relation": "calls_http",
            "_origin": ORIGIN,
            "confidence": "EXTRACTED",
            "confidence_score": 1.0,
            "context": "fetch",
            "source_file": caller,
            "source_location": "",
            "weight": float(count),
        })

    GRAPH.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    # 3. Отчёт, подписи и анализ — штатными функциями graphify.
    try:
        G = json_graph.node_link_graph(raw, edges=links_key)
    except TypeError:
        G = json_graph.node_link_graph(raw)
    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)

    (OUT / ".graphify_labels.json").write_text(
        json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (OUT / ".graphify_labels.json.sig").write_text(
        json.dumps({str(k): v for k, v in community_member_sigs(communities).items()}, indent=2),
        encoding="utf-8",
    )
    (OUT / ".graphify_analysis.json").write_text(
        json.dumps({
            "communities": {str(k): v for k, v in communities.items()},
            "cohesion": {str(k): v for k, v in cohesion.items()},
            "gods": gods,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    report = generate_report(
        G, communities, cohesion, labels, gods, surprises,
        {"warning": "Сообщества — фичи проекта (scripts/graph-structure.py), связи calls_http — fetch к своему API"},
        {"input": 0, "output": 0},
        str(ROOT / "src"),
        suggested_questions=questions,
        built_at_commit=raw.get("built_at_commit"),
    )
    (OUT / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")

    for kind in ("wiki", "html"):
        result = subprocess.run(
            [sys.executable, "-m", "graphify", "export", kind],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            print(f"export {kind} не удался: {(result.stderr or result.stdout).strip()[-300:]}")

    sizes = ", ".join(f"{labels[k]} {len(v)}" for k, v in communities.items())
    print(f"структура: {len(communities)} фич, {len(http)} связей calls_http, отчёт/вики/html обновлены")
    print(f"узлов по фичам: {sizes}")
    if unassigned:
        print("без фичи (дописать правило в AREAS scripts/graph-structure.py): "
              + ", ".join(sorted(unassigned)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

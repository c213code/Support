#!/usr/bin/env python3
"""Структурная карта кода Support из графа graphify.

graphify-out/graph.html показывает 867 символов и 2442 связи силовой
раскладкой — клубок, в котором не видно ни фич, ни слоёв. Эта карта строится
из того же graph.json, но раскладывает код так, как о нём думают в проекте:

  строки   — фичи (доска, бот, мини-апп, ИИ, …) — AREAS ниже;
  столбцы  — слой (страницы → интерфейс → API → серверная логика);
  карточки — файлы, а не отдельные функции;
  связи    — рисуются только у выбранного файла.

Запуск: python3 scripts/graph-map.py  →  graphify-out/map.html
Post-commit хук (.git/hooks/post-commit) запускает его после пересборки
графа. Файл, не попавший ни в одну фичу, скрипт называет в выводе и кладёт в
строку «Не распределено» — дописать правило в AREAS.
"""

import html
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "graphify-out" / "graph.json"
REPORT = ROOT / "graphify-out" / "GRAPH_REPORT.md"
OUT = ROOT / "graphify-out" / "map.html"

# Фичи — в порядке строк на карте. Правила — регулярки по пути от src/;
# первое совпадение выигрывает, поэтому частные случаи (фото мини-аппа в
# app/api/issues, ИИ-маршруты внутри issues и telegram) стоят раньше общих.
AREAS = [
    {
        "key": "miniapp",
        "title": "Мини-апп кураторов",
        "hint": "Форма обращения и «Менің өтініштерім» внутри Telegram",
        "color": "#0d9488",
        "rules": [
            r"^app/miniapp/",
            r"^app/api/miniapp/",
            r"^app/api/issues/\[id\]/photo/",
            r"^components/(MiniApp|SubmissionForm|MySubmissions|SubmissionPhoto)\.tsx$",
            r"^lib/(miniapp|miniappClient|statusKk|submitterNotify|telegramPhoto)\.ts$",
        ],
    },
    {
        "key": "ai",
        "title": "ИИ (Groq)",
        "hint": "Описания, дубли, словарь жаргона, подсказки решений",
        "color": "#7c3aed",
        "rules": [
            r"^app/api/ai/",
            r"^app/api/glossary/",
            r"^app/api/cron/rebuild-glossary/",
            r"^app/api/issues/(ai-validate|duplicates)/",
            r"^app/api/issues/\[id\]/similar-resolved/",
            r"^app/api/telegram/ai-recheck-messages/",
            r"^components/(GlossaryPanel|GroqStatusPanel)\.tsx$",
            r"^lib/(ai|projectContext|useAiCleaningEnabled)\.ts$",
        ],
    },
    {
        "key": "board",
        "title": "Доска и тикеты",
        "hint": "Входящие, канбан, «Сегодня», история, статусы",
        "color": "#2563eb",
        "rules": [
            r"^app/page\.tsx$",
            r"^app/(inbox|history)/",
            r"^app/api/(issues|dates|groups)/",
            r"^components/(Inbox|KanbanBoard|Dashboard|IssueForm|ResolveDialog|EscalateDialog"
            r"|AttachToIssuePicker|CommandPalette|BotReplies|ShortcutsHelp)\.tsx$",
            r"^lib/(issueStatus|mergeIssue|relatedIssue|similarity|ticketHints|textClean"
            r"|ticketDescription|escalation|resolutionNote|solutionLibrary|status|groups)\.ts$",
        ],
    },
    {
        "key": "bot",
        "title": "Telegram-бот",
        "hint": "Вебхук, команды, кнопки, автоответы, разбор дня в личке",
        "color": "#0284c7",
        "rules": [
            r"^app/api/telegram/",
            r"^lib/webhook/",
            r"^lib/(telegram|telegramCallbacks|botReply|autoReply|autoReplyApproval|agentIntent"
            r"|agentTelegram|agentThread|botMessageDelete|dedupeReview|dailyReview|situations)\.ts$",
        ],
    },
    {
        "key": "report",
        "title": "Репорт боссам",
        "hint": "Текст репорта, вечерняя отправка, утреннее напоминание",
        "color": "#ea580c",
        "rules": [
            r"^app/api/report/",
            r"^app/api/cron/(evening-report|morning-report-check)/",
            r"^components/ReportLedger\.tsx$",
            r"^lib/(report|reportSend)\.ts$",
        ],
    },
    {
        "key": "platform",
        "title": "Платформа JUZ40",
        "hint": "Смена почты ученику, обнуление ДТ",
        "color": "#16a34a",
        "rules": [
            r"^app/platform/",
            r"^app/api/platform/",
            r"^components/(ChangeEmailTool|ResetUntResultTool)\.tsx$",
            r"^lib/(platform|emailChangeRequest|untResetRequest)\.ts$",
        ],
    },
    {
        "key": "logs",
        "title": "Логи",
        "hint": "Поиск по Elasticsearch, ИИ-разбор ошибок, VPN-сервис",
        "color": "#b45309",
        "rules": [
            r"^app/logs/",
            r"^app/api/logs/",
            r"^app/api/vpn-service/",
            r"^components/(LogsExplorer|VpnServiceButton)\.tsx$",
            r"^lib/(logsClient|logFields|vpnService)\.ts$",
        ],
    },
    {
        "key": "access",
        "title": "Вход и настройки",
        "hint": "Сессия агента, proxy, тумблеры бота",
        "color": "#db2777",
        "rules": [
            r"^app/login/",
            r"^app/api/auth/",
            r"^app/api/settings/",
            r"^proxy\.ts$",
            r"^components/BotSettingsMenu\.tsx$",
            r"^lib/(auth|settings|useBotSettings|useCurrentAgent|agents)\.ts$",
        ],
    },
    {
        "key": "shared",
        "title": "Общие модули",
        "hint": "База, даты, типы, иконки, модалки — ими пользуются все",
        "color": "#64748b",
        "rules": [
            r"^app/layout\.tsx$",
            r"^components/(AppShell|Icons|Modal|Toast|ConfirmDialog|Avatar)\.tsx$",
            r"^lib/(prisma|date|types|fetchApiJson|useHotkeys)\.ts$",
        ],
    },
]
UNASSIGNED = {
    "key": "unassigned",
    "title": "Не распределено",
    "hint": "Новый файл без правила в scripts/graph-map.py",
    "color": "#dc2626",
}

LAYERS = [
    {"key": "pages", "title": "Страницы", "hint": "app/**/page.tsx"},
    {"key": "ui", "title": "Интерфейс", "hint": "components, клиентские хуки"},
    {"key": "api", "title": "API", "hint": "app/api/**/route.ts, proxy"},
    {"key": "logic", "title": "Серверная логика", "hint": "lib"},
]

# Код, который выполняется в браузере, хотя лежит в lib/.
CLIENT_LIB = re.compile(r"^lib/(use[A-Z]\w*|miniappClient|fetchApiJson)\.ts$")
# Связи, которые считаются зависимостью файла от файла.
DEP_RELATIONS = {"imports", "imports_from", "calls", "indirect_call", "re_exports"}


def layer_of(path: str) -> str:
    if path.startswith("app/api/") or path == "proxy.ts":
        return "api"
    if path.startswith("app/"):
        return "pages"
    if path.startswith("components/") or CLIENT_LIB.match(path):
        return "ui"
    return "logic"


def area_of(path: str) -> str:
    for area in AREAS:
        if any(re.search(rule, path) for rule in area["rules"]):
            return area["key"]
    return UNASSIGNED["key"]


def display_name(path: str) -> str:
    """Имя карточки. У маршрутов и страниц одинаковые имена файлов, поэтому
    для них — адрес (в столбце API без общего «/api/»). Расширение не пишем:
    слой и так виден по столбцу, а полный путь есть в подсказке и панели."""
    if path == "proxy.ts":
        return "proxy"
    m = re.match(r"^app/api/(.+)/route\.ts$", path)
    if m:
        return m.group(1)
    m = re.match(r"^app/(?:(.+)/)?page\.tsx$", path)
    if m:
        return "/" + (m.group(1) or "")
    return re.sub(r"\.(tsx?|mts)$", "", path.rsplit("/", 1)[-1])


def is_entry(path: str) -> bool:
    """Точки входа Next.js: их никто не импортирует, и это нормально."""
    return bool(
        re.search(r"(^|/)(page|layout|route)\.tsx?$", path) or path == "proxy.ts"
    )


# Строка с адресом нашего API в кавычках: "/api/…", '/api/…' или `/api/…`.
API_LITERAL = re.compile(r"""["'`](/api/[^"'`?\s]*)""")


def scan_http_calls(paths: set[str]) -> dict[tuple[str, str], int]:
    """Связи «файл → маршрут» через fetch.

    graphify видит импорты и вызовы функций, но не fetch("/api/…"): для графа
    интерфейс и API не связаны вовсе, и у каждого маршрута «используют 0».
    Досканируем исходники сами: адрес в кавычках сопоставляем с папками
    app/api (сегмент [id] принимает любое значение, ${…} в шаблоне — тоже).
    Строки-комментарии пропускаем: там адреса упоминаются, а не вызываются."""
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
    # /api/issues/duplicates подходит и под issues/[id]: побеждает маршрут,
    # у которого больше буквальных сегментов.
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
        print(f"[graph-map] нет {GRAPH} — сначала graphify update", file=sys.stderr)
        return 1
    graph = json.loads(GRAPH.read_text(encoding="utf-8"))
    nodes = graph["nodes"]
    edges = graph.get("links") or graph.get("edges") or []

    def rel(node) -> str:
        return (node.get("source_file") or "").split("src/", 1)[-1]

    by_id = {n["id"]: n for n in nodes}
    files: dict[str, dict] = {}
    for node in nodes:
        path = rel(node)
        if not path:
            continue
        entry = files.setdefault(
            path,
            {
                "id": path,
                "name": display_name(path),
                "area": area_of(path),
                "layer": layer_of(path),
                "entry": is_entry(path),
                "symbols": [],
            },
        )
        label = node.get("label", "")
        # Узел самого файла (label = имя файла) — не символ.
        if label and label != path.rsplit("/", 1)[-1]:
            line = int(re.sub(r"\D", "", node.get("source_location") or "") or 0)
            entry["symbols"].append([label, line])

    weights: dict[tuple[str, str], int] = defaultdict(int)
    calls: set[tuple[str, str]] = set()
    for edge in edges:
        if edge.get("relation") not in DEP_RELATIONS:
            continue
        a, b = by_id.get(edge["source"]), by_id.get(edge["target"])
        if not a or not b:
            continue
        pa, pb = rel(a), rel(b)
        if pa == pb or pa not in files or pb not in files:
            continue
        weights[(pa, pb)] += 1
        if edge["relation"] in ("calls", "indirect_call"):
            calls.add((pa, pb))

    http = scan_http_calls(set(files))
    for pair, count in http.items():
        weights[pair] += count

    def kind(pair: tuple[str, str]) -> str:
        return "http" if pair in http else "call" if pair in calls else "import"

    for entry in files.values():
        entry["symbols"].sort(key=lambda s: s[1])

    commit = "?"
    if REPORT.exists():
        m = re.search(r"Built from commit: `([0-9a-f]+)`", REPORT.read_text(encoding="utf-8"))
        if m:
            commit = m.group(1)[:7]

    areas = [{k: a[k] for k in ("key", "title", "hint", "color")} for a in AREAS]
    unassigned = sorted(p for p, f in files.items() if f["area"] == UNASSIGNED["key"])
    if unassigned:
        areas.append(UNASSIGNED)

    data = {
        "meta": {
            "commit": commit,
            "files": len(files),
            "links": len(weights),
            "http": len(http),
        },
        "areas": areas,
        "layers": LAYERS,
        "files": sorted(files.values(), key=lambda f: (f["area"], f["layer"], f["name"])),
        "edges": [[a, b, w, kind((a, b))] for (a, b), w in sorted(weights.items())],
    }
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    OUT.write_text(TEMPLATE.replace("__DATA__", payload).replace(
        "__COMMIT__", html.escape(commit)), encoding="utf-8")

    counts = defaultdict(int)
    for f in files.values():
        counts[f["area"]] += 1
    summary = ", ".join(f"{a['title']} {counts[a['key']]}" for a in areas)
    print(f"[graph-map] {len(files)} файлов, {len(weights)} связей "
          f"(из них {len(http)} через fetch) → {OUT.relative_to(ROOT)}")
    print(f"[graph-map] {summary}")
    if unassigned:
        print("[graph-map] без фичи (дописать правило в AREAS): " + ", ".join(unassigned))
    return 0


TEMPLATE = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Карта кода Support</title>
<style>
  :root {
    --bg: #f4f5f7;
    --panel: #ffffff;
    --card: #ffffff;
    --text: #111827;
    --muted: #6b7280;
    --line: #e5e7eb;
    --grid: #eceef2;
    --uses: #2563eb;
    --used-by: #d97706;
    --dim: 0.22;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116;
      --panel: #151a21;
      --card: #1b2129;
      --text: #e5e7eb;
      --muted: #8b95a3;
      --line: #2a313b;
      --grid: #20262e;
      --uses: #60a5fa;
      --used-by: #fbbf24;
      --dim: 0.18;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px;
    padding: 12px 20px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  h1 { margin: 0; font-size: 16px; font-weight: 650; }
  .meta { color: var(--muted); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-left: auto; }
  .controls input[type=search] {
    width: 220px; padding: 6px 10px;
    border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: var(--text); font: inherit;
  }
  .controls label { display: flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; }
  .legend { display: flex; gap: 14px; color: var(--muted); }
  .legend i { display: inline-block; width: 18px; height: 2px; margin-right: 5px; vertical-align: middle; }

  .layout { display: flex; align-items: flex-start; }
  .scroller { flex: 1; min-width: 0; overflow: auto; padding: 16px 20px 40px; }
  .map { position: relative; min-width: 1080px; }
  .grid {
    display: grid;
    grid-template-columns: 168px repeat(4, minmax(210px, 1fr));
    border: 1px solid var(--line); border-radius: 12px;
    background: var(--panel); overflow: hidden;
  }
  .colhead {
    padding: 10px 12px; border-bottom: 1px solid var(--line);
    font-weight: 600; background: var(--panel);
  }
  .colhead small { display: block; font-weight: 400; color: var(--muted); }
  .rowhead {
    padding: 12px; border-top: 1px solid var(--grid);
    border-left: 4px solid var(--area);
  }
  .rowhead b { display: block; font-size: 13px; }
  .rowhead small { display: block; margin-top: 2px; color: var(--muted); }
  .cell {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
    align-content: start; gap: 6px;
    min-height: 56px; padding: 10px;
    border-top: 1px solid var(--grid); border-left: 1px solid var(--grid);
  }
  .card {
    position: relative; z-index: 2;
    display: flex; flex-direction: column; gap: 1px;
    max-width: 100%; padding: 5px 9px 5px 10px;
    border: 1px solid var(--line); border-left: 3px solid var(--area);
    border-radius: 7px; background: var(--card); color: var(--text);
    font: inherit; text-align: left; cursor: pointer;
    transition: opacity 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
  }
  .card:hover { border-color: var(--area); }
  .card:focus-visible { outline: 2px solid var(--uses); outline-offset: 2px; }
  /* Переносим по «/» (там стоит <wbr>), а не посреди слова. */
  .card .n { font-weight: 550; overflow-wrap: break-word; }
  .card .c { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .card .orphan { color: #dc2626; }
  .map.has-sel .card { opacity: var(--dim); }
  .map.has-sel .card.sel,
  .map.has-sel .card.uses,
  .map.has-sel .card.used-by { opacity: 1; }
  .card.sel { box-shadow: 0 0 0 2px var(--text); }
  .card.uses { box-shadow: 0 0 0 2px var(--uses); }
  .card.used-by { box-shadow: 0 0 0 2px var(--used-by); }
  .card.uses.used-by { box-shadow: 0 0 0 2px var(--uses), 0 0 0 4px var(--used-by); }
  .map.searching .card:not(.match) { opacity: var(--dim); }
  .card.match { box-shadow: 0 0 0 2px var(--text); }
  svg.edges { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: visible; }
  svg.edges.front { z-index: 3; }
  svg.edges path { fill: none; }

  aside {
    position: sticky; top: 58px;
    width: 300px; max-height: calc(100vh - 58px); overflow: auto;
    padding: 16px 18px 40px;
    border-left: 1px solid var(--line); background: var(--panel);
  }
  aside h2 { margin: 0 0 2px; font-size: 15px; overflow-wrap: anywhere; }
  aside .path { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
  aside h3 { margin: 16px 0 6px; font-size: 12px; color: var(--muted); font-weight: 600; }
  aside ul { margin: 0; padding: 0; list-style: none; }
  aside li button {
    display: block; width: 100%;
    padding: 4px 6px; border: 0; border-radius: 6px; background: none;
    color: var(--text); font: inherit; text-align: left; cursor: pointer;
    overflow-wrap: anywhere;
  }
  aside li button:hover { background: var(--bg); }
  aside li button small { display: block; color: var(--muted); font-size: 11px; }
  aside .tag { display: inline-block; margin-right: 6px; padding: 1px 7px; border-radius: 999px; background: var(--bg); color: var(--muted); font-size: 11px; }
  aside .sym { display: flex; justify-content: space-between; gap: 8px; padding: 2px 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  aside .sym span:last-child { color: var(--muted); }
  aside .empty { color: var(--muted); padding: 2px 6px; }
  aside .intro p { margin: 0 0 10px; color: var(--muted); }
  aside .intro b { color: var(--text); font-weight: 600; }
  @media (max-width: 900px) {
    .layout { flex-direction: column; }
    aside { position: static; width: 100%; max-height: none; border-left: 0; border-top: 1px solid var(--line); }
  }
  @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
</style>
</head>
<body>
<header>
  <h1>Карта кода Support</h1>
  <span class="meta" id="meta"></span>
  <div class="controls">
    <input type="search" id="q" placeholder="Файл или функция…" aria-label="Поиск файла или функции">
    <label><input type="checkbox" id="shared"> Связи с общими модулями</label>
    <label><input type="checkbox" id="all"> Все связи</label>
    <span class="legend">
      <span><i style="background:var(--uses)"></i>использует</span>
      <span><i style="background:var(--used-by)"></i>используется в</span>
      <span><i style="background:repeating-linear-gradient(90deg,var(--muted) 0 4px,transparent 4px 7px)"></i>по HTTP</span>
    </span>
  </div>
</header>
<div class="layout">
  <div class="scroller">
    <div class="map" id="map">
      <div class="grid" id="grid"></div>
      <svg class="edges" id="edges" aria-hidden="true">
        <defs>
          <marker id="arrow-uses" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--uses)"/></marker>
          <marker id="arrow-used-by" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--used-by)"/></marker>
          <marker id="arrow-all" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)"/></marker>
        </defs>
        <g id="edge-layer"></g>
      </svg>
    </div>
  </div>
  <aside id="panel" aria-live="polite"></aside>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
(() => {
  const DATA = JSON.parse(document.getElementById("data").textContent);
  const areaByKey = Object.fromEntries(DATA.areas.map((a) => [a.key, a]));
  const layerByKey = Object.fromEntries(DATA.layers.map((l) => [l.key, l]));
  const fileById = Object.fromEntries(DATA.files.map((f) => [f.id, f]));
  const out = {}, inc = {};
  for (const f of DATA.files) { out[f.id] = new Map(); inc[f.id] = new Map(); }
  for (const [a, b, w, kind] of DATA.edges) {
    out[a].set(b, { w, kind });
    inc[b].set(a, { w, kind });
  }

  const map = document.getElementById("map");
  const grid = document.getElementById("grid");
  const svg = document.getElementById("edges");
  const layer = document.getElementById("edge-layer");
  const panel = document.getElementById("panel");
  const q = document.getElementById("q");
  const sharedBox = document.getElementById("shared");
  const allBox = document.getElementById("all");
  const cards = {};
  let selected = null;

  document.getElementById("meta").textContent =
    `коммит ${DATA.meta.commit} · ${DATA.meta.files} файлов · ${DATA.meta.links} связей между файлами, из них ${DATA.meta.http} по HTTP`;

  const isShared = (id) => fileById[id].area === "shared";
  const visibleEdge = (a, b) => sharedBox.checked || (!isShared(a) && !isShared(b));
  // Кто вызывает точку входа снаружи кода — у них «никто не вызывает» норма.
  const externalCaller = (f) =>
    f.id === "proxy.ts" ? "перед каждым запросом"
    : f.id.startsWith("app/api/telegram/webhook/") ? "вызывает Telegram"
    : f.id.startsWith("app/api/cron/") ? "вызывает Vercel Cron"
    : f.layer === "pages" ? "страница"
    : null;
  // Похоже на неиспользуемое: модуль, который никто не импортирует, или
  // маршрут API, который ни один файл не вызывает через fetch.
  const problem = (f) => {
    if (inc[f.id].size > 0 || externalCaller(f)) return null;
    if (f.layer === "api") return "никто не вызывает";
    return f.entry ? null : "никто не импортирует";
  };

  // --- сетка: фичи × слои ---
  grid.append(el("div", "colhead", ""));
  for (const l of DATA.layers) {
    const head = el("div", "colhead", l.title);
    head.append(el("small", "", l.hint));
    grid.append(head);
  }
  for (const area of DATA.areas) {
    const files = DATA.files.filter((f) => f.area === area.key);
    const head = el("div", "rowhead", "");
    head.style.setProperty("--area", area.color);
    head.append(el("b", "", area.title), el("small", "", `${area.hint} · ${files.length}`));
    grid.append(head);
    for (const l of DATA.layers) {
      const cell = el("div", "cell", "");
      for (const f of files.filter((f) => f.layer === l.key)) cell.append(card(f, area));
      grid.append(cell);
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function card(f, area) {
    const b = el("button", "card", "");
    b.type = "button";
    b.style.setProperty("--area", area.color);
    // Места для переноса: после «/» и «-» и на стыке слов в camelCase
    // (Submission|Form), чтобы узкая карточка не резала имя посреди слова.
    const name = el("span", "n", "");
    f.name.split(/(?<=[/-])|(?<=[a-z])(?=[A-Z])/).forEach((part, i) => {
      if (i > 0) name.append(document.createElement("wbr"));
      name.append(part);
    });
    b.append(name);
    const c = el("span", "c", "");
    const issue = problem(f);
    if (issue) {
      c.append(el("span", "orphan", issue));
    } else {
      const caller = externalCaller(f);
      c.textContent = `→ ${out[f.id].size}  ← ${inc[f.id].size}` + (caller && inc[f.id].size === 0 ? ` · ${caller}` : "");
    }
    b.title = `src/${f.id}\nиспользует ${out[f.id].size} · используется в ${inc[f.id].size}`;
    b.append(c);
    b.addEventListener("click", () => select(selected === f.id ? null : f.id));
    cards[f.id] = b;
    return b;
  }

  // --- выбор файла ---
  function select(id, { scroll = false } = {}) {
    selected = id;
    map.classList.toggle("has-sel", Boolean(id));
    for (const [fid, node] of Object.entries(cards)) {
      node.classList.toggle("sel", fid === id);
      node.classList.toggle("uses", Boolean(id) && out[id].has(fid) && visibleEdge(id, fid));
      node.classList.toggle("used-by", Boolean(id) && inc[id].has(fid) && visibleEdge(fid, id));
    }
    history.replaceState(null, "", id ? "#" + encodeURIComponent(id) : location.pathname);
    if (id && scroll) cards[id].scrollIntoView({ block: "center", inline: "center" });
    renderPanel();
    draw();
  }

  // --- связи ---
  function draw() {
    const box = map.getBoundingClientRect();
    svg.setAttribute("width", map.scrollWidth);
    svg.setAttribute("height", map.scrollHeight);
    layer.replaceChildren();
    const pairs = [];
    if (selected) {
      for (const b of out[selected].keys()) if (visibleEdge(selected, b)) pairs.push([selected, b, "uses"]);
      for (const a of inc[selected].keys()) if (visibleEdge(a, selected)) pairs.push([a, selected, "used-by"]);
      svg.classList.add("front");
    } else if (allBox.checked) {
      for (const [a, b] of DATA.edges) if (visibleEdge(a, b)) pairs.push([a, b, "all"]);
      svg.classList.remove("front");
    }
    for (const [a, b, kind] of pairs) {
      const viaHttp = out[a].get(b)?.kind === "http";
      const ra = cards[a].getBoundingClientRect(), rb = cards[b].getBoundingClientRect();
      const ax = ra.left - box.left, ay = ra.top - box.top + ra.height / 2;
      const bx = rb.left - box.left, by = rb.top - box.top + rb.height / 2;
      let d;
      if (Math.abs((ax + ra.width / 2) - (bx + rb.width / 2)) > 60) {
        // В разных столбцах — от боковой грани к боковой.
        const forward = bx > ax;
        const x1 = forward ? ax + ra.width : ax, x2 = forward ? bx : bx + rb.width;
        // Изгиб — половина расстояния: у соседних столбцов линия идёт почти
        // прямо в промежуток между ними, а не петлёй поверх карточек.
        const bend = Math.max(12, Math.abs(x2 - x1) * 0.5) * (forward ? 1 : -1);
        d = `M${x1},${ay} C${x1 + bend},${ay} ${x2 - bend},${by} ${x2},${by}`;
      } else {
        // В одном столбце — дугой сбоку. У последнего столбца справа панель,
        // поэтому там дуга уходит влево.
        const last = fileById[a].layer === DATA.layers[DATA.layers.length - 1].key;
        const bulge = (30 + Math.abs(by - ay) * 0.12) * (last ? -1 : 1);
        const x1 = last ? ax : ax + ra.width, x2 = last ? bx : bx + rb.width;
        d = `M${x1},${ay} C${x1 + bulge},${ay} ${x2 + bulge},${by} ${x2},${by}`;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      const color = kind === "uses" ? "var(--uses)" : kind === "used-by" ? "var(--used-by)" : "var(--muted)";
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", kind === "all" ? "0.7" : "1.6");
      path.setAttribute("stroke-opacity", kind === "all" ? "0.35" : "0.85");
      path.setAttribute("marker-end", `url(#arrow-${kind})`);
      if (viaHttp) path.setAttribute("stroke-dasharray", "5 4");
      layer.append(path);
    }
  }

  // --- панель ---
  function renderPanel() {
    panel.replaceChildren();
    if (!selected) {
      const intro = el("div", "intro", "");
      const suspects = DATA.files.filter(problem);
      intro.innerHTML =
        "<p><b>Строки</b> — фичи проекта, <b>столбцы</b> — слой: от страницы к серверной логике.</p>" +
        "<p><b>Нажмите на файл</b> — появятся его связи: синие — что он использует, жёлтые — где используется, пунктир — вызов по HTTP (fetch). Esc — снять выбор.</p>" +
        "<p>На карточке: <b>→</b> сколько файлов использует, <b>←</b> в скольких используется.</p>" +
        "<p>Связи с общими модулями (база, даты, иконки) скрыты: их используют все, и они только шумят. Включаются галочкой сверху.</p>";
      panel.append(intro);
      panel.append(el("h3", "", `Похоже, не используется · ${suspects.length}`));
      panel.append(list(suspects.map((f) => [f.id, problem(f)])));
      const heavy = [...DATA.files].sort((a, b) => inc[b.id].size - inc[a.id].size).slice(0, 8);
      panel.append(el("h3", "", "Больше всего зависимых"));
      panel.append(list(heavy.map((f) => [f.id, `${inc[f.id].size}`])));
      return;
    }
    const f = fileById[selected];
    panel.append(el("h2", "", f.name));
    panel.append(el("div", "path", "src/" + f.id));
    const tags = el("div", "", "");
    tags.style.marginTop = "8px";
    tags.append(el("span", "tag", areaByKey[f.area].title), el("span", "tag", layerByKey[f.layer].title));
    if (problem(f)) tags.append(el("span", "tag", problem(f)));
    else if (externalCaller(f)) tags.append(el("span", "tag", externalCaller(f)));
    panel.append(tags);

    const note = (id, link) => areaByKey[fileById[id].area].title + (link.kind === "http" ? " · HTTP" : "");
    const uses = [...out[selected].entries()].sort((x, y) => y[1].w - x[1].w);
    const users = [...inc[selected].entries()].sort((x, y) => y[1].w - x[1].w);
    panel.append(el("h3", "", `Использует · ${uses.length}`));
    panel.append(list(uses.map(([id, link]) => [id, note(id, link)])));
    panel.append(el("h3", "", `Используется в · ${users.length}`));
    panel.append(list(users.map(([id, link]) => [id, note(id, link)])));
    panel.append(el("h3", "", `Символы · ${f.symbols.length}`));
    if (f.symbols.length === 0) panel.append(el("div", "empty", "—"));
    for (const [label, line] of f.symbols) {
      const row = el("div", "sym", "");
      row.append(el("span", "", label), el("span", "", line ? "L" + line : ""));
      panel.append(row);
    }
  }

  function list(items) {
    const ul = el("ul", "", "");
    if (items.length === 0) ul.append(el("li", "empty", "—"));
    for (const [id, note] of items) {
      const li = el("li", "", "");
      const b = el("button", "", "");
      b.type = "button";
      b.append(el("span", "", fileById[id].name), el("small", "", note));
      b.title = "src/" + id;
      b.addEventListener("click", () => select(id, { scroll: true }));
      li.append(b);
      ul.append(li);
    }
    return ul;
  }

  // --- поиск ---
  q.addEventListener("input", () => {
    const term = q.value.trim().toLowerCase();
    map.classList.toggle("searching", Boolean(term));
    for (const f of DATA.files) {
      const hit = Boolean(term) && (f.id.toLowerCase().includes(term) ||
        f.name.toLowerCase().includes(term) ||
        f.symbols.some(([s]) => s.toLowerCase().includes(term)));
      cards[f.id].classList.toggle("match", hit);
    }
  });
  q.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = DATA.files.find((f) => cards[f.id].classList.contains("match"));
    if (first) { q.value = ""; q.dispatchEvent(new Event("input")); select(first.id, { scroll: true }); }
  });

  sharedBox.addEventListener("change", () => select(selected));
  allBox.addEventListener("change", draw);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement !== q) select(null);
  });
  let raf = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); });

  // Ссылка вида map.html#lib/issueStatus.ts открывает карту на этом файле.
  function selectFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    select(fileById[id] ? id : null, { scroll: Boolean(fileById[id]) });
  }
  window.addEventListener("hashchange", selectFromHash);
  selectFromHash();
})();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    sys.exit(main())

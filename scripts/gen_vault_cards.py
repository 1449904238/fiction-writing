# -*- coding: utf-8 -*-
"""从 json 渲染 Obsidian vault 版卡片（frontmatter + wikilink + tag + MOC）。
知识库唯一权威：C:/fuhui/ObsidianStore/writer/方法论库/
- json 在 知识卡片/ 练习卡/ 规则与清单/
- md 视图在 经典情节20种/ 开始写吧/（本脚本渲染，勿手工改）
用法：python gen_vault_cards.py   （幂等，可重复执行）
"""
import json, glob, os, re

VAULT = r"C:/fuhui/ObsidianStore/writer/方法论库"
JSON_D = os.path.join(VAULT, "知识卡片")
JSON_E = os.path.join(VAULT, "练习卡")
PLOT_DIR = os.path.join(VAULT, "经典情节20种")
EX_DIR = os.path.join(VAULT, "开始写吧")
os.makedirs(PLOT_DIR, exist_ok=True)
os.makedirs(EX_DIR, exist_ok=True)

def fm_line(k, v):
    return f'{k}: "{v}"' if v else None

def render_plot(c):
    body = [f"# {c['id']} {c['name']}", ""]
    body.append(f"- **类型**：{c.get('type','')}")
    if c.get("one_liner"): body.append(f"- **一句话**：{c['one_liner']}")
    body.append("")
    if c.get("definition"): body += ["## 定义", "", c["definition"], ""]
    ta = c.get("three_act", {})
    if ta:
        body.append("## 三幕结构")
        for k, label in [("act1","第一幕"),("act2","第二幕"),("act3","第三幕")]:
            if ta.get(k): body += ["", f"**{label}**：{ta[k]}"]
        body.append("")
    if c.get("key_points"):
        body += ["## 写作要点", ""]
        body += [f"- {p}" for p in c["key_points"]]
        body.append("")
    if c.get("pitfalls"):
        body += ["## 常见误区", ""]
        body += [f"- {p}" for p in c["pitfalls"]]
        body.append("")
    if c.get("use_when"):
        body += ["## 适用判断信号", ""]
        body += [f"- {u}" for u in c["use_when"]]
        body.append("")
    if c.get("examples"):
        body += ["## 经典示例", ""]
        body += [f"- {e}" for e in c["examples"]]
        body.append("")
    src = c.get("source", {})
    body += ["## 来源", "", f"- 书：{src.get('book','')}｜章：{src.get('chapter','')}｜raw: `{src.get('raw_file','')}`", ""]
    return "\n".join(body)

def render_theory(c):
    body = [f"# {c['id']} {c['name']}", ""]
    if c.get("key_ideas"):
        body += ["## 核心观点", ""]
        body += [f"- {i}" for i in c["key_ideas"]]
        body.append("")
    if c.get("rules"):
        body += ["## 可执行规则", ""]
        body += [f"- {r}" for r in c["rules"]]
        body.append("")
    src = c.get("source", {})
    body += ["## 来源", "", f"- 书：{src.get('book','')}｜章：{src.get('chapter','')}｜raw: `{src.get('raw_file','')}`", ""]
    return "\n".join(body)

def render_ex(c):
    body = [f"# {c['id']} {c['title']}", ""]
    if c.get("section"): body.append(f"- **板块**：{c['section']}")
    if c.get("author"): body.append(f"- **供稿作家**：{c['author']}")
    if c.get("use_when"): body.append(f"- **适用场景**：{'、'.join(c['use_when'])}")
    body.append("")
    if c.get("purpose"): body += ["## 目的", "", c["purpose"], ""]
    if c.get("steps"):
        body += ["## 步骤", ""]
        body += [f"{i}. {s}" for i, s in enumerate(c["steps"], 1)]
        body.append("")
    if c.get("duration"): body += ["## 时长", "", c["duration"], ""]
    if c.get("output"): body += ["## 产出物", "", c["output"], ""]
    src = c.get("source", {})
    body += ["## 来源", "", f"- 书：{src.get('book','')}｜章：{src.get('chapter','')}｜raw: `{src.get('raw_file','')}`", ""]
    return "\n".join(body)

def _san(fn_raw):
    return re.sub(r'[\\/:*?"<>|“”‘’！？，。；：（）()【】\s]+', "_", fn_raw)

def write_md(c, body, kind, tags, rel_links, out_dir, existing_map=None):
    import json as _json
    fm = ["---", f'id: {_json.dumps(c["id"], ensure_ascii=False)}']
    for k in ["name", "type", "section", "author"]:
        if c.get(k): fm.append(f'{k}: {_json.dumps(c[k], ensure_ascii=False)}')
    if c.get("use_when"):
        fm.append("use_when:")
        fm += [f'  - {_json.dumps(u, ensure_ascii=False)}' for u in c["use_when"]]
    fm.append(f'kind: "{kind}"')
    s = c.get("source", {})
    fm.append(f'book: {_json.dumps(s.get("book",""), ensure_ascii=False)}')
    fm.append(f'chapter: {_json.dumps(s.get("chapter",""), ensure_ascii=False)}')
    fm.append(f'source: {_json.dumps(s.get("raw_file",""), ensure_ascii=False)}')
    fm.append("tags:")
    fm += [f"  - {t}" for t in tags]
    fm.append("---")
    out = "\n".join(fm) + "\n\n" + body.strip() + "\n"
    if rel_links:
        out += "\n## 相关\n\n" + "\n".join(rel_links) + "\n"
    fn = (existing_map or {}).get(c["id"])
    if not fn:
        raw = c.get("name") or c.get("title") or c["id"]
        safe = re.sub(r'[\\/:*?"<>|“”‘’！？，。：；（）()【】\s]+', "_", raw)
        fn = f'{c["id"]}_{safe}.md'
    with open(os.path.join(out_dir, fn), "w", encoding="utf-8") as f:
        f.write(out)

# 生成时用文件名做链接目标（真实文件名），先统计
actual_plot = {}
for f in glob.glob(os.path.join(PLOT_DIR, "*.md")):
    m = re.match(r"(plot\d{2}|theory_\d+)", os.path.basename(f))
    if m: actual_plot[m.group(1)] = os.path.basename(f)[:-3]
actual_ex = {}
for f in glob.glob(os.path.join(EX_DIR, "*.md")):
    m = re.match(r"(ex\d{3})", os.path.basename(f))
    if m: actual_ex[m.group(1)] = os.path.basename(f)[:-3]

# 预计算确定性文件名（json → 文件名，写入与链接共用同一映射）
def _expected(c):
    return f'{c["id"]}_{_san(c.get("name") or c.get("title") or c["id"])}.md'
expected_plot = {}
for f in glob.glob(os.path.join(JSON_D, "*.json")):
    c = json.load(open(f, encoding="utf-8-sig"))
    expected_plot[c["id"]] = _expected(c)
expected_ex = {}
for f in glob.glob(os.path.join(JSON_E, "*.json")):
    c = json.load(open(f, encoding="utf-8-sig"))
    expected_ex[c["id"]] = _expected(c)

plot_moc = {"动作情节": [], "头脑情节": []}
theory_links = []
theory4 = expected_plot.get("theory_4", "theory_4_动作情节与头脑情节")[:-3]
for f in sorted(glob.glob(os.path.join(JSON_D, "*.json"))):
    c = json.load(open(f, encoding="utf-8-sig"))
    if c["id"].startswith("plot"):
        tags = ["写作/情节", f"写作/{c['type'].replace('情节','')}"]
        rel = ["[[_MOC_情节库|返回情节库]]", f"[[{theory4}|动作/头脑二分法]]"]
        write_md(c, render_plot(c), "情节卡", tags, rel, PLOT_DIR, expected_plot)
        plot_moc[c["type"]].append((c["id"], c["name"]))
    else:
        write_md(c, render_theory(c), "理论卡", ["写作/理论"], ["[[_MOC_情节库|返回情节库]]"], PLOT_DIR, expected_plot)
        theory_links.append((c["id"], c["name"]))

ex_moc = {}
for f in sorted(glob.glob(os.path.join(JSON_E, "*.json"))):
    c = json.load(open(f, encoding="utf-8-sig"))
    tags = ["写作/练习"] + [f"练习/{u}" for u in c.get("use_when", [])]
    rel = ["[[_MOC_练习库|返回练习库]]", "[[练习卡索引|按板块速查表]]"]
    write_md(c, render_ex(c), "练习卡", tags, rel, EX_DIR, expected_ex)
    ex_moc.setdefault(c.get("section", "未分类"), []).append((c["id"], c["title"]))

# MOC 情节库
moc = ["# MOC 情节库", "", "《经典情节20种》蒸馏卡 · json 权威在 `方法论库/知识卡片/`", ""]
for label, key in [("头脑情节（14）", "头脑情节"), ("动作情节（6）", "动作情节")]:
    moc.append(f"## {label}")
    moc.append("")
    for i, n in sorted(plot_moc[key]):
        moc.append(f"- [[{expected_plot[i][:-3]}|{n}]]")
    moc.append("")
moc.append("## 理论要点卡")
moc.append("")
for i, n in sorted(theory_links):
    moc.append(f"- [[{expected_plot[i][:-3]}|{n}]]")
moc.append("")
open(os.path.join(PLOT_DIR, "_MOC_情节库.md"), "w", encoding="utf-8").write("\n".join(moc))

# MOC 练习库
moc2 = ["# MOC 练习库", "", "《开始写吧！——虚构文学创作》蒸馏卡 · json 权威在 `方法论库/练习卡/`", ""]
order = ["开始动笔", "视角", "人物发展", "对话", "情节和节奏", "背景和描述", "技巧", "修改"]
for sec in order + [s for s in ex_moc if s not in order]:
    moc2.append(f"## {sec}（{len(ex_moc[sec])}）")
    moc2.append("")
    for i, t in sorted(ex_moc[sec]):
        moc2.append(f"- [[{expected_ex[i][:-3]}|{t}]]")
    moc2.append("")
open(os.path.join(EX_DIR, "_MOC_练习库.md"), "w", encoding="utf-8").write("\n".join(moc2))

print("渲染完成: 情节库", len(glob.glob(os.path.join(PLOT_DIR, "*.md"))), "| 练习库", len(glob.glob(os.path.join(EX_DIR, "*.md"))))

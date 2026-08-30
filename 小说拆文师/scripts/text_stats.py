# -*- coding: utf-8 -*-
"""
text_stats.py - 拆文文本统计工具（纯 Python 标准库，无第三方依赖）

用法：
    python text_stats.py <文件.md 或 目录>
    python text_stats.py <目录> --top 10     # 只看前10章

输出：各章字数/句长/对话占比/段落/标点统计，写入 stdout。
把输出保存为 拆文库/{书名}/文风统计.md。

统计口径：
- 字数：去除空白后的字符数
- 句子：以 。！？…；分句（省略号按一处分隔）
- 对话行：包含中文引号（“ ” 「 『 等）的段落（宽口径：整段计入对话，系统性偏高，仅作相对比较用）
- 省略号：按连用计一处（…/……/……… 均算 1 处）
- 段落：非空行
"""
import sys
import os
import re
import argparse
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SENT_SPLIT = re.compile(r"[。！？；]+|…+")
DIALOGUE = re.compile(r"[“「『\"]")

def parse_chapter(text):
    text = re.sub(r"^#.*$", "", text, flags=re.MULTILINE)  # 去标题行
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    total_chars = sum(len(re.sub(r"\s", "", p)) for p in paras)

    sentences = []
    for p in paras:
        for s in SENT_SPLIT.split(p):
            s = s.strip()
            if s:
                sentences.append(s)
    sent_lens = [len(re.sub(r"\s", "", s)) for s in sentences]

    dial_paras = sum(1 for p in paras if DIALOGUE.search(p))
    dial_chars = sum(len(re.sub(r"\s", "", p)) for p in paras if DIALOGUE.search(p))

    marks = {
        "！": text.count("！"),
        "？": text.count("？"),
        "……": len(re.findall(r"…+", text)),  # 连用计一处
        "——": text.count("——"),
    }
    return {
        "paras": len(paras),
        "chars": total_chars,
        "sents": len(sent_lens),
        "sent_lens": sent_lens,
        "dial_chars": dial_chars,
        "avg_sent": round(sum(sent_lens) / len(sent_lens), 1) if sent_lens else 0,
        "short_ratio": round(sum(1 for l in sent_lens if l <= 12) / len(sent_lens) * 100, 1) if sent_lens else 0,
        "avg_para": round(total_chars / len(paras), 1) if paras else 0,
        "dial_para_ratio": round(dial_paras / len(paras) * 100, 1) if paras else 0,
        "dial_char_ratio": round(dial_chars / total_chars * 100, 1) if total_chars else 0,
        "marks": marks,
    }

def fmt(n):
    return f"{n:,}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="章节 md 文件或包含章节的目录")
    ap.add_argument("--top", type=int, default=0, help="只统计前 N 章（按文件名排序）")
    args = ap.parse_args()

    files = []
    if os.path.isdir(args.path):
        for f in sorted(os.listdir(args.path)):
            if f.endswith((".md", ".txt")):
                files.append(os.path.join(args.path, f))
    elif os.path.isfile(args.path):
        files = [args.path]
    else:
        print(f"[错误] 路径不存在: {args.path}")
        sys.exit(1)

    if args.top:
        files = files[: args.top]

    if not files:
        print("[错误] 未找到 .md/.txt 文件")
        sys.exit(1)

    # 排序可靠性检查：文件名不符合 第NNN章 零填充格式时，字典序可能与章节顺序不一致
    if os.path.isdir(args.path) and any(not re.search(r"第\d{3}章", os.path.basename(f)) for f in files):
        print("> [提示] 部分文件名不符合「第NNN章」格式，按文件名排序可能不反映实际章节顺序；"
              "建议按 第NNN章_章名.md 命名（--top 取前 N 章依赖此排序）。\n")

    print("| 章节 | 字数 | 段落数 | 段均字数 | 平均句长 | 短句占比 | 对话段占比 | 对话字占比 | ！ | ？ | …… | —— |")
    print("|------|------|--------|----------|----------|----------|------------|------------|---|---|----|----|")

    all_chars, all_sent_lens, all_dial_chars = 0, [], 0
    marks_total = {"！": 0, "？": 0, "……": 0, "——": 0}
    for fp in files:
        try:
            with open(fp, "r", encoding="utf-8") as fh:
                text = fh.read()
        except UnicodeDecodeError:
            with open(fp, "r", encoding="gbk", errors="ignore") as fh:
                text = fh.read()
        r = parse_chapter(text)
        name = os.path.splitext(os.path.basename(fp))[0]
        print(
            f"| {name} | {fmt(r['chars'])} | {r['paras']} | {r['avg_para']} | {r['avg_sent']} "
            f"| {r['short_ratio']}% | {r['dial_para_ratio']}% | {r['dial_char_ratio']}% "
            f"| {r['marks']['！']} | {r['marks']['？']} | {r['marks']['……']} | {r['marks']['——']} |"
        )
        all_chars += r["chars"]
        all_dial_chars += r["dial_chars"]  # 原始对话字数直接累计，避免经舍入比例反推的精度损失
        for m in marks_total:
            marks_total[m] += r["marks"][m]
        all_sent_lens.extend(r["sent_lens"])  # 真实句长逐句累计，供整体汇总

    n = len(files)
    if n:
        overall_avg = round(sum(all_sent_lens) / len(all_sent_lens), 1) if all_sent_lens else 0
        overall_short = round(
            sum(1 for l in all_sent_lens if l <= 12) / len(all_sent_lens) * 100, 1
        ) if all_sent_lens else 0
        print(f"\n**汇总（{n} 章）**：总字数 {fmt(all_chars)}，均章 {fmt(all_chars // n)} 字，"
              f"整体平均句长 {overall_avg} 字，整体短句占比 {overall_short}%，"
              f"对话字占比约 {round(all_dial_chars / all_chars * 100, 1) if all_chars else 0}%，"
              f"叹号均章 {round(marks_total['！'] / n, 1)}，问号均章 {round(marks_total['？'] / n, 1)}，"
              f"省略号均章 {round(marks_total['……'] / n, 1)}，破折号均章 {round(marks_total['——'] / n, 1)}")
        print("\n> 口径：句子按 。！？；… 切分；对话段落=含中文引号的段落（宽口径，含引号段落整段计入，"
              "系统性偏高，仅作相对比较用）；省略号按连用计一处。数字为机械统计，供拆文报告文本维度引用。")

if __name__ == "__main__":
    main()

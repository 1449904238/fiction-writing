# -*- coding: utf-8 -*-
"""parse-ebook.py — 电子书/文本解析共享脚本（epub/mobi/txt → 分章 markdown）

共享约定（引用不复制）：
- 小说拆文师 / 小说导入师 / book-distillation-kb（vault Skill/workflows/distill-book.md）三方调用
- 依赖：pip install mobi ebooklib beautifulsoup4 lxml（隔离 venv）
- 输出命名：{prefix}_{序号:03d}_{章节标题}.md，章节标题取首个 heading；<200 字的目录/封面页跳过

用法：
  python parse-ebook.py <输入文件> <输出目录> <前缀>
  例：python parse-ebook.py 书.epub raw plot20
"""
import os, re, sys, glob

def html_to_text(html):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style"]):
        tag.decompose()
    for h in soup.find_all(["h1", "h2", "h3", "h4"]):
        level = int(h.name[1])
        h.replace_with("\n\n" + "#" * level + " " + h.get_text(strip=True) + "\n\n")
    text = soup.get_text("\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t\u3000]+", " ", text)
    return text.strip()

def safe_name(title, i):
    t = re.sub(r'[\\/:*?"<>|“”‘’！？，。：；（）\s]+', "_", title)
    return f"{t[:60]}" or f"section_{i:02d}"

def extract_epub(path):
    import ebooklib
    from ebooklib import epub
    book = epub.read_epub(path, options={"ignore_ncx": True})
    items = [it for it in book.get_items_of_type(ebooklib.ITEM_DOCUMENT)]
    spine_ids = [sid for sid, _ in book.spine]
    idmap = {it.get_id(): it for it in items}
    ordered = [idmap[sid] for sid in spine_ids if sid in idmap] or items
    chapters = []
    for it in ordered:
        text = html_to_text(it.get_content().decode("utf-8", "ignore"))
        if len(text) < 200:
            continue
        m = re.search(r"^#{1,3} (.+)$", text, re.M)
        title = m.group(1).strip() if m else f"section_{len(chapters)+1:02d}"
        chapters.append((title, text))
    return chapters

def extract_mobi(path):
    import mobi
    tempdir, _ = mobi.extract(path)
    htmls = []
    for root, _, files in os.walk(tempdir):
        for fn in files:
            if fn.lower().endswith((".html", ".htm")):
                htmls.append(os.path.join(root, fn))
    assert htmls, "no html extracted from mobi"
    main = max(htmls, key=os.path.getsize)
    raw = open(main, "rb").read().decode("utf-8", "ignore")
    chapters = []
    for part in re.split(r"<mbp:pagebreak[^>]*>", raw, flags=re.I):
        t = html_to_text(part)
        if len(t) < 200:
            continue
        m = re.search(r"^#{1,3} (.+)$", t, re.M)
        title = m.group(1).strip() if m else f"section_{len(chapters)+1:02d}"
        chapters.append((title, t))
    return chapters

def extract_txt(path):
    txt = open(path, encoding="utf-8", errors="ignore").read()
    parts = re.split(r"\n\s*(第[一二三四五六七八九十百0-9]+[章节卷部回]|[0-9]+[.、．]\s*[\u4e00-\u9fff]{2,20})", txt)
    chapters = []
    for i in range(0, len(parts) - 1, 2):
        title = parts[i + 1].strip()
        body = parts[i].strip()
        if len(body) >= 200:
            chapters.append((title, body))
    if not chapters:
        chapters.append((os.path.basename(path), txt))
    return chapters

def main():
    src, outdir, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    ext = os.path.splitext(src)[1].lower()
    if ext == ".epub":
        chapters = extract_epub(src)
    elif ext == ".mobi" or ext == ".azw3":
        chapters = extract_mobi(src)
    else:
        chapters = extract_txt(src)
    n = 0
    for i, (title, text) in enumerate(chapters, 1):
        fn = f"{prefix}_{i:03d}_{safe_name(title, i)}.md"
        with open(os.path.join(outdir, fn), "w", encoding="utf-8") as f:
            f.write(f"# {title}\n\n{text}\n")
        n += 1
    print(f"解析完成: {n} 章 → {outdir}/")
    # 输出章节清单供与目录核对（防合并/吞章）
    for i, (title, _) in enumerate(chapters, 1):
        print(f"  {i:03d}  {title[:50]}")

if __name__ == "__main__":
    main()

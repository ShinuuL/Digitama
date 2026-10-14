"""Fatia as folhas de sprites do Digimon World DS (assets-ref/<id>.png).

    python scripts/sheets.py list   → assets-ref/_labels/<id>.png com cada sprite numerado
    python scripts/sheets.py export → aplica scripts/sheets.json e grava os quadros em
                                      %APPDATA%/br.com.mastersys.digitama/sprites/<id>/

Cada folha tem cores de fundo próprias (fundo geral e caixas atrás de cada
quadro); elas ficam transparentes. Os sprites são achados como componentes
conectados (8 vizinhos); os pedaços de um mesmo sprite (garra solta, chifre)
são unidos se as caixas encostam.
"""
import json
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "assets-ref")
OUT = os.path.join(os.environ.get("APPDATA", ""), "br.com.mastersys.digitama", "sprites")

BG = {
    "agumon": ["ff00ff", "74ec60"],
    "dorimon": ["ff00ff", "74ec60"],
    "dorumon": ["ff00ff", "74ec60"],
    "gallantmon": ["ff00ff", "74ec60"],
    "wargrowlmon": ["ff00ff", "74ec60"],
    "dorugamon": ["48b058", "008080"],
    "greymon": ["50b058", "008080"],
    "wargreymon": ["50b058", "008080"],
    "doruguremon": ["00a0a0", "38a038"],
    "growlmon": ["800080"],
    "guilmon": ["000080"],
    "koromon": ["8003af"],
    "metalgreymon": [],
    "alphamon": ["white"],
}


def is_bg(px, bgs):
    r, g, b, a = px
    if a < 128:
        return True
    for h in bgs:
        if h == "white":
            if r >= 245 and g >= 245 and b >= 245:
                return True
        elif (r, g, b) == tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)):
            return True
    return False


def strip_lines(im, run=40):
    """Grades e bordas de painel: trechos retos longos da mesma cor viram fundo."""
    im = im.copy()
    px = im.load()
    w, h = im.size
    kill = set()
    for y in range(h):
        x = 0
        while x < w:
            x2 = x
            while x2 + 1 < w and px[x2 + 1, y] == px[x, y]:
                x2 += 1
            if x2 - x + 1 >= run:
                kill.update((i, y) for i in range(x, x2 + 1))
            x = x2 + 1
    for x in range(w):
        y = 0
        while y < h:
            y2 = y
            while y2 + 1 < h and px[x, y2 + 1] == px[x, y]:
                y2 += 1
            if y2 - y + 1 >= run:
                kill.update((x, j) for j in range(y, y2 + 1))
            y = y2 + 1
    for p in kill:
        px[p] = (0, 0, 0, 0)
    return im


def components(im, bgs):
    im = strip_lines(im)
    w, h = im.size
    px = im.load()
    seen = [[False] * w for _ in range(h)]
    boxes = []
    for y in range(h):
        for x in range(w):
            if seen[y][x] or is_bg(px[x, y], bgs):
                continue
            stack = [(x, y)]
            seen[y][x] = True
            x0 = x1 = x
            y0 = y1 = y
            n = 0
            while stack:
                cx, cy = stack.pop()
                n += 1
                x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and not is_bg(px[nx, ny], bgs):
                            seen[ny][nx] = True
                            stack.append((nx, ny))
            boxes.append([x0, y0, x1 + 1, y1 + 1, n])
    # molduras (componentes ralos e grandes) saem antes de unir qualquer coisa
    boxes = [bx for bx in boxes if not ((bx[2] - bx[0]) * (bx[3] - bx[1]) > 2500 and bx[4] / ((bx[2] - bx[0]) * (bx[3] - bx[1])) < 0.12)]
    # só fragmentos pequenos (garra, chifre soltos) se juntam ao sprite que encostam
    big = [bx for bx in boxes if bx[4] >= 150]
    small = [bx for bx in boxes if bx[4] < 150]
    rest = []
    for f in small:
        host = next((b for b in big if f[0] <= b[2] + 1 and b[0] <= f[2] + 1 and f[1] <= b[3] + 1 and b[1] <= f[3] + 1), None)
        if host:
            host[0], host[1], host[2], host[3], host[4] = min(host[0], f[0]), min(host[1], f[1]), max(host[2], f[2]), max(host[3], f[3]), host[4] + f[4]
        else:
            rest.append(f)
    out = []
    for x0, y0, x1, y1, n in big + rest:
        bw, bh = x1 - x0, y1 - y0
        if n < 40 or bw < 6 or bh < 6:
            continue
        out.append((x0, y0, x1, y1))
    out.sort(key=lambda b: (b[1] // 20, b[0]))
    return out


def cut(im, box, bgs):
    x0, y0, x1, y1 = box
    c = strip_lines(im).crop(box).convert("RGBA")
    px = c.load()
    for y in range(c.height):
        for x in range(c.width):
            if is_bg(px[x, y], bgs):
                px[x, y] = (0, 0, 0, 0)
    return c


def cmd_list():
    os.makedirs(os.path.join(REF, "_labels"), exist_ok=True)
    for mid, bgs in BG.items():
        path = os.path.join(REF, f"{mid}.png")
        if not os.path.exists(path):
            continue
        im = Image.open(path).convert("RGBA")
        boxes = components(im, bgs)
        big = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
        d = ImageDraw.Draw(big)
        for i, (x0, y0, x1, y1) in enumerate(boxes):
            d.rectangle([x0 * 2, y0 * 2, x1 * 2 - 1, y1 * 2 - 1], outline=(255, 255, 0))
            d.rectangle([x0 * 2, y0 * 2, x0 * 2 + 18, y0 * 2 + 12], fill=(0, 0, 0))
            d.text((x0 * 2 + 2, y0 * 2), str(i), fill=(255, 255, 0))
        big.save(os.path.join(REF, "_labels", f"{mid}.png"))
        print(mid, len(boxes), "sprites", [(i, b[2] - b[0], b[3] - b[1]) for i, b in enumerate(boxes)])


def cmd_export():
    spec = json.load(open(os.path.join(ROOT, "scripts", "sheets.json"), encoding="utf-8"))
    for mid, poses in spec.items():
        if mid.startswith("_"):
            continue
        im = Image.open(os.path.join(REF, f"{mid}.png")).convert("RGBA")
        boxes = components(im, BG[mid])
        dest = os.path.join(OUT, mid)
        os.makedirs(dest, exist_ok=True)
        for f in os.listdir(dest):
            if f.endswith(".png"):
                os.remove(os.path.join(dest, f))
        for pose, idx in poses.items():
            items = idx if isinstance(idx, list) else [idx]
            for k, i in enumerate(items):
                name = pose if len(items) == 1 and not pose.endswith("_") else f"{pose.rstrip('_')}_{k}"
                cut(im, boxes[i], BG[mid]).save(os.path.join(dest, f"{name}.png"))
        print("ok", mid, {p: (v if isinstance(v, int) else len(v)) for p, v in poses.items()})


if __name__ == "__main__":
    {"list": cmd_list, "export": cmd_export}[sys.argv[1] if len(sys.argv) > 1 else "list"]()

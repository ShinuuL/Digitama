# Gera as fontes pixel do Digivice a partir da folha de glifos feita no Aseprite:
#   art/font/digivice.aseprite + art/font/charset.txt
#     → src/shared/fonts/Digivice.ttf       (traço grosso: títulos, faixas, rótulos)
#     → src/shared/fonts/DigiviceFino.ttf   (traço de 1 px)
#
#   python scripts/build-font.py [caminho-do-aseprite]
#
# Precisa de Pillow e fontTools (pip install pillow fonttools). Cada pixel vira
# um quadrado de 100 unidades num em de 800: com font-size 8px (ou 16, 24…)
# cada pixel da fonte cai num pixel da tela.
#
# A folha: células de 8×12 em 16 colunas, na ordem de charset.txt. Linhas 0–1
# da célula são o acento das maiúsculas, 2–8 a altura das maiúsculas (a base
# fica embaixo da linha 8) e 9–10 os descendentes.
import os
import subprocess
import sys
import tempfile

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CELL_W, CELL_H, COLS = 8, 12, 16
BASE_ROW = 8  # última linha acima da base
P = 100  # unidades por pixel
UPM = 800
ASCENT, DESCENT = 9 * P, 2 * P
SPACE = 3

aseprite = next(
    (p for p in [sys.argv[1] if len(sys.argv) > 1 else None, os.environ.get("ASEPRITE"), r"C:\DEV\Tools\aseprite\build\bin\aseprite.exe"] if p and os.path.exists(p)),
    "aseprite",
)
src = os.path.join(ROOT, "art", "font", "digivice.aseprite")
chars = open(os.path.join(ROOT, "art", "font", "charset.txt"), encoding="utf-8").read().strip("\n")

with tempfile.TemporaryDirectory() as tmp:
    png = os.path.join(tmp, "sheet.png")
    subprocess.run([aseprite, "-b", src, "--save-as", png], check=True, capture_output=True)
    sheet = Image.open(png).convert("RGBA")
    sheet.load()


def pixels(index):
    """Os pixels (x, y da célula) do glifo `index` da folha."""
    col, row = index % COLS, index // COLS
    out = set()
    for y in range(CELL_H):
        for x in range(CELL_W):
            px = (col * CELL_W + x, row * CELL_H + y)
            if px[0] < sheet.width and px[1] < sheet.height and sheet.getpixel(px)[3] >= 128:
                out.add((x, y))
    return out


def glyph(pix):
    """Contornos (um retângulo por trecho de linha, sentido horário) e a largura."""
    pen = TTGlyphPen(None)
    rows = {}
    for x, y in pix:
        rows.setdefault(y, []).append(x)
    for y, xs in rows.items():
        xs.sort()
        start = prev = xs[0]
        for x in xs[1:] + [None]:
            if x is not None and x == prev + 1:
                prev = x
                continue
            x0, x1 = start * P, (prev + 1) * P
            y0 = (BASE_ROW - y) * P
            y1 = y0 + P
            pen.moveTo((x0, y0))
            pen.lineTo((x0, y1))
            pen.lineTo((x1, y1))
            pen.lineTo((x1, y0))
            pen.closePath()
            if x is not None:
                start = prev = x
    width = (max(x for x, _ in pix) + 2) * P if pix else SPACE * P
    lsb = min(x for x, _ in pix) * P if pix else 0
    return pen.glyph(), width, lsb


def build(path, family, bold):
    names = [".notdef", "space"] + [f"uni{ord(c):04X}" for c in chars]
    cmap = {32: "space", 160: "space"}
    glyphs, metrics = {}, {}
    # .notdef: uma caixa vazia
    box = {(x, y) for x in range(4) for y in range(2, 9) if x in (0, 3) or y in (2, 8)}
    glyphs[".notdef"], w, lsb = glyph(box)
    metrics[".notdef"] = (w, lsb)
    empty = TTGlyphPen(None)
    glyphs["space"] = empty.glyph()
    metrics["space"] = (SPACE * P, 0)
    for i, ch in enumerate(chars):
        pix = pixels(i)
        if bold:
            pix = pix | {(x + 1, y) for x, y in pix}
        name = f"uni{ord(ch):04X}"
        glyphs[name], w, lsb = glyph(pix)
        metrics[name] = (w, lsb)
        cmap[ord(ch)] = name
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
    fb.setupNameTable({"familyName": family, "styleName": "Regular"})
    fb.setupOS2(
        sTypoAscender=ASCENT, sTypoDescender=-DESCENT, sTypoLineGap=0,
        usWinAscent=ASCENT, usWinDescent=DESCENT, sxHeight=5 * P, sCapHeight=7 * P,
        usWeightClass=700 if bold else 400, fsType=0,
    )
    fb.setupPost()
    fb.save(path)


out_dir = os.path.join(ROOT, "src", "shared", "fonts")
os.makedirs(out_dir, exist_ok=True)
build(os.path.join(out_dir, "Digivice.ttf"), "Digivice", bold=True)
build(os.path.join(out_dir, "DigiviceFino.ttf"), "Digivice Fino", bold=False)
print(f"{len(chars)} glifos → {out_dir}")

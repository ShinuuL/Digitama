-- Exporta uma pasta de art/ (fx, icons) para um módulo TypeScript (rodado
-- pelo scripts/export-art.mjs). Cada arquivo vira uma animação: os quadros como
-- grades de letras e a duração de cada um.
--
-- As cores são fixas e têm significado (o pet pinta na hora com as cores do
-- golpe, da nota…):
--   k #1a1222 contorno   w #ffffff branco   x #ff8a1e cor principal
--   y #ffd23f cor clara  d #b04a00 sombra da cor  transparente = "."
-- Qualquer outra cor é erro: a arte precisa usar só esta paleta.

local dir = app.params["dir"]
local out = app.params["out"]
local label = app.params["label"] or "fx"
assert(dir and out, "use --script-param dir=… --script-param out=…")

local PALETTE = {
  ["1a1222"] = "k",
  ["ffffff"] = "w",
  ["ff8a1e"] = "x",
  ["ffd23f"] = "y",
  ["b04a00"] = "d",
}

local files = {}
for _, name in ipairs(app.fs.listFiles(dir)) do
  if name:match("%.aseprite$") then table.insert(files, name) end
end
table.sort(files)

local lines = {
  "// GERADO por scripts/export-art.mjs a partir de art/" .. label .. "/*.aseprite. Não edite à mão:",
  "// abra o .aseprite no Aseprite, salve e rode `node scripts/export-art.mjs`.",
  "// Letras: k contorno, w branco, x cor principal, y cor clara, d sombra da cor, . vazio.",
  "",
  "export interface ArtAnim {",
  "  /** Duração de cada quadro, em ms. */",
  "  ms: number[];",
  "  frames: string[][];",
  "}",
  "",
  "export const ART = {",
}

for _, name in ipairs(files) do
  local id = name:gsub("%.aseprite$", "")
  local spr = app.open(app.fs.joinPath(dir, name))
  local ms, frames = {}, {}
  for i, frame in ipairs(spr.frames) do
    local img = Image(spr.spec)
    img:drawSprite(spr, i)
    local rows = {}
    for y = 0, img.height - 1 do
      local row = {}
      for x = 0, img.width - 1 do
        local px = img:getPixel(x, y)
        if app.pixelColor.rgbaA(px) < 128 then
          table.insert(row, ".")
        else
          local hex = string.format("%02x%02x%02x", app.pixelColor.rgbaR(px), app.pixelColor.rgbaG(px), app.pixelColor.rgbaB(px))
          local ch = PALETTE[hex]
          assert(ch, string.format("%s, quadro %d, pixel (%d,%d): cor #%s fora da paleta", name, i, x, y, hex))
          table.insert(row, ch)
        end
      end
      table.insert(rows, '"' .. table.concat(row) .. '"')
    end
    table.insert(ms, tostring(math.floor(frame.duration * 1000 + 0.5)))
    table.insert(frames, "      [" .. table.concat(rows, ", ") .. "],")
  end
  spr:close()
  table.insert(lines, string.format('  "%s": {', id))
  table.insert(lines, "    ms: [" .. table.concat(ms, ", ") .. "],")
  table.insert(lines, "    frames: [")
  for _, f in ipairs(frames) do table.insert(lines, f) end
  table.insert(lines, "    ],")
  table.insert(lines, "  },")
end

table.insert(lines, "} satisfies Record<string, ArtAnim>;")
table.insert(lines, "")
local f = assert(io.open(out, "w"))
f:write(table.concat(lines, "\n"))
f:close()
print(string.format("%d animações → %s", #files, out))

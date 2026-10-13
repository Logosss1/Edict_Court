# Top-down court scenes — art spec

Rowan approved the top-down 太和殿 in `scripts/pixel/td/taihe.mjs`. **That file is the style reference:**
3/4 RPG view (like Stardew Valley / classic 16-bit JRPG interiors), orthographic, NOT isometric. The back
wall or the far buildings sit along the top edge seen face-on; the floor or ground fills most of the
frame seen from above; round columns stand on the floor with a short shaft and a shadow falling to the
lower right; light comes from the top-left.

Render it to look at it: `node -e "import('./scripts/pixel/td/taihe.mjs').then(m=>require('fs').writeFileSync('/tmp/x.png', m.taihe().bg.toPNG()))"`.
The approved preview (with the character sprites on top) is `/mnt/project-files/court-plan/samples/太和殿俯视-白天上朝-代码版.png`.

## Hard rules

- One file per scene: `scripts/pixel/td/<key>.mjs` exporting `function <key>()` that returns `{ bg, spots }`.
  `bg` is a `Bitmap(1280, 720)` (2× detail). Use helpers from `./common.mjs`, and you may import
  the existing helpers exported by `../scenes.mjs` (hipRoof, hallBody, queTower, tree, lampTree,
  boshanlu, scrollShelf, lowDesk, mat, pottedPlant, goulan, zhilingWindow, plaster, qizhuBeam, ...).
  Add new shared helpers to `common.mjs` only if two scenes need them.
- **Tang48 palette only** (`C.*` from raster.mjs). ≤ 48 colours per scene including the sprites —
  you cannot add colours.
- No text in the art (no Chinese characters). Plaques are blank boards; the game draws the names.
- No people or animals in the background — they are sprites placed by the game at the `spots`.
- The background is the **daytime** look. Night, dusk, rain and snow are applied by the game as tints
  and particles, so do not bake shadows of a particular time beyond the usual top-left light.
- Keep the left/right/bottom edges where doors are honest: draw a visible opening where a door spot is.
- Leave clear floor where `spots` put characters; nothing tall may hide a seat or a path.
- Spots are in **world units** = pixels / 2 (the world is 640×360).
- Do not run `npm run assets` / `scripts/gen-pixel-assets.mjs` and do not write into `assets/`. Do not
  commit. Do not touch `src/`. Write your own throwaway preview PNGs under `/tmp`.
- Before you finish, render each scene, **look at the PNG yourself** (Read it), and also render a
  preview with a few character sprites from `assets/pixel/chars/*.png` (64×96 frames, 8 columns,
  frame 0 = idle facing the viewer; feet at the bottom centre of the frame) composited at the seat spots,
  so the scale is right. Iterate until it looks as good as taihe.

## spots contract (all scenes)

```js
{
  walk: [{ x0, x1, y0, y1 }, ...],   // union of rectangles where the emperor may walk (feet position)
  doors: { <sceneKey>: [x, y, w, h] }, // walking into this rect leads to that scene
  emperorStart: [x, y],              // where the emperor appears when the scene is opened directly
  title: [x, y],                     // where the game writes the scene name (bottom-centre usually)
  lanterns: [[x, y], ...],           // hanging lantern sprites (32×72 px, origin top-centre), optional
  lamps: [[x, y], ...],              // candle flame points (night glow), optional
  incense: [[x, y], ...],            // incense smoke points, optional
  npcs: [{ kind: 'eunuch'|'lady'|'guard'|'clerk', x, y, facing: 'front'|'left'|'right'|'back', act?: 'sweep'|'tray'|'lamp'|'idle'|'patrol', route?: [[x, y], ...] }],
  cat?: [[x, y], ...],               // cat wander points, optional
  birds?: true,                      // open sky: birds may fly over
  water?: [x, y, w, h],              // pond / moat area for ripples and fish, optional
}
```
Scene keys: `taihe guangchang chengtian junjichu liubu donggong yuhuayuan gongdao jiaolou yutu`.

## Scene list and connections

Layout follows the Forbidden City (names are Ming/Qing), drawn in the existing style.

| key | name | doors | must contain / extra spots |
|---|---|---|---|
| guangchang | 太和殿广场 | taihe (top centre, up the steps), chengtian (bottom centre) | Top: the 太和殿 front — three-tier white marble terrace with balustrades and a central stair, the hall's red facade and the eaves of its roof along the top edge. On the terrace: bronze cranes, turtles, a sundial 日晷 and a 嘉量. Square of big grey bricks with a raised stone imperial path down the middle. **Two columns of small bronze 品级山 rank markers** on each side of the path. A few large bronze water vats 铜缸 at the edges. Extra spots: `sundial: [x, y, r]` (centre and dial radius, the game draws the gnomon shadow), `ranks: { east: [[x,y]×6], west: [[x,y]×5] }` (where officials stand before morning court, next to the markers), `guards: [[x,y]...]`. |
| chengtian | 承天门 | guangchang (centre gate passage, top), liubu (right edge), jiaolou (left edge) | The gate tower seen from the south: red wall with five arched passages (the centre one is the door), the tower's roof along the top. Stone plaza in front with a pair of 华表 columns and stone lions. A notice board on the left and the 登闻鼓 drum on a frame on the right. Extra spots: `board: [x, y, w, h]` (the paper area where the game writes up to 5 headlines, about 96×45), `drum: [x, y]`, `flags: [[x, y]...]`, `wallTop: [[x, y]...]` (two points on top of the wall a cat can walk between), `guards: [[x, y]...]`. |
| junjichu | 军机处 | taihe (right edge), gongdao (left edge) | Council room. The back wall holds the **memorial wall (折子墙)**: 8 paper columns with red header bands, from world x 24 to 616 (column width 74), header row at y ≈ 35, then 8 slips per column at y = 52 + i·20 (so the board runs from y ≈ 24 to ≈ 216). Below it, a wooden floor with three desks for 中书令, 侍中, 尚书令 and two smaller clerk desks; shelves of scrolls, a brazier. Extra spots: `board: { x: 24, colW: 74, headerY: 35, slipY0: 52, slipDy: 20 }` (must match your drawing), `seats: { zhongshu: [x,y], menxia: [x,y], shangshu: [x,y] }` (the official's feet when seated behind the desk, facing the viewer), `clerks: [[x,y], [x,y]]`, `chain: [x, y]` (a free strip ≥ 600 wide, ~14 high, where the game writes the selected edict's flow; currently y ≈ 226). |
| liubu | 六部院 | chengtian (left edge of the courtyard) | A courtyard with **six office rooms, all visible at once**, roofs cut away so the interiors show: three rooms along the top, three along the bottom, a paved courtyard strip across the middle (a well, a tree, potted plants). Each room has an open doorway onto the courtyard, a desk with the minister's seat, a clerk's stool, a blank plaque above the doorway, and furniture for its trade: 户部 abacus and ledgers/strongbox, 礼部 ritual bronzes and books, 兵部 sand-table map and weapon rack, 刑部 scrolls of law and a 獬豸 statue, 工部 drawings, rulers and a model building, 吏部 shelves of name registers. Room order, top row left→right: hubu, libu, bingbu; bottom row: xingbu, gongbu, libu_hr. Extra spots: `rooms: { <dept>: { rect: [x,y,w,h], seat: [x,y], clerk: [x,y], plaque: [x,y], door: [x,y,w,h] } }`. `walk` must be the courtyard strip plus each room's interior, connected through the doorways. |
| donggong | 东宫 | taihe (left edge) | The crown prince's study: desk and seat for the prince, a bookcase wall, a folding screen, a window onto a small bamboo garden, a tea table, an incense burner. Extra spots: `seats: { taizi: [x, y] }`, `desk: [x, y, w, h]` (clickable). |
| yuhuayuan | 御花园 | gongdao (bottom edge) | Decorative. Rockery (堆秀山) with a small pavilion on top, a koi pond with a little bridge (`water`), ancient cypresses, flower beds, pebble mosaic paths, a square pavilion (万春亭). Extra spots: `fish: [[x, y]...]` (points inside the pond), `fireflies: [x, y, w, h]`. |
| gongdao | 宫道长街 | junjichu (left end), yuhuayuan (right end) | Decorative. A long street running left–right between two high red walls topped with yellow-glazed tiles; gates at both ends; stone lantern posts along the walls. The NPC routes walk the length of the street. |
| jiaolou | 角楼 | chengtian (right edge) | Decorative. The palace corner tower on the wall corner (upper part of the frame, the famous multi-eaved roof), the moat (护城河) across the middle with its reflection, a willow-lined bank and path along the bottom. Extra spots: `water`, `moon: [x, y]` (where the moon's reflection sits on the water). |
| yutu | 宫城舆图 | — | The palace map: a flat top-down overview on aged paper, the walls, moat, axis and each building drawn small. Extra spots: `places: { <sceneKey>: [x, y, w, h] }` (one clickable rect per scene above, except yutu), `label: { <sceneKey>: [x, y] }`. No `walk`, no doors, no emperor. |

Characters: add an `eunuch` (内侍) to `scripts/pixel/characters.mjs` (`CHARACTERS` table plus whatever
drawing support it needs): beardless, a dark green/blue-grey robe, a small soft cap, holding a fly-whisk
(拂尘) in the idle pose. Every animation in `anims.json` must exist for it, like the others.

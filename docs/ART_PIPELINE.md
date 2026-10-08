# 像素美术管线（两步走，美术不阻塞开发）

## 规格锁（风格一致性的前提）

1.2.1 起改为 **2 倍精度**：美术按 1280×720 绘制，朝堂世界坐标仍是 640×360（相机 ×2，精灵 ×0.5 显示），因此逻辑、站位、热点坐标都不变，只是每个世界单位里有 2×2 个像素可画细节。

| 项 | 规格 |
|---|---|
| 场景 | **1280×720**，`assets/pixel/scenes/<key>.png`；同名 `.json` 记录门、灯、香炉、灯笼、告示榜等热点（世界坐标） |
| 角色 | **64×96 / 帧**（显示为 32×48 世界单位），8 列；帧布局写在 `src/renderer/court/game/anims.json`，生成器与运行时共用 |
| 动作 | 29 组 × 4 帧 = 116 帧，精灵表 **512×1440**：待机、四向行走、说话、思考、跪拜、封驳、作揖、呈奏、阅卷、书写、用印、派发、算盘、检索、远眺、筹谋、执法、丈量、忧虑、欢喜、惶恐、品茶、伸懒腰、张望、坐姿待机 / 说话 / 书写 |
| 调色板 | **Tang48**（47 色 + 透明，前 31 色与旧 Tang32 相同），每场景（背景 + 该场景全部角色 + 道具）≤48 色；`tang48.gpl` 可直接导入 Aseprite / LibreSprite |
| 描边 | 统一 1px 墨色外描边（#1a1220） |
| 明暗 | 光源左上：左 / 上缘亮色，右侧 2–3px 暗色，下摆暗色 |
| 半透明 | 禁止（导入时按 alpha<128 透明吸附） |
| 唐制参考 | 庑殿顶缓坡深檐、硕大斗拱、鸱尾、灰瓦绿剪边、朱柱粉壁、直棂窗、七朱八白阑额、莲花柱础与莲花纹方砖、宝帐御床、青绿山水屏风、灯树、博山炉；承天门为夯土包砖城台、过梁式门道、阙楼；服饰为圆领袍、软脚幞头、革带銙、鱼袋、笏板，刑部獬豸冠，皇帝赭黄 |

`scripts/gen-pixel-assets.mjs` 生成时会校验每个场景的色数（见 `assets/pixel/report.json`）。

## 第一步：占位阶段（已完成）

全部由代码生成（`scripts/pixel/*.mjs`）：16 套角色精灵表（皇上坐姿、太子金冠、三省紫袍、六部各色官袍与幞头、持戟金吾卫、执障扇宫人、军机处章京）、4 个唐风场景（太和殿：御座高台 + 屏风 + 仪仗 + 列班；军机处：折子墙；六部值房：内嵌实时面板的屏风；承天门：城楼 + 诏令告示墙 + 登闻鼓）、道具（折子、奏折、障扇、书案、朱印……）。四场景与全部 L2 交互都已基于占位素材跑通。

## 第二步：正式美术阶段（需要生图模型，本构建环境未执行）

> 本构建环境无法调用 Seedream / Flux 等生图服务，因此**正式美术尚未生成**。以下是完整可执行的管线与 prompt 包，产出后一条命令即可替换占位素材。

### 1. 先出角色定稿（每个角色 1 张正面立绘）

通用前缀（强制关键词）：

```
16-bit pixel art, Tang dynasty, limited palette, sprite sheet, no anti-aliasing,
crisp 1px dark outline, light from top-left, flat shading with 2-3 tones per material,
character 64x96 pixels, front view, full body, transparent background
```

| key | 角色描述（追加在前缀后） |
|---|---|
| emperor | Tang emperor seated on a golden throne, ochre-yellow round-collar robe with dragon roundels, black futou hat with upright wings, stern and dignified |
| taizi | crown prince, crimson round-collar robe, small golden crown, holding an ivory hu tablet |
| zhongshu | chancellor of the Secretariat, purple round-collar robe, black futou hat, short beard, ivory hu tablet |
| menxia | chancellor of the Chancellery (reviewer), purple robe, long black beard, severe expression, ivory hu tablet |
| shangshu | head of the Department of State Affairs, purple robe, black futou, holding a scroll list |
| bingbu | minister of war, crimson robe with a steel breastplate, black futou |
| xingbu | minister of justice, dark blue-black robe, long beard |
| gongbu | minister of works, teal robe |
| libu | minister of rites, green robe, holding a paper scroll |
| hubu | minister of revenue, crimson robe, abacus at belt |
| libu_hr | minister of personnel, light purple robe, holding a register |
| guard | Tang palace guard, mingguang armor, red tassel helmet, halberd |
| lady | Tang court lady, high hair bun with gold pins, red dress, shawl |

### 2. 以定稿为参考图批量出动作帧

参考图 + 同一 seed，逐动作生成：`idle breathing 2 frames` / `walking down 4 frames` / `walking up (back view) 4 frames` / `walking side (facing right) 4 frames` / `talking with raised sleeve 2 frames` / `thinking, hand on chin 2 frames` / `kneeling and bowing (kowtow) 2 frames` / `raising the hu tablet horizontally in objection 2 frames`，要求 `same character, same palette, same proportions, 64x96 per frame`（动作清单见 `anims.json`）。

### 3. 场景

```
16-bit pixel art, Tang dynasty, limited palette, no anti-aliasing, 1280x720, orthographic 3/4 top-down view,
```
- **taihe**：`interior of the Hall of Supreme Harmony: raised three-tier white marble dais at top center, golden dragon folding screen, empty golden throne, vermilion pillars with blue-green dougong brackets, dark polished floor bricks, red carpet down the middle, hanging palace lanterns, bronze incense tripods, open space on both sides for two ranks of officials`
- **junjichu**：`Grand Council office: wooden walls, a large paper board with eight red header columns for memorials, three low writing desks, bookshelves, lanterns`
- **liubu**：`ministry office: red walls, a large blank hanging paper screen on the right two thirds, a name plaque top-left, lattice window, writing desk, bookshelf, incense burner`
- **chengtian**：`Chengtian Gate of Chang'an: gate tower with grey tile hip roof and green chiwen, rammed red brick city wall with three arched gateways, stone plaza, a wooden imperial notice board on the left, a big drum on a frame on the right, banners, blue sky`

### 4. Aseprite / LibreSprite 规整

1. `File → Import Sprite Sheet`（或打开生成图），`Sprite → Canvas Size` 对齐到 512×1440（角色）/ 1280×720（场景）；若生成图是 N 倍放大，先按 N 缩小（`Sprite Size`，Nearest）。
2. `View → Grid Settings`：64×96（角色）；逐帧对齐。
3. `Sprite → Color Mode → Indexed`，调色板选 `assets/pixel/tang48.gpl`（关闭抖动）。
4. 修正描边与明暗规则，删除半透明像素，导出 PNG（8-bit，非隔行）。

### 5. 一条命令替换占位素材

```bash
node scripts/art/import-art.mjs char zhongshu ~/Desktop/zhongshu.png            # 已是 512×1440
node scripts/art/import-art.mjs char menxia  ~/Desktop/menxia@4x.png --downscale 4  # 生成图为 4 倍放大
node scripts/art/import-art.mjs scene taihe  ~/Desktop/taihe.png
node scripts/art/import-art.mjs prop  zhezi_doing ~/Desktop/zhezi.png
```

导入工具会：按块多数表决对齐像素网格 → 吸附到 Tang48 → 校验尺寸与 ≤48 色 → 备份占位图到 `assets/pixel/_placeholder/` → 写入并登记 `assets/pixel/formal-art.json`（之后重新生成占位素材时不会覆盖正式美术）。`tests/unit.test.ts` 中有「模糊 4 倍放大图可还原为逐像素一致原图」的回归测试。

场景中的角色站位、屏风（六部实时面板）位置等坐标写在 `src/renderer/court/game/scenes.ts`，门 / 灯 / 香炉等热点写在 `scripts/pixel/scenes.mjs` 并随场景 `.json` 输出；若正式场景构图改变，需同步调整。

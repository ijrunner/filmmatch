# 配方数据契约 · Schema v1.3

- 日期：2026-09-25（R18 · 色彩表达力 II）
- 状态：草案 v1.3（在 v1.2 基础上的只增不删扩展；`SCHEMA_VERSION` 升为 **1.3**）
- 依据：`docs/prd/配方Schema-v1.md`（全结构不变）、`配方Schema-v1.1.md`（质感段）、`配方Schema-v1.2.md`（分离色调 + R17 `output.range`）。
  本版新增三组字段：`color.look.coupling`（染料串扰六系数）、`color.look.hsl`（HSL 8 色相，仅网页与 .cube 承载）、顶层 `anchors`（按管线锚点标定）。

## 版本说明

1. **只增不删**：不删除、不改名、不改语义任何既有字段。
2. **读方忽略未知字段**：解析器遇到不认识的字段一律跳过，不报错。
3. **旧 v1 / v1.1 / v1.2 配方可直接读入**：缺失的新字段不写入运行时对象（而非补默认键），
   语义回落「恒等 / 历史固定矩阵」——因此旧配方读入后的**渲染输出与 R18 之前逐位一致**（有逐位测试）。
4. **实现单一真源**：
   - 串扰矩阵：`app/src/engine/look.ts`（`DEFAULT_COUPLING` / `normalizeCoupling` / `dyeCross`，文件头有冻结数学定义）；
   - HSL：`app/src/engine/look.ts`（`hslAdjustRgb` / `rgbToHsv` / `hsvToRgb` / 带表常量）；
   - 锚点：`app/src/film/effectmath.ts`（`anchorsToLookCal` / `lookCalToAnchors` / `lookTonalLandings`）+ `app/src/dctl/logmath.ts`（`anchorsFromLook`，TF 编码侧）。
   - GLSL 镜像（`film/pipeline.ts` 的 `GRADE_FS`）、对数域（`dctl/logmath.ts`）、DCTL（`dctl/codegen.ts`）逐式镜像；一致性由 `film/lookshader.test.ts` / `dctl/consistency-chain.test.ts` / `film/r18-coupling.test.ts` 钉死。
5. **版本号策略**：写出恒为 `1.3`；读方接受 `1 / 1.1 / 1.2 / 1.3`
   （`app/src/ui/recipe.ts` 的 `SCHEMA_VERSION` / `SUPPORTED_SCHEMA_VERSIONS`；`app/src/share/code.ts` 的完整码解码同样接受 1.3）。
   导入时版本号不在集合内或字段越界 → 可读错误（`app/src/ui/storage.ts` 的 `parseRecipe` / `validateRecipeRanges`）。

## 1. `color.look.coupling` —— 六项独立染料串扰（R18 / C4）

**语义（冻结，改 `engine/look.ts` 即改四处镜像）**：有效串扰矩阵
`M = I + k·(C − I)`，其中 `k = color.look.dye_coupling`（既有总强度，默认 0），`C` 为
「完全串扰矩阵」：

```
       ⎡ 0     rg    rb ⎤
C  =   ⎢ gr    0.2   gb ⎥        （对角 = 乳剂自抑制先验，冻结常量，不进 UI）
       ⎣ br    bg   −0.6 ⎦
```

即逐通道：`r' = r(1−k) + g·k·rg + b·k·rb`、`g' = r·k·gr + g(1−0.8k) + b·k·gb`、
`b' = r·k·br + g·k·bg + b(1−1.6k)`。

| 键 | 语义（X 行 Y 列 = 通道 Y 串入通道 X 的强度） | 范围 | 默认（= 历史固定矩阵对应项） |
|---|---|---|---|
| `rg` | G 串入 R | 0–2 | 0.55 |
| `rb` | B 串入 R | 0–2 | 0.30 |
| `gr` | R 串入 G | 0–2 | 0.35 |
| `gb` | B 串入 G | 0–2 | 0.45 |
| `br` | R 串入 B | 0–2 | 0.25 |
| `bg` | G 串入 B | 0–2 | 0.35 |

- **兼容性**：`coupling` 为可选对象；缺省或缺键回落默认值 → 与 R18 之前唯一写死的固定矩阵
  **逐位一致**（`d.x = r(1−k) + g(k×0.55) + …` 的同一浮点运算序列）。
  `k = 0` 时任意 coupling 均恒等（默认值恒等护栏 2）。
- **序列化**：`color.look.coupling = { rg: {value, origin}, … }`（Schema 包装，与 look 平键同构）；
  仅在运行时对象存在时写出（旧配方不添新键）。origins 键 = `look.coupling.rg` 等。
- **UI**：进阶模式「复古褪色」组新增 6 滑杆（`串扰 R←G` 等，0–1.5）；简单模式不露（不影响 E2E 基线）。
- **DCTL**：六系数**以常量烘焙**进生成源码（不新增 UI 参数——参数预算含内联匹配段已 63/64）。
  默认系数按历史字面量输出（产物逐字节不变）；自定义时按 4 位小数常量内联。总强度 `FM_CROSSTALK` 参数保留。

## 2. `color.look.hsl` —— HSL 8 色相（R18；仅网页预览与 .cube 承载）

**语义（LR HSL 语义近似；单一真源 `engine/look.ts`）**：8 窄带色相
（红 0° / 橙 30° / 黄 60° / 绿 120° / 青 180° / 蓝 240° / 紫 280° / 品红 320°）× 三通道：

| 键（每色相 ×3） | 范围 | 默认 | 量纲 |
|---|---|---|---|
| `hue` | −1–1 | 0 | ±1 = ±30°（LR HueAdjustment 满量程；正 = 顺时针，红→橙） |
| `sat` | −1–1 | 0 | 饱和 ×(1 ± 0.75) |
| `lum` | −1–1 | 0 | 明度 ×(1 ± 0.30) |

- 权重：色相圆距平滑衰减（CORE 15° 内全权重、EDGE 45° 外为 0），按带总和归一；
  相邻带最大间隔 60° = 2×EDGE → 全轮无死区。权重从原始色相计算（不随偏移重算）。
- 灰（s=0）不受 hue/sat 影响、lum 仍生效；输出恒在 0..1。
- **恒等**：缺省或全 0 → 整段跳过（不做 HSV 往返），输出逐位不变。
- **承载边界（诚实标注）**：HSL 只进网页预览（GRADE_FS `u_hsl[8]` uniform）与 `.cube` 导出
  （`bakeRecipeLUT` → `lookTransform`）。**不进 DCTL 面板/源码**——参数预算不足（63/64，见
  EFFECT-REPORT-R18 §HSL 取舍建议）；配方带 HSL 时 DCTL 生成器显式警告。
- **序列化**：`color.look.hsl = { red: { hue: {value, origin}, sat: …, lum: … }, … }`；
  仅写出存在的通道；origins 键 = `look.hsl.red.hue` 等。

## 3. `anchors` —— 按管线锚点标定（R18 / C3，顶层可选字段）

**语义（冻结，`film/effectmath.ts`）**：锚点描述「卡的关键点位在该管线归一化工作域中的落点」：

| 字段路径 | 语义 | 范围 |
|---|---|---|
| `anchors.yrgb.{black,white,pivot}` | YRGB 管线（BT.1886→log2 归一化）下输入黑/白经 look 后的落点与中灰枢轴（0.5） | 0–1 |
| `anchors.rcm.{black,white,pivot}` | RCM/DaVinci Intermediate（对数域重归一化=恒等）下的同三元组（pivot 0.333） | 0–1 |

- **look 褪色层落点公式（显示域与对数域同式）**：`blk = black_lift + 0.1×fade`、`wht = 1 − 0.08×fade`。
- **重标定（切管线时）**：`fade = (1 − white)/0.08`、`black_lift = black − 0.1×fade`（负值取 0）、
  `pivot = anchors.pivot`。由 `anchorsToLookCal` 实现，写入对数域 `LogLookParams.{fade, black_lift, pivot}`
  （`black_lift` 为 R18 新增可选字段，仅锚点路径非零；DCTL 侧烘焙为常量 `lp.black_extra`，不占 UI 参数）。
- **推导方向**：`anchorsFromLook(look, tf)` = 显示域落点经管线 TF 编码（与 `anchorsToLookCal` 互为正逆）。
- **兼容性**：可选字段；卡/配方无 anchors → 不触发重标定，DCTL 产物与 R18 之前逐字节一致。
  内置卡中 **fl05 / fl06** 携带示例锚点（推导式：`D = black_lift + 0.1×fade`、`W = 1 − 0.08×fade`，
  yrgb 侧再经 `tfEncode`；见 `film/r18-anchors.test.ts`），其余卡不带。
- **效果（数值台实测，`tools/alignment-report.mjs` r18 节）**：带锚点卡在两条管线的显示域黑位
  漂移 ≤ 1e-15（fl05 无锚点时 yrgb 0.0144 / rcm 0.018 → 有锚点 ≈ 0）。
- **序列化**：配方顶层 `anchors: { yrgb?: {black,white,pivot}, rcm?: {…} }`（裸数值，非 Schema 包装——
  它是标定元数据而非滑杆参数）；不进配方码 hash。origins 机制不涉及。

## 迁移矩阵（读方兼容）

| 读入版本 | coupling | hsl | anchors | 行为 |
|---|---|---|---|---|
| 1 / 1.1 | 缺省 → 历史固定矩阵 | 缺省 → 恒等 | 缺省 → 不重标定 | 与 R18 之前逐位一致（有逐位测试） |
| 1.2 | 同上 | 同上 | 同上 | 同上 |
| 1.3 | 有则按六系数 | 有则启用（仅网页/.cube） | 有则切管线重标定 | 新维度生效 |

- 越界校验（`validateRecipeRanges`）：`coupling.*` ∈ [0,2]、`hsl.*.{hue,sat,lum}` ∈ [−1,1]、
  `anchors.*.{black,white,pivot}` ∈ [0,1]；越界/非有限 → 可读错误（含字段路径）。
- 回环：导出 → 导入逐位一致（`ui/recipe.test.ts` R18 节）；旧版读入后重新导出升为 1.3
  （`ui/schema-matrix.test.ts` 矩阵补 1.3 行）。

## 关联交付物（R18）

- 串扰六系数：`film/r18-coupling.test.ts`（逐位兼容 + DCTL 常量烘焙 + 参数计数不变）。
- 锚点：`film/r18-anchors.test.ts`（重标定数学 + 双管线落点一致 + 卡示例值推导）。
- HSL：`engine/hsl.test.ts`（方向/量纲/恒等/区间）+ `film/lookshader.test.ts`（GLSL 镜像，含 HSL 的
  7 组 look × 1108 点 max 分量差 3.3e-16）+ `dctl/codegen.test.ts`（诚实警告）。
- XMP 映射（R15 接管）：`estimate/xmpmap.ts` 的 HSL 8×3 → `look.hsl`、Calibration `ShadowTint` →
  `split_shadow_*`（三原色 Hue·Saturation 保持 unmapped）。

#!/bin/bash
# FilmMatch P1+R2 E2E 验收截图（F11/F12/F13/标注编辑器/导入面板/分享回路/矩阵档位/标签筛选）
# 用法：bash tools/e2e-shots.sh（要求先 npx vite build 产出 dist/）
# 流程：本地静态服务(8137) → 无头 Chromium（SwiftShader）截图 → tools/e2e-verify.mjs 断言
set -u
cd "$(dirname "$0")/.." || exit 1
CHROME=${CHROME:-/usr/bin/chromium}
PORT=${FM_E2E_PORT:-8137}
OUT=tools/e2e
FLAGS=(--headless --hide-scrollbars --disable-dev-shm-usage --no-sandbox
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
  --window-size=1680,1050 --virtual-time-budget=9000)

if [ ! -f dist/index.html ]; then
  echo "[e2e] 缺少 dist/index.html —— 先执行 npx vite build"; exit 1
fi

node tools/e2e-serve.mjs "$PORT" dist &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null' EXIT
for _ in $(seq 1 50); do
  if node -e "fetch('http://127.0.0.1:$PORT/index.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 0.1
done

mkdir -p "$OUT"
shoot() { # shoot <名称> <hash> [dump] [窗口尺寸 WxH]
  local name=$1 hash=$2 dump=${3:-} size=${4:-}
  local extra=(); [ -n "$size" ] && extra=(--window-size="$size")
  "$CHROME" "${FLAGS[@]}" "${extra[@]}" --screenshot="$OUT/$name.png" "http://127.0.0.1:$PORT/index.html#$hash" >"$OUT/$name.log" 2>&1
  if [ -s "$OUT/$name.png" ]; then echo "[ok] $name ($(stat -c%s "$OUT/$name.png")B)"; else echo "[FAIL] $name"; tail -3 "$OUT/$name.log"; fi
  if [ "$dump" = "dump" ]; then
    "$CHROME" "${FLAGS[@]}" "${extra[@]}" --dump-dom "http://127.0.0.1:$PORT/index.html#$hash" > "$OUT/$name.dom" 2>/dev/null
  fi
}
# 宽预算变体：demo 流程里缩略图 GPU 渲染量大（风格卡 14 张后），首烘会被 9s 虚拟时间窗
# 挤掉 → 画布白屏入基线（R20 起 p8-05/06/07 的回归）。虚拟时间放宽到 30s，烘焙完成后才截图。
shootb() { # shootb <名称> <hash> [dump]
  local name=$1 hash=$2 dump=${3:-}
  "$CHROME" "${FLAGS[@]}" --virtual-time-budget=30000 --screenshot="$OUT/$name.png" "http://127.0.0.1:$PORT/index.html#$hash" >"$OUT/$name.log" 2>&1
  if [ -s "$OUT/$name.png" ]; then echo "[ok] $name ($(stat -c%s "$OUT/$name.png")B)"; else echo "[FAIL] $name"; tail -3 "$OUT/$name.log"; fi
  if [ "$dump" = "dump" ]; then
    "$CHROME" "${FLAGS[@]}" --virtual-time-budget=30000 --dump-dom "http://127.0.0.1:$PORT/index.html#$hash" > "$OUT/$name.dom" 2>/dev/null
  fi
}

# 基线与 P1 场景（freeze=1：颗粒相位固定，截图逐像素可复现）
shoot p1-01-default      "src=neon&freeze=1&t=0.5"                                                 dump
shoot p1-02-stockwall    "src=neon&demo=stockwall&freeze=1&t=0.5"                                  dump
shoot p1-03-import       "demo=import&freeze=1&t=0.5"                                              dump
shoot p1-04-guide        "src=neon&ref=stock:fl05&demo=guide&freeze=1&t=0.5"                       dump
shoot p1-04b-guide-off   "src=neon&ref=stock:fl05&freeze=1&t=0.5"                                  dump
shoot p1-05-annotate     "src=neon&demo=annotate&freeze=1&t=0.5"                                   dump
shoot p1-06-shareloop    "src=neon&demo=shareloop&freeze=1&t=0.5"                                  dump
# F12 同帧型号全帧（两两像素差异断言；黄昏帧含大面积中间调/高光，观感差异不被暗部稀释）
# R2：型号卡 5 → 10 张（fl01..fl10），逐张截图供两两差异断言
for p in fl01 fl02 fl03 fl04 fl05 fl06 fl07 fl08 fl09 fl10; do
  shoot "p1-stock-$p" "src=dusk&ref=stock:$p&freeze=1&t=0.5"
done

# R14 新增：展开④调配方面板（型号卡参考 → 匹配组应为「不适用」禁用态；锁进视觉基线防回归）
shoot p1-07-panel-stock "src=neon&ref=stock:fl06&demo=adjust&freeze=1&t=0.5" dump
# R2 新增：矩阵档位对比（同帧同预览区，画幅/ISO/光晕档均不同）+ 标签筛选
# p2-00：同帧「原图」（无参考）——型号全帧「与原图差」的对照基准
shoot p2-00-dusk-orig   "src=dusk&freeze=1&t=0.5"
shoot p2-01-matrix      "src=chart&demo=matrix&freeze=1&t=0.5"     dump
shoot p2-02-matrix-std  "src=chart&demo=matrixstd&freeze=1&t=0.5"  dump
shoot p2-03-tagfilter   "src=chart&demo=tagfilter&freeze=1&t=0.5"  dump

# R3 新增：批量匹配（F14）——合成测试集（7 段）+ 逐段 CDL + 统一风格层 + 打包（不下载）
shoot p3-01-batch    "view=batch&demo=batch&freeze=1&t=0.5"    dump
shoot p3-02-batch-b  "view=batch&demo=batchb&freeze=1&t=0.5"   dump
# R7 新增：逐段单节点 DCTL（每段一个 .dctl，内联该段 CDL）
shoot p3-03-batch-single "view=batch&demo=batchsingle&freeze=1&t=0.5" dump

# R4 新增：DCTL 生成页（YRGB×fl06 / RCM×fl05）——生成源码 + 一致性核验
# R6 新增：分层导出与双语标签两个形态
shoot p4-01-dctl      "view=dctl&demo=dctl&freeze=1&t=0.5"      dump
shoot p4-02-dctl-rcm  "view=dctl&demo=dctl-rcm&freeze=1&t=0.5"  dump
# R4 一致性核验：加高视口以把「gamma 空间 look vs 对数域 look」并排画布整页入镜（数值断言走 meta）
shoot p4-03-dctl-consistency "view=dctl&demo=dctl&freeze=1&t=0.5" "" 1680x2400
# R6 新增：分层导出（只色彩层）与双语标签（中英混排 + 分组前缀 + tooltip）
shoot p4-04-dctl-stages "view=dctl&demo=dctl-stages&freeze=1&t=0.5" dump
shoot p4-05-dctl-labels "view=dctl&demo=dctl-labels&freeze=1&t=0.5" dump
# R7 新增：内联 CDL 匹配段（单节点导出；ref=stock:fl06 让工作台解算出真实系数）
shoot p4-06-dctl-match "src=neon&view=dctl&demo=dctl-match&freeze=1&t=0.5" dump
# R8 新增：风格卡（6 张冲印工艺/时代感维度）与预设导入导出回环
shoot p6-01-styles   "src=neon&demo=styles&freeze=1&t=0.5"    dump
shoot p6-02-presetio "src=neon&demo=presetio&freeze=1&t=0.5"  dump
# R10 新增：拖动性能守门（虚拟时间下计时不可用，但烘焙次数/体素是确定性计数）
shoot p7-01-perf "src=neon&ref=stock:fl06&demo=perf&perfEvents=30&freeze=1&t=0.5" dump
# R5 新增：工作台 ⑤ 节点包导出区（搭建清单 + 实验性 .drx）
shoot p5-01-drx       "src=neon&ref=stock:fl06&demo=drx&freeze=1&t=0.5"  dump

# R16 新增：对比开关左移固定（预览左上角常驻浮层）+ 预览 HUD + 组级重置
# p8-01/p8-02：浮层常驻（调色态 / 分屏态）；浮层与 ④ 入口分段控件同步断言走 meta + dump-dom
shoot p8-01-viewhud        "src=neon&ref=stock:fl06&demo=overlay&freeze=1&t=0.5"           dump
shoot p8-02-viewhud-split  "src=neon&ref=stock:fl06&demo=overlay&split=0.5&freeze=1&t=0.5" dump
# p8-03/p8-04：组级重置前后（「复古褪色」组：fade 0.55/sat 0.35/冷偏 → 点「重置本组」→ 回到初始）
shoot p8-03-groupreset     "src=neon&ref=stock:fl06&demo=groupreset&freeze=1&t=0.5"         dump
shoot p8-04-groupreset-ok  "src=neon&ref=stock:fl06&demo=groupreset&reset=1&freeze=1&t=0.5" dump
# R15 新增：XMP 预设导入（合成 fixture：品牌词名 / 全中性 / 损坏 → 估算起点卡落风格卡 tab）
# p8-05：导入结果与卡片网格（meta 断言：卡数/清洗名/恒等护栏/应用链路）；p8-06：应用品牌卡后画面可辨
shootb p8-05-xmpimport          "src=neon&demo=xmpimport&freeze=1&t=0.5"                dump
shootb p8-06-xmpimport-apply    "src=neon&demo=xmpimport&apply=brand&freeze=1&t=0.5"    dump
# R19 新增：卡片墙三分组筛选（&filter=mine 让 demo 结束在「我的卡」态：只显 XMP 估算起点卡，内置墙隐藏）
shootb p8-07-xmpfilter          "src=neon&demo=xmpimport&filter=mine&freeze=1&t=0.5"    dump

# R17 新增：GPU tile-atlas 烘焙一致性 + 数据范围开关（⑤ 区分段控件 + .cube 头部范围声明 + HUD 范围字段）
# p9-01：rangeCheck（full vs legal 导出对比）+ bakeConsistency（SwiftShader 真实 GPU vs CPU 烘焙逐点对比，<1e-3）
# p9-02：&rangeSel=legal → 开关切到 Legal（HUD/控件状态切换；画面不变——数据范围只声明导出目标）
shoot p9-01-range              "src=neon&ref=lib:lib_neon_fl05&demo=range&freeze=1&t=0.5"            dump
shoot p9-02-range-legal        "src=neon&ref=lib:lib_neon_fl05&demo=range&rangeSel=legal&freeze=1&t=0.5" dump

node tools/e2e-verify.mjs "$OUT"
VERIFY=$?
# R11 视觉回归：与 tools/e2e/visual-baseline.json 的紧凑签名比对（改动 UI 且确认无误后跑 --record 更新基线）
node tools/visual-baseline.mjs
VISUAL=$?
[ $VERIFY -ne 0 ] && exit $VERIFY
exit $VISUAL

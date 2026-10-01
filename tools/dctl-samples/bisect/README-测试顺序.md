# 达芬奇 DCTL 诊断包 · 测试顺序（2026-09-22 第六轮）

## 结论：闪退根因已定位并修复

**根因**：`DEFINE_UI_PARAMS` 声明的 UI 参数被写在自定义 `__DEVICE__` 助手函数里。
Resolve 只把参数注入 `transform()` 的**局部作用域**（官方文档原话：
"This variable can be used inside the transform function."），helper 里读 `FM_XXX`
属于未定义作用域 → 达芬奇直接闪退（连错误对话框都不弹）。

**证据**：本地 15 个文件的构造差分完全分离——崩的（30/43/三个样例）都在
`fm_look_channel` / `fm_log_look` 里引用参数；能用的（20–24、40–42）一个都没引用。
公开项目 17 个 DCTL 同样无一例外：需要时一律显式传参或传结构体。

**修法**：参数在 `transform()` 里读出 → 打包成 `FmChannelParams` / `FmLookParams`
结构体 → 显式传给 helper。`validateDctl` 已加规则拦死这类写法（回归测试覆盖）。

## 现在只需测这三个（约 20 秒）

| 顺序 | 文件 | 预期 | 说明 |
| --- | --- | --- | --- |
| 1 | `61_params_in_helper.dctl` | **闪退** | 最小复现（12 行）：helper 里直接读 UI 参数 |
| 2 | `62_params_as_arg.dctl` | 正常出效果 | 同一份代码，只把参数改成显式传入 |
| 3 | `60_fixed_color_only.dctl` | 正常出效果 | 修好的真实色彩管线（对数域 look + 边缘色散） |

1 崩、2 好 = 根因确认闭环（这两个文件只差一处）。3 好 = 修复后的真实管线可用。
若 3 也正常，请再测 `FM_*.dctl` 三个样例（同样已修复）。

**想直接看证据**：61 闪退后，在 `~/.local/share/DaVinciResolve/logs/davinci_resolve.log`
（或 ResolveDebug.txt）里搜 `undeclared identifier`，应能看到编译器抱怨的正是 `FM_GAIN`。

## 已知可用基线（保留备查，可跳过）

| 文件 | 采样次数 | 结构 | 此前实测 |
| --- | --- | --- | --- |
| `40_tap_28_flat.dctl` | 84 | 裸块 | ✅ 正常 |
| `41_tap_09_inif.dctl` | 27 | if 包抽头 | ✅ 正常 |
| `42_tap_28_inif.dctl` | 84 | if 包抽头 | ✅ 正常 |

这三个已证明「84 次采样」与「抽头包在 if 里」都不是闪退原因。

## 已作废并删除的历史诊断文件

`30–34`（分层二分）、`43`（无分支）、`50–57`（数学探针）：它们排除了采样次数、`if`、
`_expf`、死函数、裸向量声明、提前 return、硬件配置，根因确定后不再需要，留着只会混淆。
记录见 `app/tools/EFFECT-REPORT-R4.md` §7。

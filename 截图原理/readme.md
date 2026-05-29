# 截图原理

本文只说明 Python 端如何截图，以及截图数据的基本像素格式。

Fuyutsui 的 Python 端会截取游戏窗口客户区的极窄区域，读取插件端绘制在屏幕上的像素条。本文只关注截图实现本身，不展开像素值所代表的业务语义。

## 截图使用的库

主运行链路使用的是 Python 库 `mss`。

在调用 `mss` 截图前，`GetPixels.py` 第 14-18 行还调用了 `SetProcessDPIAware()` 解决 Windows 高 DPI 缩放对截图坐标的影响。若不调用此 API，`ClientToScreen` 返回的窗口坐标在高 DPI 显示器上会被缩放偏移，导致截图位置错误。

证据在 `Fuyutsui/Fuyutsui/GetPixels.py`：

```python
import mss
```

`GetPixels.py` 通过线程局部缓存创建 `mss.mss()` 实例：

```python
def _get_sct():
    if not hasattr(_tls, "sct"):
        _tls.sct = mss.mss()
    return _tls.sct
```

`_tls` 使用 `threading.local`（`GetPixels.py` 第 25-32 行）让每个线程持有自己的 `mss.mss()` 单例，因为 mss 的 DC（设备上下文）是线程局部的，不能跨线程共享。

此外，`logic_gui.py` 还使用 `_state_lock = threading.Lock()`（第 220 行）来保护 `_state_dict` 的读写：截图线程写入时加锁（第 418-423 行），GUI 线程读取时同样加锁（第 894-900 行、第 1047-1051 行），构成完整的两层次线程安全设计。

此外还定义了 `PIXELS_PER_ROW = 255`（第 23 行），扫描循环使用 `min(PIXELS_PER_ROW, width)` 限制处理范围，即使窗口宽度超过 255 也只处理前 255 像素。

真正的截图发生在 `scan_screen_data()` 中，主要调用 `sct.grab(...)`：

```python
top_img = sct.grab({"top": base_y, "left": base_x, "width": width, "height": 1})
left_img = sct.grab({"top": base_y, "left": base_x, "width": 1, "height": height})
# 第三个 grab 有条件执行：仅在 left_img 中发现红色标记时执行
# marker_row_img = sct.grab({"top": base_y + marker_y, "left": base_x, "width": width, "height": 1})
```

`Fuyutsui/Fuyutsui/requirements.txt` 也把 `mss>=9.0.0` 列为运行依赖。

## 不是主链路的截图代码

`Fuyutsui/Fuyutsui/other/GetRGB.py` 使用了 `pyautogui` 和 `PIL.ImageGrab`：

```python
import pyautogui
from PIL import ImageGrab
```

这个脚本按鼠标当前位置截取 1x1 像素并打印 RGB，更像是调试或取色辅助工具。主 GUI 与战斗逻辑没有从这里读取游戏状态；主 GUI 在 `Fuyutsui/Fuyutsui/logic_gui.py` 中导入的是：

```python
from GetPixels import get_info
```

后台循环（`_run_priest_loop()`）每 `LOGIC_INTERVAL=0.2` 秒调用一次 `get_info()`（`logic_gui.py` 第 115、404-408 行）。扫描结果经 `_state_lock` 保护存入 `_state_dict`（第 418-423 行），供 GUI 线程和其他逻辑线程安全读取，所以实际运行时的状态扫描入口仍然是 `GetPixels.py` 的 `mss` 截图逻辑。

`Fuyutsui/Fuyutsui/other/GetInfo.py` 是另一个使用 `mss` 截图的独立实现，与主文件 `GetPixels.py` 存在以下差异：
- 使用 `with mss.mss() as sct:` 上下文管理器创建实例，而非 `_get_sct()` 线程局部缓存
- `PIXELS_PER_ROW=200`（主文件为 255）
- 仅实现了 `scan_top_bar()`（扫描顶部长条），**没有** `scan_screen_data()` 的左边界标记扫描逻辑
- 没有 `bar_data` 相关机制，因此不支持配置中的 `step: bar` 调度
- 可作为轻量参考理解截图基本原理，但实际运行时不被 GUI 主循环使用

## 截图范围

`scan_screen_data()` 不是整屏截图，而是先通过 Windows API 找到标题为 `魔兽世界` 的窗口客户区，再截取几个很窄的区域（典型场景下最多三次截图，而非固定三次）：

- 顶部一行：`width x 1`，用于读取插件端顶部长条，总是执行。扫描时实际使用 `min(PIXELS_PER_ROW, width)` 限制（`PIXELS_PER_ROW=255`），即使窗口宽度超过 255 也只处理前 255 像素。
- 左侧一列：`1 x height`，用于寻找边界标记行，总是执行。
- 标记行：`width x 1`，用于读取更多 bar 数据，**仅在左边界扫描到红色标记时有条件执行**（即 `marker_y is not None` 时才触发第三次截图）。

插件端在屏幕顶端绘制了两层像素条：
- **colorBars**（`block.lua` 第 17-22 行）：`FrameStrata=TOOLTIP, FrameLevel=10000`，锚定 `TOPLEFT(0,0)`，2px 高。这是 Python 端截取的 `top_img`（顶部长条）数据来源。
- **countBars**（`block.lua` 第 67-71 行）：`FrameStrata=TOOLTIP, FrameLevel=1`，锚定 `TOPLEFT(0,-2)`，20px 高。这是 Python 端截取的 `left_img` 和 `marker_row_img`（左侧标记行）数据来源。

countBars 在 colorBars 下方 2px（y 偏移 -2），且 FrameLevel 远低于 colorBars 的 10000，两者同处 TOOLTIP 层级。

这种设计减少了每次截图的数据量，也解释了源码注释里为什么说 `mss` 比 `PIL` 更适合这里：它需要高频、低延迟地读取少量屏幕像素。

> **注意**：`scan_screen_data()` 在获取窗口句柄后仅检查窗口宽高（`width <= 0 or height <= 0`），**没有像 `get_game_top_left()`（第 48-50 行）那样调用 `IsIconic(hwnd)` 检查窗口是否最小化**。在窗口最小化时，某些 DWM 环境下 `mss.grab()` 可能因帧缓冲重构而卡死。当前实现依赖主调用方 （`logic_gui.py`）在 `get_info()` 返回 `None` 时做降级处理来间接缓解此问题。

## 像素格式

`mss` 返回的原始数据按 BGRA 顺序排列。代码中读取像素时通常这样取值：

```python
b, g, r = raw_data[offset], raw_data[offset + 1], raw_data[offset + 2]
```

因此文档或 mod 示例里如果讨论颜色编码，需要注意 Python 端解析时看到的是 `B, G, R` 的字节顺序，而不是常见说明里的 `R, G, B` 顺序。

### 颜色标记协议

`GetPixels.py` 第 62-83 行定义了以下 5 种颜色标记函数，用于解析插件端在像素条中编码的数据边界：

| 函数 | RGB 值 | 用途 |
|---|---|---|
| `_is_rgb_red_marker` | (1, 0, 0) | 左边界标记行中的分段起始标记 |
| `_is_rgb_red_green_marker` | (1, 1, 0) | 与 (1,0,0) 配对表示一个数据段的「开始」 |
| `_is_rgb_white` | (255, 255, 255) | 标记行中数据段之间的背景分隔 |
| `_is_rgb_green_marker` | (0, 1, 0) | 顶部长条（colorBars）的数据起点标记 |
| `_is_rgb_gray_end_marker` | (200, 200, 200) | 行末终止标记，遇此标记则停止该行扫描 |

注意 `mss` 返回的原始数据按 BGRA 顺序排列，因此 Python 端的颜色检测函数传入参数顺序为 `(b, g, r)`：

```python
def _is_rgb_red_marker(b, g, r):
    \"\"\"RGB (1, 0, 0)；mss 为 BGRA 顺序入参。\"\"\"
    return r == 1 and g == 0 and b == 0
```

### 像素值的编码协议

插件端（`Fuyutsui/core/block.lua`）通过 `SetColorTexture` 将数据编码到像素中。Python 端读取时遵循以下编码规则：

**顶部长条（colorBars）**：

插件端维护 255 个 `CreatTexture` 色块（`block.lua` 第 25-46 行），每个色块调用：
```lua
tex:SetColorTexture(0, i / 255, b, 1)
```
- R 通道固定为 0
- **G 通道编码索引 `i/255`**（标识该色块的位置序号 1~255）
- **B 通道编码数值 `b`**（该位置对应的业务数值，范围 0~255）
- A 通道固定为 1 (不透明)

Python 端解析时（`GetPixels.py` 第 114-138 行）：
- 先找绿色标记 `(R=0, G=1, B=0)` 作为起点
- 向右扫描，当 `R=0` 且 `1 <= G <= PIXELS_PER_ROW` 时，用 **G 值作为字典键**、**B 值作为字典值**：`row_data[g] = b`

**左侧标记行（countBars 背景色块）**：

插件端为每个进度条创建背景色块（`block.lua` 第 110-118 行）：
```lua
tex:SetColorTexture(1 / 255, currentRelativeIndex / 255, 0, 1)
```
- R 通道为 `1/255`（标记此像素属于 bar 区域，Python 端通过检测 R=1 识别红色标记）
- G 通道编码相对位置索引 `currentRelativeIndex/255`（从 1 递增）
- B 通道固定为 0
- 行末终点色块为 `SetColorTexture(200/255, 200/255, 200/255, 1)`，Python 端检测到 RGB(200,200,200) 即终止该行扫描

> G 通道携带索引、B 通道携带数值的设计使得单像素即可同时传递位置和值两个信息，这是理解截图数据解析的核心。

## 数据流

### get_info() 调用链

`get_info()`（`GetPixels.py` 第 383-398 行）是截图解析的主入口，内部按顺序调用：

1. `scan_screen_data()` -- 执行截图并返回 `(row_data, bar_data)`
2. `load_config()` -- 加载 `config.yml`（缓存避免每帧重复 YAML 解析，使用函数属性 `load_config._cache`，见第 34-41 行）
3. `_get_spec_config(config, class_id, spec_id)` -- 合并职业专精配置（见下方配置合并）
4. `build_state_dict(config, row_data, state_config, class_id, spec_id, bar_data)` -- 构建最终状态字典

### step: bar 特殊调度

`_resolve_raw_from_field()`（第 267-281 行）根据配置中字段的 `step` 值决定数据来源：
- 当 `step` 为数字时，从 `row_data`（顶部长条扫描结果）中取值
- 当 `step` 为字符串 `"bar"` 时，从 `bar_data`（左侧标记行解析结果）中取值，键由配置中的 `bar` 整数决定

实际用例（`config.yml` 第 349 行）：
```yaml
苦修层数: {step: bar, bar: 1, type: "int"}
```

### build_state_dict() 三部分结构

`build_state_dict()`（第 302-380 行）将状态字典分为三大部分：

**(a) 顶层字段**（第 316-331 行）：遍历非 `spells`、非 `group` 的字段，根据 `type` 转换为 `int`（默认）或 `bool`。

**(b) spells 子字典**（第 333-348 行）：技能冷却值，嵌套在 `result["spells"]` 下。

**(c) group 子字典**（第 350-378 行）：队伍成员数据，从配置中的 `start` 开始，每隔 `num` 个 step 为一个成员，嵌套在 `result["group"]` 下。

### 配置三层合并

`_get_spec_config()`（第 284-299 行）执行三层配置合并：
1. **元像素层**：从顶层取 `_META_PIXEL_KEYS = ("锚点", "职业", "专精")`
2. **state 层**：合并 `config["state"]` 内的通用字段
3. **专精覆盖层**：用职业专精子配置的键值对覆盖前面两层

后层覆盖前层，最终返回合并后的配置字典。

### 降级处理

当 `get_info()` 返回 `None` 时，`logic_gui.py` 第 418-433 行做以下降级：
- 通过 `_state_dict = state_dict or {}` 将 `None` 降级为空字典
- 检测到 `_state_dict` 为空或缺少 `"有效性"` 键时，设置当前步骤为 `"等待游戏状态"` 并 `continue` 跳过本次按键决策循环

## 附录

### 已弃用函数

`GetPixels.py` 包含两个已弃用函数，内部均委托给 `scan_screen_data()`：
- `scan_top_bar()`（第 239-249 行）直接调用 `scan_screen_data()` 并仅返回 `row_data`
- `scan_row_data_red_white_markers()`（第 252-260 行）直接调用 `scan_screen_data()` 并仅返回 `bar_data`

### 自测模式

`GetPixels.py` 第 401-422 行的 `if __name__ == "__main__":` 块可用于独立测试 `get_info()` 的扫描结果和耗时。

### 扫描耗时记录

`logic_gui.py` 第 229 行定义 `_scan_ms`，第 404-408 行在每次主循环调用 `get_info()` 前后使用 `time.perf_counter()` 计时，UI 实时信息窗口右上角显示「扫描: X.X ms」（第 986、1082 行）。

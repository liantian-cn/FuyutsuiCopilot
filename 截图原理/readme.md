# 截图原理

本文只说明 Python 端如何截图，以及截图数据的基本像素格式。

Fuyutsui 的 Python 端会截取游戏窗口客户区的极窄区域，读取插件端绘制在屏幕上的像素条。本文只关注截图实现本身，不展开像素值所代表的业务语义。

## 截图使用的库

主运行链路使用的是 Python 库 `mss`。

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

真正的截图发生在 `scan_screen_data()` 中，主要调用 `sct.grab(...)`：

```python
top_img = sct.grab({"top": base_y, "left": base_x, "width": width, "height": 1})
left_img = sct.grab({"top": base_y, "left": base_x, "width": 1, "height": height})
marker_row_img = sct.grab({"top": base_y + marker_y, "left": base_x, "width": width, "height": 1})
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

后台循环定期调用 `get_info()`，所以实际运行时的状态扫描入口仍然是 `GetPixels.py` 的 `mss` 截图逻辑。

## 截图范围

`scan_screen_data()` 不是整屏截图，而是先通过 Windows API 找到标题为 `魔兽世界` 的窗口客户区，再截取几个很窄的区域：

- 顶部一行：`width x 1`，用于读取插件端顶部长条。
- 左侧一列：`1 x height`，用于寻找边界标记行。
- 标记行：`width x 1`，用于读取更多 bar 数据。

这种设计减少了每次截图的数据量，也解释了源码注释里为什么说 `mss` 比 `PIL` 更适合这里：它需要高频、低延迟地读取少量屏幕像素。

## 像素格式

`mss` 返回的原始数据按 BGRA 顺序排列。代码中读取像素时通常这样取值：

```python
b, g, r = raw_data[offset], raw_data[offset + 1], raw_data[offset + 2]
```

因此文档或 mod 示例里如果讨论颜色编码，需要注意 Python 端解析时看到的是 `B, G, R` 的字节顺序，而不是常见说明里的 `R, G, B` 顺序。

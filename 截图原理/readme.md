# 截图原理

Fuyutsui 的数据通路分成两段：

1. 插件端 Lua 在游戏画面中绘制像素条，把职业、专精、状态、技能冷却和队伍信息编码到像素颜色里。
2. Python 端截取游戏窗口客户区的极窄区域，读取像素颜色并还原成状态字典，再交给职业逻辑决定是否发送按键。

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

## 技能冷却的来源

技能冷却不是 Python 直接调用游戏 API 读取的。Fuyutsui 的插件端先在游戏内读取法术状态，然后把结果写成像素；Python 端只负责截图和解码。

冷却相关的 Lua API 主要在 `Fuyutsui/main.lua` 顶部缓存：

```lua
local GetSpellCooldownDuration = C_Spell.GetSpellCooldownDuration
local GetSpellChargeDuration = C_Spell.GetSpellChargeDuration
local GetSpellCooldown = C_Spell.GetSpellCooldown
```

这些 API 在 `Fuyutsui:updateSpellCooldown()` 中被周期性调用。每个需要输出冷却的技能来自当前职业/专精的 `ClassBlocks` 配置，配置项一般长这样：

```lua
[40] = { type = "spell", spellId = 7384, name = "压制" },
[41] = { type = "spell", spellId = 7384, name = "压制", charge = true },
```

`type = "spell"` 表示这个索引用来输出技能冷却。带 `charge = true` 的条目不是另一个技能，而是同一个 `spellId` 的充能恢复计时，通常在 Python 配置里命名为“某某充能”。

`loadPlayerBlocks()` 会把这些职业配置整理成 `blocks.spells`：

```lua
if v.charge then
    blocks.spells[v.spellId].charge = k
else
    blocks.spells[v.spellId].index = k
end
```

也就是说，一个 `spellId` 最多可以有两个输出位置：

- `index`：技能本身的冷却剩余时间。
- `charge`：技能充能恢复的剩余时间。

## 冷却如何写入像素

`updateSpellCooldown()` 会遍历当前已知的 `spells` 表：

```lua
for spellID, info in pairs(spells) do
    local index = info.index
    local cdDurationObj = GetSpellCooldownDuration(spellID)
    local cdInfo = GetSpellCooldown(spellID)
    ...
    self:CreatTexture(index, b)
end
```

写入顶部像素条时使用 `CreatTexture(index, b)`。这个函数在 `Fuyutsui/core/block.lua` 中把颜色写成：

```lua
tex:SetColorTexture(0, i / 255, b, 1)
```

因此：

- 红色通道固定为 `0`。
- 绿色通道是像素索引 `i / 255`，Python 端用它识别这是第几个字段。
- 蓝色通道 `b` 是实际值，Python 端读回后变成 `0..255` 的整数。

对技能冷却来说，`b` 来自：

```lua
local result = cdDurationObj:EvaluateRemainingDuration(curve255, 1)
local value = EvaluateColorFromBoolean(cdInfo.isEnabled, result, fallbackColor)
local _, _, b = value:GetRGB()
if cdInfo.isOnGCD then b = 0 end
self:CreatTexture(index, b)
```

可以把它理解成“剩余冷却时间被压进 0..255 的蓝色值”。Python 职业逻辑里的常见约定是：

- `0`：技能当前可用。
- `> 0`：技能仍在冷却，数值大致表示剩余时间。
- `1`：经常被用作不可用、未学会、没有冷却对象或没有物品数量的兜底值。
- `-1`：Python 逻辑中 `spells.get("技能名", -1)` 的默认值，表示配置里没有这个字段或没有读到。

这里有一个重要细节：如果 `cdInfo.isOnGCD` 为真，代码会把 `b` 强制设为 `0`。这意味着全局公共冷却不会让技能在 Python 端表现为“还在冷却”。职业逻辑看到 `0` 时会认为技能可用，实际按键是否能成功仍由游戏客户端处理。

## 技能是否参与冷却扫描

插件端不会无条件扫描所有 `ClassBlocks` 里的技能。`updateCooldownSpellKnown()` 会先判断技能是否已学会：

```lua
local isKnown = IsSpellKnown(spellID)
if info.inSpellBook then
    isKnown = IsSpellInSpellBook(spellID)
end
if isKnown or info.forcedKnown then
    spells[spellID] = info
else
    Fuyutsui:CreatTexture(index, 1)
end
```

这带来几个结果：

- 普通技能默认用 `C_SpellBook.IsSpellKnown(spellID)` 判断。
- 配了 `inSpellBook = true` 的技能改用 `IsSpellInSpellBook(spellID)`。
- 配了 `forcedKnown = true` 的技能即使普通已知判断不通过，也会放进扫描表。
- 未学会的技能会把对应像素写成 `1`，避免 Python 把它误判成 `0` 可用。

`updateSpellKnown()` 会在启用插件、进入/切换专精、天赋更新等流程中被调用。它不是每帧执行，因此“是否学会这个技能”的集合主要在这些结构性变化后刷新；冷却数值本身则由 `OnUpdate` 周期刷新。

## Python 如何读到 spells

Python 端先用 `scan_screen_data()` 扫描顶部一行，形成 `row_data`：

```python
if r == 0 and 1 <= g <= PIXELS_PER_ROW:
    row_data[g] = b
```

这里的 `g` 是 Lua 写入的索引，`b` 是 Lua 写入的值。随后 `build_state_dict()` 根据 `Fuyutsui/Fuyutsui/config.yml` 的当前职业/专精配置生成 `state_dict`。

冷却字段在 `config.yml` 里放在 `spells:` 下：

```yaml
spells:
  压制: {step: 40, type: "int" }
  压制充能: {step: 41, type: "int" }
```

`build_state_dict()` 会把这些字段放进 `result["spells"]`：

```python
spells_sub[spell_key] = int(raw) if raw is not None else 0
result["spells"] = spells_sub
```

所以职业逻辑最终拿到的是：

```python
spells = state_dict.get("spells") or {}
压制 = spells.get("压制", -1)
压制充能 = spells.get("压制充能", -1)
```

大多数职业逻辑用 `== 0` 判断技能可用，例如 `致死打击 == 0`、`神圣震击CD == 0`、`纯净术 == 0`。对充能恢复时间，则会用范围判断，例如“层数还剩 1 层，且充能恢复时间接近完成时再使用”。

## 充能层数和充能冷却不是一回事

Fuyutsui 里跟“充能”有关的数据有两类：

1. `type = "spell" + charge = true`：写入顶部像素条，表示下一层充能恢复还剩多久。
2. `countBars` + `valueType = "charge"`：写入第二条 bar，表示当前有几层充能。

例如牧师戒律配置里既有“苦修”的冷却/充能冷却，也有“苦修层数”：

```lua
["countBars"] = {
    { valueType = "charge", name = "苦修", minValue = 0, maxValue = 2, spellId = 47540 },
}
```

第二条 bar 由 `CreateAutoLayoutBar()` 创建，刷新时调用：

```lua
local charges = C_Spell.GetSpellCharges(spellId)
val = charges.currentCharges or 0
bar:SetValue(val)
```

Python 端不是从顶部 `spells` 里读这个层数，而是从 `bar_data` 里读。`config.yml` 中对应字段写成：

```yaml
苦修层数: {step: bar, bar: 1, type: "int"}
```

也就是说：

- `spells["苦修"]`：苦修技能本身是否可用。
- `spells["苦修充能"]`：下一层充能恢复剩余时间。
- `state_dict["苦修层数"]`：当前已有几层充能。

职业逻辑会把三者组合使用，例如“技能本身可用、当前只有一层、下一层即将恢复”时优先消耗，避免浪费充能恢复。

## 物品冷却

药水和治疗石这类物品冷却不在 `spells` 子字典里。Lua 端使用 `C_Item.GetItemCooldown(itemID)`：

```lua
local startTimeSeconds, durationSeconds, enableCooldownTimer = C_Item.GetItemCooldown(itemID)
if startTimeSeconds > 0 then
    return durationSeconds - (GetTime() - startTimeSeconds)
else
    return 0
end
```

`updateItemCoolDown()` 会把这些冷却写到普通 state 字段，例如：

- `大红冷却`
- `大蓝冷却`
- `治疗石冷却`
- `鲁莽药水冷却`
- `圣光潜力冷却`

因此 Python 逻辑有两种读取方式：

```python
大红冷却 = state_dict.get("大红冷却", -1)
神圣震击CD = spells.get("神圣震击", -1)
```

文档和 mod 示例里要区分：技能冷却通常在 `state_dict["spells"]`，物品冷却通常在 `state_dict` 顶层。

## 冷却在过程中改变时怎么处理

游戏内有些技能冷却会在过程中改变，例如冷却缩减、充能恢复加速、技能替换、光环影响、天赋变化或物品进入/结束冷却。Fuyutsui 的处理方式不是预测，而是高频重新读取游戏当前状态。

插件端在 `StartFrameUpdates()` 中注册 `OnUpdate`，每帧执行一部分高频更新；冷却相关的低频更新每 `0.2` 秒执行一次：

```lua
self.timeElapsed = self.timeElapsed + elapsed
if self.timeElapsed > 0.2 then
    self:updateSpellCooldown()
    self:updateItemCoolDown()
    self.timeElapsed = 0
end
```

因为 `updateSpellCooldown()` 每次都会重新调用 `GetSpellCooldownDuration(spellID)` 和 `GetSpellCooldown(spellID)`，所以它不会依赖上一次保存的剩余时间。如果游戏端因为某个机制把冷却缩短、延长、重置或替换，下一个 0.2 秒刷新周期就会把新的剩余时间写进像素条。

插件端也注册了多种冷却或技能状态事件，例如：

- `SPELL_UPDATE_COOLDOWN`
- `SPELL_UPDATE_CHARGES`
- `SPELL_UPDATE_USES`
- `SPELL_UPDATE_ICON`
- `COOLDOWN_VIEWER_SPELL_OVERRIDE_UPDATED`

这些事件会触发对应的辅助处理，例如光环、图标、技能覆盖、动作条按键映射或 bar 刷新。需要注意的是，主冷却数值本身仍然有 `OnUpdate` 每 0.2 秒调用 `updateSpellCooldown()` 兜底，所以即使某次事件没有直接写入某个冷却像素，下一次周期扫描也会重新读取游戏 API 的当前值。

Python 端也不是缓存旧冷却。`logic_gui.py` 的后台逻辑循环大约每 `0.2` 秒调用一次：

```python
state_dict = get_info()
```

`get_info()` 重新截图、重新解析 `row_data` 和 `bar_data`，再重建 `state_dict`。因此职业逻辑每轮看到的都是最近一次截图解码结果。

这套机制的特点是：

- 冷却变化最多有 Lua 刷新间隔加 Python 扫描间隔的延迟，通常约几个 0.1 秒量级。
- 不需要 Python 自己推算冷却结束时间。
- 如果游戏 API 因公共冷却返回 `isOnGCD`，Lua 会把技能冷却值压成 `0`，让职业逻辑忽略 GCD。
- 如果技能临时不可用但没有进入真实冷却，职业逻辑可能仍看到 `0`；实际发送后是否成功由游戏端决定，并可能进入“法术失败”处理。

## 法术失败与冷却的关系

Fuyutsui 还会记录“法术失败”。Lua 的 `updateSpellFailed(spellID)` 会在 `UNIT_SPELLCAST_FAILED` 时根据 `Fuyutsui.spellsList` 找到失败技能索引，并写入 `法术失败` 字段。

Python 职业逻辑不会盲目重试失败技能。它通常会先把失败索引映射回技能名，然后检查这个技能当前冷却是否为 `0`：

```python
spell_name = failed_spell_map.get(法术失败)
if spell_name and spells.get(spell_name, -1) == 0:
    return spell_name
```

这说明“法术失败”和“冷却”是联动的：只有失败技能仍然被判定为可用时，逻辑才会安排重试。这样可以避免一个技能失败后已经进入冷却，却仍被下一轮逻辑反复选择。

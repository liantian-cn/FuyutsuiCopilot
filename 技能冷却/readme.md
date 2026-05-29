# 技能冷却

本文解释 Fuyutsui 如何读取技能冷却、充能、物品冷却，以及游戏内冷却在过程中变化时如何被刷新到 Python 逻辑。

## 总体链路

技能冷却不是 Python 直接调用游戏 API 读取的。Fuyutsui 的插件端先在游戏内读取法术状态，把结果写成像素；Python 端再截图、解码，并把结果放进状态字典。

完整链路是：

1. `Fuyutsui/class/*.lua` 为每个职业/专精声明哪些技能要输出冷却。
2. `Fuyutsui/main.lua` 把职业配置整理成 `blocks.spells`。
3. `Fuyutsui:updateSpellCooldown()` 周期性读取游戏 API 的冷却数据。
4. `Fuyutsui/core/block.lua` 用 `CreatTexture(index, b)` 把冷却值写到顶部像素条。
5. `Fuyutsui/Fuyutsui/GetPixels.py` 用 `mss` 截图并解析顶部像素。
6. `Fuyutsui/Fuyutsui/config.yml` 把像素 step 映射成技能名。
7. `Fuyutsui/Fuyutsui/class/*_logic.py` 读取 `state_dict["spells"]` 做战斗决策。

## 职业配置如何声明冷却

每个职业 Lua 文件里的 `ClassBlocks` 会声明要输出的技能。普通技能冷却通常写成：

```lua
[40] = { type = "spell", spellId = 7384, name = "压制" },
```

如果一个技能有充能，还可以额外声明 `charge = true`：

```lua
[41] = { type = "spell", spellId = 7384, name = "压制", charge = true },
```

这两个条目使用同一个 `spellId`，但含义不同：

- 不带 `charge` 的条目输出技能本身的冷却剩余时间。
- 带 `charge = true` 的条目输出下一层充能恢复的剩余时间。

`Fuyutsui/main.lua` 的 `loadPlayerBlocks()` 会把它们整理到 `blocks.spells`：

```lua
if v.charge then
    blocks.spells[v.spellId].charge = k
else
    blocks.spells[v.spellId].index = k
end
```

因此同一个 `spellId` 可以同时有：

- `index`：冷却输出位置。
- `charge`：充能恢复输出位置。

## 插件端如何读取冷却

冷却相关的 Lua API 在 `Fuyutsui/main.lua` 顶部缓存：

```lua
local GetSpellCooldownDuration = C_Spell.GetSpellCooldownDuration
local GetSpellChargeDuration = C_Spell.GetSpellChargeDuration
local GetSpellCooldown = C_Spell.GetSpellCooldown
```

核心函数是 `Fuyutsui:updateSpellCooldown()`：

```lua
for spellID, info in pairs(spells) do
    local index = info.index
    local cdDurationObj = GetSpellCooldownDuration(spellID)
    local cdInfo = GetSpellCooldown(spellID)
    if cdDurationObj and cdInfo then
        local result = cdDurationObj:EvaluateRemainingDuration(curve255, 1)
        fallbackColor:SetRGBA(0, index, 254 / 255)
        local value = EvaluateColorFromBoolean(cdInfo.isEnabled, result, fallbackColor)
        local _, _, b = value:GetRGB()
        if cdInfo.isOnGCD then b = 0 end
        self:CreatTexture(index, b)
    else
        self:CreatTexture(index, 1)
    end
end
```

这里的关键点：

- `GetSpellCooldownDuration(spellID)` 返回可计算剩余时间的 duration 对象。
- `EvaluateRemainingDuration(curve255, 1)` 把剩余时间映射成颜色值。
- 蓝色通道 `b` 是 Python 最终读到的冷却值。
- 如果 `cdInfo.isOnGCD` 为真，代码强制 `b = 0`，让 Python 逻辑忽略公共冷却。
- 如果没有冷却对象或冷却信息，写入 `1` 作为兜底。

Python 逻辑里的常见约定是：

- `0`：技能当前可用。
- `> 0`：技能仍在冷却，数值大致表示剩余时间。
- `1`：常见兜底值，可能表示未学会、无冷却对象或不可用。
- `-1`：Python `spells.get("技能名", -1)` 的默认值，表示配置里没有这个字段或没有读到。

## 冷却如何写入像素

`updateSpellCooldown()` 最终调用 `CreatTexture(index, b)`。这个函数在 `Fuyutsui/core/block.lua` 中：

```lua
function Fuyutsui:CreatTexture(i, b)
    local tex = creatTextureByIndex(i)
    if tex then
        tex:SetColorTexture(0, i / 255, b, 1)
    end
end
```

顶部像素条的颜色编码规则是：

- `R = 0`
- `G = index / 255`
- `B = value`

Python 端解析时，`mss` 返回 BGRA 字节，所以读取代码是：

```python
b, g, r = top_raw[offset], top_raw[offset + 1], top_raw[offset + 2]
if r == 0 and 1 <= g <= PIXELS_PER_ROW:
    row_data[g] = b
```

这里 `g` 是字段索引，`b` 是冷却值。

## 技能是否参与扫描

插件端不会无条件扫描所有职业配置里的技能。`updateCooldownSpellKnown()` 会先判断技能是否已学会：

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

含义是：

- 普通技能用 `C_SpellBook.IsSpellKnown(spellID)`。
- 配了 `inSpellBook = true` 的技能用 `IsSpellInSpellBook(spellID)`。
- 配了 `forcedKnown = true` 的技能强制加入扫描。
- 未学会技能写 `1`，避免 Python 把它误判成 `0` 可用。

`updateSpellKnown()` 会在启用插件、切换专精、天赋更新等结构性变化后调用。冷却数值本身不是靠这个函数刷新，而是靠 `OnUpdate` 周期刷新。

## Python 如何生成 spells 字典

Python 端先通过 `GetPixels.py` 得到 `row_data`，再根据 `config.yml` 的当前职业/专精配置生成状态字典。

冷却字段在 `config.yml` 中放在 `spells:` 下：

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

职业逻辑最终这样读取：

```python
spells = state_dict.get("spells") or {}
压制 = spells.get("压制", -1)
压制充能 = spells.get("压制充能", -1)
```

大多数逻辑用 `== 0` 判断技能可用，例如 `致死打击 == 0`、`神圣震击CD == 0`、`纯净术 == 0`。

## 字段名不是自动推导

`XX`、`XX充能`、`XX层数` 这些名字不是代码通过字符串结尾自动识别出来的，而是手写配置形成的约定。

具体来说：

- Lua 职业文件里的 `name = "压制"` 主要是给人读的说明；真正决定像素位置的是表索引和 `spellId`。
- `loadPlayerBlocks()` 只根据 `type = "spell"`、`spellId`、`charge = true` 生成 `blocks.spells`，不会拼接或解析 `压制充能` 这种名字。
- Python 端 `config.yml` 里的键名才是 `state_dict["spells"]` 里的字段名，例如 `压制`、`压制充能`。
- `XX层数` 也不是由 `XX` 自动生成，而是 `config.yml` 中单独写的普通字段，通常通过 `step: bar` 指向第二条 bar 的某个计数字段。

因此，三类字段的关系是人工维护的：

```yaml
spells:
  压制: {step: 40, type: "int" }
  压制充能: {step: 41, type: "int" }

苦修层数: {step: bar, bar: 1, type: "int"}
```

如果 Lua 的 step、`config.yml` 的字段名、Python 职业逻辑里的 `spells.get("字段名")` 不一致，Fuyutsui 不会自动发现或修正，逻辑会读到错误值或 `-1` 默认值。写第三方 mod 文档或示例时，应把这些字段当作显式接口，而不是依赖命名后缀规则。

## 充能冷却和充能层数

Fuyutsui 里跟“充能”有关的数据有两类，不能混为一谈。

第一类是充能恢复冷却，来自顶部像素条：

```lua
[41] = { type = "spell", spellId = 7384, name = "压制", charge = true },
```

Python 里通常读作：

```python
压制充能 = spells.get("压制充能", -1)
```

第二类是当前已有几层充能，来自第二条 bar。职业 Lua 配置会声明 `countBars`：

```lua
["countBars"] = {
    { valueType = "charge", name = "苦修", minValue = 0, maxValue = 2, spellId = 47540 },
}
```

`CreateAutoLayoutBar()` 刷新时读取当前层数：

```lua
local charges = C_Spell.GetSpellCharges(spellId)
val = charges.currentCharges or 0
bar:SetValue(val)
```

Python 端通过 `step: bar` 读取：

```yaml
苦修层数: {step: bar, bar: 1, type: "int"}
```

所以同一个技能可能同时有三种数据：

- `spells["苦修"]`：技能本身是否可用。
- `spells["苦修充能"]`：下一层充能恢复还剩多久。
- `state_dict["苦修层数"]`：当前已有几层充能。

职业逻辑会组合使用这些值，例如“当前只有一层，下一层马上恢复”时优先消耗，避免浪费充能恢复。

## countBars 如何被 Python 解码

`countBars` 不在顶部 255 个像素里，而是在 `Fuyutsui/core/block.lua` 创建的第二条 bar。它用背景色块做分段标记，用白色 StatusBar 表示当前值，并用灰色终点标记结束。

Python 端 `scan_screen_data()` 会：

1. 截取左侧一列，寻找红色标记行。
2. 找到标记行后截取整行。
3. 按白色条和分段标记解析出 `bar_data`。
4. 根据 `config.yml` 里的 `step: bar, bar: N` 映射到状态字段。

因此 `countBars` 适合表示小整数计数，例如当前充能层数、施放次数、残片数量等；普通技能冷却仍走顶部像素条的 `spells`。

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

`updateItemCoolDown()` 会把这些冷却写到普通 state 字段：

- `大红冷却`
- `大蓝冷却`
- `治疗石冷却`
- `鲁莽药水冷却`
- `圣光潜力冷却`

Python 逻辑读取方式也不同：

```python
大红冷却 = state_dict.get("大红冷却", -1)
神圣震击CD = spells.get("神圣震击", -1)
```

文档或 mod 示例里需要区分：技能冷却通常在 `state_dict["spells"]`，物品冷却通常在 `state_dict` 顶层。

## 冷却过程中变化时如何处理

游戏内有些技能冷却会在过程中改变，例如冷却缩减、充能恢复加速、技能替换、光环影响、天赋变化或物品进入/结束冷却。Fuyutsui 不在 Python 端预测这些变化，而是持续重新读取游戏当前状态。

插件端在 `StartFrameUpdates()` 中注册 `OnUpdate`。每帧会执行一部分高频更新，冷却相关更新每 `0.2` 秒执行一次：

```lua
self.timeElapsed = self.timeElapsed + elapsed
if self.timeElapsed > 0.2 then
    self:updateSpellCooldown()
    self:updateItemCoolDown()
    self.timeElapsed = 0
end
```

因为 `updateSpellCooldown()` 每次都会重新调用 `GetSpellCooldownDuration(spellID)` 和 `GetSpellCooldown(spellID)`，所以它不依赖上一次保存的剩余时间。游戏端如果把冷却缩短、延长、重置或替换，下一个刷新周期就会把新值写进像素条。

插件端还注册了多种冷却或技能状态事件：

- `SPELL_UPDATE_COOLDOWN`
- `SPELL_UPDATE_CHARGES`
- `SPELL_UPDATE_USES`
- `SPELL_UPDATE_ICON`
- `COOLDOWN_VIEWER_SPELL_OVERRIDE_UPDATED`

这些事件会触发相关辅助处理，例如光环、图标、技能覆盖、动作条按键映射或 bar 刷新。主冷却数值仍由 `OnUpdate` 每 0.2 秒调用 `updateSpellCooldown()` 兜底。

Python 端也不缓存旧冷却。`logic_gui.py` 的后台逻辑循环大约每 `0.2` 秒调用：

```python
state_dict = get_info()
```

`get_info()` 会重新截图、重新解析 `row_data` 和 `bar_data`，再重建 `state_dict`。职业逻辑每轮看到的是最近一次截图解码结果。

这套机制的特点是：

- 冷却变化最多有 Lua 刷新间隔加 Python 扫描间隔的延迟，通常是几个 0.1 秒量级。
- Python 不需要自己推算冷却结束时间。
- 公共冷却被 `isOnGCD` 分支压成 `0`，职业逻辑会忽略 GCD。
- 技能临时不可用但没有进入真实冷却时，职业逻辑可能仍看到 `0`；实际按键是否成功由游戏端决定。

## 法术失败与冷却

Fuyutsui 还会记录“法术失败”。Lua 的 `updateSpellFailed(spellID)` 会在 `UNIT_SPELLCAST_FAILED` 时根据 `Fuyutsui.spellsList` 找到失败技能索引，并写入 `法术失败` 字段。

Python 职业逻辑不会盲目重试失败技能。它通常会先把失败索引映射回技能名，然后检查这个技能当前冷却是否为 `0`：

```python
spell_name = failed_spell_map.get(法术失败)
if spell_name and spells.get(spell_name, -1) == 0:
    return spell_name
```

这说明“法术失败”和“冷却”是联动的：只有失败技能仍然被判定为可用时，逻辑才会安排重试。这样可以避免一个技能失败后已经进入冷却，却仍被下一轮逻辑反复选择。

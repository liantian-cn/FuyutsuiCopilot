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

### 颜色曲线的数学原理

`updateSpellCooldown()` 调用了 `cdDurationObj:EvaluateRemainingDuration(curve255, 1)`。理解颜色曲线对理解冷却值的含义至关重要。

`curve255` 在 `main.lua` 中通过 `Fuyutsui:creatColorCurve(255, 255)` 创建，函数定义在 `Fuyutsui/core/core.lua`：

```lua
function Fuyutsui:creatColorCurve(point, b)
    local curve = C_CurveUtil.CreateColorCurve()
    curve:SetType(Enum.LuaCurveType.Linear)
    curve:AddPoint(0, CreateColor(0, 0, 0, 1))          -- t=0 → B=0 (黑色)
    curve:AddPoint(point, CreateColor(0, 0, b / 255, 1)) -- t=point → B=b/255
    return curve
end
```

所以 `curve255 = creatColorCurve(255, 255)` 产生了两个控制点：
- 剩余时间 = 0 → B 通道 = 0.0
- 剩余时间 = 255秒 → B 通道 = 1.0

`C_CurveUtil.EvaluateRemainingDuration` 取 duration 对象的剩余秒数，在线性曲线上查值。超出 255 秒的值会被钳制（clamp）在 1.0。因此：

```
raw_B ≈ min(剩余秒数, 255)
```

这是整数近似值（Python 端读到的是 0-255 的整数），实际映射关系：

| 剩余冷却时间 | B 通道 (0-1) | Python raw_B | 含义 |
|---|---|---|---|
| 0 秒 | 0.0 | 0 | 技能可用 |
| 1~254 秒 | ~time/255 | 1~254 | 正在冷却，值约等于剩余秒数 |
| ≥255 秒 | 1.0 | 255 | 长冷却，已钳制到上限 |

这个线性映射是职业逻辑中使用 `> N`、`>= 162` 等阈值判断的基础——它们直接按秒数含义比较 raw_B 值。

**注意：** `EvaluateRemainingDuration(curve255, 1)` 的第二参数 `1` 仅在法术冷却调用中出现（充能冷却 `GetSpellChargeDuration` 的调用不传此参数）。该参数与 `C_CurveUtil` 内部对 duration 对象的取整/取模行为有关，会略微影响小数值的精度，但不影响核心映射关系。

### `isEnabled` 与 `fallbackColor` 的影响

```lua
fallbackColor:SetRGBA(0, index, 254 / 255)
local value = EvaluateColorFromBoolean(cdInfo.isEnabled, result, fallbackColor)
```

当 `cdInfo.isEnabled` 为 `false`（技能被禁用，例如沉默、缴械、资源不足等导致不可施放）时，`EvaluateColorFromBoolean` 返回 `fallbackColor` 而非曲线计算的颜色。此时 B = 254/255 ≈ 0.996，Python raw_B ≈ 254。

这意味着 **raw_B = 254 有双重含义**：
- 可能是约 254 秒的剩余冷却（极少见，但不为零）。
- 更常见的是技能被当前状态禁用（isEnabled = false）。

部分职业逻辑利用了这一特性——当 `处决宣判CD == 255` 时表示"长冷却尚未准备好"，`== 254` 时表示"技能被禁用"。这两个值都大于大多数冷却检查阈值，因此被自然地归入"不可用"分支。

### `isOnGCD` 的强制归零

```lua
if cdInfo.isOnGCD then b = 0 end
```

技能处于公共冷却时，蓝色通道被强制设为 0。这确保了：
- Python 不会因为 GCD 倒计时而误以为技能有自己的冷却。
- 职业逻辑可以用 `== 0` 统一判断技能是否可用，无需单独处理 GCD。

这也意味着：一个真正在独立冷却中的技能，如果同时也在 GCD 上，Python 会读到 0（"可用"），因为 GCD 结束前技能可能已经冷却完毕。这是一个合理的近似——如果技能还在真实冷却中，GCD 结束后下一轮扫描就会显示正确的冷却值。

### 冷却值的完整语义表

综合颜色曲线、`isEnabled`、`isOnGCD`、兜底写入等所有情况，`spells` 字典中的冷却值有以下含义：

| raw_B | 含义 | 来源 |
|---|---|---|
| `0` | 技能可用（冷却就绪，或正处于 GCD） | 曲线 t=0 端，或 `isOnGCD` 强制归零 |
| `1~253` | 技能正在冷却，值约等于剩余秒数 | 曲线线性映射 |
| `254` | 技能被禁用（isEnabled=false），或极罕见的恰好 254 秒冷却 | `fallbackColor` 的 B 分量 |
| `255` | 冷却剩余 ≥255 秒（长冷却钳制），或技能未学会（写入 1…见下文） | 曲线钳制上限 |
| `-1` | 字段未在 `config.yml` 中配置或像素读取失败 | `spells.get("名称", -1)` 默认值 |

注意：`updateCooldownSpellKnown()` 对未学会技能写入 `CreatTexture(index, 1)`，Python 读出 raw_B = 1。这与"冷却剩余 1 秒"的曲线查值（raw_B ≈ 1）在数值上重叠。但职业逻辑中 `== 0` 判断可用，所以 `1` 会被正确处理为"不可用"。

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

### 物品冷却与技能冷却的编码差异

物品冷却和技能冷却在 Lua 端的编码方式不同，导致 Python 端的值在语义上有细微差别：

**技能冷却**使用颜色曲线：

```lua
local result = cdDurationObj:EvaluateRemainingDuration(curve255, 1)
local _, _, b = value:GetRGB()  -- b 是 0-1 的浮点数
```

**物品冷却**使用直接计算：

```lua
local remainingTime = self:GetItemRemainingTime(itemID)
self:CreatTexture(blocks.state["大红冷却"], math.min(1, remainingTime / 255))
```

差异在于：
- 技能冷却通过曲线插值，`b` 值是 `GetRGB()` 返回的浮点数（0-1），受曲线精度影响。
- 物品冷却通过 `remainingTime / 255` 直接归一化，更精确但也是 0-1 范围。
- 物品冷却的 `GetItemRemainingTime()` 在 `enableCooldownTimer` 为 false 时返回 255（表示"无冷却计时器"），写入像素的值就是 `math.min(1, 255/255) = 1`。
- 物品冷却在物品数量为 0 时也写入 `1`，与冷却剩余 1 秒在数值上无法区分。但物品冷却的判定仍用 `== 0`。

物品冷却还涉及 `ITEM_COUNT_CHANGED` 事件，当药水数量变化时 Lua 会重新获取物品数量：

```lua
function Fuyutsui:ITEM_COUNT_CHANGED(_, itemID)
    if potions[itemID] then
        self:GetItemCount()
    end
end
```

物品数量与冷却共同影响 `updateItemCoolDown()` 的输出——有冷却但数量为 0 时写入 `1`。

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

| 事件 | 触发的处理 | 作用 |
|---|---|---|
| `SPELL_UPDATE_COOLDOWN` | `updateAuraBySpellCooldown(spellID)` | 冷却变化时同步光环过期时间 |
| `SPELL_UPDATE_CHARGES` | `SPELL_UPDATE_CHARGES` 事件处理（目前为空） | 充能变化时触发 bar 刷新 |
| `SPELL_UPDATE_USES` | `SPELL_UPDATE_USES` 事件处理（目前为空） | `countBars` bar 已直接注册此事件刷新 |
| `SPELL_UPDATE_ICON` | `updateAuraByIcon(spellID)` | 技能图标覆盖变化（如触发高亮） |
| `COOLDOWN_VIEWER_SPELL_OVERRIDE_UPDATED` | `updateAuraBySpellOverride(baseSpellID, overrideSpellID)` | 技能替换（天赋/被动替换技能 ID） |

主冷却数值仍由 `OnUpdate` 每 0.2 秒调用 `updateSpellCooldown()` 兜底。

### SPELL_UPDATE_COOLDOWN 与光环同步

当游戏触发 `SPELL_UPDATE_COOLDOWN` 事件时，Lua 端会调用 `updateAuraBySpellCooldown(spellID)`。这个函数在 `Fuyutsui/core/auras.lua` 中：

```lua
function Fuyutsui:updateAuraBySpellCooldown(spellID)
    local ev = e["法术冷却"]
    local addBySpell = addAuras[ev]
    local updateBySpell = updateAuras[ev]
    local removeBySpell = removeAuras[ev]
    applyAuraMapForSpellEvent(addBySpell and addBySpell[spellID], nil)
    updateAuraMapForSpellEvent(updateBySpell and updateBySpell[spellID], nil)
    clearAurasFromRemoveMap(removeBySpell and removeBySpell[spellID], true)
end
```

这段代码的含义是：当某个法术的冷却状态发生变化时，与该法术关联的光环需要同步更新。例如：
- 某个爆发技能进入冷却 → 可能意味着对应的增益光环已经生效，需要更新光环过期时间。
- 某个技能冷却结束 → 可能意味着之前由该技能触发的光环应当被移除。

事件码 `e["法术冷却"]` 对应 `"SPELL_UPDATE_COOLDOWN"`，作为键在 `addAuras`、`updateAuras`、`removeAuras` 三个映射表中查找对应光环配置。这三个映射表由职业配置中的光环声明构建。

同理，`SPELL_UPDATE_ICON` 通过 `updateAuraByIcon(spellID)` 同步图标覆盖相关的光环，`COOLDOWN_VIEWER_SPELL_OVERRIDE_UPDATED` 通过 `updateAuraBySpellOverride()` 同步技能替换相关的光环。

### 技能覆盖（Spell Override）机制

`COOLDOWN_VIEWER_SPELL_OVERRIDE_UPDATED` 事件在以下场景触发：
- 天赋切换导致技能 A 被技能 B 替换。
- 被动效果改变技能 ID。

Fuyutsui 的处理函数 `updateAuraBySpellOverride(baseSpellID, overrideSpellID)` 会在 `updateAuras` 映射中查找 `baseSpellID`，将匹配光环的 `expirationTime` 设置为 `GetTime() + aura.duration`（如果替代技能存在）或 nil（如果替代技能被移除）。

这个机制确保：当一个技能被另一个技能替换时，Python 端能通过光环状态感知到变化，而不是继续按照旧技能的冷却状态做决策。

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

## cooldowns 标志与爆发开关

Fuyutsui 有一个名为 `cooldowns` 的用户可切换标志，通过 `/fu cd` 命令控制。这个标志的 **核心用途不是开关冷却扫描**，而是控制"爆发开关"——一个 Python 逻辑用来决定是否自动使用长冷却爆发技能的布尔标记。

关键区别：
- `updateSpellCooldown()` **始终运行**，不受 `cooldowns` 标志影响。所有技能冷却值始终被扫描和写入像素。
- `cooldowns` 标志只改变"爆发开关"像素的值。

标志在三处被写入像素：

1. `updatePlayerConfig()`（初始化/专精切换时）：
```lua
if blocks.state["爆发开关"] then
    self:CreatTexture(blocks.state["爆发开关"], c.cooldowns / 255 or 0)
end
```

2. `SwitchCooldown()`（用户使用 `/fu cd` 切换时）：
```lua
if st and st["爆发开关"] then
    self:CreatTexture(st["爆发开关"], c.cooldowns / 255 or 0)
end
```

3. 快速切换按钮也会同步此值。

Python 职业逻辑读取方式：
```python
爆发 = state_dict.get("爆发开关", 0)
# 或
爆发开关 = int(state_dict.get("爆发开关", 0) or 0)
```

常见用法模式：
```python
if 爆发 == 1 and 复仇之怒CD == 0:
    # 自动使用爆发技能
```

如果 `爆发 == 0`，即使爆发技能冷却就绪，逻辑也不会自动施放——留给玩家手动控制。

## spellsList 的完整结构

`Fuyutsui.spellsList`（定义在 `Fuyutsui/core/config.lua`，第 1-624 行）是一个覆盖所有职业的全局映射表，将法术 ID 映射到统一索引和失败跟踪标记：

```lua
Fuyutsui.spellsList = {
    [5782]    = { index = 1,  failed = true },   -- 恐惧
    [6789]    = { index = 2,  failed = true },   -- 死亡缠绕
    [30283]   = { index = 3,  failed = true },   -- 暗影之怒
    [1247378] = { index = 4,  failed = false },  -- 无失败跟踪
    ...
}
```

该表的两个关键字段：
- `index`：该法术在顶部像素条中的统一显示位置（与职业配置中的 `ClassBlocks` 表索引对应）。
- `failed`：布尔值，标记是否对该法术启用失败检测。只有标记了 `failed = true` 的法术，`updateSpellFailed()` 才会在施法失败时写入 `法术失败` 字段。

`spellsList` 被多处引用：
- `updateSpellFailed(spellID)` — 通过 `spellsList[spellID].index` 查找失败显示位置。
- `updatePlayerAssistant()` — 通过 `spellsList[spellID].index` 查找一键辅助建议技能的显示位置。
- `printSuccSpell(spellID)` — 开发用，打印不在列表中的新法术 ID。

## loadPlayerBlocks 内部流程

`loadPlayerBlocks(specIndex)` 在 `Fuyutsui/main.lua` 中定义，是连接职业配置和冷却扫描的关键函数。它在专精切换时被调用，负责重新初始化 `blocks` 表的三类数据：

```lua
blocks = {
    state = {},     -- name → pixelIndex（如 "大红冷却" → 15, "法术失败" → 14）
    auras = {},     -- pixelIndex → auraConfig（光环配置）
    spells = {},    -- spellID → { index, charge?, forcedKnown?, inSpellBook? }
    countBars = {}, -- key → { valueType, minValue, maxValue, spellId }
}
```

处理逻辑按 `v.type` 分派：

| type | 处理 | 填充位置 |
|---|---|---|
| `"block"` | 按 `v.name` 登记状态显示位置 | `blocks.state[name] = k` |
| `"aura"` | 直接存入光环配置 | `blocks.auras[k] = v` |
| `"spell"` | 按 `v.charge` 决定是 `index` 还是 `charge`，同时登记 `forcedKnown`、`inSpellBook` | `blocks.spells[spellId]` |
| `"group"` | 登记队伍显示的起始位置、成员数等 | `blocks.groups` |
| `"countBars"` | 特殊的充能/计数 bar 配置（顶层键） | `blocks.countBars` |

初始化完成后，`loadPlayerBlocks()` 会依次调用一系列更新函数：
- `updatePlayerCasting(0)`
- `updatePlayerSpecInfo()`
- `updatePlayerValid()`
- `updatePlayerCooldown()`（注意：不是 `updateSpellCooldown()`，而是将所有冷却像素重置为 `1` 的初始化函数）
- `updatePlayerHealth()` / `updatePlayerPower()` / `updatePlayerBuff()`
- `updatePlayerBarInfo()` → 创建 `countBars` 的 StatusBar
- `updateRune()` / `updateTargetRangeBlock()` / `updateTargetHealth()` / `updateEnemyCount()`
- `updateGroup()` / `GetItemCount()`

延迟 1 秒后通过 `C_Timer.After` 调用 `updatePlayerConfig()` 补充爆发开关等配置状态。

## 符文冷却（updateRune）

死亡骑士的符文系统是另一种冷却资源。Fuyutsui 通过 `updateRune()` 读取并写入像素：

```lua
function Fuyutsui:updateRune()
    if blocks and blocks.state["符文"] then
        local total = 0
        for i = 1, 6 do
            local runeCount = GetRuneCount(i)
            if runeCount then
                total = total + runeCount
            end
        end
        state.runeCount = total / 255 or 0
        self:CreatTexture(blocks.state["符文"], state.runeCount)
    end
end
```

这个函数汇总 6 个符文槽的当前可用数量（每个槽 0 或 1），归一化为 0-1 浮点数后写入像素。Python 端读到的是约 `(可用符文数 / 255)` 的值。

符文计数在 `OnUpdate` 的低频循环中每 0.2 秒刷新一次，与法术冷却刷新在同一周期。

## 一键辅助（updatePlayerAssistant）与冷却的关系

```lua
function Fuyutsui:updatePlayerAssistant()
    local spellId = C_AssistedCombat.GetNextCastSpell()
    local spellIndex = spellsList[spellId] and spellsList[spellId].index or 0
    state.assistantSpell = spellIndex / 255 or 0
    self:CreatTexture(blocks.state["一键辅助"], state.assistantSpell)
end
```

`updatePlayerAssistant()` 调用暴雪内置的 `C_AssistedCombat.GetNextCastSpell()` API，获取游戏推荐的下一个施放法术，并将其在 `spellsList` 中的索引写入像素。

Python 职业逻辑可以通过 `state_dict["一键辅助"]` 读取游戏推荐法术的索引，有些逻辑会与自己的冷却判断组合使用。例如：

```python
if 一键辅助 == 38:
    # 游戏推荐施放某个特定法术
```

这本质上是冷却决策的辅助输入——游戏推荐本身已经考虑了冷却状态，Fuyutsui 将其作为额外的参考信号。

## 法术失败与冷却

Fuyutsui 还会记录”法术失败”。Lua 的 `updateSpellFailed(spellID)` 会在 `UNIT_SPELLCAST_FAILED` 时触发，处理流程如下：

```lua
function Fuyutsui:updateSpellFailed(spellID)
    local isUsable = C_Spell.IsSpellUsable(spellID)

    if spellsList[spellID] and spellsList[spellID].failed then
        failedSpell = spellsList[spellID].index
        state.failedSpell = failedSpell / 255 or 0
    else
        failedSpell = nil
        state.failedSpell = 0
    end

    if not isUsable or not failedSpell then return end

    failedSpellId = spellID

    if failedSpellTimer then
        failedSpellTimer:Cancel()
        failedSpellTimer = nil
    end

    failedSpellTimer = C_Timer.NewTimer(1.5, function()
        self:CreatTexture(blocks.state[“法术失败”], 0)
        failedSpellTimer = nil
        failedSpell = nil
        failedSpellId = nil
    end)
    self:CreatTexture(blocks.state[“法术失败”], state.failedSpell)
end
```

关键点：
1. **双重检查**：先用 `C_Spell.IsSpellUsable(spellID)` 判断技能是否仍然可用——如果技能已不可用（比如进入了冷却），则不记录失败（直接 `return`）。
2. **仅跟踪标记法术**：只有 `spellsList[spellID].failed == true` 的法术才会被记录。大部分法术在 `spellsList` 中 `failed` 字段为 `nil`/`false`。
3. **1.5 秒自动清除**：失败标记通过 `C_Timer.NewTimer(1.5, ...)` 在 1.5 秒后自动清除。这是为了在连续施法场景中给 Python 一个合理的重试窗口。
4. **成功施法清除**：`updateFailedSpellBySuccess(spellID)` 在 `UNIT_SPELLCAST_SUCCEEDED` 时匹配 `failedSpellId`，如果匹配则立即清除失败标记并打印 `”插入技能: 技能名”`。

Python 职业逻辑不会盲目重试失败技能。它通常会先把失败索引映射回技能名，然后检查这个技能当前冷却是否为 `0`：

```python
spell_name = failed_spell_map.get(法术失败)
if spell_name and spells.get(spell_name, -1) == 0:
    return spell_name
```

这说明“法术失败”和“冷却”是联动的：只有失败技能仍然被判定为可用时，逻辑才会安排重试。这样可以避免一个技能失败后已经进入冷却，却仍被下一轮逻辑反复选择。

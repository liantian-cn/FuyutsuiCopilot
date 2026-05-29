# Zeta 代码复查报告

基于 `main.lua`、`core/block.lua`、`core/core.lua`、`class/Druid.lua`、`class/Shaman.lua`、`class/Evoker.lua`、`Fuyutsui/GetPixels.py`、`Fuyutsui/config.yml` 和 `队友状态/readme.md` 的独立源码验证结果。

---

## 共同发现

### 1. `UNIT_SPELLCAST_SENT` 代码片段遗漏 `isSec` 守卫和 `castTargetName`（Alpha #1 / Beta #3 / Gamma #3）

**结论：三位审查员全部正确。**

**源码证据：** `main.lua:1409-1422`

```lua
function Fuyutsui:UNIT_SPELLCAST_SENT(_, unitTarget, targetName, castGUID, spellID)
    if unitTarget ~= "player" then return end
    if not isSec(targetName) then              -- 文档缺失此行
        for unit, data in pairs(group) do
            if data.name == targetName then
                state.castTargetUnit = unit
                state.castTargetName = targetName  -- 文档缺失此行
                state.castTargetIndex = data.index / 255
                break
            end
        end
    end
end
```

文档第 336-347 行的代码片段缺失了：
1. `if not isSec(targetName) then` 守卫（如果 `targetName` 是安全值则跳过）
2. `state.castTargetName = targetName` 赋值

**文档修改建议：** 补充上述两行缺失的代码。

---

## 差异点复查

### A. 两位审查员共同发现

#### A1. `obj.healthPercent = b` 赋值遗漏（Alpha #6 / Beta #7）

**结论：两位正确。文档第 123 行前缺少 `obj.healthPercent = b`。**

**源码证据：** `main.lua:1094-1103`

```lua
function Fuyutsui:updateUnitHealthInfo(unit)
    ...
    local _, _, b = healthPercent:GetRGB()
    obj.healthPercent = b          -- 文档第 122-123 行之间缺失此行
    self:CreatTexture(index, obj.healthPercent)
end
```

**文档修改建议：** 在 `local _, _, b = healthPercent:GetRGB()` 之后增加 `obj.healthPercent = b`。

#### A2. `obj.inRange` 保存但从未使用（Alpha #2 / Beta #8）

**结论：两位正确。`obj.inRange` 是死字段。**

**源码证据：**
- `main.lua:1318` 初始化时保存 `inRange = UnitInRange(unit)`
- `main.lua:1125` `updateGroupInRangeAndHealth()` 中重新调用了 `UnitInRange(unit)`，没有读取 `obj.inRange`

**文档修改建议：** 将文档第 105 行 `inRange` 的说明从"影响职责槽是否为 0"改为"初始化时保存但后续未使用，实际职责判定中重新调用了 UnitInRange(unit)"。或者从表格中移除该字段并加脚注。

#### A3. `dispelCapabilities` 注释索引 2 和 3 写反（Alpha #4 / Beta #4）

**结论：两位正确。源文件 `main.lua:166-167` 注释确实写反。**

**源码证据：** `main.lua:164-169`

```lua
local dispelCapabilities = {
    [1] = false,  -- 魔法驱散
    [2] = false,  -- 疾病驱散    ← 错误，对照 dispelAbilities[2] 是诅咒
    [3] = false,  -- 诅咒驱散    ← 错误，对照 dispelAbilities[3] 是疾病
    [4] = false,  -- 中毒驱散
    [11] = false, -- 流血
}
```

而 `dispelAbilities`（第 116-122 行）明确将 [2] 对应诅咒法术、[3] 对应疾病法术。

**文档修改建议：** 文档本身第 309-316 行的驱散类型表是正确的（2=诅咒、3=疾病），不需要修改文档，但可以加脚注说明源文件注释有误。

#### A4. 德鲁伊"迅捷治愈"字段名与实际监控内容不一致（Alpha #10 / Beta #9）

**结论：两位正确。字段名有误导性。**

**源码证据：** `class/Druid.lua:172`

```lua
[5] = { 48438, 8936, 774, 155777 }, -- 迅捷治愈(回春术, 萌芽, 愈合, 野性生长)
```

监控的 spellId 为：
- 48438 = 野性成长
- 8936 = 愈合
- 774 = 回春术
- 155777 = 萌芽

这些是可被迅捷治愈（18562）消耗的 HoT，不是迅捷治愈本身。Python `config.yml` 第 917 行也沿用"迅捷治愈"这个可能产生误导的字段名。

**文档修改建议：** 文档第 251 行应补充说明：该字段名称为"迅捷治愈"，但实际监控的是可被迅捷治愈消耗的 HoT（包含野性成长、愈合、回春术、萌芽），用于判断目标是否带可消耗 HoT。

---

### B. 仅 Alpha 发现的点

#### B1. `updateGroup()` 字段表遗漏 5 个字段（Alpha #3）

**结论：Alpha 正确。**

**源码证据：** `main.lua:1312-1328` 初始化表中包含：

| 字段 | 初始值 | 文档状态 |
|---|---|---|
| `inSightTimer` | `nil` | 缺失 |
| `curve` | `curve100` | 缺失 |
| `curveTimer` | `nil` | 缺失 |

另外还有两个字段虽不在初始化表中但由后续函数设置：
- `valid`：由 `updateUnitValid()` 设置（第 1106-1110 行），直接影响职责槽输出
- `healthPercent`：由 `updateUnitHealthInfo()` 设置（第 1102 行），血量曲线输出值

**文档修改建议：** 在队友字段表中补充 `curve`（初始化曲线）、`valid`（有效性，由 updateUnitValid 设置）、`healthPercent`（血量像素值）、`inSightTimer`（视野恢复计时器）、`curveTimer`（治疗吸收还原计时器）。

#### B2. `rejuv` 强依赖 `auras` 存在的设计缺陷（Alpha #5）

**结论：Alpha 正确，但实际影响有限。**

**源码证据：** `main.lua:1248-1276`

```lua
function Fuyutsui:OnUpdateUnitAura()
    if not blocks or not blocks.groups or not blocks.groups.auras then return end
    -- ... aura 处理 ...
    if blocks.groups.rejuv then
        -- ... rejuv 处理 ...
    end
end
```

第 1249 行的 `not blocks.groups.auras` 守卫会在 `auras` 未配置时直接 return，导致 `rejuv` 代码永远无法执行。

**但实际影响受限于当前配置：** 当前唯一使用 `rejuv` 的专精（恢复德鲁伊，`class/Druid.lua:169-176`）同时也配置了 `auras`，所以实际不会触发此缺陷。但对于第三方 mod 作者来说，如果只配 `rejuv` 不配 `auras`，则回春计数会静默失效。

**代码复查需求：** 源码可按需考虑将 `auras` 守卫改为同时检查 `auras` 或 `rejuv`，但不能简单移除——若既没有 `auras` 也没有 `rejuv`，遍历 group 做空循环就是浪费。

**文档修改建议：** 在文档第 232 行的已有提示基础上补充说明：此限制源于 `OnUpdateUnitAura()` 第 1249 行的提前返回；第三方 mod 作者如果只需要回春计数，也必须同时配置一个空的 `auras`（或修改源码守卫逻辑）。

#### B3. 驱散类型表缺少 Python 读取值说明（Alpha #7）

**结论：Alpha 正确。**

**源码证据：** `main.lua:189-196`

```lua
for i, v in pairs(dispelCapabilities) do
    if v then
        dispelCurve:AddPoint(i, CreateColor(0, 1, i / 255, 1))
    else
        dispelCurve:AddPoint(i, CreateColor(0, 0, 0, 1))
    end
end
```

曲线将驱散类型编号 i 映射为 `i/255`，Python 读回时按整数取值（`int(raw)`），因此 Python 读到的值就等于驱散类型编号（1/2/3/4）。而流血类型（11）因 `dispelAbilities[11] = {}`，`dispelCapabilities[11]` 始终为 false，曲线输出 0。

**文档修改建议：** 在驱散类型表（第 308-316 行）后补充说明：Python 读到的整数值等于驱散类型编号（1=魔法, 2=诅咒, 3=疾病, 4=中毒），且因 `dispelAbilities[11]` 为空，流血类型始终输出 0。

#### B4. Python `GetPixels.py` 第 351 行注释公式错误（Alpha #8）

**结论：Alpha 正确。**

**源码证据：** `GetPixels.py:351`

```python
# Lua: index = unit_start + obj.index * unit_num + field_offset (1~5)
```

实际 Lua 公式（`main.lua:1097`）：

```lua
local index = blocks.groups.start + (obj.index - 1) * blocks.groups.num + blocks.groups.healthPercent
```

Python 注释缺少 `- 1`。Python 实际解码代码（第 360 行 `base_step = start + (i - 1) * num_params`）是正确的，只是注释有误。

**文档修改建议：** 可通过脚注指出 Python 注释中的公式缺少 `- 1`。也可顺便修正 `GetPixels.py` 第 351 行的注释。

#### B5. `healAbsorb` "15 点" 表述模糊（Alpha #9）

**结论：Alpha 正确。**

**源码证据：** `main.lua:1098,1178`

```lua
obj.healAbsorb = 15                                    -- 第 1178 行
obj.curve = creatColorCurveScaling(100 + obj.inComingHeals - obj.healAbsorb)  -- 第 1098 行
```

`healAbsorb = 15` 表示曲线基准从 100 降到 85，不是"血量减少 15% 或 15 点"。

**文档修改建议：** 第 131 行"临时降低血量曲线 15 点"改为"临时将血量曲线基准从 100 降低到 85，使 Python 读到的血量百分比偏低，近似模拟吸收盾效果"。

---

### C. 仅 Beta 发现的点

#### C1. 永久光环数值描述有误（Beta #1）

**结论：Beta 正确。文档描述有歧义。**

**源码证据：**
- `main.lua:1256-1257`：永久光环写入 `CreatTexture(index, 1)`
- `core/block.lua:44`：`tex:SetColorTexture(0, i / 255, b, 1)` — B 通道为 `b`（float）
- 8-bit BGRA 编码下，`b = 1.0` 映射为字节值 255

因此：Lua 确实写了 `value = 1`，但 Python 读到的是 255。永久光环和持续 255 秒的光环确实无法区分。

**文档修改建议：** 第 226 行"当前源码实际写入 `1`，不是 `255`"修改为"当前源码实际写入 `CreatTexture(index, 1)`，编码后字节值为 255，与持续 255 秒的光环无法区分"。

#### C2. `updateGroup()` 局部变量引用错误的影响远大于文档所述（Beta #2）

**结论：Beta 的分析更深入、更准确。文档严重低估了此问题。**

**源码证据：** `main.lua:16-17,1302-1333`

```lua
-- 模块级局部变量（第 16-17 行）
local group = Fuyutsui.group      -- 指向 core.lua 初始化的 {}
local groupList = Fuyutsui.groupList

-- updateGroup() 第 1302-1304 行
function Fuyutsui:updateGroup()
    self.group = {}               -- 创建新表，仅赋值给 Fuyutsui.group
    self.groupList = {}           -- 创建新表，仅赋值给 Fuyutsui.groupList
    ...
    table.insert(groupList, unit) -- 写入局部变量（原始表）！
    group[unit] = { ... }         -- 写入局部变量（原始表）！
```

**影响分析：**
1. `self.group = {}` 创建新表，但局部 `group` 仍指向原始表（core.lua 初始化的 `{}`）。
2. `group[unit] = {...}` 写入原始表，原始表从未被清空，累积所有历史成员。
3. `table.insert(groupList, unit)` 向原始 `groupList` 追加，`groupList` 持续增长，包含已离队成员和重复项。
4. 所有使用局部 `group`/`groupList` 的函数（`updateUnitHealthInfo`、`updateGroupInRangeAndHealth`、`updateUnitFullAura`、`OnUpdateUnitAura` 等）操作的都是累积的旧数据。
5. `updateGroupInRangeAndHealth()` 遍历 `#groupList`（可能包含 7+ 项而非实际 2 人），访问旧成员，尝试调用 `UnitHealthPercent` 等 API，可能导致异常。

**这不是文档所说的"旧成员和重复列表项可能继续留在局部表里"的残留风险，而是所有队友状态更新函数都在操作过时数据的系统性 bug。**

**代码复查需求：最高优先级。** 修复方法：`updateGroup()` 中应该直接清空并写入局部 `group`/`groupList`，而不是赋值 `self.group = {}`。例如修改为：

```lua
function Fuyutsui:updateGroup()
    -- 清空局部变量指向的原始表
    for k in pairs(group) do group[k] = nil end
    for i = #groupList, 1, -1 do groupList[i] = nil end
    -- 或者重新从 Fuyutsui 读取最新引用
    -- group = Fuyutsui.group  -- 但作为 upvalue 不能重新赋值
    ...
```

实际上因为 `group` 和 `groupList` 是 upvalue，无法被重新赋值。所以修复方案是：
- **方案 A：** 直接清空 `group` 和 `groupList` 表（`wipe`），同时不修改 `self.group`/`self.groupList` 的绑定。
- **方案 B：** 将 `self.group` 和 `self.groupList` 改为在模块顶部直接使用 `Fuyutsui.group` 而不用本地缓存。

**文档修改建议：** 大幅升级第 13 行和第 113 行的警示，说明此问题的实际影响是所有队友操作函数都在处理累积的旧数据。

#### C3. `updateUnitIncomingHealsCurve2()` 未在文档中提及（Beta #5）

**结论：Beta 正确。**

**源码证据：** `main.lua:1201-1205`

```lua
local function updateUnitIncomingHealsCurve2()
    for unit, data in pairs(group) do
        data.inComingHeals = 0
    end
end
```

此函数在 `UNIT_SPELLCAST_STOP`（第 1439 行）被调用。它将**所有**队友的 `inComingHeals` 置为 0，而不是只清空当前施法目标。

注意：`UNIT_SPELLCAST_CHANNEL_STOP`（第 1461-1471 行）**没有**调用此函数，所以引导停止时 `inComingHeals` 不会被立刻清空，仅通过 `state.castTargetUnit = nil` 和 0.2 秒后 `OnUpdateUnitAura` 的曲线重建间接影响。

**文档修改建议：**
1. 命名并描述 `updateUnitIncomingHealsCurve2()` 函数的行为。
2. 第 351 行的"读条停止或引导停止时清空"改为"读条停止时（`UNIT_SPELLCAST_STOP`）调用 `updateUnitIncomingHealsCurve2()` 将所有成员的 `inComingHeals` 置为 0"。
3. 补充说明引导停止时不会立即清空 `inComingHeals`。

#### C4. 血量曲线 `b > 100` 分支行为未说明（Beta #6）

**结论：Beta 正确。**

**源码证据：** `main.lua:35-37`

```lua
if b > 100 then
    curve:AddPoint(0, CreateColor(0, 0, (b - 100) / 255, 1))
    curve:AddPoint(1, CreateColor(0, 0, b / 255, 1))
end
```

当 `b = 115`（例如 `inComingHeals = 15`）时：
- 0% 血量 → B = (115-100)/255 = 15/255 → Python 读到字节值 15
- 100% 血量 → B = 115/255 → Python 读到字节值 115

这意味着即使目标实际血量为 0（死亡或空血），Python 也会读到 15 而非 0。`_role_not_zero()` 过滤不会受到影响（因为职责槽和血量槽是分开的），但任何直接依赖 Python 血量值是否为 0 来判断死亡的逻辑都会失效。

**文档修改建议：** 在第 126 行的基础上补充 `b > 100` 分支的具体影响：曲线最低点上移，Python 读到的血量最小值不为 0，影响死亡判断逻辑。

#### C5. `helpfulSpells` 未指出遗漏的专精（Beta #13）

**结论：Beta 正确。**

**源码证据：** `main.lua:65-73`

```lua
local helpfulSpells = {
    [2061] = 15,    -- 快速治疗 (Priest)
    [1262763] = 15, -- 祈福 (Priest)
    [82326] = 40,   -- 圣光术 (Paladin)
    [19750] = 15,   -- 圣光闪现 (Paladin)
    [8936] = 15,    -- 愈合 (Druid)
    [186263] = 50,  -- 暗影愈合 (Priest)
    [77472] = 15,   -- 治疗波 (Shaman)
}
```

缺失的治疗专精：
- 织雾武僧：无任何单体治疗法术在表中
- 戒律牧师：真言术：盾 (17)、苦修 (47540) 等不在表中
- 恩护唤魔师：无任何法术在表中

**文档修改建议：** 在 helpfulSpells 表格后补充说明：当前仅覆盖牧师、圣骑士、德鲁伊、萨满的部分单体治疗法术，织雾武僧和恩护唤魔师的主要治疗法术不在表中，因此该机制对这些专精无效。

#### C6. `clearGroupBlocks()` 的范围对其他模块的影响（Beta #10）

**结论：Beta 正确。**

**源码证据：** `main.lua:1293-1300`

```lua
function Fuyutsui:clearGroupBlocks()
    if blocks.groups and blocks.groups.start then
        local startIndex = blocks.groups.start
        for index = startIndex, 255 do
            self:CreatTexture(index, 0)
        end
    end
end
```

起始索引一般为 45（德鲁伊）或 70（其他）。若被调用，将从 45 或 70 一直清空到 255，覆盖 group 槽位之后的所有 spells、auras、countBars 等模块的像素数据。

**文档修改建议：** 在第 419 行的基础上补充：如果 `clearGroupBlocks()` 被调用，会从 `blocks.groups.start` 清空到索引 255，覆盖所有后续模块（spells、auras 等）的像素数据。

#### C7. 目标驱散使用不同曲线（Beta #12）

**结论：Beta 正确。**

**源码证据：** `main.lua:75-77`

```lua
local dispelCurve = C_CurveUtil.CreateColorCurve()
target.enemyCurve = C_CurveUtil.CreateColorCurve()
target.friendCurve = C_CurveUtil.CreateColorCurve()
```

队友驱散在 `getAuraDispelTypeColor()`（第 1278-1291 行）中使用 `dispelCurve`。
目标驱散在 `getTargetDispelType()`（第 559-583 行）中根据目标类型使用 `target.enemyCurve` 或 `target.friendCurve`。

三条曲线的映射值也不同，用于区分这些值来自队友驱散、敌方目标驱散还是友方目标驱散。

**文档修改建议：** 第 425 行的描述补充为：目标友方可驱散使用 `target.friendCurve`（值为 11-15），目标敌方使用 `target.enemyCurve`（值为 2-3），队友驱散使用 `dispelCurve`（值为 1-4）。三者是独立的曲线实例，编码值不同。

#### C8. `roleMap` 中 `NONE = 0` 的 Lua 真值特殊性（Beta #14）

**结论：Beta 正确。**

**源码证据：** `core/config.lua:1023-1028`

```lua
Fuyutsui.roleMap = {
    ["TANK"] = 1,
    ["HEALER"] = 2,
    ["DAMAGER"] = 3,
    ["NONE"] = 0,
}
```

使用处 `main.lua:1126`：

```lua
local roleValue = roleMap[obj.role] and roleMap[obj.role] / 255 or 5 / 255
```

在 Lua 中 `0` 为真值，所以 `roleMap["NONE"] and roleMap["NONE"] / 255` 计算为 `0`；若 `obj.role` 不在 `roleMap` 中则 `roleMap[obj.role]` 返回 `nil`（假），触发 `5/255` 兜底。如果是在 Python/PHP/JS 等 `0` 为假的语言中，此逻辑会出错。

**文档修改建议：** 第 166 行的说明可增加脚注：此代码依赖 Lua 中 `0` 为真值的特性；若翻译到其他语言需注意 `NONE = 0` 在 `and/or` 模式下的行为差异。

#### C9. `updateIndex` 不重置可能导致刷新遗漏（Beta #15）

**结论：Beta 正确。这是一个轻微的功能缺陷。**

**源码证据：** `main.lua:19,1112-1138,1302-1334,1643-1654`

```lua
-- 第 19 行：模块级变量，初始化为 1
local ..., updateIndex = ..., 1

-- 第 1116-1137 行：使用 updateIndex 轮询
local numUnits = #groupList
local unit = groupList[updateIndex]
...
updateIndex = updateIndex + 1
if updateIndex > numUnits then
    updateIndex = 1
end

-- 第 1302 行：updateGroup() 不重置 updateIndex
-- 第 1643-1654 行：GROUP_ROSTER_UPDATE 也不重置 updateIndex
```

**问题场景：** 队伍从 5 人变为 2 人后，`updateIndex` 可能为 3, 4, 或 5（取决于轮询时机）。同时结合 C2 的局部变量 bug，`groupList` 含有旧成员，`numUnits` 计算错误，进一步加剧此问题。

**即使 C2 被修复**（`groupList` 被正确清空），`updateIndex` 不重置仍有影响：
- `updateIndex` 为 4，新的 `groupList` 只有 2 个条目
- `groupList[4]` 为 nil，`obj` 为 nil，函数在第 1118 行 return
- 该帧跳过刷新，`updateIndex` 递增到 5，仍越界，再次 return
- 直到 `updateIndex > 2` 时被重置为 1，错过最多 3 帧的刷新

**代码复查需求：中优先级。** 修复建议：在 `updateGroup()` 末尾或 `GROUP_ROSTER_UPDATE` 中重置 `updateIndex = 1`。

**文档修改建议：** 补充说明 `updateIndex` 是模块级全局变量，`updateGroup()` 不重置它，队伍人数减少时可能跳过若干帧的刷新。

#### C10. 萨满"大地生命"字段名称注释不统一（Beta #11）

**结论：Beta 正确，但影响极小。**

**源码证据：**
- `class/Shaman.lua:156`：注释写 `-- 大地生命武器`
- `config.yml:632`：字段名 `大地生命`
- 文档第 247 行：使用 `大地生命`

Lua 注释的"大地生命武器"是对艾泽里特特质原名的直译，Python 配置和文档中的"大地生命"是缩写。两者指向同一法术 ID 382024。

**文档修改建议：** 可在脚注中说明 Lua 注释为"大地生命武器"但 Python/config.yml 统一简写为"大地生命"。

---

## 需要代码修复的项目

### 最高优先级

**C2 — `updateGroup()` 局部变量引用错误。**
源文件：`main.lua:16-17,1302-1333`
修复方案：在 `updateGroup()` 中清空局部 `group` 和 `groupList` 表的内容（pairs wipe）而非创建新表。因为 `group` 和 `groupList` 是 upvalue 不可重新赋值，只能原地清空：
```lua
function Fuyutsui:updateGroup()
    -- 清空原始表
    for k in pairs(group) do group[k] = nil end
    for i = #groupList, 1, -1 do groupList[i] = nil end
    ...
```

### 中优先级

**C9 — `updateIndex` 不重置。**
源文件：`main.lua:19,1302-1334,1643-1654`
修复方案：在 `updateGroup()` 末尾添加 `updateIndex = 1`。

### 低优先级（注释修正）

**A3 — `dispelCapabilities` 注释索引 2 和 3 写反。**
源文件：`main.lua:166-167`
修复方案：将 `-- 疾病驱散` 改为 `-- 诅咒驱散`，将 `-- 诅咒驱散` 改为 `-- 疾病驱散`。

**B4 — `GetPixels.py` 第 351 行注释公式缺 `- 1`。**
源文件：`Fuyutsui/GetPixels.py:351`
修复方案：将 `obj.index * unit_num` 改为 `(obj.index - 1) * unit_num`。

### 设计考量（无需立即修复）

**B2 — `rejuv` 依赖 `auras` 的设计缺陷。**
源文件：`main.lua:1248-1249`
当前配置（恢复德鲁伊）同时声明了 `auras` 和 `rejuv`，实际未触发。可作为第三方 mod 作者的注意事项记录。

---

## 总结

| 差异点 | 结论 | 代码修复必要 |
|---|---|---|
| **共同 #1** (isSec/castTargetName) | 三位正确 | 纯文档 |
| **A1** (healthPercent 赋值) | Alpha+Beta 正确 | 纯文档 |
| **A2** (inRange 死字段) | Alpha+Beta 正确 | 纯文档 |
| **A3** (dispelCapabilities 注释) | Alpha+Beta 正确 | 低（注释修正） |
| **A4** (迅捷治愈字段名) | Alpha+Beta 正确 | 纯文档 |
| **B1** (字段表漏 5 项) | Alpha 正确 | 纯文档 |
| **B2** (rejuv 依赖 auras) | Alpha 正确 | 设计考量 |
| **B3** (驱散表缺 Python值说明) | Alpha 正确 | 纯文档 |
| **B4** (GetPixels.py 注释) | Alpha 正确 | 低（注释修正） |
| **B5** (healAbsorb 表述) | Alpha 正确 | 纯文档 |
| **C1** (永久光环数值描述) | Beta 正确 | 纯文档 |
| **C2** (updateGroup 局部变量) | **Beta 更准确** | **最高** |
| **C3** (updateUnitIncomingHealsCurve2) | Beta 正确 | 纯文档 |
| **C4** (b>100 曲线行为) | Beta 正确 | 纯文档 |
| **C5** (helpfulSpells 遗漏专精) | Beta 正确 | 纯文档 |
| **C6** (clearGroupBlocks 范围) | Beta 正确 | 纯文档 |
| **C7** (目标驱散不同曲线) | Beta 正确 | 纯文档 |
| **C8** (roleMap NONE=0 真值) | Beta 正确 | 纯文档 |
| **C9** (updateIndex 不重置) | Beta 正确 | **中** |
| **C10** (大地生命字段名) | Beta 正确 | 纯文档 |

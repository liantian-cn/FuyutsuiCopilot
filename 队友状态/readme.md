# 队友状态

本文说明 Fuyutsui 如何读取队友、小队和团队成员的信息，并把这些信息传给 Python 端职业逻辑。这里的“队友状态”包含血量、职责/距离有效性、可驱散类型、玩家施加在队友身上的增益，以及施法目标相关的辅助信息。

先明确几个结论：

- 当前源码没有读取队友能量、法力、怒气、符文能量等资源。`能量值` 只属于玩家自身。
- 队友状态不是 Python 直接调用游戏 API 读取的，而是 Lua 插件写入顶部像素条后由 Python 截图解码。
- 队友增益只记录玩家自己施加、且职业配置声明过的少量光环，不会扫描队友身上所有 Buff。
- 队友可驱散魔法不是只看“有没有魔法 Debuff”，还会结合当前玩家是否学会对应驱散法术；无能力驱散时输出 0。
- 当前 `Evoker.lua` 的增辉队友配置有两处不一致：光环字段写成了 `aura`，但 `main.lua` 读取的是 `v.auras`；Lua 侧 `num = 5`，Python `config.yml` 侧 `num = 4`。因此 `先知先觉` 队友光环很可能不会被写入像素，而且第 2 个及后续增辉队友槽位可能错位。这一点需要实测或修正源码后再视为可用。
- 当前圣骑士防护也存在 Lua/Python 配置不一致：Lua 侧声明了 `type = "group"`，但 Python `config.yml` 没有配置防骑 `group:`，因此防骑不会生成有意义的 `state_dict["group"]`。
- 当前 `updateGroup()` 还有一个需要注意的源码问题：`main.lua` 顶部缓存了局部 `group` 和 `groupList`，但 `updateGroup()` 重新赋值的是 `self.group` 和 `self.groupList`。因此旧成员、重复成员列表和旧像素槽位都有残留风险，不能简单假设”非当前队友槽位一定为 0”。（经代码复查确定为运行时数据污染 bug，不是简单的残留风险）

## 总体链路

完整链路是：

1. `Fuyutsui/class/*.lua` 在当前职业/专精的 `ClassBlocks` 里声明 `type = "group"`。
2. `Fuyutsui/main.lua` 的 `loadPlayerBlocks()` 把该配置整理成 `blocks.groups`。
3. `updateGroup()` 调用 `IterateGroupMembers()` 尝试建立 `group` 和 `groupList`。`updateGroup()` 有四条触发路径：（a）初始化时 `GetCharacterSpecInfo()` 直接调用 `self:updateGroup()`（main.lua:349）；（b）切专精/天赋时 `PLAYER_TALENT_UPDATE` 事件直接调用 `self:updateGroup()`（main.lua:1365-1368）；（c）队伍列表变化时 `GROUP_ROSTER_UPDATE` 事件触发更新；（d）`updatePlayerBlocks()` 调用 `self:updateGroup()`（main.lua:244）。需注意 `GROUP_ROSTER_UPDATE` 路径存在 1 秒防抖（debounce）机制（main.lua:1642-1654）：每次事件触发时先取消上一计时器（`rosterTimer:Cancel()`），再新建 1 秒 `C_Timer.NewTimer` 延迟执行 `updateGroup()`。因此连续快速重新组队时，`updateGroup()` 仅执行一次，mod 作者不能假设「队伍成员变化后立即能读到新数据」。注意：初始化时 `GetCharacterSpecInfo()` 和 `updatePlayerBlocks()` 各调用一次 `updateGroup()`（分别通过 main.lua:349 和 main.lua:244），因此 `OnEnable` 中 `updateGroup` 会被执行两次。切专精时 `PLAYER_TALENT_UPDATE` 处理函数（main.lua:1365-1368）也通过 `updatePlayerSpecInfo` 间接调用和直接调用各一次，同样存在双重重入。mod 作者不应假设 `updateGroup()` 在任何生命周期内只会执行一次。
4. `updateGroupInRangeAndHealth()`、`UNIT_AURA()`、`OnUpdateUnitAura()` 等函数读取 WoW API，并调用 `CreatTexture(index, value)` 写入顶部像素。
5. `Fuyutsui/Fuyutsui/GetPixels.py` 用 `mss` 截取顶部一行，按像素 G/B 通道解码。
6. `Fuyutsui/Fuyutsui/config.yml` 的 `group:` 配置把连续像素槽映射成 `state_dict["group"]`。
7. `Fuyutsui/Fuyutsui/utils.py` 和职业逻辑用 `state_dict["group"]` 选择治疗、驱散、补 Buff 的目标。

顶部像素仍使用统一编码：

```lua
tex:SetColorTexture(0, index / 255, value, 1)
```

Python 读取到：

- `G` 通道：像素索引，也就是 `step`。
- `B` 通道：字段值，0-255 的整数。

## 队友槽位如何排列

Lua 端的队友块配置示例：

```lua
[70] = {
    type = "group",
    num = 6,
    healthPercent = 1,
    role = 2,
    dispel = 3,
    auras = {
        [4] = { 156322 },
        [5] = { 1244893 },
        [6] = { 53563, 156910 },
    },
}
```

含义是：

- `start`：从哪个顶部像素索引开始。Lua 里就是外层 key，例如上例的 `70`。
- `num`：每个队友占几个连续像素。
- `healthPercent`、`role`、`dispel`：每个队友内部的相对槽位。
- `auras`：额外队友光环槽位，相对槽位作为 key，值是一组 spellId。
- `rejuv`：德鲁伊额外使用的回春数量槽位。

每个成员实际写入位置为：

```lua
index = blocks.groups.start + (obj.index - 1) * blocks.groups.num + fieldOffset
```

注意这里的 `fieldOffset` 从 1 开始，所以第 1 个成员的第 1 个字段写到 `start + 1`。Python 端也按同样规则解码：

```python
base_step = start + (i - 1) * num
row_key = base_step + rel_step
```

注意：GetPixels.py 第 352 行的注释写有 `-1`（`row_key=base_step+(rel_step-1)`），但实际代码第 370 行使用的是 `row_key = base_step + rel_step` 无 `-1`，与本文档公式一致。该注释具有误导性，mod 作者应以实际代码为准。

Python 固定解析 30 个槽位，生成 `state_dict["group"]["1"]` 到 `state_dict["group"]["30"]`。Lua 只会主动刷新当前遍历到的队伍成员；如果某个像素槽没有被写入，Python 会读成 0，但当前源码没有在重新建组时清空全部 group 槽位，旧槽位可能残留。

## 队友列表来自哪里

队友单位由 `Fuyutsui:IterateGroupMembers()` 生成：

```lua
local unit = (not forceParty and IsInRaid()) and 'raid' or 'party'
local numGroupMembers = unit == 'party' and GetNumSubgroupMembers() or GetNumGroupMembers()
local i = reversed and numGroupMembers or (unit == 'party' and 0 or 1)
```

规则是：

- 在团队中使用 `raid1` 到 `raidN`。
- 在小队中先返回 `player`，再返回 `party1` 到 `partyN`。
- 单人时 `GetNumSubgroupMembers()` 为 0，也会返回 `player`，所以第 1 个 group 槽位通常是玩家自己。

注意：团队模式下 IterateGroupMembers 从 i=1 开始返回 raid1 到 raidN，不会返回 player（core/core.lua:352-366）。因此第 1 个 group 槽位对应的是 raid1 而非玩家自身。上述"第 1 个槽位通常是玩家自己"仅在小队/单人模式下成立。团队治疗逻辑的 mod 作者不应假设 slot 1 为玩家自身。

`updateGroup()` 为每个单位保存：

| 字段 | 来源 | 是否直接传给 Python |
|---|---|---|
| `index` | 遍历顺序，从 1 开始 | 间接决定 group 槽位 |
| `name` | `GetUnitName(unit, true)` | 不写入像素 |
| `GUID` | `UnitGUID(unit)` | 不写入像素，只用于死亡事件匹配 |
| `role` | `UnitGroupRolesAssigned(unit)`；玩家自己用 `state.specRole` | 写入 `职责` |
| `isDead` | `UnitIsDeadOrGhost(unit)` | 影响 `职责` 槽是否为 0 |
| `inRange` | `UnitInRange(unit)` | 保存但不被后续函数读取（死字段） |
| `canAttack` | `UnitCanAttack("player", unit)` | 保存但当前队友输出不使用 |
| `canAssist` | `UnitCanAssist("player", unit)` | 影响有效性 |
| `inSight` | 初始 true，视野错误后短暂 false | 影响 `职责` 槽是否为 0 |
| `healAbsorb` | 治疗吸收事件临时标记 | 影响血量曲线 |
| `inComingHeals` | 玩家正在读条的单体治疗预估 | 影响血量曲线 |
| `aura` | 玩家施加在该单位上的光环缓存 | 用于输出职业队友光环 |
| `curve` | `creatColorCurveScaling()` 动态赋值 | 否，用于血量曲线生命周期 |
| `valid` | `updateUnitValid()` 动态赋值，`= not isDead and canAssist and inSight` | 间接（影响职责槽是否为 0） |
| `healthPercent` | `updateUnitHealthInfo()` 动态赋值，`= GetRGB() 的 B 值` | 间接（就是写入像素的值） |
| `inSightTimer` | 视野恢复定时器 | 否，仅 Lua 内部使用 |
| `curveTimer` | 治疗吸收恢复定时器 | 否，仅 Lua 内部使用 |

注意：这是一个比"残留风险"严重得多的运行时数据污染问题。main.lua:16-17 将 Fuyutsui.group 和 Fuyutsui.groupList 缓存到局部变量 group/groupList。updateGroup()（第 1303 行）执行 self.group = {} 创建新表赋值给 Fuyutsui.group，但局部变量 group 仍指向旧表。后续所有对 group 和 groupList 的写入（第 1307 行 table.insert(groupList, unit)、第 1312 行 group[unit] = {...}）操作的都是旧表。而所有队友更新函数（updateUnitHealthInfo、updateGroupInRangeAndHealth、OnUpdateUnitAura 等）都通过局部变量访问旧表。结果是：

1. groupList（旧表）永远不会被清空，每次 updateGroup() 调用后持续积累重复条目。
2. 离队成员的条目永远保留在旧 group 表中，不会被移除。
3. Fuyutsui.group（新表）从未被使用，处于空状态。
4. groupList 因持续增长不会缩小，导致 Python 解码的 30 个槽位被过期数据填充。

第三方作者排查队友槽位异常时，必须意识到上述"双表分裂"问题，不能假设非当前队友槽位为 0。

另外，updateIndex（main.lua:19）在 updateGroup() 运行后不会被重置。队伍人数减少时，updateIndex 可能超出 #groupList 的有效范围，导致 updateGroupInRangeAndHealth() 在后续帧中因 groupList[updateIndex] 返回 nil 而提前 return（main.lua:1117-1118），且不递增 updateIndex，造成刷新停滞。当前此问题被上述双表分裂问题掩盖（groupList 从不缩小），但修复双表分裂时必须配套在 updateGroup() 末尾重置 updateIndex = 1。

## 血量

队友血量由 `updateUnitHealthInfo(unit)` 输出：

```lua
obj.curve = creatColorCurveScaling(100 + obj.inComingHeals - obj.healAbsorb)
local healthPercent = UnitHealthPercent(unit, false, obj.curve)
local _, _, b = healthPercent:GetRGB()
obj.healthPercent = b
self:CreatTexture(index, obj.healthPercent)
```

正常情况下 Python 读到的 `生命值` 是 1-100 的百分比整数，不是当前血量数值。0% 血量时读数为 1 而非 0，这是因为 creatColorCurveScaling(100) 的曲线重叠导致最低点 B 值为 1/255。但当 `inComingHeals` 生效时，曲线基准会变成 `100 + inComingHeals - healAbsorb`，所以读数可能超过 100。

当 b > 100 时，creatColorCurveScaling() 还会整条曲线上移（main.lua:35-37）：X=0 处 B 值从 0 变为 (b-100)/255，X=1 处 B 值从 100/255 变为 b/255，中间均匀线性插值。例如 inComingHeals = 15 时 b = 115，0% 血量时 Python 读到 15 而非 0。这意味着死亡判断逻辑不能单纯依赖"职责=0"过滤，因为极端低血量时读数不是 0。

血量有两个修正量：

- `inComingHeals`：玩家开始施放某些单体治疗时，临时提高目标血量读数，避免连续对同一个目标过量治疗。
- `healAbsorb`：目标发生治疗吸收变化时，临时将血量曲线基准从 100 降低到 85（`healAbsorb = 15`），默认 1 秒后恢复。但 updateUnitHealAbsorbCurve 每次触发都会取消旧定时器并重新计时（main.lua:1178-1187）。如果 UNIT_HEAL_ABSORB_AMOUNT_CHANGED 在短时间内多次触发（例如多个治疗吸收效果同时刷新），血量曲线基准为 85 的持续时间会被延长，超出上述 1 秒窗口。

当前 `helpfulSpells` 只覆盖这些治疗法术：

| spellId | 预估加血 | 注释 |
|---|---:|---|
| `2061` | 15 | 快速治疗 |
| `1262763` | 15 | 祈福 |
| `82326` | 40 | 圣光术 |
| `19750` | 15 | 圣光闪现 |
| `8936` | 15 | 愈合 |
| `186263` | 50 | 暗影愈合 |
| `77472` | 15 | 治疗波 |

注意当前 helpfulSpells 只覆盖了牧师（快速治疗、祈福、暗影愈合）、圣骑士（圣光术、圣光闪现）、德鲁伊（愈合）、萨满（治疗波）。织雾武僧的活血术/氤氲之雾和戒律牧师的苦修等主要单体治疗法术不在其中。

`UNIT_HEALTH`、`UNIT_MAXHEALTH`、`UNIT_HEAL_ABSORB_AMOUNT_CHANGED`、`UNIT_HEAL_PREDICTION` 会更新死亡/有效状态；实际血量像素还会在每帧的 `updateGroupInRangeAndHealth()` 中轮询刷新。注意：这些事件同样会更新玩家自身的血量显示。`UNIT_HEAL_ABSORB_AMOUNT_CHANGED`（main.lua:1597-1598）在 `unit == "player"` 时调用 `self:updatePlayerHealth()`，与 `UNIT_HEALTH` / `UNIT_MAXHEALTH` / `UNIT_HEAL_PREDICTION` 的行为一致。

## 职责、距离、死亡和视野

Python 里的 `职责` 不是纯职责字段，它同时表达“这个单位当前能不能作为目标”。每帧 `updateGroupInRangeAndHealth()` 只刷新一个成员，并写入该成员的职责槽。

有效时：

```lua
local inRange = UnitIsUnit(unit, "player") and true or UnitInRange(unit)
local roleValue = roleMap[obj.role] and roleMap[obj.role] / 255 or 5 / 255
local trueValue = CreateColor(0, 0, roleValue, 1)
local booleanValue = EvaluateColorFromBoolean(inRange, trueValue, falseValueBlack)
local _, _, b = booleanValue:GetRGB()
self:CreatTexture(index, b)
```

无效时直接写 0。

职责编码为：

| Python 值 | 含义 |
|---:|---|
| `1` | 坦克，且未死、可协助、视野可用、距离可用 |
| `2` | 治疗，且有效 |
| `3` | 输出，且有效 |
| `0` | 无职责、死亡、不可协助、不在视野、超出距离，或未写入 |
| `5` | Lua 中遇到未知职责时的兜底值 |

注：roleMap["NONE"] = 0（core/config.lua:1027）。Lua 中 0 为真值，因此 NONE 职责不会穿透 and/or 模式的 or 分支（main.lua:1126）。若在其他语言中实现类似逻辑需注意此差异。

Python 的治疗选择函数会跳过 `职责 == 0` 的单位，例如 `get_lowest_health_unit()`、`get_unit_with_dispel_type()` 都会先调用 `_role_not_zero()`。

视野状态只在施法失败消息中被间接判断：

```lua
if message == "目标不在视野中" then
    updateUnitInSight(state.castTargetUnit)
end
```

`updateUnitInSight()` 会让该单位 `inSight = false`，1.5 秒后恢复 true。

实战效果：inSight 仅通过 UI_ERROR_MESSAGE「目标不在视野中」这个施法失败消息间接设为 false，正常游戏中几乎永远不会触发此条件。因此 `obj.valid`（main.lua:1123）中的 `inSight` 检查近乎形同虚设，mod 作者不应依赖 `inSight` 作为有意义的有效性门控。

以上"无效时直接写 0"仅适用于职责槽。健康像素由 updateUnitHealthInfo 写入（main.lua:1119），该函数在职责槽之前执行且无死亡/无效检查。对于死亡单位，UnitHealthPercent 返回 0%，经由曲线映射后产生约 1 的 B 值（见血量节关于曲线重叠的说明），因此死亡单位的生命值像素为 1 而非 0。

## 队友能量和其他资源

当前没有队友资源读取链路。

Lua 端只注册了玩家资源事件：

```lua
function Fuyutsui:UNIT_POWER_UPDATE(_, unit, powerType)
    if unit ~= "player" then return end
    self:updatePlayerPower(powerType)
end
```

`type = "group"` 中也没有 `power`、`mana`、`energy` 等字段。因此 Python 的 `state_dict["group"][slot]` 里不会出现队友能量。若第三方 mod 作者需要队友法力或其他资源，需要在 `ClassBlocks`、`loadPlayerBlocks()`、Lua 更新函数、`config.yml` 和 Python 消费逻辑中补一条新的 group 字段链路。

## 队友增益

队友增益使用真实 WoW Aura API，但不是全量扫描。它只缓存玩家自己施加的、职业配置关心的光环。

初始化或全量更新时：

```lua
for i = 1, 5 do
    local buff = C_UnitAuras.GetBuffDataByIndex(unit, i, "PLAYER|HELPFUL|RAID_IN_COMBAT")
    if buff then
        obj.aura[buff.auraInstanceID] = buff
    end
end
```

增量更新时：

```lua
if not isSec(v.spellId) and v.sourceUnit == "player" then
    obj.aura[v.auraInstanceID] = v
end
```

然后 `OnUpdateUnitAura()` 每 0.2 秒按 `blocks.groups.auras` 输出配置过的光环槽：

- 一个槽可以配置多个 spellId。
- `getMaxAuraByTable()` 会选过期时间最晚的那个光环。另外，该函数在迭代光环时会调用 `isSec()` 删除秘密值光环的缓存项（main.lua:1224-1225），看到秘密值光环时直接从 obj.aura 中移除。`isSec` 是 `main.lua:2` 定义的局部别名 `local isSec = issecretvalue`，对应 WoW API `issecretvalue`。暴雪对特定光环隐藏 spellId、targetName、unitGUID 等数据，`isSec()` 用于过滤这些受保护的秘密/遮蔽值（getMaxAuraByTable 第 1224 行在迭代光环时调用 isSec 移除秘密值缓存；UNIT_SPELLCAST_SENT 第 1411 行对 targetName 使用 isSec 过滤保护名）。
- `expirationTime == 0` 视为永久光环。Lua 传入 value=1，经 SetColorTexture(0, index/255, value, 1) 归一化编码后，B 通道 8 位值为 1.0 * 255 = 255。因此 Python 读到的是 255，与持续 255 秒的光环无法区分。
- 有持续时间时，用 `C_UnitAuras.GetAuraDuration(unit, auraInstanceID)` 转成剩余秒数，最多 255。
- 没有匹配光环时写 0。

这些字段在 Python 中直接表现为 `state_dict["group"][slot]["光环名"]` 的整数值。职业逻辑通常只判断是否为 0，或者选择没有某个光环的单位。

全量光环更新只把前 5 个 `PLAYER|HELPFUL|RAID_IN_COMBAT` Buff 写入 `obj.aura`，不会先清空旧缓存。Blizzard 的 GetBuffDataByIndex 按优先级、剩余时间等内部规则排序，不是简单的原始施放顺序。如果玩家在目标身上有超过 5 个可控的 HELPFUL Buff，仅前 5 个会被缓存到 obj.aura 中，后续的光环输出可能不完整。如果旧 aura 没有通过 `removedAuraInstanceIDs` 删除，缓存里可能暂时保留过期的 `auraInstanceID`。另外，`OnUpdateUnitAura()` 一开始要求 `blocks.groups.auras` 存在；因此只配置 `rejuv`、不配置 `auras` 的 group 块不会输出回春数量。这是一个结构性问题，不是简单的功能不可用——如果只配置 rejuv 而不配置 auras，OnUpdateUnitAura()（main.lua:1248-1249）在第 1249 行检查 blocks.groups.auras 为 nil 后直接 return，整个函数静默退出，rejuv 分支（第 1270 行）永远不可达。

### 当前配置的队友光环

| 职业/专精 | 每人字段数 | Python 字段 | 对应 Lua spellId |
|---|---:|---|---|
| 圣骑士/神圣 | 6 | `永恒之火` | `156322` |
| 圣骑士/神圣 | 6 | `救世道标` | `1244893` |
| 圣骑士/神圣 | 6 | `圣光道标` | `53563`、`156910` |
| 牧师/戒律 | 5 | `救赎` | `194384` |
| 牧师/戒律 | 5 | `真言术：盾` | `17`、`1253593` |
| 牧师/神圣 | 5 | `愈合祷言` | `41635` |
| 牧师/神圣 | 5 | `恢复` | `139` |
| 萨满/恢复 | 6 | `激流` | `61295` |
| 萨满/恢复 | 6 | `大地之盾` | `974`、`383648` |
| 萨满/恢复 | 6 | `大地生命`（Lua 源文件注释写为"大地生命武器"，与配置名不一致） | `382024` |
| 武僧/织雾 | 5 | `复苏之雾` | `119611` |
| 武僧/织雾 | 5 | `氤氲之雾` | `124682` |
| 德鲁伊/恢复 | 7 | `生命绽放` | `33763` |
| 德鲁伊/恢复 | 7 | `迅捷治愈` | `48438`、`8936`、`774`、`155777`（注：此字段监控的是可被迅捷治愈[18562]消耗的 HoT——回春术[774]、萌芽[155777]、愈合[8936]、野性成长[48438]——而非迅捷治愈法术本身） |
| 德鲁伊/恢复 | 7 | `愈合` | `8936` |
| 德鲁伊/恢复 | 7 | `回春数量` | 特殊计数：`774`、`155777` |
| 唤魔师/增辉 | 4 或 5 | `先知先觉` | 配置里写了 `409311`、`410089`，但 Lua 字段名疑似错误，见下文 |

德鲁伊的 `回春数量` 不走普通剩余时间逻辑，而是统计缓存光环中 `774` 或 `155777` 的数量，再写入 `rejuvCount / 255`。

### 增辉的配置问题

`Fuyutsui/class/Evoker.lua` 中增辉 group 写的是：

```lua
num = 5,
healthPercent = 1,
role = 2,
dispel = 3,
aura = {
    [4] = { 409311, 410089 },
}
```

但 `loadPlayerBlocks()` 只读取：

```lua
blocks.groups.auras = v.auras
```

因此 `blocks.groups.auras` 不会包含增辉的 `先知先觉` 配置，`OnUpdateUnitAura()` 也会直接返回。与此同时 Python 的 `config.yml` 又配置了：

```yaml
num: 4
先知先觉: {step: 4, type: "int" }
```

所以 Python 会读这个槽位，但该槽位大概率一直是 0；即使把 `aura` 改成 `auras`，Lua/Python 的 `num` 仍然不一致，第 2 个及后续成员的 `生命值`、`职责`、`驱散`、`先知先觉` 会按不同步长解释。第三方作者不要把当前增辉 group 字段当作已可靠输出，除非先修正并验证 Lua 与 Python 配置。

## 队友可驱散状态

队友驱散输出在 `UNIT_AURA()` 中刷新。需要注意的是，`getAuraDispelTypeColor()` 函数入口会检查 `if not blocks.groups or not obj then return end`（main.lua:1278-1280），`UNIT_AURA` 事件处理也会检查 `if not obj then return end`（main.lua:1761-1762），确认目标单位已在 group 表中才会处理。因此对宠物、非队伍友方等非 group 成员触发的 `UNIT_AURA` 不会写入驱散像素。

```lua
local auraInstanceIDs = C_UnitAuras.GetUnitAuraInstanceIDs(
    unit,
    "HARMFUL|RAID_PLAYER_DISPELLABLE",
    1,
    4
)
```

它只看 `RAID_PLAYER_DISPELLABLE` 的有害光环，也就是游戏认为当前玩家有可能驱散的团队 Debuff。若找到，取第一个 auraInstanceID：

```lua
local color = C_UnitAuras.GetAuraDispelTypeColor(unit, auraInstanceIDs[1], dispelCurve)
Fuyutsui:CreatTexture(index, color.b)
```

`dispelCurve` 会在 `updateSpellKnown()` 中根据玩家已学会的驱散法术动态生成：

| Python `驱散` 值 | 类型 | 能力来源示例 |
|---:|---|---|
| `1` | 魔法 | `527`、`360823`、`4987`、`115450`、`88423`、`77130` |
| `2` | 诅咒 | `383016`、`51886`、`392378`、`2782`、`475` |
| `3` | 疾病 | `390632`、`213634`、`393024`、`213644`、`388874`、`218164` |
| `4` | 中毒 | `392378`、`2782`、`393024`、`213644`、`388874`、`218164`、`365585` |
| `11` | 流血 | 当前配置为空，因此通常不会输出为可驱散 |
| `0` | 没有可驱散 Debuff，或玩家当前没有对应驱散能力 |

Python 端读到的整数值直接等于驱散类型编号（1=魔法、2=诅咒、3=疾病、4=中毒、11=流血）。这是通过 Lua 的 `dispelCurve:AddPoint(i, CreateColor(0, 1, i/255, 1))`（main.lua:191）编码的：B 通道写入 i/255，Python 读回整数 i。

当玩家未学会对应驱散法术时，`dispelCurve` 在该点写入 0（main.lua:194），Python 读到 0。流血类型（dispelAbilities[11] = {} 为空，main.lua:121）也是如此，因此通常输出 0。

注意：如上表所示，文档的驱散类型编号与 dispelAbilities 索引一致（2=诅咒、3=疾病）。但 main.lua:166-167 中 dispelCapabilities 的注释将 [2] 和 [3] 的标签写反了，应以 dispelAbilities 的法术 ID 分类为准。

Python 端用 `get_unit_with_dispel_type(state_dict, dispel_type)` 查第一个匹配单位，例如：

```python
dispel_unit_magic, _ = get_unit_with_dispel_type(state_dict, 1)
dispel_unit_disease, _ = get_unit_with_dispel_type(state_dict, 3)
dispel_unit_poison, _ = get_unit_with_dispel_type(state_dict, 4)
```

治疗职业还会结合 `队伍类型`、`首领战`、白名单/黑名单决定是否真的驱散。常见逻辑是：

- 大秘境/小队环境里优先允许驱散魔法。
- 团队环境中只在指定首领 ID 允许驱散魔法。
- 疾病、诅咒、中毒按职业能力和逻辑顺序处理。

## 施法目标和治疗预估

Fuyutsui 还会跟踪玩家正在对哪个队友读条：

```lua
function Fuyutsui:UNIT_SPELLCAST_SENT(_, unitTarget, targetName, castGUID, spellID)
    if unitTarget ~= "player" then return end
    if not isSec(targetName) then
        for unit, data in pairs(group) do
            if data.name == targetName then
                state.castTargetUnit = unit
                state.castTargetName = targetName
                state.castTargetIndex = data.index / 255
                break
            end
        end
    end
end
```

此处 `if not isSec(targetName)` 使用与第 248 行相同的 `isSec()` 机制（`issecretvalue` 的别名），过滤暴雪保护的秘密/遮蔽值——被隐藏或遮蔽的目标名无法通过字符串匹配找到对应队友，因此跳过该次施法目标记录。

若当前专精配置了 `施法目标`，Lua 会把 `state.castTargetIndex` 写到玩家状态区；Python 读到的是目标 group 槽位编号。这个字段不在 `state_dict["group"]` 内，但它和队友治疗链路有关。

读条开始时，UNIT_SPELLCAST_START 调用 updateUnitIncomingHealsCurve(spellID)，按 helpfulSpells 给 state.castTargetUnit 增加临时血量修正；读条停止时 UNIT_SPELLCAST_STOP 调用 updateUnitIncomingHealsCurve2() 将所有队友的 inComingHeals 置为 0。注意：此机制仅在普通读条（UNIT_SPELLCAST_START/STOP）中生效。引导（UNIT_SPELLCAST_CHANNEL_START/STOP）和储力（UNIT_SPELLCAST_EMPOWER_START/STOP）的处理函数既不会设置也不会清理 inComingHeals。

该重置由 updateUnitIncomingHealsCurve2()（main.lua:1201-1205）执行，它遍历 group 中所有成员将 inComingHeals 置为 0。注意：由于双表分裂问题（见"队友列表来自哪里"节），updateUnitIncomingHealsCurve2() 使用局部变量 group（旧表）迭代。当前所有成员都写入旧表，因此函数能正确工作；但 Fuyutsui.group（新表）始终为空，是潜在的代码脆弱点。

另外，updateUnitIncomingHealsCurve() 会在以下情况下静默返回不设置 inComingHeals：（1）state.castTargetUnit 为 nil（未通过 UNIT_SPELLCAST_SENT 成功匹配到目标）；（2）目标单位不在队友列表中（仍未被 updateGroup 添加或已离队）。

当前源码中 UNIT_SPELLCAST_EMPOWER_STOP 的条件判断为 `unitTarget ~= "player"`（main.lua:1485），与 CHANNEL_STOP 的 `== "player"` 相反。导致玩家支配角色自身完成储力时，state.empowering、state.castTargetUnit、state.castTargetName、state.castTargetIndex 均不会被清除，储能像素和施法目标追踪可能久置为过期值。第三方 mod 作者在修复此 bug 前，应注意储能相关的逻辑不能依赖 state.empowering 的正确清除。

## Python 如何使用队友信息

Python 解码后的结构大致如下：

```python
{
    "group": {
        "1": {
            "生命值": 82,
            "职责": 1,
            "驱散": 0,
            "救赎": 12,
            "真言术：盾": 0,
        },
        "2": {
            "生命值": 67,
            "职责": 3,
            "驱散": 1,
            "救赎": 0,
            "真言术：盾": 5,
        },
    }
}
```

`utils.py` 提供了多种队友选择函数：

| 函数 | 用途 |
|---|---|
| `get_lowest_health_unit()` | 找血量最低且职责不为 0 的单位 |
| `get_count_units_below_health()` / `count_units_below_health()` | 统计低血量单位数量 |
| `get_unit_with_role()` | 找指定职责的单位 |
| `get_unit_with_role_and_without_aura_name()` | 找指定职责且缺少某光环的单位 |
| `get_lowest_health_unit_without_aura()` | 找缺少某光环且血量最低的单位 |
| `get_lowest_health_unit_with_aura()` | 找有某光环且血量最低的单位 |
| `get_lowest_health_unit_with_any_aura()` | 找拥有任意指定光环且血量最低的单位 |
| `get_lowest_health_unit_with_aura_count()` | 找某光环数值等于指定值的最低血单位 |
| `get_unit_with_aura()` | 找拥有指定光环且持续时间最高的单位 |
| `count_units_without_aura_below_health()` | 统计缺少某光环且低血的单位 |
| `count_units_with_aura()` | 统计有某光环的单位 |
| `get_unit_with_dispel_type()` | 找第一个指定驱散类型的单位 |

职业逻辑再用返回的 group 槽位调用 `get_hotkey(int(unit), "技能名")`，从 keymap 中找对应单位的按键。

## 当前各专精的 group 配置

Python `config.yml` 中实际配置了这些 group 字段：

| 职业/专精 | start | num | Python 字段 |
|---|---:|---:|---|
| 圣骑士/神圣 | 70 | 6 | `生命值`、`职责`、`驱散`、`永恒之火`、`救世道标`、`圣光道标` |
| 圣骑士/惩戒 | 70 | 3 | `生命值`、`职责`、`驱散` |
| 圣骑士/防护 | 未配置 | 未配置 | Python 未配置 `group:`；Lua 侧有 `num = 3` 的 group 块，但不会被 Python 解析 |
| 牧师/戒律 | 70 | 5 | `生命值`、`职责`、`驱散`、`救赎`、`真言术：盾` |
| 牧师/神圣 | 70 | 5 | `生命值`、`职责`、`驱散`、`愈合祷言`、`恢复` |
| 萨满/恢复 | 70 | 6 | `生命值`、`职责`、`驱散`、`激流`、`大地之盾`、`大地生命` |
| 武僧/织雾 | 70 | 5 | `生命值`、`职责`、`驱散`、`复苏之雾`、`氤氲之雾` |
| 德鲁伊/恢复 | 45 | 7 | `生命值`、`职责`、`驱散`、`生命绽放`、`迅捷治愈`、`愈合`、`回春数量` |
| 唤魔师/增辉 | 70 | 4 | `生命值`、`职责`、`驱散`、`先知先觉`；但 Lua 侧是 `num = 5` 且疑似未正确输出 `先知先觉` |

未配置 group 的职业/专精不会生成有意义的 `state_dict["group"]` 字段。

## 需要注意的细节

- `updateGroupInRangeAndHealth()` 每帧只刷新一个队友的血量和职责槽，团队人数多时完整轮询需要多帧。
- `OnUpdateUnitAura()` 每 0.2 秒刷新一次队友光环槽。
- `UNIT_AURA()` 只在队友 aura 事件到来时刷新驱散槽；如果状态异常，可能要等下一次 aura 事件或重新建组。
- `updateGroup()` 目前不会主动调用 `clearGroupBlocks()`；同时局部 `group`/`groupList` 没有被清空。队伍人数减少或重新建组时，这是一个比"残留风险"严重得多的运行时数据污染问题。main.lua:16-17 将 Fuyutsui.group 和 Fuyutsui.groupList 缓存到局部变量 group/groupList。updateGroup()（第 1303 行）执行 self.group = {} 创建新表赋值给 Fuyutsui.group，但局部变量 group 仍指向旧表。后续所有对 group 和 groupList 的写入（第 1307 行 table.insert(groupList, unit)、第 1312 行 group[unit] = {...}）操作的都是旧表。而所有队友更新函数（updateUnitHealthInfo、updateGroupInRangeAndHealth、OnUpdateUnitAura 等）都通过局部变量访问旧表。结果是：

1. groupList（旧表）永远不会被清空，每次 updateGroup() 调用后持续积累重复条目。
2. 离队成员的条目永远保留在旧 group 表中，不会被移除。
3. Fuyutsui.group（新表）从未被使用，处于空状态。
4. groupList 因持续增长不会缩小，导致 Python 解码的 30 个槽位被过期数据填充。

第三方作者排查队友槽位异常时，必须意识到上述"双表分裂"问题，不能假设非当前队友槽位为 0；Python 固定解析 30 个槽位，逻辑侧依赖 `职责 == 0` 过滤无效单位时要特别小心。如果未来主动调用 clearGroupBlocks()，它从 blocks.groups.start 一直清零到 255（main.lua:1296），会覆盖同一像素区间内 spells、auras 等其他模块写入的像素。
- 全量光环更新只扫描前 5 个 `PLAYER|HELPFUL|RAID_IN_COMBAT` Buff，且不会清空旧缓存；增量更新依赖 `UNIT_AURA` 的 added/updated/removed 列表。
- 队友姓名只用于把 `UNIT_SPELLCAST_SENT` 的 `targetName` 映射回 group 槽位，不会传给 Python。
- 队友 GUID 只用于 `UNIT_DIED` 匹配死亡，不会传给 Python。
- `canAttack` 被保存进 group 对象，但当前队友输出链路没有使用它。
- `目标类型` 里的友方可驱散值和队友 `驱散` 字段不是同一个输出槽。前者属于玩家状态里的目标信息，后者属于 group 成员信息。此外，两者使用的颜色曲线也不同：目标驱散使用 target.enemyCurve 和 target.friendCurve（main.lua:76-77），队友驱散使用 dispelCurve（main.lua:75），三者是独立的 C_CurveUtil.CreateColorCurve() 实例。

## 修订记录

| 日期 | 修改位置 | 原因 | 摘要 |
|---|---|---|---|
| 2026-05-30 | 血量表格（spellId 186263） | spellId 186263 名称误写为「暗影痊合」 | 修正为「暗影愈合」 |
| 2026-05-30 | 队友列表来自哪里（第94行） | 未说明团队模式下第1个槽位对应 raid1 而非玩家自身 | 补充团队模式与小队模式的明确说明 |
| 2026-05-30 | 总体链路（第3步） | 遗漏 updateGroup() 的初始化及 PLAYER_TALENT_UPDATE 触发路径 | 补充列出全部三个触发路径：初始化、PLAYER_TALENT_UPDATE、GROUP_ROSTER_UPDATE |
| 2026-05-30 | 总体链路（第3步） | 遗漏 GROUP_ROSTER_UPDATE 的1秒防抖机制 | 补充说明 rosterTimer 取消重建及连续快速重组的防抖效果 |
| 2026-05-30 | 队友增益（isSec 首次出现处） | 未解释 isSec() 的含义和来源 | 补充说明 isSec 是 issecretvalue 的局部别名，用于过滤暴雪保护秘密值 |
| 2026-05-30 | 施法目标和治疗预估（isSec 出现处） | 同队友增益节遗漏 | 补充与第248行一致的 isSec 说明 |
| 2026-05-30 | 队友可驱散状态（UNIT_AURA 说明） | 未提及驱散函数仅对已在 group 表中的单位生效 | 补充 getAuraDispelTypeColor 和 UNIT_AURA 的 group[unit] 检查说明 |
| 2026-05-30 | 视野机制（inSight 说明） | 未点明 inSight 几乎永远为 true 的实战效果 | 补充说明 inSight 检查近乎形同虚设，mod 作者不应依赖
| 2026-05-30 | 队友增益（isSec 行号） | 错误声称 isSec 在第 369 行使用，实际第 369 行为 updatePlayerBlocks | 将「第 369 行也使用相同机制」替换为准确的 getMaxAuraByTable 第 1224 行和 UNIT_SPELLCAST_SENT 第 1411 行引用 |
| 2026-05-30 | 总体链路（第3步） | 遗漏第4条 updateGroup() 触发路径及双重重入行为 | 补充路径 (d) updatePlayerBlocks()，并说明初始化及切专精时的双重重入 |
| 2026-05-30 | 职责代码片段 | 使用了未定义的 trueValue 变量和 b 变量 | 补充 local trueValue = CreateColor(...) 和 local _, _, b = booleanValue:GetRGB() |
| 2026-05-30 | 队友槽位排列（Python 公式） | 未提及 GetPixels.py 第352行注释与实际代码不符 | 添加注说明注释含 -1 但实际执行无 -1 |
| 2026-05-30 | 血量（事件说明） | 未提及 UNIT_HEAL_ABSORB_AMOUNT_CHANGED 等事件也会更新玩家自身血量 | 补充这些事件同样调用 self:updatePlayerHealth() 的说明 |

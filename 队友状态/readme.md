# 队友状态

本文说明 Fuyutsui 如何读取队友、小队和团队成员的信息，并把这些信息传给 Python 端职业逻辑。这里的“队友状态”包含血量、职责/距离有效性、可驱散类型、玩家施加在队友身上的增益，以及施法目标相关的辅助信息。

先明确几个结论：

- 当前源码没有读取队友能量、法力、怒气、符文能量等资源。`能量值` 只属于玩家自身。
- 队友状态不是 Python 直接调用游戏 API 读取的，而是 Lua 插件写入顶部像素条后由 Python 截图解码。
- 队友增益只记录玩家自己施加、且职业配置声明过的少量光环，不会扫描队友身上所有 Buff。
- 队友可驱散魔法不是只看“有没有魔法 Debuff”，还会结合当前玩家是否学会对应驱散法术；无能力驱散时输出 0。
- 当前 `Evoker.lua` 的增辉队友配置有两处不一致：光环字段写成了 `aura`，但 `main.lua` 读取的是 `v.auras`；Lua 侧 `num = 5`，Python `config.yml` 侧 `num = 4`。因此 `先知先觉` 队友光环很可能不会被写入像素，而且第 2 个及后续增辉队友槽位可能错位。这一点需要实测或修正源码后再视为可用。

## 总体链路

完整链路是：

1. `Fuyutsui/class/*.lua` 在当前职业/专精的 `ClassBlocks` 里声明 `type = "group"`。
2. `Fuyutsui/main.lua` 的 `loadPlayerBlocks()` 把该配置整理成 `blocks.groups`。
3. `updateGroup()` 调用 `IterateGroupMembers()` 建立 `group` 和 `groupList`。
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

Python 固定解析 30 个槽位，生成 `state_dict["group"]["1"]` 到 `state_dict["group"]["30"]`。Lua 只会给实际队伍成员写像素，其他槽位一般读成 0。

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

`updateGroup()` 为每个单位保存：

| 字段 | 来源 | 是否直接传给 Python |
|---|---|---|
| `index` | 遍历顺序，从 1 开始 | 间接决定 group 槽位 |
| `name` | `GetUnitName(unit, true)` | 不写入像素 |
| `GUID` | `UnitGUID(unit)` | 不写入像素，只用于死亡事件匹配 |
| `role` | `UnitGroupRolesAssigned(unit)`；玩家自己用 `state.specRole` | 写入 `职责` |
| `isDead` | `UnitIsDeadOrGhost(unit)` | 影响 `职责` 槽是否为 0 |
| `inRange` | `UnitInRange(unit)` | 影响 `职责` 槽是否为 0 |
| `canAttack` | `UnitCanAttack("player", unit)` | 保存但当前队友输出不使用 |
| `canAssist` | `UnitCanAssist("player", unit)` | 影响有效性 |
| `inSight` | 初始 true，视野错误后短暂 false | 影响 `职责` 槽是否为 0 |
| `healAbsorb` | 治疗吸收事件临时标记 | 影响血量曲线 |
| `inComingHeals` | 玩家正在读条的单体治疗预估 | 影响血量曲线 |
| `aura` | 玩家施加在该单位上的光环缓存 | 用于输出职业队友光环 |

## 血量

队友血量由 `updateUnitHealthInfo(unit)` 输出：

```lua
obj.curve = creatColorCurveScaling(100 + obj.inComingHeals - obj.healAbsorb)
local healthPercent = UnitHealthPercent(unit, false, obj.curve)
local _, _, b = healthPercent:GetRGB()
self:CreatTexture(index, obj.healthPercent)
```

正常情况下 Python 读到的 `生命值` 是 0-100 的百分比整数，不是当前血量数值。

血量有两个修正量：

- `inComingHeals`：玩家开始施放某些单体治疗时，临时提高目标血量读数，避免连续对同一个目标过量治疗。
- `healAbsorb`：目标发生治疗吸收变化时，临时降低血量曲线 15 点，1 秒后恢复。

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

`UNIT_HEALTH`、`UNIT_MAXHEALTH`、`UNIT_HEAL_ABSORB_AMOUNT_CHANGED`、`UNIT_HEAL_PREDICTION` 会更新死亡/有效状态；实际血量像素还会在每帧的 `updateGroupInRangeAndHealth()` 中轮询刷新。

## 职责、距离、死亡和视野

Python 里的 `职责` 不是纯职责字段，它同时表达“这个单位当前能不能作为目标”。每帧 `updateGroupInRangeAndHealth()` 只刷新一个成员，并写入该成员的职责槽。

有效时：

```lua
local inRange = UnitIsUnit(unit, "player") and true or UnitInRange(unit)
local roleValue = roleMap[obj.role] and roleMap[obj.role] / 255 or 5 / 255
local booleanValue = EvaluateColorFromBoolean(inRange, trueValue, falseValueBlack)
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

Python 的治疗选择函数会跳过 `职责 == 0` 的单位，例如 `get_lowest_health_unit()`、`get_unit_with_dispel_type()` 都会先调用 `_role_not_zero()`。

视野状态只在施法失败消息中被间接判断：

```lua
if message == "目标不在视野中" then
    updateUnitInSight(state.castTargetUnit)
end
```

`updateUnitInSight()` 会让该单位 `inSight = false`，1.5 秒后恢复 true。

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
- `getMaxAuraByTable()` 会选过期时间最晚的那个光环。
- `expirationTime == 0` 视为永久光环，写入 `255`。
- 有持续时间时，用 `C_UnitAuras.GetAuraDuration(unit, auraInstanceID)` 转成剩余秒数，最多 255。
- 没有匹配光环时写 0。

这些字段在 Python 中直接表现为 `state_dict["group"][slot]["光环名"]` 的整数值。职业逻辑通常只判断是否为 0，或者选择没有某个光环的单位。

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
| 萨满/恢复 | 6 | `大地生命` | `382024` |
| 武僧/织雾 | 5 | `复苏之雾` | `119611` |
| 武僧/织雾 | 5 | `氤氲之雾` | `124682` |
| 德鲁伊/恢复 | 7 | `生命绽放` | `33763` |
| 德鲁伊/恢复 | 7 | `迅捷治愈` | `48438`、`8936`、`774`、`155777` |
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

队友驱散输出在 `UNIT_AURA()` 中刷新：

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
    for unit, data in pairs(group) do
        if data.name == targetName then
            state.castTargetUnit = unit
            state.castTargetIndex = data.index / 255
            break
        end
    end
end
```

若当前专精配置了 `施法目标`，Lua 会把 `state.castTargetIndex` 写到玩家状态区；Python 读到的是目标 group 槽位编号。这个字段不在 `state_dict["group"]` 内，但它和队友治疗链路有关。

读条开始时，`updateUnitIncomingHealsCurve(spellID)` 会按 `helpfulSpells` 给 `state.castTargetUnit` 增加临时血量修正；读条停止或引导停止时清空。

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
- `updateGroup()` 目前不会主动调用 `clearGroupBlocks()`，队伍人数减少时旧槽位是否残留需要实测；Python 固定解析 30 个槽位，所以逻辑侧依赖 `职责 == 0` 过滤无效单位。
- 全量光环更新只扫描前 5 个 `PLAYER|HELPFUL|RAID_IN_COMBAT` Buff；增量更新依赖 `UNIT_AURA` 的 added/updated/removed 列表。
- 队友姓名只用于把 `UNIT_SPELLCAST_SENT` 的 `targetName` 映射回 group 槽位，不会传给 Python。
- 队友 GUID 只用于 `UNIT_DIED` 匹配死亡，不会传给 Python。
- `canAttack` 被保存进 group 对象，但当前队友输出链路没有使用它。
- `目标类型` 里的友方可驱散值和队友 `驱散` 字段不是同一个输出槽。前者属于玩家状态里的目标信息，后者属于 group 成员信息。

# 一键辅助

"一键辅助"是魔兽世界内置功能（`C_AssistedCombat` API）的统称。Fuyutsui 通过 block 索引 13 将官方一键辅助推荐的下一个施法技能 ID 编码到色块行中，Python 端读取后作为战斗逻辑的决策依据之一。

## 数据流总览

```text
WoW C_AssistedCombat API
  → Lua: updatePlayerAssistant() 读取推荐技能
  → 写入 block 索引 13（B 通道 = 技能 index/255）
  → Python: 读取 state_dict["一键辅助"]
  → 在 action_map 中查找映射，决定下一步操作
```

## Lua 端

### 槽位定义

**固定位置：** 所有职业、所有专精中均为 `[13] = { type = "block", name = "一键辅助" }`。

定义在各 `class/*.lua` 文件（如 `Fuyutsui/class/Mage.lua` 第 17 行）：
```lua
[13] = { type = "block", name = "一键辅助" },
```

### config.yml 映射

`Fuyutsui/Fuyutsui/config.yml` 第 15 行：
```yaml
一键辅助: {step: 13, type: "int" }
```

### 数据写入函数

`Fuyutsui/main.lua` 第 511–517 行：

```lua
-- 13. 更新玩家[一键辅助]
function Fuyutsui:updatePlayerAssistant()
    local spellId = C_AssistedCombat.GetNextCastSpell()
    local spellIndex = spellsList[spellId] and spellsList[spellId].index or 0
    state.assistantSpell = spellIndex / 255 or 0
    self:CreatTexture(blocks.state["一键辅助"], state.assistantSpell)
end
```

**工作原理：**
1. 调用 WoW 原生 API `C_AssistedCombat.GetNextCastSpell()` 获取官方一键辅助推荐的技能 ID
2. 在全局 `spellsList` 中查找该技能 ID 对应的 `index`（即技能的编号，定义在 `Fuyutsui/core/config.lua`）
3. 将 `index / 255` 写入 block 索引 13 的 B 通道
4. 若技能不在 spellsList 中，写入 0

### 更新频率

`Fuyutsui/main.lua` 第 1825–1837 行 — 在低频逻辑中每 0.2 秒调用一次：

```lua
-- 2. 低频逻辑（每 0.2 秒执行）
self.timeElapsed = self.timeElapsed + elapsed
if self.timeElapsed > 0.2 then
    -- ...
    self:updatePlayerAssistant()
    -- ...
    self.timeElapsed = 0
end
```

### 玩家状态表

`Fuyutsui/main.lua` 中 `state.assistantSpell` 存储当前一键辅助技能的归一化 index 值：
```lua
state.assistantSpell = spellIndex / 255 or 0
```

## Python 端

### 读取

所有职业的 `*_logic.py` 文件中统一通过 state_dict 读取：

```python
一键辅助 = state_dict.get("一键辅助", 0)
```

由于 B 通道写入的是 `index/255`，Python 端读取到的值是 0–255 范围内的整数（`row_data[13]`），经由 config.yml 映射为 `state_dict["一键辅助"]`。

### 核心用途：action_map 索引

一键辅助的值（技能 index）被用作 `action_map` 的键，查找对应的技能名称和按键宏。这是 **"官方一键辅助兜底"** 模式的核心机制。

每个职业的 logic 文件中都定义了一个 `action_map` 字典，将一键辅助返回的技能 index 映射到 `(技能说明, 宏名称)` 元组：

**以法师为例** (`Fuyutsui/Fuyutsui/class/mage_logic.py`)：
```python
action_map = {
    1: ("寒冰屏障", "寒冰屏障"),
    2: ("解除诅咒", "解除诅咒"),
    3: ("强化隐形术", "强化隐形术"),
    4: ("超级新星", "超级新星"),
    # ... 共 55 个映射
    55: ("造餐术", "造餐术"),
}
```

**以死亡骑士为例** (`Fuyutsui/Fuyutsui/class/deathknight_logic.py`)：
```python
action_map = {
    4: ("亡者大军", "亡者大军"),
    5: ("心脏打击", "心脏打击"),
    6: ("枯萎凋零", "枯萎凋零"),
    7: ("死神的抚摸", "死神的抚摸"),
    # ...
    42: ("死灵缠绕", "凋零缠绕"),
}
```

### 决策优先级

在大部分职业逻辑中，"一键辅助" 的 `action_map` 查找作为**保底兜底**，优先级低于战斗状态判断。典型结构（以战士为例）：

```python
tup = action_map.get(一键辅助)
action_hotkey = None
current_step = "无匹配技能"

if 法术失败 != 0 and 失败法术 is not None:
    current_step = f"施放 {失败法术}"
    action_hotkey = get_hotkey(0, 失败法术)
elif 一键辅助 == 12:
    current_step = "施放 战斗怒吼"           # 优先处理 buff 类
    action_hotkey = get_hotkey(0, "战斗怒吼")
elif ...:
    # 其他高优先级逻辑
elif ...战斗 and ...:
    if tup:
        current_step = f"施放 {tup[0]}"      # 兜底：一键辅助推荐
        action_hotkey = get_hotkey(0, tup[1])
    else:
        current_step = "战斗中-无匹配技能"
else:
    current_step = "无匹配技能"
```

### 特殊用途：非战斗 buff 触发

部分职业用一键辅助的特定 index 值来判断是否需要施放非战斗 buff：

**牧师：** index 10 = 真言术：韧，index 20 = 暗影形态

```python
elif 一键辅助 == 10:
    current_step = "施放 真言术：韧"
    action_hotkey = get_hotkey(0, "真言术：韧")
elif 一键辅助 == 20:
    current_step = "施放 暗影形态"
    action_hotkey = get_hotkey(0, "暗影形态")
```

**萨满：** index 1–4 对应 buff（唤潮者的护卫、大地生命武器、天怒、水之护盾）

```python
elif 一键辅助 in [1, 2, 3, 4] and tup:
    current_step = f"施放 {tup[0]}"
    action_hotkey = get_hotkey(0, tup[1])
```

**术士：** 特定 index 用于召唤宠物（index 9, 10, 13, 14, 60, 61 在 `summon_baby` 集合中）

```python
summon_baby = {9, 10, 13, 14, 60, 61}

elif 一键辅助 in summon_baby and 邪能统御 == 0:
    current_step = "施放 邪能统御"
    action_hotkey = get_hotkey(0, "邪能统御")
```

**战士：** index 12 = 战斗怒吼

```python
elif 一键辅助 == 12:
    current_step = "施放 战斗怒吼"
    action_hotkey = get_hotkey(0, "战斗怒吼")
```

**暗牧（引导中）：** 一键辅助 != 22 表示不需要打断引导

```python
if 战斗 and 1 <= 目标类型 <= 3 and 一键辅助 !=22:
    if tup:
        current_step = f"施放 {tup[0]}"
        action_hotkey = get_hotkey(0, tup[1])
```

## 输出模式开关

Fuyutsui 支持两种输出模式，由 `db.char.dpsMode` 控制：

| dpsMode 值 | 含义 | 行为 |
|---|---|---|
| 0 | 官方一键辅助 | Python logic 使用 action_map 查找一键辅助推荐 |
| 1 | 手动编写逻辑 | Python logic 按手写优先级决策（不依赖一键辅助） |

切换命令（`Fuyutsui/core/core.lua` 第 150–167 行）：
```
/fu dpsmode           -- 切换模式
/fu dpsmode manual    -- 设为手动编写逻辑
/fu dpsmode assistant -- 设为官方一键辅助
```

Ace GUI 中也提供了下拉选择 (`Fuyutsui/gui.lua` 第 313–323 行)：
```lua
dpsMode = {
    type = "select",
    order = 30,
    name = "输出模式",
    values = { [0] = "官方一键辅助", [1] = "手动编写逻辑" },
}
```

## spellsList 的 index 体系

一键辅助传递的是 `spellsList[spellId].index`，即技能的全局编号。`spellsList` 在 `Fuyutsui/core/config.lua` 中定义，为全部职业的每个关注技能分配了唯一的 `index`。

**Python 端的 action_map 键必须与 Lua 端 spellsList 的 index 一致**，否则无法正确匹配。

## 各职业 action_map 规模

| 职业 | action_map 条目数 | 特殊用法 |
|---|---|---|
| 死亡骑士 | 39 | 全兜底 |
| 恶魔猎手 | 13 | 全兜底 |
| 德鲁伊 | 30 | 全兜底 |
| 唤魔师 | 10 | 全兜底 |
| 猎人 | 23 | 全兜底 |
| 法师 | 55 | 全兜底 |
| 武僧 | 17 | 全兜底 |
| 圣骑士 | 18 | 全兜底 |
| 牧师 | 27 | index 10/20/22 特殊判断 |
| 潜行者 | 60 | 全兜底 |
| 萨满 | 24 | index 1-4 buff 判断 |
| 术士 | 19 | summon_baby 宠物判断 |
| 战士 | 39 | index 12 战吼判断 |

## 数据编码细节

### 传递的值类型

- Lua 端写入 B 通道：`spellIndex / 255`
- 传输方式：像素 B 通道（0–255 整数）
- Python 端读取：`state_dict["一键辅助"]`，值是 0–255 整数
- 值为 0 表示一键辅助未推荐任何在 spellsList 中的技能
- 非零值表示一键辅助推荐的技能在 `spellsList` 中的 `index`

### 为什么用 index 而不是 spellId

1. 节省像素精度：index 最大约 60（远小于 spellId 的 7 位数），用 8 位像素 B 通道足够编码
2. 跨端一致性：Lua 和 Python 共享同一个 spellsList，index 作为轻量标识符
3. Python 端直接在 action_map 中用 index 作为键查找，无需额外转换

## 相关文件

| 文件 | 作用 |
|---|---|
| `Fuyutsui/main.lua:512-517` | `updatePlayerAssistant()` 函数定义 |
| `Fuyutsui/main.lua:1832` | 每 0.2 秒调用一次 |
| `Fuyutsui/core/config.lua` | spellsList 定义（spellId→index 映射） |
| `Fuyutsui/core/core.lua:150-167` | dpsMode 切换命令 |
| `Fuyutsui/gui.lua:313-323` | Ace GUI 输出模式选择 |
| `Fuyutsui/Fuyutsui/config.yml:15` | step 13→"一键辅助" 映射 |
| `Fuyutsui/Fuyutsui/class/*_logic.py` | 各职业 action_map 及使用逻辑 |

## 相关文档

- `块分配表/readme.md`：block 索引 13 的位置和编码规则
- `截图原理/readme.md`：Python 端如何读取像素数据

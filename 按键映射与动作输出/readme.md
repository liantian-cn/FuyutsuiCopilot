# 按键映射与动作输出

本文解释 Fuyutsui 如何将职业逻辑产生的决策（"对单位 X 施放技能 Y"）映射到具体按键，以及如何将按键发送给魔兽世界窗口。

> **重要提示：本文档不包含任何具体键位信息。** 每个用户的键位由各自的 keymap 文件定义，本文只解释 keymap 的设计机制和映射流程，不列举任何具体按键。

## 总体链路

1. `config.yml` 为每个职业声明 `keymap` 字段，指向该职业专用的 keymap 文件。
2. `utils.py` 的 `select_keymap_for_class(class_id)` 在每次 state_dict 刷新时（受 `LOGIC_INTERVAL=0.2s` 守卫）切换到当前职业的 keymap，而非每次主循环迭代（`TOGGLE_INTERVAL=0.1s`）。
3. `utils.py` 的 `get_hotkey(unit, spell)` 根据目标单位和技能名从 keymap 中查找热键字符串。
4. 职业逻辑 `class/*_logic.py` 调用 `get_hotkey()`，返回 `action_hotkey`。
5. `logic_gui.py` 的主循环将 `action_hotkey` 传递给 `send_key_to_wow()`。
6. `send_key_to_wow()` 解析热键字符串，通过 Windows `PostMessage` API 将按键发送给魔兽世界窗口。
7. 若 `class_id` 不匹配任何已知职业逻辑模块，则转为执行默认逻辑（`_default_logic`），返回 `(None, '无逻辑定义', {})`，主循环跳过本轮按键决策并在状态栏显示"无逻辑定义"。当 `state_dict` 中 `'职业'` 字段缺失时 `class_id=None`；当值为 `0` 时 `class_id=0`。两者均不匹配 `LOGIC_FUNCS_BY_CLASS` 中的任何已知职业，均触发 `_default_logic` 兜底路径，GUI 显示"无逻辑定义"。此组合在游戏刚启动、像素数据到达但职业尚未被识别时常见，调试初始配置问题时应优先排查。

## keymap 文件

### 文件位置和选择

keymap 文件按需加载。代码默认路径为 `Fuyutsui/Fuyutsui/keymap.yml`（根目录，通常不存在）。每个职业在 `config.yml` 中通过 `keymap` 字段指定其 keymap 文件名，实际加载路径为 `Fuyutsui/Fuyutsui/keymap/<文件名>`。在 `keymap/` 目录下同时存在一个空的 `keymap.yml` 文件，但仅当某个职业的 keymap 字段明确设为 `"keymap.yml"` 时才会被使用。

`config.yml` 中每个职业的顶层配置指定使用哪个 keymap 文件：

```yaml
# config.yml 示例结构
5:          # 职业 ID = 5（牧师）
  keymap: "priest.yml"   # 使用 keymap/priest.yml
  1:                     # 专精 ID = 1（戒律）
    spells: ...
```

`select_keymap_for_class(class_id)` 的逻辑：

1. 如果 `class_id` 与当前已加载的 keymap 相同且缓存存在，直接返回（避免重复加载）。
2. 如果 `class_id` 为 `None`，则使用默认路径 `keymap.yml`。注意：`select_keymap_for_class(None)` 会回退到默认路径。但是，当 `class_id=None` 时主循环使用 `_default_logic`（不调用 `get_hotkey()`/`load_keymap()`），因此标准流程中不会因默认文件不存在而抛出 `FileNotFoundError`。仅当自定义逻辑直接调用 `get_hotkey()` 时此路径才有 `FileNotFoundError` 风险。
3. 否则从 `config.yml` 读取该职业的 `keymap` 字段。若该职业没有 `keymap` 字段、或 `keymap` 值不是非空字符串，`keymap_path` 会静默回退到默认路径 `keymap.yml`。但与 `class_id=None` 路径不同，此时 class_id 有效，实际职业逻辑函数会调用 `get_hotkey()` 从而触发 `load_keymap()`，若默认 `keymap.yml` 不存在则有真实的 `FileNotFoundError` 风险。建议开发者在配置中始终为每个职业声明有效的 `keymap` 字段，或添加文件存在性检查。若 `keymap` 字段有效，则拼接出完整路径 `keymap/<文件名>`。

> **注：** `select_keymap_for_class()` 内部使用 `config.get(class_id) or config.get(str(class_id))` 同时尝试数值和字符串两种键类型。双重查找覆盖 YAML 键类型与 class_id 类型恰好相反的场景（如 YAML 用字符串键而 class_id 为整数，或反之），但若两者同为整数键且 class_id 为字符串时两次查找均失败。实际运行时 `state_dict["职业"]` 由 `int()` 转换而来，始终为整数，因此正常运行无影响。

> **注：** 若 `keymap` 值为绝对路径（如 `D:/shared/keymaps/通用.yml` 或 `/home/user/configs/warlock.yml`），则直接使用该路径，不拼接 `keymap/` 前缀。此特性适用于跨项目共享 keymap 或将 keymap 存储在 Fuyutsui 目录外的场景。

4. 更新 `KEYMAP_PATH`，清空 keymap 缓存和热键查找缓存，下次调用 `get_hotkey()` 时会重新加载。

> **注意：** 若 keymap 文件存在但 YAML 格式有误，`load_keymap()` 中的 `yaml.safe_load()` 会抛出 `yaml.YAMLError`，被顶层异常处理器捕获后仅打印 `"Worker error:"` 到控制台，逻辑线程停止运行而不产生 GUI 错误弹窗。调试 keymap 加载问题时建议先手动验证 YAML 格式。

### 文件格式

keymap 文件是 YAML 格式，每条记录包含三个字段：

```yaml
# 每条记录的结构
条目编号: {unit: <单位编号>, 技能: "<技能名称>", 热键: "<热键字符串>"}
```

三个字段的含义：

| 字段 | 说明 |
|------|------|
| `unit` | 目标单位编号。`0` 表示玩家自身（无需切换目标），`1`~`30` 表示队伍中的对应单位 |
| `技能`（或 `spell`） | 技能名称，与 `config.yml` 中 `spells` 下的键名以及职业逻辑中传给 `get_hotkey()` 的技能名一致 |
| `热键`（或 `hotkey`） | 热键字符串，格式为 `修饰键-修饰键-主键`，如 `CTRL-NUMPAD1`、`ALT-SHIFT-F1` |

> **注意：** 字段名必须严格拼写为上述名称之一（`spell`/`技能`/`hotkey`/`热键`）。拼写错误（如将 `热键` 误写为 `热健`）会导致该字段在加载时值为 `None`，对应条目会被缓存构建过程静默跳过，不报错、不写入缓存。调试 keymap 加载问题时，请先确认每条记录的字段名书写正确。

`get_hotkey()` 同时支持中英文字段名：`spell` 与 `技能` 等效，`hotkey` 与 `热键` 等效。引擎按英文→中文顺序依次查找。

### 条目编号

条目编号（YAML 中的 key）仅用于保证 YAML 文件中的唯一性，**在热键查找逻辑中不被使用**。系统以 `(unit, 技能)` 二元组作为查找键。

## 热键查找：`get_hotkey(unit, spell)`

### 函数签名

```python
def get_hotkey(unit, spell):
    """
    根据 unit 和 spell 返回热键。
    若 unit 为空（None 或 ""），则按 unit=0 查找。
    返回热键字符串，未找到则返回 None。
    """
```

### 缓存机制

首次调用 `get_hotkey()` 时构建缓存：

1. 调用 `load_keymap()` 加载当前 keymap 的 YAML。
2. 遍历每条记录，提取 `unit`、`spell`、`hotkey` 三个值。
3. 检查每个条目的 `spell` 和 `hotkey` 字段：若任一字段为 `None`（如字段名拼写错误或值缺失），该条目被静默跳过，不写入缓存。
4. 对 `unit` 做安全转换：`None` 或空字符串视为 `0`，非数字字符串也视为 `0`。
5. 构建字典 `{(unit, spell): hotkey}` 作为缓存。

后续调用直接从缓存字典查找，不再解析 YAML。当 `select_keymap_for_class()` 切换 keymap 时缓存被清空，下次 `get_hotkey()` 会重新构建。

### unit 参数处理

`unit` 参数的转换逻辑（同时适用于构建缓存和调用侧）：

1. `unit` 为 `None` 或空字符串 `""` → 视为 `0`（玩家自身）。
2. `unit` 为字符串 → 尝试 `int(unit)` 转换；转换失败则视为 `0`。
3. 其他情况 → 直接使用原值。

**`unit=0` 的特殊含义**：表示玩家自身。游戏内的宏对此类按键不需要切换目标，直接对当前目标或自身施法。这是大多数输出技能（攻击技能、自我 buff）使用 `unit=0` 的原因。

**`unit=1~30`**：表示队伍中的第 1~30 号单位。游戏内的宏通过 `/target [@party1]` 等方式指定目标。治疗职业（如戒律牧、奶德）会为每个队伍位置配置独立的按键，宏中包含对应的目标选择指令。

### 查找失败

如果 `(unit, spell)` 在缓存中不存在，`get_hotkey()` 返回 `None`。职业逻辑中调用后若得到 `None`，则本循环不发送任何按键。这是一种静默失败——不会报错，只是跳过本次按键发送。

## 单位编号到游戏目标

### 编号来源

单位编号来自 `state_dict["group"]` 字典的 key。这些 key 是字符串 `"1"` ~ `"30"`，对应魔兽世界队伍/团队框架中的固定位置。

职业逻辑通过 `utils.py` 中的辅助函数获取目标单位编号：

| 辅助函数 | 返回 |
|----------|------|
| `get_lowest_health_unit(state_dict, health_threshold=100)` | `(slot, pct)` 或 `(None, None)` |
| `get_unit_with_dispel_type(state_dict, dispel_type)` | `(key, data)` 或 `(None, None)` |
| `get_unit_with_role(state_dict, role, reverse=False)` | 单位编号字符串或 `None` |
| `get_lowest_health_unit_with_any_aura(state_dict, *aura_names, health_threshold=100)` | `(slot, pct)` 或 `(None, None)` |
| `get_lowest_health_unit_without_aura(state_dict, aura_name, health_threshold=100)` | `(slot, pct)` 或 `(None, None)` |
| `get_lowest_health_unit_with_aura(state_dict, aura_name, health_threshold=100)` | `(slot, pct)` 或 `(None, None)` |
| `get_lowest_health_unit_with_aura_count(state_dict, aura_name, aura_count, health_threshold=100)` | `(slot, pct)` 或 `(None, None)` |
| `get_unit_with_aura(state_dict, aura_name)` | `(unit, duration)`（取 duration 最高单位，非首个匹配）或 `(None, None)` |
| `get_count_units_below_health(state_dict, health_threshold=100)` | `int`（符合条件的单位数量） |
| `count_units_below_health(state_dict, health_threshold)` | `int`（符合条件的单位数量） |
| `count_units_without_aura_below_health(state_dict, aura_name, health_threshold)` | `int`（符合条件的单位数量） |
| `count_units_with_aura(state_dict, aura_name)` | `int`（符合条件的单位数量） |
| `get_unit_with_role_and_without_aura_name(state_dict, role, aura_name, reverse=False)` | `(unit, health_pct)` 或 `(None, None)` |

> **注：** `get_lowest_health_unit_with_any_aura` 使用 `*aura_names` 变参，调用时直接传多个字符串：`get_lowest_health_unit_with_any_aura(state_dict, "光环A", "光环B", health_threshold=90)`。

> **注：** 以上函数中 `reverse` 参数在 `get_unit_with_role`、`get_unit_with_role_and_without_aura_name` 中可用，`reverse=False`（默认）返回第一个匹配单位，`reverse=True` 返回逆序最后一个匹配单位。

> **注：** 上述辅助函数中，除 `get_unit_with_role` 和 `get_unit_with_role_and_without_aura_name` 外，其余 11 个函数均对 `role=0` 的单位执行过滤。`role=0` 表示无职责分配的非活跃单位（如未进队玩家），系统在遍历队伍单位时会自动跳过这些单位。开发者若需对 `role=0` 的单位进行操作，应使用 `get_unit_with_role` 或 `get_unit_with_role_and_without_aura_name`，或自行遍历 `state_dict["group"]`。注意：当单位没有 `职责` 字段（值为 `None`）时，`_role_not_zero()` 返回 `True`，即该单位通过所有 role 过滤函数，不会被过滤。这与 `role=0` 时被过滤的行为不同。Mod 开发者在处理角色过滤时应注意区分 `role=None`（缺失）和 `role=0`（已分配的值为 0）两种情况。

> **注：** `get_lowest_health_unit_with_aura_count` 的 `aura_count` 参数表示光环层数/数量必须**精确等于**该值，而非阈值或最小值。调用者应确保传入的 count 值与像素数据中的光环值做精确匹配。

> **注：** `health_threshold` 参数在上述大部分函数中有默认值 `=100`，但在 `count_units_below_health` 和 `count_units_without_aura_below_health` 中为必选参数（无默认值）。使用时请根据函数签名区分。
>
> **注：** `get_unit_with_aura` 使用 `if duration <= 0: continue`（仅将大于 0 的数值视为"拥有该光环"），而 `_has_aura` 使用 `return int(val) != 0`（任何非零值视为有光环）。若光环数据出现负数或特殊占位符，两者判断结果可能不同。Mod 开发者在自定义光环检查时应注意此差异。

这些函数返回的单位编号或其元组格式详见上表。

### 映射原理

每个 `(unit, spell)` 组合对应一个唯一的游戏内按键。以治疗职业为例：

- `get_hotkey(1, "快速治疗")` → 对队伍第 1 人施放快速治疗的按键
- `get_hotkey(5, "快速治疗")` → 对队伍第 5 人施放快速治疗的按键
- `get_hotkey(0, "心灵震爆")` → 对当前目标施放心灵震爆的按键

**这一映射依赖用户自己在游戏中为每个 keymap 条目设置对应的宏，并将宏绑定到 keymap 中声明的按键上。** keymap 文件本身不包含宏内容，它只声明"什么按键对应什么技能和单位"。

## 热键字符串格式

### 基本格式

```
修饰键-主键
```

多修饰键时用 `-` 连接：

```
修饰键1-修饰键2-主键
```

### 支持的修饰键

| 修饰键字符串 | 含义 | 备注 |
|-------------|------|------|
| `CTRL` 或 `CONTROL` | Ctrl 键 | `CONTROL` 会被自动转换为 `CTRL` |
| `ALT` 或 `MENU` | Alt 键 | `MENU` 会被自动转换为 `ALT` |
| `SHIFT` | Shift 键 | |

修饰键可以任意组合，如 `ALT-CTRL`、`ALT-SHIFT`、`CTRL-SHIFT`、`ALT-CTRL-SHIFT`。

> **注意：** 修饰键仅支持上表中的五个标识符（以及它们的同义词 `CONTROL`→`CTRL`、`MENU`→`ALT`）。不在列表中的字符串（如 `WIN`、`META`、`HYPER`）会被解析器静默丢弃，不产生错误。请确认您的热键字符串仅使用这些修饰键。

### 支持的主键类型

1. **功能键**：`F1` ~ `F12`
2. **数字键盘**：`NUMPAD0` ~ `NUMPAD9`、`NUMPADPLUS`、`NUMPADMINUS`、`NUMPADMULTIPLY`、`NUMPADDIVIDE`、`NUMPADDECIMAL`
3. **鼠标侧键**：`XBUTTON1`（鼠标第 4 键）、`XBUTTON2`（鼠标第 5 键），也支持别名 `X1`/`MOUSE4`、`X2`/`MOUSE5`
4. **单字符键**：如 `,`、`.`、`/`、`;`、`'`、`[`、`]`、`=`、`` ` `` 等

> **注意**：`-`（连字符/减号）虽为可输入按键，但因解析器使用 `-` 作为修饰键分隔符，无法作为裸主键使用。如需绑定减号键，请使用 `NUMPADMINUS`（数字键盘减号）替代。

### 解析过程

`_parse_hotkey(hotkey_str)` 负责解析热键字符串：

1. 去除首尾空白，对整个字符串执行 `upper()` 转为大写，按 `-` 分割。`upper()` 主要用于修饰键段的归一化（`CTRL`/`CONTROL`/`SHIFT` 等不区分大小写）。
2. 最后一段是主键，前面所有段都是修饰键。
3. 单字符主键（`len(parts[-1]) == 1`）从原始输入的字符串重新提取，从而保留原始大小写供 `VkKeyScanW` 正确转换。
4. 修饰键段中只识别 `CTRL`/`CONTROL`/`ALT`/`MENU`/`SHIFT` 五个标识符，不匹配的字符串会被静默丢弃（不报错、不警告）。
5. 修饰键去重（同一个修饰键出现多次只保留一次）。
6. 返回 `(修饰键列表, 主键字符串)` 元组。

## 按键发送：`send_key_to_wow()`

### 函数签名

```python
def send_key_to_wow(keys_str, window_title="魔兽世界"):
    """
    向指定窗口后台发送按键（不要求窗口在前台）。
    找到窗口则发送并返回 True，否则返回 False。
    """
```

### 发送方式

Fuyutsui 使用 **Windows `PostMessage` API** 向游戏窗口后台发送按键。这意味着：

- **游戏窗口不需要在前台**，可以在后台运行。
- 每个按键以 `WM_KEYDOWN` / `WM_KEYUP` 消息的形式投递到游戏窗口的消息队列。
- 修饰键先按下，然后主键按下/抬起，最后修饰键按相反顺序抬起。

### 按键序列

`send_key_to_wow()` 内部按键事件的发送顺序：

```
1. 修饰键1 WM_KEYDOWN
2. 修饰键2 WM_KEYDOWN    （如有）
3. 主键    WM_KEYDOWN
4. 主键    WM_KEYUP
5. 修饰键2 WM_KEYUP       （逆序）
6. 修饰键1 WM_KEYUP       （逆序）
```

每个 `PostMessageW` 调用的 `lParam` 参数：

- `WM_KEYDOWN`：`0x00000001`
- `WM_KEYUP`：`0xC0000001`

### 虚拟键码转换

`_get_vk(key_name)` 将键名转换为 Windows 虚拟键码（VK）：

1. 检查是否在 `_VK` 字典中（功能键、数字键盘、修饰键、鼠标侧键）。
2. 检查是否在 `_CHAR_VK` 字典中（标点符号等特殊字符）。
3. 对于单字符，调用 Windows API `VkKeyScanW(ord(char))` 获取虚拟键码，取低 8 位。

无法识别的键名返回 `None`，此时 `send_key_to_wow()` 返回 `False` 且不发送任何按键。

此外，`utils.py` 还提供了公开函数 `get_vk(key_str)`，是对 `_get_vk()` 的安全封装。它先检查输入不为空且为字符串，然后调用 `_get_vk()` 完成转换。mod 开发者可在自定义代码中直接使用此函数获取按键的虚拟键码（VK code），用于后续的按键状态检测（需自行调用 `GetAsyncKeyState`）或按键发送等场景，无需自行做空值处理。

### 查找窗口

`send_key_to_wow()` 通过 `FindWindowW(None, "魔兽世界")` 查找游戏窗口。窗口标题不匹配时返回 `False`。

### 局限性

`PostMessage` 发送的是高层 Windows 消息。部分游戏使用 DirectInput 或原始输入方式读取按键，此时 `PostMessage` 可能不被响应。这种情况下需要另行使用驱动级模拟或前台 SendInput。Fuyutsui 当前的实现依赖于魔兽世界对 `WM_KEYDOWN`/`WM_KEYUP` 消息的响应。

## 发送模式

`logic_gui.py` 提供了三种发送模式，通过 GUI 按钮切换：

### 开关模式（switch）

默认模式。按下开关按键时，逻辑状态在"开启"和"关闭"之间切换。开启后持续执行逻辑循环，每轮循环若产出了 `action_hotkey` 就发送按键。

### 单击模式（click）

每次按下开关按键，逻辑只执行一轮，发送一个按键（如果该轮有产出），然后自动关闭。适用于"按一次做一个动作"的手动控制场景。

### 按住模式（hold）

按住开关按键时持续执行逻辑循环，松开后立即停止。适用于需要精确控制持续时间的场景。

### 模式切换机制

三种模式通过 GUI 上的"开关"、"单击"、"按住"按钮切换。切换模式时会同时：

1. 更新 `_send_mode` 变量。
2. 将 `_logic_enabled` 设为 `False`（停止当前正在运行的逻辑）。
3. 清空 `_click_pending` 标志。

### 延迟机制

职业逻辑可以通过 `unit_info` 字典返回 `_delay` 字段（浮点数，单位秒），指示发送按键后需要暂停的时长。主循环在发送按键后会检查此字段，如果大于 0 则 sleep 相应时间再继续下一轮。这对于需要等待 GCD 或动画完成的技能序列特别有用。

> **注：** 职业逻辑返回的 `unit_info` 字典的**全部键值对**会显示在 GUI 的"队伍信息"弹窗中的"逻辑推荐/目标单位（unit_info）"区域（按 key 排序）。Mod 开发者可利用此特性在 `unit_info` 中附带自定义调试字段，无需额外工具即可在 GUI 中实时观察。
>
> **注：** `state_dict` 刷新受 `LOGIC_INTERVAL=0.2s` 守卫（仅每 0.2 秒调用一次 `get_info()`），但职业逻辑函数和按键发送每轮循环均执行（循环休眠间隔 `TOGGLE_INTERVAL=0.1s`）。因此在两次 state 刷新之间，职业逻辑使用缓存数据执行约 2 次，同一 `action_hotkey` 可能被重复发送。编写顺序施法、目标切换检测等有状态逻辑时，建议在函数内部自主跟踪状态变化或实现去重，不应依赖 `state_dict` 在每次逻辑调用时都反映最新游戏状态。

## 配置中的延迟字段

> **注：** `GetPixels.py` 的 `scan_screen_data()` 执行两次截图并返回 `(row_data, bar_data)` 元组：(1) 顶部长条扫描，产生按 step 索引的 `row_data`（来自绿色标记像素起始的 RGB 编码数据）；(2) 左边界红色标记行扫描，产生按分段编号索引的 `bar_data`（来自红色标记行中白色分隔的各分段）。`build_state_dict()` 通过 `_resolve_raw_from_field()` 统一从两个数据源中取值：字段配置中 `step: N` 表示取 `row_data` 数据，`step: bar` 表示取 `bar_data` 数据。

`config.yml` 中专精配置可以声明 `延迟` 字段，与技能冷却同级别：

```yaml
5:  # 牧师
  1:  # 戒律
    延迟: {step: 48, type: "int"}
    spells:
      苦修: {step: 36, type: "int"}
```

除了标准 step 索引字段，还支持 `{step: bar, bar: N, type: "T"}` 格式。其中 `step: bar` 表示字段值来自左边界红色标记行扫描区域的第 N 个分段（bar_data），而非顶部长条像素扫描中的 step 索引。`bar` 字段指定分段编号（从 1 开始）。此格式用于读取技能充能层数、资源计数器等通过独立像素条扫描获取的数据。例如：

```yaml
苦修层数: {step: bar, bar: 1, type: "int"}
耀层数: {step: bar, bar: 2, type: "int"}
```

职业逻辑通过 `state_dict.get("延迟", 0)` 读取，部分逻辑文件（如 `priest_logic.py`）额外使用 `int()` 包装以确保类型安全。注意不同逻辑文件的读取方式存在差异。当 `延迟 > 0` 时，逻辑函数通常会跳过所有按键决策（返回 `None`），实现"等待期间不做任何操作"的效果。

逻辑函数内部也可以自行设置 `unit_info["_delay"]` 来控制发键后的延迟（见上文"延迟机制"）。

## 逻辑开关按键

逻辑开关按键（用于启用/禁用/触发逻辑循环的按键，即"开关模式/单击模式/按住模式"的控制键）独立于 keymap 系统。它的键值存储在全局变量 `_toggle_key_str` 中，默认为 `"XBUTTON2"`（鼠标侧键）。

用户可以通过 GUI 上的"按键"按钮重新绑定开关按键。绑定过程会监听下一次 `KeyPress` 或 `ButtonPress` 事件，并将捕获到的按键保存。

开关按键的状态检测有两种方式：

1. **常规按键**：使用 `GetAsyncKeyState(vk)` API 轮询按键状态，每 0.1 秒检测一次。
2. **鼠标侧键**：使用低级鼠标钩子（`WH_MOUSE_LL`）捕获 `WM_XBUTTONDOWN` / `WM_XBUTTONUP` 事件。这是为了避免 `GetAsyncKeyState` 轮询 XBUTTON 导致光标闪烁的已知问题。

开关按键的去抖时间（debounce）为 `TOGGLE_DEBOUNCE_SEC = 0.12` 秒，防止侧键的机械抖动导致误触发多次开关。

> **注意：** 主逻辑循环中有两个不同的时间间隔：`TOGGLE_INTERVAL=0.1` 秒控制循环休眠间隔，即职业逻辑函数执行和按键发送的周期为 0.1 秒；`LOGIC_INTERVAL=0.2` 秒仅守卫 `state_dict` 刷新（`get_info()` 调用），即游戏状态数据每 0.2 秒更新一次。因此两次决策之间的最小间隔为 0.1 秒，但 0.2 秒内 `state_dict` 数据保持不变，逻辑函数在此期间以缓存数据重复执行（详见"延迟机制"中的相关说明）。开发者编写快速决策逻辑时应了解此 2:1 执行/刷新比例。

## Lua 端：`keybinds.lua`

Python 端的 keymap 系统是 Fuyutsui 发出按键的核心。在 Lua 插件端，存在另一个独立的按键扫描系统 `Fuyutsui/core/keybinds.lua`，它的作用是：

1. 遍历游戏内所有动作条槽位（1~180 共 180 个槽位）。
2. 对每个槽位，获取其中的动作类型和法术 ID。
3. 如果动作类型是 `macro` 或 `spell`，获取该槽位的按键绑定。
4. 将结果存入 `Fuyutsui.keybindings[spellId]`，包含按键名、槽位编号、虚拟键码、图标 ID、法术名。

这个 Lua 端数据主要用于插件自身的状态显示，**与 Python 端的 keymap 系统是两个独立的体系**。Python 端的 `get_hotkey()` 完全依赖 YAML 格式的 keymap 文件，不读取 Lua 端的数据。

`keybinds.lua` 遍历 `Fuyutsui.actionBars`（定义于 `core/config.lua`），利用每个动作条的 `startSlot`、`endSlot`、`bindingPrefix` 三个属性来匹配槽位和按键绑定前缀（如 `ACTIONBUTTON`、`MULTIACTIONBAR1BUTTON` 等）。`ProcessActionSlot` 在匹配到第一个动作条后不会跳出循环（`keybinds.lua` 第 37 行 `-- break` 被注释掉），而是继续遍历剩余动作条。当前 `actionBars` 各条目的范围互不重叠，因此缺失 `break` 不影响最终结果；但若将来添加重叠范围的动作条则需要恢复 `break` 以确保正确性。

此外，`keybinds.lua` 还引用 `Fuyutsui.keymap` 表（定义于 `config.lua`），该表将按键名称映射为 Windows 虚拟键码，涵盖标准按键（如 `"1"`、`"F1"`、`"Q"`）、数字键盘缩写（`N0`~`N9`、`N*`、`N+`、`N-`、`N.`、`N/`）以及 WoW 返回的别名（`EQUALS`、`MINUS`、`SEMICOLON`、`COMMA`、`PERIOD`、`SPACE` 等）。第 31 行 `keycode = keymap[key]` 使用此表将 `GetBindingKey()` 返回的按键名称解析为数值键码，存入 `keybindings` 的 `keycode` 字段；若 `key` 不在 `keymap` 表中，`keycode` 为 `nil`，对应法术无法生成键码。

> **注：** Lua 端 `Fuyutsui.keymap` 表与 Python 端的 `_VK`/`_CHAR_VK` 字典是各自独立的映射体系，两者的键名覆盖范围不完全一致（例如 Lua 端支持 `SPACE` 而 Python 端不支持）。调试 keymap 相关问题时，需确认按键名称在对应端有定义。

> **注意：** `keybinds.lua` 使用 `C_Timer.After(0.5, ...)` 异步延迟执行槽位扫描循环。调用 `Fuyutsui:readKeybindings()` 后，`Fuyutsui.keybindings` 表中的数据不会立即填充完毕，需要等待至少 500ms 才能反映最新的按键绑定状态。

## 完整数据流

```
config.yml                    keymap/*.yml
    │                               │
    ├─ keymap 字段选择文件 ──────────┘
    │
    ▼
select_keymap_for_class(class_id)   ─── 切换 keymap 路径，清空缓存
    │
    ▼
state_dict 有效性检查                ─── `sd.get("有效性")` 为假则跳过本轮决策
    │
    ▼
职业逻辑 *_logic.py:
    unit, _ = get_lowest_health_unit(state_dict, 100)   ─── 获取目标单位编号，返回 (slot, pct) 元组，用 _ 丢弃血量百分比
    if unit is not None:
        action_hotkey = get_hotkey(int(unit), "技能名")  ─── 查找热键字符串，int() 确保类型安全
    else:
        action_hotkey = None  ─── 无可治疗目标，跳过本轮
    return action_hotkey, current_step, unit_info
    │
    ▼
logic_gui.py 主循环:
    if action_hotkey:
        send_key_to_wow(action_hotkey)
    │
    ▼
send_key_to_wow():
    _parse_hotkey(keys_str)     ─── 解析为 (修饰键列表, 主键)
    _get_vk(main_key)           ─── 转为虚拟键码
    FindWindowW("魔兽世界")      ─── 获取游戏窗口句柄
    PostMessageW(hwnd, WM_KEYDOWN/UP, vk, lParam)  ─── 发送按键
```

> **注意：** 主循环（`logic_gui.py` 第 430–433 行）在调用职业逻辑函数之前，先检查 `state_dict` 是否有效（`sd.get("有效性")` 是否为真）。若 `state_dict` 为空或有效性为假，则跳过本轮决策并在状态栏显示"等待游戏状态"。即使逻辑开关已开启、主循环间隔已满足，在游戏状态（像素数据）无效时也不会进行任何按键映射查找和发送。
>
> **注意：** 当 `class_id` 不在 `LOGIC_FUNCS_BY_CLASS` 映射中时，主循环调用 `_default_logic` 返回 `(None, '无逻辑定义', {})`，跳过本轮所有按键决策，并在 GUI 步骤栏显示"无逻辑定义"。若在调试中看到此提示，表示当前职业尚无对应的逻辑模块。
>
> **注意：** 当 `state_dict` 中 `'职业'` 字段缺失时 `class_id=None`；当值为 `0` 时 `class_id=0`。两者均不匹配 `LOGIC_FUNCS_BY_CLASS` 中的任何已知职业，均触发 `_default_logic` 兜底路径，GUI 显示"无逻辑定义"。此组合场景在游戏刚启动、像素数据到达但职业尚未被识别时常见，应在调试初始配置问题时优先排查。

## 为 mod 扩展 keymap

如果要为新职业或自定义逻辑添加 keymap 支持：

1. **创建 keymap 文件**：在 `keymap/` 目录下创建新的 YAML 文件。每条记录包含 `unit`、`技能`、`热键` 三个字段。每个 `(unit, 技能)` 组合必须唯一。
2. **在 config.yml 中引用**：在对应职业的配置块中设置 `keymap: "你的文件名.yml"`。
3. **在职业逻辑中调用**：使用 `get_hotkey(unit, spell_name)` 获取热键，其中 `spell_name` 必须与 keymap 文件中的技能名完全一致。
4. **在游戏中绑定宏**：为 keymap 中每个热键创建对应的游戏内宏（包含目标选择和施法指令），并将宏绑定到 keymap 中声明的按键上。

### 热键字符串命名要点

- 支持修饰键组合：`CTRL`、`ALT`、`SHIFT` 及其任意组合，用 `-` 连接。
- 功能键直接写名称：`F1` ~ `F12`。
- 数字键盘加 `NUMPAD` 前缀：`NUMPAD0` ~ `NUMPAD9`。
- 标点符号直接写字符：`,`、`.`、`/`、`;` 等。
- 修饰键的书写顺序不影响功能（`CTRL-ALT` 与 `ALT-CTRL` 等效），但约定俗成按 `CTRL-ALT-SHIFT` 的顺序书写以提高可读性。

## 修订记录

| 日期 | 修改位置 | 原因 | 内容摘要 |
|------|---------|------|---------|
| 2026-05-29 | 文件位置和选择 | 默认路径描述与源码不符 | 修正 keymap 默认路径为根目录 `keymap.yml`，`keymap/` 子目录仅用于职业专用 keymap |
| 2026-05-29 | 字段名优先级 | 描述与代码逻辑相反 | 将"优先使用中文键名"改为"引擎按英文→中文顺序依次查找" |
| 2026-05-29 | 辅助函数表 | 遗漏函数且返回列不准确 | 添加 5 个 count_* 和 get_unit_with_role_and_without_aura_name 函数；修正返回值为实际元组类型 |
| 2026-05-29 | 单字符键 | `-` 被解析器用作分隔符，无法作为主键 | 从支持列表中移除 `-`，添加注意事项说明原因并推荐 `NUMPADMINUS` |
| 2026-05-29 | 虚拟键码转换 | 遗漏公开函数 get_vk() | 补充 `get_vk()` 安全封装的说明，供 mod 开发者直接使用 |
| 2026-05-29 | 完整数据流 | `get_lowest_health_unit` 返回元组，直接赋值 `unit` 导致类型错误 | 改为元组解包 `unit, _ = ...`，并补上 `health_threshold` 参数 |
| 2026-05-29 | 辅助函数表 - 签名修正 | `get_unit_with_role` 和 `get_unit_with_role_and_without_aura_name` 缺少 `reverse` 参数 | 在签名中补充 `reverse=False`，并添加脚注说明参数行为 |
| 2026-05-29 | 辅助函数表 - 新增函数 | 遗漏 `get_lowest_health_unit_with_any_aura`、`get_lowest_health_unit_with_aura`、`get_lowest_health_unit_with_aura_count` 三个函数 | 在表中补充三行，并添加 `*aura_names` 变参用法的脚注 |
| 2026-05-30 | 辅助函数表 | role=0 过滤规则未说明 | 新增脚注说明 11 个函数自动过滤 role=0 单位，列举受影响和不受影响的函数 |
| 2026-05-30 | 辅助函数表 | aura_count 参数语义未解释 | 新增脚注说明 `get_lowest_health_unit_with_aura_count` 的 `aura_count` 为精确相等匹配，非阈值 |
| 2026-05-30 | 辅助函数表 | health_threshold 默认值未标注 | 统一标注 `=100` 默认值，脚注说明必选参数与可选参数的区别 |
| 2026-05-30 | keymap 文件位置和选择 | class_id=None 行为描述不准确 | 修正描述，说明默认文件不存在时将抛出 FileNotFoundError |
| 2026-05-30 | 完整数据流 | 代码示例缺少 None 守卫和 int() 包装 | 添加 `if unit is not None` 守卫和 `int()` 类型转换 |
| 2026-05-30 | 完整数据流 | 缺少 state_dict 有效性守卫条件 | 补充主循环 state_dict 有效性检查和跳过机制，更新数据流图 |
| 2026-05-30 | 逻辑开关按键 | 缺少 LOGIC_INTERVAL 说明 | 补充主循环最小执行间隔 0.2 秒说明，与 TOGGLE_INTERVAL 对比 |
| 2026-05-30 | 配置中的延迟字段 | 延迟字段读取方式声明不准确 | 修正为更准确的表述，说明不同逻辑文件的读取差异 |
| 2026-05-30 | Lua 端 keybinds.lua | 未提及 Fuyutsui.keymap 映射表 | 新增说明 keymap 表将按键名映射为虚拟键码 |
| 2026-05-30 | Lua 端 keybinds.lua | 未提及 0.5 秒异步延迟 | 新增说明 C_Timer.After 异步扫描导致数据延迟 |
| 2026-05-30 | 辅助函数表 — 签名修正 | `get_count_units_below_health` 遗漏 `=100` 默认值 | 补全为 `get_count_units_below_health(state_dict, health_threshold=100)` |
| 2026-05-30 | 辅助函数表 — 脚注修正 | `get_count_units_below_health` 被误列入无默认值组 | 从 health_threshold 必选参数列表中移除该函数 |
| 2026-05-30 | 缓存机制 + 文件格式 | 未说明 spell/hotkey 字段为 None 的静默跳过行为 | 补充守卫条件步骤说明；在字段说明表后添加字段名拼写警告 |
| 2026-05-30 | 解析过程 | 未说明无法识别的修饰键字符串被静默丢弃 | 新增解析步骤 4，说明仅识别五个修饰键标识符，不匹配者静默丢弃 |
| 2026-05-30 | Lua 端 keybinds.lua | actionBars 结构来源说明不准确 | 明确 `Fuyutsui.actionBars` 定义于 `core/config.lua`，keybinds.lua 仅遍历使用 |
| 2026-05-30 | 支持的修饰键 | 未提示不支持修饰键的静默丢弃行为 | 在修饰键表下方添加注意说明仅支持五个标识符，其他字符串被静默丢弃 |
| 2026-05-30 | 解析过程（第1步） | 遗漏 .strip() 步骤 | 补充"去除首尾空白" |
| 2026-05-30 | Lua 端：keybinds.lua | ProcessActionSlot 缺失 break 说明 | 补充匹配后不跳出循环的行为说明 |
| 2026-05-30 | keymap 文件位置和选择 | 未说明 YAML 格式错误的异常处理 | 新增注意说明 yaml.YAMLError 导致线程静默退出 |
| 2026-05-30 | 延迟机制 | 未提及 unit_info 在 GUI 弹窗中显示 | 新增注说明 unit_info 键值对显示在"队伍信息"弹窗 |
| 2026-05-30 | 总体链路 + 完整数据流 | 缺少 class_id 不匹配已知职业时的兜底路径 | 新增第7步兜底说明及注意 |
| 2026-05-30 | 辅助函数表 - get_unit_with_aura | 选取规则未说明，返回描述过于简略 | 修正返回描述为"取 duration 最高单位，非首个匹配" |
| 2026-05-30 | 辅助函数表 - get_unit_with_aura | 未说明 duration<=0 过滤行为与 _has_aura 不一致 | 新增脚注说明两者判断逻辑差异 |
| 2026-05-30 | keymap 文件位置和选择（第3步） | 缺少职业无 keymap 字段或 keymap 值无效时的静默回退说明 | 补充说明回退到默认路径的 FileNotFoundError 风险 |
| 2026-05-30 | Lua 端：keybinds.lua | Fuyutsui.keymap 示例键名未涵盖缩写键名和 WoW 别名；未说明 Lua 与 Python 映射体系独立 | 扩展键名示例为概括性说明，新增注说明 Lua/Python 映射体系独立及 keycode 为 nil 情况 |
| 2026-05-30 | 总体链路第7步 + 完整数据流注意事项 | D6: 未说明 class_id=None 时 state_dict 部分有效的完整行为链路 | 补充 class_id=None 同时触发两条兜底路径（keymap 回退根目录 + _default_logic）及游戏启动场景下的调试指引 |
| 2026-05-30 | keymap 文件位置和选择（第3步） | 未说明 select_keymap_for_class() 的双重键查找模式 | 补充 config.get(class_id) or config.get(str(class_id)) 说明，覆盖 int/str 类型不匹配场景 |
| 2026-05-30 | keymap 文件位置和选择（第3步） | D2: 未说明 keymap 字段支持绝对路径 | 补充绝对路径不拼接 keymap/ 前缀及适用于跨项目共享的场景 |
| 2026-05-30 | 解析过程（步骤1、3） | D5: upper() 与单字符大小写保持的时序不清晰 | 步骤1明确 upper() 用于修饰键归一化，步骤3补充单字符判断条件及从原始输入重新提取的机制 |
| 2026-05-30 | 虚拟键码转换（get_vk） | D1: get_vk() 功能描述严重错误，"检测按键状态"与实际功能不符 | 修正为"获取按键的虚拟键码（VK code），用于后续的按键状态检测或按键发送" |
| 2026-05-30 | 延迟机制 | D4: 未说明 state_dict 未刷新时职业逻辑以缓存数据每 0.1 秒重复执行 | 新增注说明 0.2s 刷新间隔内逻辑执行约 2 次，建议有状态逻辑自主跟踪或去重 |
| 2026-05-30 | 逻辑开关按键注意事项 | D3: 决策循环间隔描述严重错误，将 TOGGLE_INTERVAL 与 LOGIC_INTERVAL 混淆 | 修正为明确区分 0.1s 逻辑执行周期和 0.2s 数据刷新周期，说明 2:1 执行/刷新比例 |
| 2026-05-30 | 总体链路第2步 | Gamma-A3: keymap 切换频率描述不精确 | 将"每次逻辑循环"修正为"每次 state_dict 刷新时（受 LOGIC_INTERVAL=0.2s 守卫），而非每次主循环迭代（TOGGLE_INTERVAL=0.1s）"，与脚注一致 |
| 2026-05-30 | 总体链路第7步 + 完整数据流注意事项 | Beta-A1: class_id=0 与 None 混淆 | 区分"职业字段缺失时 class_id=None"和"值为0时 class_id=0"两种情形，移除 class_id=None 的 FileNotFoundError 风险描述（已移至 keymap 文件位置章节单独说明） |
| 2026-05-30 | keymap 文件位置和选择（第2-3步） | Beta-A2 + Beta-A4: 两条路径风险等同表述错误 | 分离 class_id=None 路径（标准流程无 FileNotFoundError 风险，仅自定义逻辑直接调用 get_hotkey() 时有风险）和 class_id 有效但 keymap 字段缺失路径（有真实 FileNotFoundError 风险） |
| 2026-05-30 | keymap 文件位置和选择（注） | Alpha-A1: 双重查找覆盖范围不准确 | 补充说明两者同为整数键且 class_id 为字符串时两次查找均失败，但实际运行时 class_id 始终为整数 |
| 2026-05-30 | 辅助函数表 role 注 | Beta-A3: role=None 过滤行为未说明 | 补充说明 role=None（缺失）时 _role_not_zero() 返回 True，与 role=0 被过滤的行为不同 |
| 2026-05-30 | 配置中的延迟字段 | Gamma-A2: 缺失双扫描架构说明 | 新增 scan_screen_data() 返回 (row_data, bar_data) 元组及 _resolve_raw_from_field() 数据源选择原理 |
| 2026-05-30 | 配置中的延迟字段 | Gamma-A1: 缺失 step:bar 字段格式说明 | 新增 {step: bar, bar: N, type: "T"} 格式说明，示例展示技能充能层数、资源计数器的 bar 字段用法 |

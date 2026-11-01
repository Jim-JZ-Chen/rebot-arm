# reBot ROS 2 Web 控制台 — 接口文档

本文档分两部分：

- **第一部分**：本项目自身涉及的接口——前端实际用到的 ROS 接口、后端启动器 HTTP API、动作序列 JSON 格式、环境变量。
- **第二部分**：Seeed 官方 SDK `reBotArmController_ROS2`（v0.3.0）的**完整 ROS 接口参考**，摘自官方 [API_zh.md](https://github.com/Seeed-Projects/reBotArmController_ROS2/blob/main/API_zh.md)，包含本项目未使用的全部接口，供扩展时查阅。

文中 `<ns>` 表示 ROS 命名空间，默认为 `/rebotarm`（MuJoCo 仿真为 `/rebotarm_rs`），可在面板或环境变量中修改。

---

# 第一部分：本项目接口

## 1. 前端使用的 ROS 2 接口（经 rosbridge）

前端通过 roslibjs 连接 rosbridge（默认 `ws://localhost:9090`）访问以下接口。
这些接口均由官方 SDK 提供，完整定义见本文档第二部分。

### 1.1 Topic：关节状态反馈

| 项 | 值 |
| --- | --- |
| 名称 | `<ns>/joint_states` |
| 类型 | `sensor_msgs/msg/JointState`（标准消息） |
| 方向 | 订阅（驱动以约 100 Hz 发布，前端按 50 ms 节流接收） |

前端实际使用的字段：

```json
{
  "name": ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "..."],
  "position": [0.0, 0.75, 0.55, 0.0, 0.0, 0.0, "..."]
}
```

- 前端按 `name` 数组索引对齐 `position`，不依赖固定顺序。
- 六个臂关节名固定为 `joint1` … `joint6`，单位弧度。
- 夹爪位置从名为 `gripper` / `gripper_joint` / `gripper_joint1` 的条目读取；
  `gripper_joint1`（米制行程，约 0–0.05 m）会按 `(value / 0.05) * 5` 换算为电机原始值（开 5、闭 0）。
- 前端根据该 topic 的到达频率显示"反馈频率"，并据此判断数据链路是否正常。

### 1.2 Topic：机械臂状态

| 项 | 值 |
| --- | --- |
| 名称 | `<ns>/arm_status` |
| 类型 | `rebotarm_msgs/msg/ArmStatus`（厂商自定义） |
| 方向 | 订阅（前端按 100 ms 节流接收） |

前端识别的字段（完整字段见第二部分 6.1）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `enabled` | bool | 电机是否已使能 |
| `state_machine` | string | 状态机：`IDLE` / `TRAJ_RUNNING` / `LOWLEVEL_STREAMING` / `GRAVITY_COMP` |
| `error_codes` | string[] | 当前错误码列表 |
| `mode` | string | 底层控制模式（`mit` / `pos_vel` / `vel`） |

### 1.3 Service：启用机械臂

| 项 | 值 |
| --- | --- |
| 名称 | `<ns>/enable` |
| 类型 | `std_srvs/srv/Trigger`（标准服务） |
| 前端超时 | 12 秒 |

请求为空 `{}`。响应 `{ "success": true, "message": "..." }`，`success: false` 时前端视为失败并展示 `message`。使能后电机上力矩，面板要求先确认工作区安全才允许调用。

### 1.4 Service：禁用机械臂

| 项 | 值 |
| --- | --- |
| 名称 | `<ns>/disable` |
| 类型 | `std_srvs/srv/Trigger` |
| 前端超时 | 20 秒 |

请求为空 `{}`，响应格式同 1.3。禁用后电机卸力；若重力补偿正在运行，驱动会先停止它。

### 1.5 Service：安全回零

| 项 | 值 |
| --- | --- |
| 名称 | `<ns>/safe_home` |
| 类型 | `std_srvs/srv/Trigger` |
| 前端超时 | 30 秒（网页关机流程中后端超时为 45 秒） |

请求为空 `{}`，响应格式同 1.3。驱动侧行为：先停止重力补偿，夹爪闭合到 0 rad，再以安全速度回零。
注意：这是**回到零位姿态**，不是 `set_zero`（改写电机零点）——本面板刻意不提供后者。

### 1.6 Service：夹爪开合

| 项 | 值 |
| --- | --- |
| 名称 | `<ns>/gripper/open`、`<ns>/gripper/close` |
| 类型 | `rebotarm_msgs/srv/GripperCommand`（厂商自定义） |
| 前端超时 | 10 秒 |

请求字段（RS 型号，开 5、闭 0，见 SDK `rebotarm_hardware.yaml`）：

```json
{ "position": 5, "timeout": 5 }
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `position` | float | 目标夹爪电机角度（rad）：张开 `5`，闭合 `0`；传 `0.0` 表示用驱动配置的默认位置 |
| `timeout` | float | 驱动侧到位超时（秒），前端固定传 `5`；≤0 用驱动默认超时 |

响应：`{ "success": bool, "reached_position": float, "message": string }`，`success: false` 时前端报错。该接口为纯位置控制，**不做力反馈夹取判断**。

### 1.7 Action：关节轨迹执行

| 项 | 值 |
| --- | --- |
| 名称 | `<ns>/follow_joint_trajectory` |
| 类型 | `control_msgs/action/FollowJointTrajectory`（标准 action） |
| 前端超时 | 轨迹时长 + 20 秒，超时自动请求取消 |

前端发送单点轨迹（从当前位置插值到目标，由驱动完成）：

```json
{
  "trajectory": {
    "joint_names": ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"],
    "points": [
      {
        "positions": [0.0, 0.75, 0.55, 0.0, 0.0, 0.0],
        "time_from_start": { "sec": 3, "nanosec": 0 }
      }
    ]
  }
}
```

- `positions` 单位弧度，长度固定为 6；官方要求 `joint_names` 顺序与驱动端完全一致。
- `time_from_start` 为轨迹总时长，前端最小钳制到 0.2 秒；驱动支持多点轨迹并按各点 `time_from_start` 执行。
- 执行前前端会先取消上一条未完成轨迹，保证同一时刻只有一个 goal。

Result 字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `error_code` | int | `0`（SUCCESSFUL）为成功；非 0 时报错 |
| `error_string` | string | 失败原因描述 |

支持中途取消（`cancelGoal`）。注意：网页"取消任务"只是请求 action 服务器取消，
**不是物理急停**，不保证底层运动立即停止。

### 1.8 前端关节限位（软件层约束）

前端在发送前把目标角度钳制到下表范围（弧度，`src/lib/robot.ts`），
这属于面板侧的软件限位，不替代驱动与硬件自身的限位：

| 关节 | 最小 (rad) | 最大 (rad) | 约合角度 |
| --- | --- | --- | --- |
| joint1 | -2.80 | 2.80 | ±160.4° |
| joint2 | 0 | 3.14 | 0 ~ 180° |
| joint3 | 0 | 3.14 | 0 ~ 180° |
| joint4 | -1.57 | 1.57 | ±90° |
| joint5 | -1.57 | 1.57 | ±90° |
| joint6 | -3.14 | 3.14 | ±180° |

预置姿态（弧度）：零位 `ZERO_POSE = [0,0,0,0,0,0]`；就绪 `READY_POSE = [0,0.75,0.55,0,0,0]`；
观察位 `OBSERVE_POSE = [0.35,1.05,0.7,-0.35,0.25,-0.4]`。

---

## 2. 启动器 HTTP API（server/）

由 `server/index.mjs` 提供，默认监听 `127.0.0.1:3000`（可用 `HOST` / `PORT` 环境变量修改）。
所有响应均为 JSON，带 `Cache-Control: no-store`。仅部署了启动器的主机可用；
纯 `npm run dev` 的前端开发环境没有这些接口。

### 写操作通用约束

- 必须 `POST` 且 `Content-Type: application/json`，否则 `415`。
- 若浏览器带 `Origin` 头，其 host 必须与请求 `Host` 一致，否则 `403`（CSRF 防护）。
- 请求体限 4 KB，超限 `413`；JSON 解析失败 `400`。
- 每个写操作必须携带与其匹配的 `confirm` 字符串（防止误触），不匹配返回 `400`。
- 同一时间只允许一个系统任务执行；冲突返回 `409`。

### 2.1 查询系统状态

```
GET /api/system/status
```

响应 `200`：

```json
{
  "launcherMode": "systemd",
  "services": { "can": true, "driver": true, "rosbridge": false },
  "job": { },
  "serverTime": "2025-01-01T08:00:00.000Z"
}
```

| 字段 | 含义 |
| --- | --- |
| `launcherMode` | `systemd`（真机）或 `mock`（模拟） |
| `services` | 三个受控服务的运行状态：`rebot-can.service`、`rebot-driver.service`、`rebot-rosbridge.service` |
| `job` | 当前/最近一次系统任务对象，无任务时为 `null` |
| `serverTime` | 服务器当前时间（ISO 8601） |

`job` 对象结构：

```json
{
  "id": "uuid",
  "operation": "start",
  "label": "启动机械臂软件系统",
  "launcherMode": "systemd",
  "status": "running",
  "createdAt": "...", "startedAt": "...", "updatedAt": "...", "finishedAt": "...",
  "error": "步骤“...”失败，后续步骤未执行。",
  "steps": [
    { "id": "can-start", "name": "配置 CAN 通道", "status": "success",
      "detail": "rebot-can.service 已运行",
      "startedAt": "...", "finishedAt": "..." }
  ]
}
```

- 任务 `status`：`pending` / `running` / `success` / `error`。
- 步骤 `status`：`pending` / `running` / `success` / `skipped` / `error`。
- 任一步骤失败则任务中止，后续步骤保持 `pending`，`error` 字段说明原因。

### 2.2 启动机械臂软件系统

```
POST /api/system/start
Content-Type: application/json

{ "confirm": "START" }
```

成功受理返回 `202 { "jobId": "...", "job": {...} }`，任务异步执行以下步骤：

| 顺序 | 步骤 id | 说明 |
| --- | --- | --- |
| 1 | `can-start` | 启动 `rebot-can.service`（CAN can0 配置为 1 Mbps），等待 active |
| 2 | `driver-start` | 启动 `rebot-driver.service`，等待 active |
| 3 | `interfaces-check` | 轮询 ROS 接口（最长 35 秒），要求 `enable`/`disable`/`safe_home` 三个服务与 `follow_joint_trajectory` action 全部出现 |
| 4 | `rosbridge-start` | 启动 `rebot-rosbridge.service`，并实际探测 9090 端口可连 |
| 5 | `feedback-check` | `ros2 topic echo --once` 读取一帧 `<ns>/joint_states`，校验含 `name` 与 `position` |

### 2.3 关闭机械臂系统

```
POST /api/system/shutdown
Content-Type: application/json

{ "confirm": "ARM_SHUTDOWN" }
```

返回 `202`，执行步骤：

| 顺序 | 步骤 id | 说明 |
| --- | --- | --- |
| 1 | `shutdown-check` | 检查驱动是否运行（仅提示，不动作） |
| 2 | `safe-home` | 调用 `<ns>/safe_home`；驱动未运行时标记 `skipped` |
| 3 | `arm-disable` | 调用 `<ns>/disable`；驱动未运行时标记 `skipped` |
| 4 | `driver-stop` | 停止 `rebot-driver.service` |
| 5 | `rosbridge-stop` | 停止 `rebot-rosbridge.service` |
| 6 | `can-stop` | 停止 `rebot-can.service` |

安全步骤（2、3）失败会中止整个流程，不会继续停驱动。

### 2.4 关闭 ROS 主机

```
POST /api/system/host-shutdown
Content-Type: application/json

{ "confirm": "HOST_SHUTDOWN" }
```

返回 `202`。先完整执行 2.3 的全部步骤，最后追加：

| 步骤 id | 说明 |
| --- | --- |
| `host-shutdown` | 执行 `sudo shutdown -h now`（依赖 sudoers 白名单）。命令被接受后连接随即中断，属预期行为；关机后只能人工上电 |

### 2.5 错误响应

所有错误统一为：

```json
{ "error": "人类可读的错误描述" }
```

| 状态码 | 场景 |
| --- | --- |
| 400 | 缺少/错误 `confirm` 字段、JSON 无效、路径非法 |
| 403 | Origin 与 Host 不一致（跨来源）、静态文件目录穿越 |
| 404 | 未知 API 路径或静态文件不存在 |
| 405 | 静态资源使用了非 GET/HEAD 方法 |
| 409 | 已有系统任务正在执行 |
| 413 | 请求体超过 4 KB |
| 415 | 写操作未使用 `application/json` |
| 500 | 未预期的服务端错误 |

---

## 3. 动作序列 JSON 格式

前端动作序列支持导入/导出 JSON（仅保存在浏览器 localStorage）。格式为步骤数组：

```json
[
  { "id": "step-ready", "type": "joint",  "name": "进入观察位",
    "positions": [0.35, 1.05, 0.7, -0.35, 0.25, -0.4], "duration": 4 },
  { "id": "step-open",  "type": "gripper", "name": "张开夹爪", "action": "open" },
  { "id": "step-wait",  "type": "wait",   "name": "等待稳定", "duration": 0.8 },
  { "id": "step-close", "type": "gripper", "name": "闭合夹爪", "action": "close" },
  { "id": "step-home",  "type": "home",   "name": "安全回零" }
]
```

公共字段：`id`（字符串，唯一）、`name`（显示名）。

| `type` | 专有字段 | 说明 |
| --- | --- | --- |
| `joint` | `positions: number[6]`（rad）、`duration: number`（s） | 发送 FollowJointTrajectory 单点轨迹 |
| `gripper` | `action: "open" \| "close"` | 调用夹爪服务 |
| `wait` | `duration: number`（s） | 纯等待，不发任何指令 |
| `home` | — | 调用安全回零服务 |

localStorage 键：`rebot.rosbridge.url`、`rebot.namespace` 保存连接配置。

---

## 4. 后端环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 启动器监听地址 |
| `PORT` | `3000` | 启动器监听端口 |
| `REBOT_LAUNCHER_MODE` | `mock` | `systemd` 为真机模式，其余值为模拟模式（由部署脚本设置为 `systemd`） |
| `REBOT_WORKSPACE` | 无（systemd 模式必填） | reBot ROS 工作空间路径（含 `install/setup.bash`），用于 source 环境后执行 ros2 命令 |
| `REBOT_NAMESPACE` | `/rebotarm` | 后端检查/调用 ROS 接口时使用的命名空间，须以 `/` 开头且只含字母数字下划线斜杠连字符 |
| `REBOT_MOCK_FAIL_STEP` | 无 | 调试用途：mock 模式下强制指定步骤 id 失败 |

---

# 第二部分：官方 SDK 完整接口参考

以下内容摘自 Seeed 官方 SDK [reBotArmController_ROS2](https://github.com/Seeed-Projects/reBotArmController_ROS2)
的 `API_zh.md`（适用版本 v0.3.0），涵盖全部 Topic、Service、Action、低层命令与消息定义。
标注 ✅ 的接口已被本项目使用，其余为 SDK 提供但本项目未使用的扩展能力。

## 5. 接口总览

| 类别 | 接口 | 类型 | 用途 | 本项目 |
|---|---|---|---|---|
| Topic | `<ns>/joint_states` | `sensor_msgs/msg/JointState` | 6 轴关节状态 | ✅ |
| Topic | `<ns>/arm_status` | `rebotarm_msgs/msg/ArmStatus` | 状态机与健康状态 | ✅ |
| Topic | `<ns>/joints/<joint>/state` | `rebotarm_msgs/msg/JointMotorState` | 单关节电机状态 | — |
| Topic | `<ns>/gripper/state` | `rebotarm_msgs/msg/JointMotorState` | 夹爪电机状态 | — |
| Service | `<ns>/enable` | `std_srvs/srv/Trigger` | 使能机械臂 | ✅ |
| Service | `<ns>/disable` | `std_srvs/srv/Trigger` | 失能机械臂 | ✅ |
| Service | `<ns>/safe_home` | `std_srvs/srv/Trigger` | 安全回零 | ✅ |
| Service | `<ns>/set_mode` | `rebotarm_msgs/srv/SetMode` | 切换底层控制模式 | — |
| Service | `<ns>/set_zero` | `rebotarm_msgs/srv/SetZero` | 设置关节零点（危险，刻意不用） | — |
| Service | `<ns>/move_to_pose_ik` | `rebotarm_msgs/srv/MoveToPoseIK` | IK 预检查与关节角求解 | — |
| Service | `<ns>/gripper/set` | `rebotarm_msgs/srv/SetGripper` | 设置夹爪电机位置 | — |
| Service | `<ns>/gripper/open` | `rebotarm_msgs/srv/GripperCommand` | 打开夹爪 | ✅ |
| Service | `<ns>/gripper/close` | `rebotarm_msgs/srv/GripperCommand` | 闭合夹爪 | ✅ |
| Service | `<ns>/gravity_compensation/start` | `std_srvs/srv/Trigger` | 启动重力补偿 | — |
| Service | `<ns>/gravity_compensation/stop` | `std_srvs/srv/Trigger` | 停止重力补偿 | — |
| Action | `<ns>/move_to_pose` | `rebotarm_msgs/action/MoveToPose` | 末端位姿轨迹 | — |
| Action | `<ns>/follow_joint_trajectory` | `control_msgs/action/FollowJointTrajectory` | 标准关节轨迹 | ✅ |
| Action | `<ns>/gripper/command` | `control_msgs/action/GripperCommand` | 标准夹爪 action | — |
| Command Topic | `<ns>/joints/<joint>/cmd/mit` | `rebotarm_msgs/msg/JointMitCmd` | 单关节 MIT raw command | — |
| Command Topic | `<ns>/joints/<joint>/cmd/pos_vel` | `rebotarm_msgs/msg/JointPosVelCmd` | 单关节位置速度 raw command | — |
| Command Topic | `<ns>/joints/<joint>/cmd/vel` | `rebotarm_msgs/msg/JointVelCmd` | 单关节速度 raw command | — |
| Command Topic | `<ns>/gripper/cmd/mit` | `rebotarm_msgs/msg/JointMitCmd` | 夹爪 MIT raw command | — |
| Command Topic | `<ns>/gripper/cmd/pos_vel` | `rebotarm_msgs/msg/JointPosVelCmd` | 夹爪位置速度 raw command | — |
| Command Topic | `<ns>/gripper/cmd/vel` | `rebotarm_msgs/msg/JointVelCmd` | 夹爪速度 raw command | — |

## 6. 基本约定

### 6.1 命名空间

默认 `/rebotarm`。启动时可用 `arm_namespace:=left_arm` 修改，所有接口名前缀随之替换。
命名空间只影响 ROS graph 名字，不改变 TF frame（`base_link`、`end_link` 等仍来自 URDF）。
多机械臂场景需自行规划 TF frame 前缀。

### 6.2 单位

| 字段 | 单位 |
|---|---|
| 关节位置 | rad |
| 关节速度 | rad/s |
| 力矩 / effort | N·m |
| 末端位置 | m |
| 四元数 | 无量纲，`x/y/z/w` |
| 夹爪电机位置 | rad |
| duration | s |

### 6.3 运动合法性

- `move_to_pose_ik` / `move_to_pose` 直接复用底层 SDK（`reBotArm_control_py`）的 IK、轨迹规划和 joint limit 逻辑。
- `follow_joint_trajectory` 接收上层直接给出的关节轨迹：ROS 层只做消息格式、关节名顺序检查和按 `time_from_start` 执行，**不做 IK 或 URDF 限位二次校验**。
- 低层 command topic 面向调试，不承担任何合法性检查；应用层应优先使用 service / action。

### 6.4 QoS

| 类别 | QoS | 说明 |
|---|---|---|
| 高频状态 topic | `qos_profile_sensor_data`（BEST_EFFORT） | `/joint_states` 与电机状态 |
| `arm_status` | TRANSIENT_LOCAL + RELIABLE，depth 1 | 类似 latched，后启动的订阅者也能拿到最后状态 |
| command topic | RELIABLE，depth 10 | 低层命令不应丢包 |

订阅 `/joint_states` 必须用 sensor-data QoS，否则可能出现 `offering incompatible QoS. Last incompatible policy: RELIABILITY`。

### 6.5 控制状态机

`arm_status.state_machine` 可能值：

| 值 | 说明 |
|---|---|
| `IDLE` | 空闲或位置保持 |
| `TRAJ_RUNNING` | 正在执行轨迹 action |
| `LOWLEVEL_STREAMING` | 收到过低层 raw command |
| `GRAVITY_COMP` | 重力补偿运行中 |

## 7. Topic 详解

### 7.1 `<ns>/joint_states` ✅

类型 `sensor_msgs/msg/JointState`，QoS sensor-data。`name` 顺序来自底层 `RebotArm.groups["arm"].joint_names`，通常为 `joint1` … `joint6`。

| 字段 | 说明 |
|---|---|
| `name` | 关节名 |
| `position` | 关节角，rad |
| `velocity` | 关节速度，rad/s |
| `effort` | 关节力矩，N·m |

### 7.2 `<ns>/arm_status` ✅

类型 `rebotarm_msgs/msg/ArmStatus`，QoS TRANSIENT_LOCAL + RELIABLE depth 1。

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | string | 底层模式：`mit`、`pos_vel`、`vel` |
| `enabled` | bool | 机械臂是否使能 |
| `control_loop_active` | bool | 底层控制循环是否运行 |
| `state_machine` | string | 见 6.5 状态机表 |
| `joint_names` | string[] | 关节名 |
| `per_joint_status_code` | uint8[] | 每个关节的底层状态码 |
| `error_codes` | string[] | 当前错误码列表 |

### 7.3 `<ns>/joints/<joint>/state`

类型 `rebotarm_msgs/msg/JointMotorState`，QoS sensor-data。`<joint>` 为 `joint1`–`joint6`，发布单关节电机状态。

### 7.4 `<ns>/gripper/state`

类型 `rebotarm_msgs/msg/JointMotorState`，QoS sensor-data。夹爪电机状态；未配置夹爪时不发布。

## 8. Service 详解

### 8.1 `<ns>/enable` ✅

`std_srvs/srv/Trigger`。使能机械臂；若夹爪已初始化，同时确保夹爪处于 MIT 模式。

### 8.2 `<ns>/disable` ✅

`std_srvs/srv/Trigger`。停止控制循环并失能机械臂；若重力补偿正在运行，先停止它。

### 8.3 `<ns>/safe_home` ✅

`std_srvs/srv/Trigger`。先停止重力补偿；若夹爪已初始化先闭合到 `0.0 rad`；然后切回 `pos_vel` 控制并调用 SDK `RebotArmEndPose.safe_home()`，以安全速度回零。

### 8.4 `<ns>/set_mode`

`rebotarm_msgs/srv/SetMode`。切换底层控制模式。

请求：`{ "mode": "mit" | "pos_vel" | "vel" }`
响应：`{ "success": bool, "message": string }`

```bash
ros2 service call /rebotarm/set_mode rebotarm_msgs/srv/SetMode "{mode: 'pos_vel'}"
```

### 8.5 `<ns>/set_zero`（本项目刻意不使用）

`rebotarm_msgs/srv/SetZero`。**改写电机零点，危险性高**。

请求：`{ "joint_name": "" }`（空字符串 = 全部关节；否则为单关节名如 `joint3`）
响应：`{ "success": bool, "message": string }`

### 8.6 `<ns>/move_to_pose_ik`

`rebotarm_msgs/srv/MoveToPoseIK`。调用 SDK `RebotArmEndPose.move_to_ik(...)` 求解并更新内部目标关节角，适合 IK 预检查或小步位姿调整；不是完整轨迹 action。

请求：

| 字段 | 类型 | 说明 |
|---|---|---|
| `target_pose` | `geometry_msgs/Pose` | 目标末端位姿，默认以 `base_link` 为参考 |

响应：

| 字段 | 类型 | 说明 |
|---|---|---|
| `success` | bool | IK 是否成功 |
| `message` | string | 结果说明 |
| `q_solution` | float64[] | 求解得到的关节角，rad |

```bash
ros2 service call /rebotarm/move_to_pose_ik rebotarm_msgs/srv/MoveToPoseIK \
  "{target_pose: {position: {x: 0.30, y: 0.0, z: 0.30}, orientation: {w: 1.0}}}"
```

### 8.7 `<ns>/gripper/set`

`rebotarm_msgs/srv/SetGripper`。直接设置夹爪电机位置（rad），不做开口距离到电机角度的映射。范围按模型校验：DM 为 `[-5.0, 0.0]`，RS 为 `[0.0, 5.0]`，越界拒绝。

请求：`{ "position": float64, "max_effort": float64（预留，当前不用） }`
响应：`{ "success": bool, "reached_position": float64 }`

### 8.8 `<ns>/gripper/open` ✅

`rebotarm_msgs/srv/GripperCommand`。位置控制打开夹爪。`position` 为目标电机角度 rad；传 `0.0` 使用配置的默认打开位置。`timeout` ≤ 0 使用默认超时。

请求：`{ "position": float64, "timeout": float64 }`
响应：`{ "success": bool, "reached_position": float64, "message": string }`

### 8.9 `<ns>/gripper/close` ✅

`rebotarm_msgs/srv/GripperCommand`。位置控制闭合夹爪，字段同 open。**不做力反馈夹取判断**。

### 8.10 `<ns>/gravity_compensation/start` / `stop`

`std_srvs/srv/Trigger`。启动/停止 controller 内部重力补偿闭环。实现要点：进入 MIT 模式后锁定当前关节位置，用 `compute_generalized_gravity(q)` 计算重力前馈，对多圈角度反馈做就近连续化。停止后切回 `pos_vel` 保持。

## 9. Action 详解

### 9.1 `<ns>/move_to_pose`

`rebotarm_msgs/action/MoveToPose`。末端笛卡尔位姿 action，内部调用 SDK `RebotArmEndPose.move_to_traj(...)`。

Goal：

| 字段 | 类型 | 说明 |
|---|---|---|
| `target_pose` | `geometry_msgs/Pose` | 目标末端位姿 |
| `duration` | float64 | 轨迹时长，s |

Result：`{ "success": bool, "message": string, "final_pose": geometry_msgs/Pose }`
Feedback：字段在定义中保留（`current_pose` / `progress` / `time_elapsed`），但当前实现**不发布反馈**。

```bash
ros2 action send_goal /rebotarm/move_to_pose rebotarm_msgs/action/MoveToPose \
  "{target_pose: {position: {x: 0.30, y: 0.0, z: 0.30}, orientation: {w: 1.0}}, duration: 2.0}"
```

### 9.2 `<ns>/follow_joint_trajectory` ✅

`control_msgs/action/FollowJointTrajectory`。标准关节轨迹 action。读取轨迹中所有 point，按各点 `time_from_start` 更新关节目标，实际发送由 SDK 的 `pos_vel` 控制循环完成；action 存活期间在 Feedback 的 `actual` 中回填当前 positions/velocities。

约束：

- `joint_names` 必须与底层关节顺序完全一致；
- 每个 point 必须包含完整 `positions`；
- point 之间按时间线性更新关节目标，不做 IK 或 URDF 限位校验。

### 9.3 `<ns>/gripper/command`

`control_msgs/action/GripperCommand`（标准 action）。适合行为树、任务编排或 MoveIt 风格接口。`command.position` 单位 rad，按模型范围校验；`command.max_effort` 为标准字段但当前实现不用它做力矩限制。

## 10. 低层 Command Topic（调试用途）

面向调试与实验，不建议作为应用层常规运动接口。轨迹运行时的仲裁由 launch 参数 `cmd_arbitration` 控制：`reject`（默认，拒绝低层命令）或 `preempt`（arm 关节低层命令抢占轨迹）。

安全约束：

- 重力补偿运行时拒绝全部低层 command；
- 轨迹运行时 gripper 低层 command 始终拒绝，不抢占；
- 夹爪 MIT / POS_VEL command 的 `pos` 按模型配置范围校验；
- 不做轨迹规划、IK 或 joint limit 校验。

| Topic | 类型 | 说明 |
|---|---|---|
| `<ns>/joints/<joint>/cmd/mit` | `JointMitCmd` | 单关节 MIT raw command |
| `<ns>/joints/<joint>/cmd/pos_vel` | `JointPosVelCmd` | 单关节位置速度 raw command |
| `<ns>/joints/<joint>/cmd/vel` | `JointVelCmd` | 单关节速度 raw command |
| `<ns>/gripper/cmd/mit` | `JointMitCmd` | 夹爪 MIT raw command |
| `<ns>/gripper/cmd/pos_vel` | `JointPosVelCmd` | 夹爪位置速度 raw command |
| `<ns>/gripper/cmd/vel` | `JointVelCmd` | 夹爪速度 raw command |

（QoS 均为 RELIABLE depth 10；`<joint>` 为 `joint1`–`joint6`。）

## 11. 自定义消息定义（rebotarm_msgs）

```text
# ArmStatus.msg
std_msgs/Header header
string mode
bool enabled
bool control_loop_active
string state_machine
string[] joint_names
uint8[] per_joint_status_code
string[] error_codes
```

```text
# JointMotorState.msg
std_msgs/Header header
string joint_name
float64 position
float64 velocity
float64 torque
uint8 status_code
```

```text
# JointMitCmd.msg
float64 pos
float64 vel
float64 kp
float64 kd
float64 tau
builtin_interfaces/Time stamp
```

```text
# JointPosVelCmd.msg
float64 pos
float64 vlim
builtin_interfaces/Time stamp
```

```text
# JointVelCmd.msg
float64 vel
builtin_interfaces/Time stamp
```

```text
# SetMode.srv
string mode
---
bool success
string message
```

```text
# SetZero.srv
string joint_name
---
bool success
string message
```

```text
# MoveToPoseIK.srv
geometry_msgs/Pose target_pose
---
bool success
string message
float64[] q_solution
```

```text
# SetGripper.srv
float64 position
float64 max_effort
---
bool success
float64 reached_position
```

```text
# GripperCommand.srv
float64 position
float64 timeout
---
bool success
float64 reached_position
string message
```

```text
# MoveToPose.action
geometry_msgs/Pose target_pose
float64 duration
---
bool success
string message
geometry_msgs/Pose final_pose
---
geometry_msgs/Pose current_pose
float64 progress
float64 time_elapsed
```

## 12. 官方推荐调用流程与集成注意

末端位姿移动：

```bash
ros2 service call /rebotarm/enable std_srvs/srv/Trigger
ros2 action send_goal /rebotarm/move_to_pose rebotarm_msgs/action/MoveToPose \
  "{target_pose: {position: {x: 0.30, y: 0.0, z: 0.30}, orientation: {w: 1.0}}, duration: 2.0}"
ros2 service call /rebotarm/safe_home std_srvs/srv/Trigger
ros2 service call /rebotarm/disable std_srvs/srv/Trigger
```

集成注意：

- 所有角度均为弧度，不是角度；
- `/move_to_pose` 更适合"到达某个末端位姿"的常规应用层使用；
- 重力补偿必须在 controller 内部运行，不要在外部节点用 `/joint_states` + raw command 重写高频闭环；
- `/safe_home` 会先闭合夹爪再回零；`reBotArmController` 退出时默认也走同一流程；
- 夹爪 open/close 服务是纯位置控制，不含力反馈夹取判断；
- 修改驱动端 `hardware_manager.py` / `ros_services.py` / `ros_actions.py` 后需重启驱动才生效。

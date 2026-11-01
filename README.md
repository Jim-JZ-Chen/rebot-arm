# reBot ROS 2 Web 控制台

面向 Seeed reBot Arm B601-RS 的本地 Web 面板，使用 Vue 3、TypeScript、Three.js、rosbridge 与 roslibjs。默认进入浏览器演示模式，不会连接硬件。

## 功能

- URDF / OBJ 三维机械臂，随关节反馈更新；
- 六轴反馈、目标位姿、±1° 点动和标准关节轨迹执行；
- 启用、安全回零、安全禁用、夹爪开合；
- 动作序列编辑、排序、逐步执行、取消、JSON 导入导出；
- rosbridge 地址和命名空间配置；
- 网页分步启动 CAN、ROS 驱动和 rosbridge，并检查 ROS 接口及实际关节反馈；
- 分别关闭机械臂系统或整台 ROS 主机，逐步显示成功、失败和跳过状态；
- 浏览器演示模式，用于无 ROS / 无真机时验证界面与流程。

设置与序列仅保存在当前浏览器的 localStorage，不会跨设备同步，清除浏览器数据会删除它们。

## 网页启动与关机（真机推荐）

第一次部署仍需在 Ubuntu 24.04 + ROS 2 Jazzy 主机上配置一次；之后日常使用不需要敲命令行。

```bash
npm ci
npm run build
sudo bash deploy/install.sh /绝对路径/rebot_ws
```

其中 `/绝对路径/rebot_ws` 是包含 `install/setup.bash` 的 reBot ROS 工作空间。安装脚本会：

- 安装 CAN、ROS 驱动、rosbridge 和本地面板的 systemd 服务；
- 只让面板服务开机自动运行，机械臂驱动仍由网页手动启动；
- 通过 sudoers 精确允许六个固定服务启停命令和主机关机命令，不开放任意 Shell；
- 默认只监听 `127.0.0.1:3000`，避免把系统操作接口暴露到局域网。

安装完成后打开 `http://127.0.0.1:3000`。不要在未增加身份认证和 HTTPS 的情况下将 3000 端口暴露到局域网或公网。

### 启动步骤

1. 配置 CAN `can0` 为 1 Mbps，并确认服务运行；
2. 启动 reBot ROS 驱动；
3. 检查 Enable、Disable、Safe Home 和 FollowJointTrajectory 接口；
4. 启动 rosbridge，并实际连接 9090 端口；
5. 读取一次真实 `joint_states`，确认有关节反馈。

启动软件不会自动调用 Enable，仍需在页面确认安全后手动启用机械臂。

### 两种关机

- **关闭机械臂系统**：检查状态 → 安全回零 → 禁用机械臂 → 停止驱动 → 停止 rosbridge → 关闭 CAN。
- **关闭 ROS 主机**：完成上述全部步骤后，再请求整台控制电脑关机。需要二次确认，关机后只能人工上电。

如果驱动原本未运行，安全回零和禁用会标记为“跳过”。任何安全步骤失败都会中止后续操作；网页关机按钮不是物理急停。

## 无真机本地运行

使用模拟启动器验证网页和分步流程，不会访问 ROS 或硬件：

```bash
npm ci
npm run build
REBOT_LAUNCHER_MODE=mock node server/index.mjs
```

打开 `http://127.0.0.1:3000`。仅运行 `npm run dev` 时没有本地启动器 API，系统电源区域会显示未连接。

## 连接 reBot ROS 2

推荐 Ubuntu 24.04 + ROS 2 Jazzy。先按 Seeed 官方文档构建并 source reBot 工作空间，然后启动机械臂：

```bash
source /opt/ros/jazzy/setup.bash
source install/setup.bash
ros2 launch rebotarm_bringup bringup.launch.py model:=rs channel:=can0
```

另一个终端启动 rosbridge：

```bash
source /opt/ros/jazzy/setup.bash
ros2 run rosbridge_server rosbridge_websocket
```

如尚未安装：

```bash
sudo apt install ros-jazzy-rosbridge-suite
```

在面板中切换到「ROS 2 目标」：

- WebSocket：`ws://localhost:9090`
- Namespace：`/rebotarm`
- 使用官方 MuJoCo 仿真命名空间时，可改为 `/rebotarm_rs`

如果浏览器与 ROS 不在同一台电脑，将 `localhost` 改为 ROS 主机的局域网地址，并确认 9090 端口仅对可信局域网开放。若网页通过 HTTPS 打开，浏览器会阻止不安全的 `ws://`，需要为 rosbridge 配置 `wss://`。

## 使用的 ROS 接口

官方接口文档： https://github.com/Seeed-Projects/reBotArmController_ROS2/blob/main/API_zh.md

- `/<namespace>/joint_states`：`sensor_msgs/msg/JointState`
- `/<namespace>/arm_status`：`rebotarm_msgs/msg/ArmStatus`
- `/<namespace>/follow_joint_trajectory`：`control_msgs/action/FollowJointTrajectory`
- `/<namespace>/enable`、`disable`、`safe_home`：`std_srvs/srv/Trigger`
- `/<namespace>/gripper/open`、`close`：`rebotarm_msgs/srv/GripperCommand`

本面板不发布底层 MIT 电机命令。关节与序列运动通过控制器提供的 Service / Action 完成，并等待执行结果。

## 真机安全

1. 先在浏览器演示或 MuJoCo 仿真验证命名空间、目标角度与动作顺序。
2. 真机首次连接时使用低速、单关节、小角度测试。
3. 确保工作区无人、无障碍，物理急停立即可用。
4. 网页「取消任务」只取消当前网页任务，不是物理急停，也不能保证所有底层运动立即停止。
5. `set_zero` 会改写电机零点，本面板刻意不提供该按钮。

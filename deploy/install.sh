#!/usr/bin/env bash
set -euo pipefail

# One-time Ubuntu 24.04 + ROS 2 Jazzy installation.
# Usage: sudo bash deploy/install.sh /absolute/path/to/rebot_ws

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 sudo 运行此一次性安装脚本。" >&2
  exit 1
fi

TARGET_USER=${SUDO_USER:-}
if [[ -z "${TARGET_USER}" || "${TARGET_USER}" == "root" ]]; then
  echo "无法确定运行面板的普通用户，请从该普通用户账户执行 sudo。" >&2
  exit 1
fi

TARGET_HOME=$(getent passwd "${TARGET_USER}" | cut -d: -f6)
APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORKSPACE=$(realpath -m "${1:-${TARGET_HOME}/rebot_ws}")
NODE_BIN=$(command -v node || true)

for value in "${TARGET_USER}" "${APP_DIR}" "${WORKSPACE}"; do
  if [[ "${value}" =~ [[:space:]\|\&] ]]; then
    echo "用户名或路径包含脚本不支持的空格／特殊字符：${value}" >&2
    exit 1
  fi
done

if [[ ! -f "${WORKSPACE}/install/setup.bash" ]]; then
  echo "找不到 ${WORKSPACE}/install/setup.bash。请传入正确的 reBot ROS 工作空间路径。" >&2
  exit 1
fi
if [[ ! -f "${APP_DIR}/dist/index.html" || ! -f "${APP_DIR}/server/index.mjs" ]]; then
  echo "请先在项目目录执行 npm ci && npm run build，再运行安装脚本。" >&2
  exit 1
fi
if [[ -z "${NODE_BIN}" ]]; then
  echo "找不到 Node.js。Ubuntu 24.04 建议安装 Node.js 20 或更新版本。" >&2
  exit 1
fi
for required in systemctl ip shutdown visudo; do
  if ! command -v "${required}" >/dev/null 2>&1; then
    echo "缺少系统程序：${required}" >&2
    exit 1
  fi
done

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "${TEMP_DIR}"' EXIT

render() {
  local source=$1
  local destination=$2
  sed \
    -e "s|__REBOT_USER__|${TARGET_USER}|g" \
    -e "s|__REBOT_WORKSPACE__|${WORKSPACE}|g" \
    -e "s|__REBOT_APP_DIR__|${APP_DIR}|g" \
    -e "s|__REBOT_NODE__|${NODE_BIN}|g" \
    "${source}" > "${destination}"
}

for unit in rebot-can.service rebot-driver.service rebot-rosbridge.service rebot-launcher.service; do
  render "${APP_DIR}/deploy/${unit}" "${TEMP_DIR}/${unit}"
  install -m 0644 "${TEMP_DIR}/${unit}" "/etc/systemd/system/${unit}"
done

render "${APP_DIR}/deploy/rebot-launcher.sudoers" "${TEMP_DIR}/rebot-launcher"
visudo -cf "${TEMP_DIR}/rebot-launcher"
install -m 0440 "${TEMP_DIR}/rebot-launcher" /etc/sudoers.d/rebot-launcher

systemctl daemon-reload
systemctl enable rebot-launcher.service
systemctl restart rebot-launcher.service

cat <<EOF

安装完成。机械臂驱动和 rosbridge 没有设置为开机启动。
请打开：http://127.0.0.1:3000

网页现在可以：
1. 分步启动 CAN、ROS 驱动、rosbridge 并检查关节反馈。
2. 安全回零、禁用后关闭机械臂系统。
3. 安全关闭机械臂系统后关闭整台 ROS 主机。

如果页面提示权限失败，请检查 /etc/sudoers.d/rebot-launcher 和对应 systemd 服务日志。
EOF

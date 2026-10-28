import { useRef } from "react";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Tag, Typography } from "antd";
import {
  ClockCircleOutlined,
  UserOutlined,
  DesktopOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import type { LoginLog } from "./api";
import { fetchLogs } from "./api";

type ResultCfg = { text: string; color: string; icon: React.ReactNode; row: string };
const RESULT_MAP: Record<string, ResultCfg> = {
  ok: { text: "登录成功", color: "green", icon: <CheckCircleFilled />, row: "#f6ffed" },
  rejected_limit: { text: "设备数超限", color: "red", icon: <CloseCircleFilled />, row: "#fff2f0" },
  rejected_disabled: { text: "密钥已封禁", color: "orange", icon: <ExclamationCircleFilled />, row: "#fffbe6" },
  rejected_expired: { text: "密钥已过期", color: "orange", icon: <ExclamationCircleFilled />, row: "#fffbe6" },
  rejected_notfound: { text: "密钥不存在", color: "red", icon: <CloseCircleFilled />, row: "#fff2f0" },
};

// 客户名称按名字生成一个稳定的颜色, 方便一眼区分不同客户
const NAME_COLORS = ["blue", "cyan", "geekblue", "purple", "magenta", "volcano", "gold", "lime"];
function nameColor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

export default function LogsPage() {
  const actionRef = useRef<any>(undefined);

  const columns: ProColumns<LoginLog>[] = [
    {
      title: "操作时间",
      dataIndex: "createdAt",
      search: false,
      width: 190,
      render: (_, r) => (
        <span style={{ fontFamily: "monospace", color: "#555" }}>
          <ClockCircleOutlined style={{ color: "#1677ff", marginRight: 6 }} />
          {r.createdAt}
        </span>
      ),
    },
    {
      title: "客户名称",
      dataIndex: "keyName",
      search: false,
      width: 140,
      render: (_, r) =>
        r.keyName ? (
          <Tag color={nameColor(r.keyName)} icon={<UserOutlined />}>
            {r.keyName}
          </Tag>
        ) : (
          <span style={{ color: "#bbb" }}>(未命名)</span>
        ),
    },
    {
      title: "密钥",
      dataIndex: "keyCode",
      copyable: true,
      width: 220,
      render: (v) => <Typography.Text style={{ fontFamily: "monospace" }}>{v as string}</Typography.Text>,
    },
    {
      title: "设备ID",
      dataIndex: "deviceId",
      ellipsis: true,
      render: (v) => (
        <span style={{ color: "#888" }}>
          <DesktopOutlined style={{ marginRight: 6 }} />
          {v as string}
        </span>
      ),
    },
    { title: "来源IP", dataIndex: "ip", search: false, width: 140 },
    {
      title: "结果",
      dataIndex: "result",
      valueType: "select",
      width: 140,
      valueEnum: {
        ok: { text: "登录成功" },
        rejected_limit: { text: "设备数超限" },
        rejected_disabled: { text: "密钥已封禁" },
        rejected_expired: { text: "密钥已过期" },
        rejected_notfound: { text: "密钥不存在" },
      },
      render: (_, r) => {
        const cfg = RESULT_MAP[r.result] || { text: r.result, color: "default", icon: null };
        return (
          <Tag color={cfg.color} icon={cfg.icon}>
            {cfg.text}
          </Tag>
        );
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <ProTable<LoginLog>
        headerTitle="登录日志"
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        onRow={(record) => {
          const bg = RESULT_MAP[record.result]?.row;
          return bg ? { style: { background: bg } } : {};
        }}
        request={async (params) => {
          const res = await fetchLogs(params);
          return {
            data: res.data,
            success: res.success,
            total: res.total,
          };
        }}
        search={{ labelWidth: "auto" }}
        pagination={{ defaultPageSize: 20 }}
      />
    </div>
  );
}

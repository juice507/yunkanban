import { useEffect, useState } from "react";
import { Card, Col, Row, Statistic, Tag, Table, Segmented, Input, Space, Button, Tooltip, Alert } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { fetchActivityOverview, fetchDeviceStates, type ActivityOverview, type DeviceState } from "./api";

export const PLATFORM_LABEL: Record<string, string> = { pc: "电脑", android: "安卓", ios: "苹果", other: "未知", "": "未知" };
export const STATE_META: Record<string, { label: string; color: string }> = {
  online: { label: "在线", color: "green" },
  today: { label: "今天用过", color: "gold" },
  offline: { label: "离线", color: "default" },
  kicked: { label: "已踢下线", color: "red" },
  expired: { label: "已过期", color: "volcano" },
};

function Trend({ data }: { data: ActivityOverview["trend"] }) {
  const max = Math.max(1, ...data.map((d) => d.users));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120, paddingTop: 8 }}>
      {data.map((d) => (
        <Tooltip key={d.day} title={`${d.day}：${d.users} 个用户 / ${d.devices} 台设备`}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#666" }}>{d.users}</span>
            <div style={{ width: "70%", height: (d.users / max) * 80 + 2, background: "#3a6df0", borderRadius: 3 }} />
            <span style={{ fontSize: 10, color: "#999" }}>{d.day.slice(5)}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [ov, setOv] = useState<ActivityOverview | null>(null);
  const [devs, setDevs] = useState<DeviceState[]>([]);
  const [state, setState] = useState<string>("online");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([fetchActivityOverview(), fetchDeviceStates({ state, q })]);
      setOv(a.data);
      setDevs(b.data || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const g = ov?.guard || {};
  const guardOk = g.lastResult ? g.lastResult.alive === true && g.lastResult.vip !== false && !g.dead : null;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>使用看板</h3>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
      </div>
      {ov && <Alert type="info" showIcon style={{ marginBottom: 16 }} message={`${ov.note}。在线 = ${ov.onlineWindowMin} 分钟内有活动；今日活跃 = 今天 0 点后用过。`} />}
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}><Card><Statistic title="当前在线设备" value={ov?.onlineDevices ?? "-"} suffix={ov ? <span style={{ fontSize: 13, color: "#999" }}>/ {ov.onlineUsers} 个用户</span> : null} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="今日活跃用户" value={ov?.todayUsers ?? "-"} suffix={ov ? <span style={{ fontSize: 13, color: "#999" }}>/ {ov.todayDevices} 台设备</span> : null} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="今日问题" value={ov?.todayProblems ?? "-"} valueStyle={{ color: ov && ov.todayProblems ? "#e5484d" : undefined }} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="已绑定设备 / 今日新激活" value={ov ? `${ov.boundDevices} / ${ov.todayActivated}` : "-"} /></Card></Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={14}>
          <Card title="近两周每日活跃用户" size="small">{ov && <Trend data={ov.trend} />}</Card>
        </Col>
        <Col xs={24} md={10}>
          <Card title="登录态守护" size="small" extra={guardOk === null ? null : <Tag color={guardOk ? "green" : "red"}>{guardOk ? "正常" : "异常"}</Tag>}>
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              <div>上次检查：{g.lastResult?.at || "-"}</div>
              <div style={{ color: "#666" }}>{g.lastResult?.detail || ""}</div>
              <div>上次换新：{g.lastRefresh ? `${g.lastRefresh.at}（${g.lastRefresh.ok ? "成功" : "失败：" + (g.lastRefresh.reason || "")}）` : "无"}</div>
              {g.fails ? <div style={{ color: "#e5484d" }}>连续失败 {g.fails} 次{g.breakerUntil ? `，熔断到 ${g.breakerUntil}` : ""}</div> : null}
            </div>
            <div style={{ marginTop: 8 }}>
              今日平台：{(ov?.platforms || []).map((p) => <Tag key={p.platform}>{PLATFORM_LABEL[p.platform] || p.platform} {p.c}</Tag>)}
            </div>
            <div style={{ marginTop: 6 }}>
              今日版本：{(ov?.versions || []).map((v) => <Tag key={v.version}>{v.version} · {v.c}</Tag>)}
            </div>
          </Card>
        </Col>
      </Row>
      <Card size="small" style={{ marginTop: 16 }} title="设备实时状态"
        extra={
          <Space>
            <Segmented value={state} onChange={(v) => setState(String(v))}
              options={[{ label: "在线", value: "online" }, { label: "今天用过", value: "today" }, { label: "离线", value: "offline" },
                { label: "已踢", value: "kicked" }, { label: "过期", value: "expired" }, { label: "全部", value: "" }]} />
            <Input.Search allowClear placeholder="客户名/订阅码/IP" onSearch={(v) => { setQ(v); setTimeout(load, 0); }} style={{ width: 200 }} />
          </Space>
        }>
        <Table<DeviceState> rowKey="id" size="small" loading={loading} dataSource={devs} pagination={{ pageSize: 20 }} scroll={{ x: 900 }}
          columns={[
            { title: "状态", dataIndex: "state", width: 90, render: (v) => <Tag color={STATE_META[v]?.color}>{STATE_META[v]?.label || v}</Tag> },
            { title: "客户", dataIndex: "keyName", render: (v, r) => <span>{v || <span style={{ color: "#999" }}>未备注</span>}<div style={{ fontSize: 12, color: "#999" }}>{r.keyCode}</div></span> },
            { title: "设备", dataIndex: "deviceLabel", width: 120 },
            { title: "平台", dataIndex: "platform", width: 70, render: (v) => PLATFORM_LABEL[v] || v },
            { title: "版本", dataIndex: "version", width: 80 },
            { title: "最后活动", dataIndex: "lastActiveAt", width: 170, render: (v, r) => <span>{v}{!r.exact && <Tooltip title="老插件按 IP 估算"><span style={{ color: "#bbb" }}> ≈</span></Tooltip>}</span> },
            { title: "IP", dataIndex: "ip", width: 140 },
            { title: "首次登录", dataIndex: "firstLoginAt", width: 170 },
          ]} />
      </Card>
    </div>
  );
}

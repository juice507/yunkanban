import { useEffect, useState } from "react";
import { Card, Table, Tag, Select, Input, Space, Button, DatePicker, Switch, Tooltip, Drawer } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { fetchActivityLogs, exportActivityLogs, fetchKeyInfo, type ActivityLog, type KeyInfo } from "./api";
import { PLATFORM_LABEL } from "./DashboardPage";

const CAT_COLOR: Record<string, string> = { usage: "blue", state: "cyan", problem: "red", system: "purple" };

export default function ActivityLogPage() {
  const [rows, setRows] = useState<ActivityLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState<string | undefined>();
  const [event, setEvent] = useState<string | undefined>();
  const [platform, setPlatform] = useState<string | undefined>();
  const [problem, setProblem] = useState(false);
  const [q, setQ] = useState("");
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [events, setEvents] = useState<{ value: string; category: string; label: string }[]>([]);
  const [summary, setSummary] = useState<{ category: string; c: number }[]>([]);
  const [keyDetail, setKeyDetail] = useState<KeyInfo | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);

  const params = () => ({
    page, pageSize, category, event, platform, q: q || undefined, problem: problem ? 1 : undefined,
    from: range ? range[0].startOf("day").format("YYYY-MM-DD HH:mm:ss") : undefined,
    to: range ? range[1].endOf("day").format("YYYY-MM-DD HH:mm:ss") : undefined,
  });
  const load = async () => {
    setLoading(true);
    try {
      const r = await fetchActivityLogs(params());
      setRows(r.data || []);
      setTotal(r.total || 0);
      setEvents(r.events || []);
      setSummary(r.todaySummary || []);
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [page, pageSize, category, event, platform, problem, range]);

  const openKey = async (keyId: number) => {
    setKeyLoading(true);
    try {
      const r = await fetchKeyInfo(keyId);
      if (r.success && r.data) setKeyDetail(r.data);
    } finally {
      setKeyLoading(false);
    }
  };
  const copyKey = async () => {
    if (!keyDetail) return;
    try { await navigator.clipboard.writeText(keyDetail.code); message.success("密钥已复制"); }
    catch { message.error("复制失败"); }
  };

  const cnt = (c: string) => summary.find((s) => s.category === c)?.c || 0;
  const columns = [
    { title: "时间", dataIndex: "createdAt", width: 165 },
    { title: "分类", dataIndex: "categoryLabel", width: 70, render: (v: string, r: ActivityLog) => <Tag color={CAT_COLOR[r.category]}>{v}</Tag> },
    { title: "事件", dataIndex: "eventLabel", width: 150, render: (v: string, r: ActivityLog) => <span style={{ color: r.ok ? undefined : "#e5484d" }}>{v}{r.estimated && <Tooltip title="老插件按 IP 估算"><span style={{ color: "#bbb" }}> ≈</span></Tooltip>}</span> },
    { title: "客户", dataIndex: "keyName", width: 160, render: (v: string, r: ActivityLog) => r.keyId ? <a onClick={() => openKey(r.keyId!)}>{v || r.keyCode}{v && <div style={{ fontSize: 12, color: "#999" }}>{r.keyCode}</div>}</a> : <span style={{ color: "#999" }}>-</span> },
    { title: "设备", dataIndex: "deviceLabel", width: 110, render: (v: string, r: ActivityLog) => v || r.deviceId },
    { title: "平台", dataIndex: "platform", width: 60, render: (v: string) => PLATFORM_LABEL[v] ?? v },
    { title: "版本", dataIndex: "version", width: 70 },
    { title: "IP", dataIndex: "ip", width: 130 },
    { title: "详情", dataIndex: "detail" },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>日志中心</h3>
        <Space>
          <span style={{ fontSize: 13, color: "#666" }}>今天：使用 {cnt("usage")} · 状态 {cnt("state")} · <span style={{ color: "#e5484d" }}>问题 {cnt("problem")}</span> · 系统 {cnt("system")}</span>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button icon={<DownloadOutlined />} onClick={() => exportActivityLogs({ ...params(), page: 1 })}>导出 Excel</Button>
        </Space>
      </div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Select allowClear placeholder="分类" style={{ width: 110 }} value={category} onChange={(v) => { setCategory(v); setEvent(undefined); setPage(1); }}
            options={[{ value: "usage", label: "使用" }, { value: "state", label: "状态" }, { value: "problem", label: "问题" }, { value: "system", label: "系统" }]} />
          <Select allowClear placeholder="事件" style={{ width: 170 }} value={event} onChange={(v) => { setEvent(v); setPage(1); }}
            options={events.filter((e) => !category || e.category === category).map((e) => ({ value: e.value, label: e.label }))} />
          <Select allowClear placeholder="平台" style={{ width: 100 }} value={platform} onChange={(v) => { setPlatform(v); setPage(1); }}
            options={[{ value: "pc", label: "电脑" }, { value: "android", label: "安卓" }, { value: "ios", label: "苹果" }]} />
          <DatePicker.RangePicker value={range as any} onChange={(v) => { setRange(v as any); setPage(1); }}
            presets={[{ label: "今天", value: [dayjs(), dayjs()] }, { label: "近 7 天", value: [dayjs().subtract(6, "day"), dayjs()] }]} />
          <Input.Search allowClear placeholder="客户名/订阅码/IP/详情" style={{ width: 220 }} onSearch={(v) => { setQ(v); setPage(1); setTimeout(load, 0); }} />
          <span>只看问题 <Switch size="small" checked={problem} onChange={(v) => { setProblem(v); setPage(1); }} /></span>
        </Space>
      </Card>
      <Table<ActivityLog> rowKey="id" size="small" loading={loading} dataSource={rows} columns={columns as any} scroll={{ x: 1100 }}
        rowClassName={(r) => (r.ok ? "" : "row-problem")}
        pagination={{ current: page, pageSize, total, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200], showTotal: (t) => `共 ${t} 条`,
          onChange: (p, s) => { setPage(p); setPageSize(s); } }} />
      <Drawer width={420} open={!!keyDetail || keyLoading} onClose={() => setKeyDetail(null)} title="密钥信息">
        {keyLoading && <div>加载中…</div>}
        {keyDetail && <div style={{ fontSize: 14 }}>
          <div style={{ color: "#666", marginBottom: 6 }}>密钥</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 18 }}>
            <Input value={keyDetail.code} readOnly style={{ fontFamily: "monospace" }} />
            <Button type="primary" onClick={copyKey}>复制</Button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", rowGap: 13, color: "#555" }}>
            <span>备注</span><b>{keyDetail.name || keyDetail.note || "未备注"}</b>
            <span>状态</span><b>{keyDetail.status === "active" ? "正常" : keyDetail.status}</b>
            <span>到期时间</span><b>{keyDetail.expiryDate || "永久"}</b>
            <span>设备</span><b>{keyDetail.activeDevices} / {keyDetail.maxDevices} 台</b>
            <span>关联代理</span><b>{keyDetail.agentName}</b>
            <span>卡密来源</span><b>{keyDetail.cardLabel}</b>
            <span>首次激活</span><b>{keyDetail.activatedAt || "尚未激活"}</b>
            <span>创建时间</span><b>{keyDetail.createdAt || "-"}</b>
          </div>
        </div>}
      </Drawer>
      <style>{`.row-problem td{background:#fff5f5 !important}`}</style>
    </div>
  );
}

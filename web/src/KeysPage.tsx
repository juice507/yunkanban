import { useRef, useState, useEffect } from "react";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns, ActionType } from "@ant-design/pro-components";
import {
  Button,
  Tag,
  Popconfirm,
  message,
  Modal,
  Form,
  Input,
  InputNumber,
  DatePicker,
  Statistic,
  Card,
  Row,
  Col,
  Avatar,
  Upload,
  Select,
  Space,
  Spin,
  Alert,
} from "antd";
import { PlusOutlined, KeyOutlined, DesktopOutlined, UserOutlined, UploadOutlined, CopyOutlined, DeleteOutlined, CheckCircleOutlined, ClockCircleOutlined, CalendarOutlined } from "@ant-design/icons";
import type { UploadProps } from "antd";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import type { LicenseKey, CardItem, AgentItem, ActivationPoint, AgentSlice } from "./api";
import {
  fetchKeys,
  createKey,
  createKeysBatch,
  updateKey,
  deleteKey,
  deleteKeysBatch,
  fetchStats,
  fetchActivationStats,
  fetchPendingByAgent,
  fetchCards,
  fetchAgents,
  uploadAvatar,
  resolveUrl,
} from "./api";
import DeviceDrawer from "./DeviceDrawer";

// 可拖拽调整列宽的表头单元格(零依赖, 兼容 React 19)
function ResizableTitle(props: any) {
  const { onResize, width, children, ...rest } = props;
  if (!width) return <th {...rest}>{children}</th>;
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => onResize(Math.max(60, startW + ev.clientX - startX));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return (
    <th {...rest} style={{ ...rest.style, position: "relative" }}>
      {children}
      <span className="col-resize-handle" onMouseDown={onMouseDown} />
    </th>
  );
}

const AGENT_PASTELS = [
  { bg: "#e6f4ff", color: "#1677ff" },
  { bg: "#f6ffed", color: "#389e0d" },
  { bg: "#fff7e6", color: "#d46b08" },
  { bg: "#f9f0ff", color: "#722ed1" },
  { bg: "#e6fffb", color: "#08979c" },
  { bg: "#fff0f6", color: "#c41d7f" },
  { bg: "#fcffe6", color: "#7cb305" },
  { bg: "#fff2e8", color: "#d4380d" },
  { bg: "#f0f5ff", color: "#2f54eb" },
  { bg: "#fffbe6", color: "#d48806" },
];
function agentTagStyle(id: number) {
  return AGENT_PASTELS[id % AGENT_PASTELS.length];
}

// 柱子下方的短标签: 中文取首字, 英文取首字母
function initialOf(name: string) {
  const s = (name || "").trim();
  if (!s) return "?";
  return /[a-zA-Z]/.test(s[0]) ? s[0].toUpperCase() : s[0];
}

const DURATION_PRESETS = [
  { label: "7天", days: 7 },
  { label: "1个月", days: 30 },
  { label: "3个月", days: 90 },
  { label: "永久", days: 0 },
];

const LICENSE_TYPE_OPTIONS = [
  { value: "manual", label: "普通" },
  { value: "trial", label: "试用" },
  { value: "formal", label: "正式" },
];

function LicenseTypeTag({ value }: { value?: string }) {
  if (value === "trial") return <Tag color="orange">试用</Tag>;
  if (value === "formal") return <Tag color="blue">正式</Tag>;
  return <Tag>普通</Tag>;
}

function DurationField({ form }: { form: any }) {
  return (
    <Form.Item
      label="有效期"
      tooltip="从客户第一次激活订阅码那天开始算，生成当天不算"
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        {DURATION_PRESETS.map((p) => (
          <Button key={p.label} size="small" onClick={() => form.setFieldsValue({ validDays: p.days })}>
            {p.label}
          </Button>
        ))}
      </div>
      <Form.Item name="validDays" noStyle>
        <InputNumber min={0} max={3650} style={{ width: "100%" }} addonAfter="天（0=永久）" />
      </Form.Item>
    </Form.Item>
  );
}

function LicenseDurationHint({ form }: { form: any }) {
  return (
    <Form.Item noStyle shouldUpdate={(prev, next) => prev.licenseType !== next.licenseType}>
      {() => {
        const kind = form.getFieldValue("licenseType") || "manual";
        if (kind === "trial") {
          return <Alert type="info" showIcon message="试用：首次激活起 24 小时，给闲鱼试用商品发货用" style={{ marginBottom: 16 }} />;
        }
        if (kind === "formal") {
          return <Alert type="info" showIcon message="正式：首次激活起 30 天，给闲鱼正式商品发货用" style={{ marginBottom: 16 }} />;
        }
        return <DurationField form={form} />;
      }}
    </Form.Item>
  );
}

// 每日激活柱形图(弹窗): 纯 CSS 柱子, 高度按区间最大值取比例
function ActivationChart({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const [data, setData] = useState<ActivationPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    fetchActivationStats(from, to)
      .then((res) => {
        if (alive && res.success) setData(res.data || []);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, from, to]);

  // 高度以「单个代理单日最大值」为准(分组柱, 不是按天合计)
  const max = Math.max(1, ...data.flatMap((d) => d.agents.map((a) => a.count)));
  const total = data.reduce((s, d) => s + d.count, 0);
  const setLastDays = (n: number) => setRange([dayjs().subtract(n - 1, "day"), dayjs()]);

  // 图例: 区间内出现过的代理去重
  const legend = Array.from(
    new Map(data.flatMap((d) => d.agents).map((a) => [a.agentId, a])).values()
  );

  return (
    <Modal title="每日激活数量" open={open} onCancel={onClose} width={900} footer={null}>
      <Space wrap style={{ marginBottom: 16 }}>
        <Button size="small" onClick={() => setLastDays(7)}>
          近 7 天
        </Button>
        <Button size="small" onClick={() => setLastDays(30)}>
          近 30 天
        </Button>
        <DatePicker.RangePicker
          size="small"
          allowClear={false}
          value={range}
          onChange={(v) => {
            if (v && v[0] && v[1]) setRange([v[0], v[1]]);
          }}
        />
        <span style={{ color: "#999", fontSize: 12 }}>合计 {total}</span>
      </Space>

      <Spin spinning={loading}>
        {total === 0 ? (
          <div style={{ color: "#999", textAlign: "center", padding: "48px 0" }}>这段时间没有激活记录</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 250, overflowX: "auto", paddingBottom: 4 }}>
              {data.map((d) => (
                <div
                  key={d.date}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", height: "100%", flex: "0 0 auto" }}
                >
                  {/* 这一天的若干个代理: 紧挨着的一组柱子; 没有激活的代理不出现 */}
                  <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 2 }}>
                    {d.agents.length === 0 ? (
                      <div style={{ width: 20, height: 2, background: "#f0f0f0", borderRadius: 2 }} />
                    ) : (
                      d.agents.map((a) => {
                        const s = agentTagStyle(a.agentId);
                        return (
                          <div
                            key={a.agentId}
                            className="chart-bar-item"
                            style={{ display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end" }}
                            title={`${d.date} · ${a.agentName}：${a.count} 个`}
                          >
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#fa8c16", marginBottom: 3 }}>{a.count}</div>
                            <div
                              className="chart-bar"
                              style={{
                                width: 22,
                                height: `${(a.count / max) * 100}%`,
                                minHeight: 4,
                                background: s.color,
                                borderRadius: "4px 4px 0 0",
                              }}
                            />
                            <div style={{ fontSize: 11, fontWeight: 700, color: s.color, marginTop: 4 }}>
                              {initialOf(a.agentName)}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#999", marginTop: 4, whiteSpace: "nowrap" }}>{d.date.slice(5)}</div>
                </div>
              ))}
            </div>

            {/* 图例: 首字母对应哪个代理 */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14, paddingTop: 12, borderTop: "1px solid #f0f0f0" }}>
              {legend.map((a) => {
                const s = agentTagStyle(a.agentId);
                return (
                  <span key={a.agentId} style={{ fontSize: 12, color: "#666", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <i style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
                    {initialOf(a.agentName)} = {a.agentName}
                  </span>
                );
              })}
            </div>
          </>
        )}
      </Spin>
    </Modal>
  );
}

// 各代理还有多少个没激活(柱形图弹窗)
function PendingChart({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<AgentSlice[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    fetchPendingByAgent()
      .then((res) => {
        if (alive && res.success) setData(res.data || []);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const max = Math.max(1, ...data.map((d) => d.count));
  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <Modal title="还没有激活的（按分类）" open={open} onCancel={onClose} width={760} footer={null}>
      <div style={{ color: "#999", fontSize: 12, marginBottom: 14 }}>共 {total} 个未激活</div>
      <Spin spinning={loading}>
        {data.length === 0 ? (
          <div style={{ color: "#999", textAlign: "center", padding: "48px 0" }}>所有密钥都已激活</div>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 240, overflowX: "auto" }}>
            {data.map((a) => {
              const s = agentTagStyle(a.agentId);
              return (
                <div
                  key={a.agentId}
                  className="chart-bar-item"
                  style={{ flex: "1 0 52px", display: "flex", flexDirection: "column", alignItems: "center", height: "100%" }}
                  title={`${a.agentName}：还有 ${a.count} 个没激活`}
                >
                  <div style={{ flex: 1, width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, textAlign: "center", color: "#fa8c16", marginBottom: 4 }}>
                      {a.count}
                    </div>
                    <div
                      className="chart-bar"
                      style={{
                        height: `${(a.count / max) * 100}%`,
                        minHeight: 4,
                        background: s.color,
                        borderRadius: "4px 4px 0 0",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 6, textAlign: "center", wordBreak: "break-all" }}>
                    {a.agentName}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Spin>
    </Modal>
  );
}

export default function KeysPage() {
  const actionRef = useRef<ActionType | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchResult, setBatchResult] = useState<string[]>([]);
  const [chartOpen, setChartOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([]);
  const [batching, setBatching] = useState(false);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<LicenseKey | null>(null);
  const [deviceDrawer, setDeviceDrawer] = useState<{ id: number; name: string } | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [batchForm] = Form.useForm();
  const [stats, setStats] = useState({
    totalKeys: 0,
    activatedCount: 0,
    pendingCount: 0,
    todayActivated: 0,
    totalDevices: 0,
  });
  const [uploadingCreate, setUploadingCreate] = useState(false);
  const [uploadingEdit, setUploadingEdit] = useState(false);
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const [tokens, setTokens] = useState<CardItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);

  const createAvatar = Form.useWatch("avatar", form);
  const editAvatar = Form.useWatch("avatar", editForm);
  const batchAvatar = Form.useWatch("avatar", batchForm);

  const loadStats = async () => {
    const res = await fetchStats();
    if (res.success) setStats(res.data);
  };

  const loadTokens = async () => {
    const res = await fetchCards();
    if (res.success) setTokens(res.data);
  };
  const loadAgents = async () => {
    const res = await fetchAgents();
    if (res.success) setAgents(res.data || []);
  };
  useEffect(() => {
    loadTokens();
    loadAgents();
  }, []);

  // 分配卡密的下拉选项(显示剩余名额)
  const tokenOptions = tokens.map((c) => ({
    value: c.id,
    label: `${c.label || c.providerCode}${c.status !== "active" ? "（停用）" : ""} · Cookie ${c.cookieReady}/${c.tokenCount}`,
  }));
  const agentOptions = agents.map((a) => ({
    value: a.id,
    label: `${a.name} · ${a.used}/${a.capacity || "不限"}`,
  }));

  // 生成一个 antd Upload 的 customRequest（把上传结果写入指定表单的 avatar 字段）
  const makeUploader = (targetForm: any, setUploading: (v: boolean) => void): UploadProps["customRequest"] =>
    async (options) => {
      const { file, onSuccess, onError } = options;
      setUploading(true);
      try {
        const res = await uploadAvatar(file as File);
        if (res.success) {
          targetForm.setFieldsValue({ avatar: res.url });
          message.success("上传成功");
          onSuccess?.(res);
        } else throw new Error(res.message || "上传失败");
      } catch (err: any) {
        message.error(err.message || "上传失败");
        onError?.(err);
      } finally {
        setUploading(false);
      }
    };

  const columns: ProColumns<LicenseKey>[] = [
    {
      title: "展示头像",
      dataIndex: "avatar",
      search: false,
      width: 80,
      render: (_, r) => <Avatar src={resolveUrl(r.avatar) || undefined} icon={<UserOutlined />} />,
    },
    {
      title: "展示昵称",
      dataIndex: "nickname",
      search: false,
      width: 120,
      render: (v) => v || <span style={{ color: "#999" }}>(未设置)</span>,
    },
    {
      title: "密钥",
      dataIndex: "keyCode",
      copyable: true,
      width: 210,
      render: (v) => <span style={{ fontFamily: "monospace" }}>{v}</span>,
    },
    {
      title: "备注名",
      dataIndex: "name",
      width: 180,
      render: (_, r) => {
        const title = String(r.name || "").trim();
        const extra = String(r.note || "").trim();
        if (!title && !extra) return <span style={{ color: "#bbb" }}>—</span>;
        return (
          <div style={{ lineHeight: 1.45 }}>
            <div>{title || extra}</div>
            {title && extra && extra !== title ? (
              <div style={{ color: "#888", fontSize: 12 }}>{extra}</div>
            ) : null}
          </div>
        );
      },
    },
    {
      title: "关联分类",
      dataIndex: "agentId",
      width: 140,
      valueType: "select",
      fieldProps: {
        allowClear: true,
        showSearch: true,
        optionFilterProp: "label",
        placeholder: "选择分类查看",
        options: [{ value: "0", label: "未分类" }, ...agentOptions],
      },
      render: (_, r) => {
        if (!r.agentId || !r.agentName) return <Tag>未关联</Tag>;
        const s = agentTagStyle(r.agentId);
        return (
          <Tag style={{ background: s.bg, color: s.color, borderColor: "transparent" }}>{r.agentName}</Tag>
        );
      },
    },
    {
      title: "授权类型",
      dataIndex: "licenseType",
      width: 110,
      valueType: "select",
      fieldProps: {
        allowClear: true,
        placeholder: "全部",
        options: LICENSE_TYPE_OPTIONS,
      },
      render: (_, r) => <LicenseTypeTag value={r.licenseType} />,
    },
    {
      title: "激活状态",
      key: "activated",
      search: false,
      width: 100,
      render: (_, r) => (r.activated ? <Tag color="success">已激活</Tag> : <Tag>未激活</Tag>),
    },
    {
      title: "封禁",
      dataIndex: "status",
      width: 90,
      valueType: "select",
      valueEnum: {
        active: { text: "正常" },
        disabled: { text: "已封禁" },
      },
      render: (_, r) =>
        r.status === "disabled" ? <Tag color="red">已封禁</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: "激活时间",
      dataIndex: "activatedAt",
      search: false,
      width: 165,
      render: (_, r) =>
        r.activatedAt ? String(r.activatedAt) : <span style={{ color: "#bbb" }}>—</span>,
    },
    {
      title: "分配卡密",
      dataIndex: "cardLabel",
      search: false,
      width: 140,
      render: (_, r) =>
        r.cardLabel ? (
          <Tag color="purple">{r.cardLabel}</Tag>
        ) : (
          <Tag>默认</Tag>
        ),
    },
    {
      title: "设备占用",
      dataIndex: "deviceCount",
      search: false,
      width: 100,
      render: (_, r) => (
        <Tag color={r.deviceCount >= r.maxDevices ? "red" : "blue"}>
          {r.deviceCount} / {r.maxDevices}
        </Tag>
      ),
    },
    {
      title: "到期时间",
      dataIndex: "expiryDate",
      search: false,
      render: (_, r) => {
        if (r.expiryDate && r.expiryDate !== "-") return String(r.expiryDate);
        if (r.validDays > 0) return <Tag color="blue">激活后{r.validDays}天</Tag>;
        return <Tag>永久</Tag>;
      },
    },
    {
      title: "剩余天数",
      dataIndex: "remainingDays",
      search: false,
      width: 100,
      render: (_, r) => {
        if (r.remainingDays == null) {
          if (r.validDays && r.validDays > 0 && !r.activated) return <Tag>未激活</Tag>;
          return <Tag>永久</Tag>;
        }
        const d = r.remainingDays;
        const color = d <= 0 ? "red" : d <= 3 ? "orange" : d <= 7 ? "gold" : "green";
        return <Tag color={color}>{d <= 0 ? "已到期" : `${d} 天`}</Tag>;
      },
    },
    {
      title: "客户",
      dataIndex: "customerName",
      search: false,
      width: 180,
      render: (_, r) => {
        if (!r.customerName && !r.phone && !r.wechat && !r.qq) return <span style={{ color: "#bbb" }}>—</span>;
        return (
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            {r.customerName && <div>{r.customerName}</div>}
            {r.phone && <div style={{ color: "#888" }}>电话：{r.phone}</div>}
            {r.wechat && <div style={{ color: "#888" }}>微信：{r.wechat}</div>}
            {r.qq && <div style={{ color: "#888" }}>QQ：{r.qq}</div>}
          </div>
        );
      },
    },
    { title: "创建时间", dataIndex: "createdAt", search: false },
    {
      title: "操作",
      valueType: "option",
      width: 240,
      render: (_, r) => [
        <a key="devices" onClick={() => setDeviceDrawer({ id: r.id, name: r.name || r.keyCode })}>
          设备
        </a>,
        <a
          key="edit"
          onClick={() => {
            setEditing(r);
            editForm.setFieldsValue({
              name: r.name,
              nickname: r.nickname,
              avatar: r.avatar,
              maxDevices: r.maxDevices,
              note: r.note,
              cardId: r.cardId ?? undefined,
              agentId: r.agentId ?? undefined,
              licenseType: r.licenseType || "manual",
              validDays: r.validDays || 0,
              expiryDate: r.expiryDate ? dayjs(r.expiryDate) : null,
              customerName: r.customerName || "",
              phone: r.phone || "",
              wechat: r.wechat || "",
              qq: r.qq || "",
            });
          }}
        >
          编辑
        </a>,
        r.status === "active" ? (
          <Popconfirm
            key="ban"
            title="封禁后这个密钥立刻不能再用（金10 / 会员库都生效）。确定封禁？"
            onConfirm={async () => {
              await updateKey(r.id, { status: "disabled" });
              message.success("已封禁");
              actionRef.current?.reload();
            }}
          >
            <a style={{ color: "#d4380d" }}>封禁</a>
          </Popconfirm>
        ) : (
          <a
            key="unban"
            onClick={async () => {
              await updateKey(r.id, { status: "active" });
              message.success("已解封");
              actionRef.current?.reload();
            }}
          >
            解封
          </a>
        ),
        <Popconfirm
          key="delete"
          title="删除密钥及其设备记录，已发货订单历史会保留。确定删除？"
          onConfirm={async () => {
            try {
              const res = await deleteKey(r.id);
              if (!res.success) {
                message.error(res.message || "删除失败");
                return;
              }
              message.success("已删除");
              actionRef.current?.reload();
              loadStats();
            } catch (e: any) {
              message.error(e?.response?.data?.message || e.message || "删除失败");
            }
          }}
        >
          <a style={{ color: "red" }}>删除</a>
        </Popconfirm>,
      ],
    },
  ];

  // 给每列附上可拖拽宽度(用户拖动表头右边缘即可调整; 内容自适应初始宽度)
  const resizableColumns = columns.map((col, idx) => {
    const key = String((col as ProColumns<LicenseKey>).key ?? (col as any).dataIndex ?? idx);
    const width = colWidths[key] ?? ((col.width as number) || 140);
    return {
      ...col,
      width,
      onHeaderCell: () =>
        ({
          width,
          onResize: (w: number) => setColWidths((prev) => ({ ...prev, [key]: w })),
        } as any),
    } as ProColumns<LicenseKey>;
  });

  return (
    <div style={{ padding: 24 }}>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} md={8} xl={4}>
          <Card>
            <Statistic title="密钥总数" value={stats.totalKeys} prefix={<KeyOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8} xl={5}>
          <Card>
            <Statistic title="激活好的数量" value={stats.activatedCount} prefix={<CheckCircleOutlined />} valueStyle={{ color: "#3f8600" }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8} xl={5}>
          <Card hoverable className="stat-card-clickable" onClick={() => setPendingOpen(true)}>
            <Statistic
              title={
                <span>
                  还没有激活的
                  <span style={{ color: "#d46b08", fontSize: 12, marginLeft: 6 }}>点击看分类</span>
                </span>
              }
              value={stats.pendingCount}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ color: "#d46b08" }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8} xl={5}>
          <Card hoverable className="stat-card-clickable" onClick={() => setChartOpen(true)}>
            <Statistic
              title={
                <span>
                  今日激活数量
                  <span style={{ color: "#1677ff", fontSize: 12, marginLeft: 6 }}>点击查看趋势</span>
                </span>
              }
              value={stats.todayActivated}
              prefix={<CalendarOutlined />}
              valueStyle={{ color: "#1677ff" }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8} xl={5}>
          <Card>
            <Statistic title="已绑定设备数" value={stats.totalDevices} prefix={<DesktopOutlined />} />
          </Card>
        </Col>
      </Row>

      <ProTable<LicenseKey>
        actionRef={actionRef}
        rowKey="id"
        columns={resizableColumns}
        components={{ header: { cell: ResizableTitle } }}
        scroll={{ x: "max-content" }}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys as number[]),
        }}
        request={async (params) => {
          const res = await fetchKeys({
            current: params.current,
            pageSize: params.pageSize,
            keyCode: params.keyCode,
            name: params.name,
            status: params.status,
            agentId: params.agentId,
            licenseType: params.licenseType,
          });
          loadStats();
          return { data: res.data, success: res.success, total: res.total };
        }}
        toolBarRender={() => [
          <Popconfirm
            key="batch-del"
            title={`确定删除选中的 ${selectedRowKeys.length} 把密钥？设备记录也会一起删掉。`}
            disabled={!selectedRowKeys.length}
            onConfirm={async () => {
              try {
                const res = await deleteKeysBatch(selectedRowKeys);
                if (res.success) {
                  message.success(`已删除 ${res.deleted || selectedRowKeys.length} 把密钥`);
                  setSelectedRowKeys([]);
                  actionRef.current?.reload();
                  loadStats();
                  loadAgents();
                } else {
                  message.error(res.message || "删除失败");
                }
              } catch (e: any) {
                message.error(e?.response?.data?.message || e.message || "删除失败");
              }
            }}
          >
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length}>
              批量删除{selectedRowKeys.length ? ` (${selectedRowKeys.length})` : ""}
            </Button>
          </Popconfirm>,
          <Button
            key="batch"
            onClick={() => {
              batchForm.resetFields();
              batchForm.setFieldsValue({ count: 10, maxDevices: 3, validDays: 7, licenseType: "manual" });
              setBatchOpen(true);
            }}
          >
            批量生成
          </Button>,
          <Button key="create" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            创建密钥
          </Button>,
        ]}
        search={{ labelWidth: "auto" }}
      />

      {/* 创建密钥 */}
      <Modal
        title="创建密钥"
        open={createOpen}
        width={520}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const values = await form.validateFields();
          const payload = {
            ...values,
            validDays: values.validDays || 0,
            expiryDate: "",
          };
          try {
            const res = await createKey(payload);
            if (res.success) {
              message.success(`创建成功: ${res.data.keyCode}`);
              setCreateOpen(false);
              form.resetFields();
              actionRef.current?.reload();
              loadStats();
              loadAgents();
            } else {
              message.error(res.message || "创建失败");
            }
          } catch (e: any) {
            message.error(e?.response?.data?.message || e.message || "创建失败");
          }
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ maxDevices: 3, validDays: 7, licenseType: "manual" }}>
          <Form.Item name="licenseType" label="授权类型" tooltip="选试用后，这把密钥只给闲鱼试用商品用；正式同理。普通就是手动密钥。">
            <Select options={LICENSE_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="name" label="备注名(给哪个客户)">
            <Input placeholder="例如：张三-团队版" />
          </Form.Item>
          <Form.Item label="展示头像预览">
            <Avatar size={64} src={resolveUrl(createAvatar) || undefined} icon={<UserOutlined />} />
          </Form.Item>
          <Form.Item name="nickname" label="展示昵称" tooltip="该订阅码下所有设备统一显示这个昵称">
            <Input placeholder="同事在金十页面看到的名字" />
          </Form.Item>
          <Form.Item name="avatar" label="展示头像URL" tooltip="该订阅码下所有设备统一用这个头像；留空则用全局默认头像">
            <Input placeholder="https://... 或 /uploads/..." />
          </Form.Item>
          <Form.Item label="或上传头像">
            <Upload accept="image/*" maxCount={1} showUploadList={false} customRequest={makeUploader(form, setUploadingCreate)}>
              <Button icon={<UploadOutlined />} loading={uploadingCreate}>
                {uploadingCreate ? "上传中..." : "选择文件"}
              </Button>
            </Upload>
          </Form.Item>
          <Form.Item name="maxDevices" label="最多登录设备数" tooltip="超过该数量的新设备登录会被拒绝" rules={[{ required: true }]}>
            <InputNumber min={1} max={50} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="agentId" label="关联分类" tooltip="选中后这把密钥算该分类的客户">
            <Select allowClear placeholder="不选 = 未关联" options={agentOptions} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="cardId" label="分配卡密" tooltip="选一张卡密给这个密钥；不选=使用全局默认卡密。客户设备激活时后台自动从卡密的token里分名额">
            <Select
              allowClear
              placeholder="不选 = 使用默认卡密"
              options={tokenOptions}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <LicenseDurationHint form={form} />
          <Form.Item name="customerName" label="客户名字">
            <Input placeholder="客户名字（可空）" />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="phone" label="电话" style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="可不填" />
            </Form.Item>
            <Form.Item name="wechat" label="微信" style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="可不填" />
            </Form.Item>
            <Form.Item name="qq" label="QQ" style={{ flex: 1 }}>
              <Input placeholder="可不填" />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑密钥 */}
      <Modal
        title="编辑密钥"
        open={!!editing}
        width={520}
        onCancel={() => setEditing(null)}
        onOk={async () => {
          const values = await editForm.validateFields();
          if (!editing) return;
          try {
            const res = await updateKey(editing.id, {
              ...values,
              cardId: values.cardId ?? null,
              agentId: values.agentId ?? null,
              validDays: values.validDays ?? editing.validDays ?? 0,
              expiryDate: editing.activated
                ? (values.expiryDate ? values.expiryDate.format("YYYY-MM-DD HH:mm:ss") : "")
                : "",
            });
            if (res.success === false) {
              message.error(res.message || "保存失败");
              return;
            }
            message.success("已保存");
            setEditing(null);
            actionRef.current?.reload();
            loadAgents();
          } catch (e: any) {
            message.error(e?.response?.data?.message || e.message || "保存失败");
          }
        }}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="licenseType" label="授权类型" tooltip="试用给闲鱼试用商品用，正式给正式商品用。已发出或已激活的密钥不建议改类型。">
            <Select options={LICENSE_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="name" label="备注名">
            <Input />
          </Form.Item>
          <Form.Item label="展示头像预览">
            <Avatar size={64} src={resolveUrl(editAvatar) || undefined} icon={<UserOutlined />} />
          </Form.Item>
          <Form.Item name="nickname" label="展示昵称" tooltip="该订阅码下所有设备统一显示这个昵称">
            <Input placeholder="同事在金十页面看到的名字" />
          </Form.Item>
          <Form.Item name="avatar" label="展示头像URL" tooltip="该订阅码下所有设备统一用这个头像；留空则用全局默认头像">
            <Input placeholder="https://... 或 /uploads/..." />
          </Form.Item>
          <Form.Item label="或上传头像">
            <Upload accept="image/*" maxCount={1} showUploadList={false} customRequest={makeUploader(editForm, setUploadingEdit)}>
              <Button icon={<UploadOutlined />} loading={uploadingEdit}>
                {uploadingEdit ? "上传中..." : "选择文件"}
              </Button>
            </Upload>
          </Form.Item>
          <Form.Item name="maxDevices" label="最多登录设备数" rules={[{ required: true }]}>
            <InputNumber min={1} max={50} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="agentId" label="关联分类" tooltip="选中后这把密钥算该分类的客户">
            <Select allowClear placeholder="不选 = 未关联" options={agentOptions} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="cardId" label="分配卡密" tooltip="选一张卡密；清空=使用全局默认卡密">
            <Select
              allowClear
              placeholder="不选 = 使用默认卡密"
              options={tokenOptions}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          {editing && editing.activated ? (
            <Form.Item name="expiryDate" label="到期时间(已激活，留空=永久)">
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
          ) : (
            <LicenseDurationHint form={editForm} />
          )}
          <Form.Item name="customerName" label="客户名字">
            <Input placeholder="客户名字（可空）" />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="phone" label="电话" style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="可不填" />
            </Form.Item>
            <Form.Item name="wechat" label="微信" style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="可不填" />
            </Form.Item>
            <Form.Item name="qq" label="QQ" style={{ flex: 1 }}>
              <Input placeholder="可不填" />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批量生成 */}
      <Modal
        title="批量生成密钥"
        open={batchOpen}
        confirmLoading={batching}
        width={520}
        okText="生成"
        onCancel={() => setBatchOpen(false)}
        onOk={async () => {
          const values = await batchForm.validateFields();
          setBatching(true);
          try {
            const res = await createKeysBatch({
              count: values.count,
              nickname: values.nickname || "",
              avatar: values.avatar || "",
              maxDevices: values.maxDevices,
              validDays: values.validDays || 0,
              licenseType: values.licenseType || "manual",
              cardId: values.cardId ?? null,
              agentId: values.agentId ?? null,
            });
            if (res.success && res.data) {
              setBatchOpen(false);
              batchForm.resetFields();
              setBatchResult(res.data.map((k) => k.keyCode));
              actionRef.current?.reload();
              loadStats();
              loadAgents();
            } else {
              message.error(res.message || "生成失败");
            }
          } catch (e: any) {
            message.error(e?.response?.data?.message || e.message || "生成失败");
          } finally {
            setBatching(false);
          }
        }}
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical" initialValues={{ count: 10, maxDevices: 3, validDays: 7, licenseType: "manual" }}>
          <Form.Item name="count" label="数量" rules={[{ required: true }]}>
            <InputNumber min={1} max={200} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="licenseType" label="授权类型" tooltip="批量生成试用或正式库存时在这里选。列表里会显示对应标签。">
            <Select options={LICENSE_TYPE_OPTIONS} />
          </Form.Item>
          <LicenseDurationHint form={batchForm} />
          <Form.Item name="agentId" label="关联分类" tooltip="本批密钥全部挂到这个分类">
            <Select allowClear placeholder="不选 = 未关联" options={agentOptions} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item label="展示头像预览">
            <Avatar size={64} src={resolveUrl(batchAvatar) || undefined} icon={<UserOutlined />} />
          </Form.Item>
          <Form.Item name="nickname" label="展示昵称">
            <Input placeholder="整批共用，可留空" />
          </Form.Item>
          <Form.Item name="avatar" label="展示头像URL">
            <Input placeholder="整批共用，可留空" />
          </Form.Item>
          <Form.Item label="或上传头像">
            <Upload accept="image/*" maxCount={1} showUploadList={false} customRequest={makeUploader(batchForm, setUploadingBatch)}>
              <Button icon={<UploadOutlined />} loading={uploadingBatch}>
                {uploadingBatch ? "上传中..." : "选择文件"}
              </Button>
            </Upload>
          </Form.Item>
          <Form.Item name="maxDevices" label="最多登录设备数" rules={[{ required: true }]}>
            <InputNumber min={1} max={50} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="cardId" label="分配卡密">
            <Select allowClear placeholder="不选 = 使用默认卡密" options={tokenOptions} showSearch optionFilterProp="label" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`已生成 ${batchResult.length} 把密钥`}
        open={batchResult.length > 0}
        onCancel={() => setBatchResult([])}
        footer={[
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={async () => {
              const text = batchResult.join("\n");
              try {
                await navigator.clipboard.writeText(text);
                message.success("已复制全部密钥");
              } catch {
                const ta = document.createElement("textarea");
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                message.success("已复制全部密钥");
              }
            }}
          >
            复制全部
          </Button>,
          <Button key="ok" onClick={() => setBatchResult([])}>
            关闭
          </Button>,
        ]}
      >
        <pre
          style={{
            fontFamily: "monospace",
            fontSize: 13,
            lineHeight: 1.8,
            background: "#f6f7f9",
            padding: 12,
            borderRadius: 8,
            maxHeight: 360,
            overflow: "auto",
            margin: 0,
            whiteSpace: "pre",
          }}
        >
          {batchResult.join("\n")}
        </pre>
      </Modal>

      <ActivationChart open={chartOpen} onClose={() => setChartOpen(false)} />

      <PendingChart open={pendingOpen} onClose={() => setPendingOpen(false)} />

      <DeviceDrawer
        keyId={deviceDrawer?.id ?? null}
        keyName={deviceDrawer?.name ?? ""}
        open={!!deviceDrawer}
        onClose={() => setDeviceDrawer(null)}
      />
    </div>
  );
}

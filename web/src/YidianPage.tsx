import { type Key, useEffect, useRef, useState } from "react";
import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Radio,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  message,
} from "antd";
import { KeyOutlined, PlusOutlined, ScanOutlined, UserOutlined } from "@ant-design/icons";
import { api, fetchAgents, resolveUrl, type AgentItem } from "./api";

type Account = {
  account: string;
  hasPassword: boolean;
  lastPollAt?: string;
  lastError?: string;
};
type Shop = {
  id: number;
  name: string;
  shopId: string;
  trialGoodsId: string;
  formalGoodsIds: string[];
  enabled: boolean;
  ignoreBefore?: string;
  defaultNickname: string;
  defaultAgentId: number | null;
  maxDevices: number;
  note: string;
  trialStock: number;
  formalStock: number;
  createdAt: string;
};
type ShopKey = {
  id: number;
  keyCode: string;
  licenseType: string;
  status: string;
  nickname: string;
  note: string;
  createdAt: string;
  used: boolean;
};
type KeyDefaults = { nickname: string; avatar: string; agentId: number | null; maxDevices: number };
type ScannedProduct = {
  key: string;
  goodsId: string;
  shopId: string;
  shopName: string;
  name: string;
  image: string;
  lastSeenAt: string;
  orderCount: number;
  configured: boolean;
  configuredAs: "" | "trial" | "formal";
  shopConfigured: boolean;
};

function splitGoods(text: string) {
  return String(text || "")
    .split(/[\s,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function YidianPage() {
  const actionRef = useRef<ActionType | undefined>(undefined);
  const [accountForm] = Form.useForm();
  const [shopForm] = Form.useForm();
  const [genForm] = Form.useForm();
  const [importForm] = Form.useForm();
  const [account, setAccount] = useState<Account>();
  const [stock, setStock] = useState({ trial: 0, formal: 0 });
  const [defaults, setDefaults] = useState({ shopId: "", trialGoodsId: "", formalGoodsIds: [] as string[] });
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [shopOpen, setShopOpen] = useState(false);
  const [editing, setEditing] = useState<Shop | null>(null);
  const [vault, setVault] = useState<Shop | null>(null);
  const [vaultKeys, setVaultKeys] = useState<ShopKey[]>([]);
  const [vaultDefaults, setVaultDefaults] = useState<KeyDefaults>();
  const [genOpen, setGenOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [plans, setPlans] = useState<any[]>([]);
  const [dryMeta, setDryMeta] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [scannedProducts, setScannedProducts] = useState<ScannedProduct[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Key[]>([]);
  const [scanKind, setScanKind] = useState<"trial" | "formal">("formal");
  const [scanMeta, setScanMeta] = useState("");

  const reload = async () => {
    const { data } = await api.get("/admin/yidian");
    setAccount(data.account);
    setStock(data.stock || { trial: 0, formal: 0 });
    setDefaults(data.defaults || defaults);
    accountForm.setFieldsValue({ account: data.account?.account || "", password: "" });
    actionRef.current?.reload();
    if (vault) await openVault(vault.id, false);
  };
  const openVault = async (id: number, show = true) => {
    const { data } = await api.get(`/admin/yidian/shops/${id}/keys`);
    setVault(data.shop);
    setVaultKeys(data.data || []);
    setVaultDefaults(data.defaults);
    if (show) setVault(data.shop);
  };

  useEffect(() => {
    void reload().catch(() => message.error("读取易店助手配置失败"));
    void fetchAgents().then((res) => setAgents(res.data || [])).catch(() => undefined);
  }, []);

  const saveAccount = async (values: { account: string; password?: string }) => {
    setBusy(true);
    try {
      await api.put("/admin/yidian", values);
      message.success("易店账号已保存");
      await reload();
    } catch (error: any) {
      message.error(error?.response?.data?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const inspect = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/yidian/inspect");
      const r = data.result || {};
      setDryMeta(`待发货 ${r.count ?? 0} 笔 / 易店原自动发货 ${r.nativeAutoShipping ?? "—"}`);
      setPlans((r.samples || []).map((s: any, i: number) => ({ key: i, ...s, action: s.kind, reason: s.matchedShop ? (s.skippedAsOld ? "历史单" : "已匹配") : "未配置店铺" })));
      message.success("已连接易店助手并读取待发货订单");
    } catch (error: any) {
      message.error(error?.response?.data?.message || "连接失败");
    } finally {
      setBusy(false);
    }
  };
  const dryRun = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/yidian/dry-run");
      const r = data.result || {};
      setPlans(r.plans || []);
      setDryMeta(`待发货 ${r.count ?? 0} 笔 / 开关打开后将处理 ${r.wouldShipIfOn ?? 0} 笔 / 当前会发 ${r.wouldShip ?? 0} 笔 / 试用库存 ${r.stock?.trial ?? 0} / 正式库存 ${r.stock?.formal ?? 0}`);
      message.success("演练完成，未调用发货接口");
      await reload();
    } catch (error: any) {
      message.error(error?.response?.data?.message || "演练失败");
    } finally {
      setBusy(false);
    }
  };
  const scanProducts = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/yidian/products/scan");
      const result = data.result || {};
      setScannedProducts(result.products || []);
      setSelectedProducts([]);
      setScanMeta(`已从 ${result.orderCount ?? 0} 笔易店订单中识别 ${(result.products || []).length} 个商品`);
      setScanOpen(true);
      message.success("商品扫描完成");
    } catch (error: any) {
      message.error(error?.response?.data?.message || "商品扫描失败");
    } finally {
      setBusy(false);
    }
  };
  const applyScanned = async () => {
    const picked = scannedProducts.filter((item) => selectedProducts.includes(item.key));
    if (!picked.length) return message.warning("请先选择商品");
    if (scanKind === "trial" && picked.length !== 1) return message.warning("试用商品一次只能选择一个");
    const unconfigured = picked.find((item) => !item.shopConfigured);
    if (unconfigured) return message.warning(`请先创建店铺 ${unconfigured.shopName}`);
    setBusy(true);
    try {
      const { data } = await api.post("/admin/yidian/products/apply", {
        items: picked.map((item) => ({ shopId: item.shopId, goodsId: item.goodsId, kind: scanKind })),
      });
      message.success(`已更新 ${data.result?.changed ?? 0} 个商品配置，自动发货开关未改变`);
      setScanOpen(false);
      await reload();
    } catch (error: any) {
      message.error(error?.response?.data?.message || "添加商品失败");
    } finally {
      setBusy(false);
    }
  };
  const disableNative = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/yidian/disable-native");
      message.success(`易店原自动发货已关闭（当前值 ${data.result?.automaticShipping}）`);
    } catch (error: any) {
      message.error(error?.response?.data?.message || "关闭失败");
    } finally {
      setBusy(false);
    }
  };
  const saveShop = async () => {
    const values = await shopForm.validateFields();
    const payload = { ...values, formalGoodsIds: splitGoods(values.formalGoodsIds) };
    if (editing) await api.put(`/admin/yidian/shops/${editing.id}`, payload);
    else await api.post("/admin/yidian/shops", payload);
    message.success(editing ? "店铺已更新" : "店铺已创建，自动发货默认关闭");
    setShopOpen(false);
    setEditing(null);
    await reload();
  };
  const toggleShop = async (shop: Shop, enabled: boolean) => {
    await api.put(`/admin/yidian/shops/${shop.id}/enabled`, { enabled });
    message.success(enabled ? `已打开「${shop.name}」自动发货` : `已关闭「${shop.name}」自动发货`);
    await reload();
  };
  const generateNow = async (trialCount: number, formalCount: number) => {
    if (!vault) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/admin/yidian/shops/${vault.id}/keys/generate`, { trialCount, formalCount });
      message.success(`已按默认信息创建 ${data.created} 个密钥`);
      setGenOpen(false);
      await openVault(vault.id);
      actionRef.current?.reload();
    } catch (error: any) {
      message.error(error?.response?.data?.message || "生成失败");
    } finally {
      setBusy(false);
    }
  };
  const importNow = async () => {
    if (!vault) return;
    const values = await importForm.validateFields();
    setBusy(true);
    try {
      const { data } = await api.post(`/admin/yidian/shops/${vault.id}/keys/import`, values);
      message.success(`导入 ${data.imported} 个，跳过重复 ${data.skipped} 个`);
      setImportOpen(false);
      importForm.resetFields();
      await openVault(vault.id);
      actionRef.current?.reload();
    } catch (error: any) {
      message.error(error?.response?.data?.message || "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const columns: ProColumns<Shop>[] = [
    { title: "店铺名称", dataIndex: "name", width: 160, ellipsis: true },
    { title: "闲鱼会员名", dataIndex: "shopId", width: 180, copyable: true },
    {
      title: "自动发货",
      dataIndex: "enabled",
      width: 110,
      render: (_, r) => (
        <Switch
          checked={r.enabled}
          checkedChildren="开"
          unCheckedChildren="关"
          onChange={(checked) => {
            if (checked) {
              Modal.confirm({
                title: "打开自动发货？",
                content: `将按「${r.name}」的待发货订单自动发卡。请确认该店密钥库存已备好。`,
                okText: "打开",
                onOk: () => toggleShop(r, true),
              });
              return;
            }
            void toggleShop(r, false);
          }}
        />
      ),
    },
    {
      title: "试用库存",
      dataIndex: "trialStock",
      width: 90,
      render: (v) => <Tag color={Number(v) > 2 ? "green" : "orange"}>{String(v)}</Tag>,
    },
    {
      title: "正式库存",
      dataIndex: "formalStock",
      width: 90,
      render: (v) => <Tag color={Number(v) > 2 ? "green" : "orange"}>{String(v)}</Tag>,
    },
    { title: "试用商品", dataIndex: "trialGoodsId", ellipsis: true, width: 140 },
    {
      title: "正式商品",
      dataIndex: "formalGoodsIds",
      ellipsis: true,
      render: (_, r) => r.formalGoodsIds.join("、"),
    },
    {
      title: "操作",
      valueType: "option",
      width: 180,
      render: (_, r) => [
        <a key="keys" onClick={() => void openVault(r.id)}>密钥库</a>,
        <a
          key="edit"
          onClick={() => {
            setEditing(r);
            shopForm.setFieldsValue({ ...r, formalGoodsIds: r.formalGoodsIds.join("\n") });
            setShopOpen(true);
          }}
        >
          编辑
        </a>,
        <Popconfirm
          key="del"
          title="删除店铺后，密钥会变成未关联，确定？"
          onConfirm={async () => {
            await api.delete(`/admin/yidian/shops/${r.id}`);
            message.success("已删除");
            actionRef.current?.reload();
          }}
        >
          <a style={{ color: "red" }}>删除</a>
        </Popconfirm>,
      ],
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>易店助手发货</h2>
      <Alert
        type="info"
        showIcon
        message="每家店单独开关。密钥库可一键按默认头像、昵称、分类生成，也可直接粘贴导入，不必再到密钥管理里复制。"
        style={{ marginBottom: 16 }}
      />
      {account?.lastError ? <Alert type="warning" showIcon message={account.lastError} style={{ marginBottom: 16 }} /> : null}

      <Space style={{ marginBottom: 16 }} wrap>
        <Card size="small"><Statistic title="未使用试用密钥" value={stock.trial} /></Card>
        <Card size="small"><Statistic title="未使用正式密钥" value={stock.formal} /></Card>
        <Card size="small"><Statistic title="最近轮询" value={account?.lastPollAt || "—"} /></Card>
      </Space>

      <Card title="易店账号" style={{ marginBottom: 16 }}>
        <Form form={accountForm} layout="inline" onFinish={saveAccount}>
          <Form.Item name="account" label="账号" rules={[{ required: true }]}><Input style={{ width: 180 }} /></Form.Item>
          <Form.Item name="password" label="密码"><Input.Password placeholder={account?.hasPassword ? "已保存，留空不改" : "请输入"} style={{ width: 180 }} /></Form.Item>
          <Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={busy}>保存账号</Button>
              <Button onClick={() => void inspect()} loading={busy}>只读测试</Button>
              <Button onClick={() => void dryRun()} loading={busy}>演练</Button>
              <Button danger onClick={() => void disableNative()} loading={busy}>关闭易店原自动发货</Button>
            </Space>
          </Form.Item>
        </Form>
        {dryMeta ? <div style={{ marginTop: 12, color: "#666" }}>{dryMeta}</div> : null}
        {plans.length ? (
          <Table
            size="small"
            style={{ marginTop: 12 }}
            pagination={false}
            dataSource={plans}
            rowKey={(r) => String(r.orderId || r.key || Math.random())}
            columns={[
              { title: "订单", dataIndex: "orderId", ellipsis: true },
              { title: "店铺", dataIndex: "shopId", width: 160 },
              { title: "动作", dataIndex: "action", width: 140 },
              { title: "说明", dataIndex: "reason", ellipsis: true },
            ]}
          />
        ) : null}
      </Card>

      <ProTable<Shop>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        search={false}
        pagination={false}
        request={async () => {
          const { data } = await api.get("/admin/yidian");
          setAccount(data.account);
          setStock(data.stock || { trial: 0, formal: 0 });
          return { data: data.shops || [], success: true, total: (data.shops || []).length };
        }}
        toolBarRender={() => [
          <Button key="scan" icon={<ScanOutlined />} loading={busy} onClick={() => void scanProducts()}>
            扫描闲鱼商品
          </Button>,
          <Button
            key="create"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              shopForm.resetFields();
              shopForm.setFieldsValue({
                shopId: defaults.shopId,
                trialGoodsId: defaults.trialGoodsId,
                formalGoodsIds: (defaults.formalGoodsIds || []).join("\n"),
                maxDevices: 3,
                defaultNickname: "王子",
                defaultAgentId: agents.find((a) => a.name === "程莉")?.id,
              });
              setShopOpen(true);
            }}
          >
            创建店铺
          </Button>,
        ]}
      />

      <Modal
        title="扫描到的闲鱼商品"
        open={scanOpen}
        width={980}
        okText={scanKind === "formal" ? "添加为正式商品" : "设为试用商品"}
        cancelText="关闭"
        confirmLoading={busy}
        onOk={() => void applyScanned()}
        onCancel={() => setScanOpen(false)}
      >
        <Alert
          type="info"
          showIcon
          message={scanMeta}
          description="扫描来源为易店助手订单历史；没有产生过订单的新商品暂时不会出现。已配置商品不会重复添加。"
          style={{ marginBottom: 12 }}
        />
        <Space style={{ marginBottom: 12 }}>
          <span>添加类型：</span>
          <Radio.Group value={scanKind} onChange={(e) => setScanKind(e.target.value)}>
            <Radio.Button value="formal">正式商品</Radio.Button>
            <Radio.Button value="trial">试用商品</Radio.Button>
          </Radio.Group>
          <span style={{ color: "#888" }}>已选 {selectedProducts.length} 个</span>
        </Space>
        <Table<ScannedProduct>
          size="small"
          rowKey="key"
          scroll={{ y: 480 }}
          pagination={{ pageSize: 10 }}
          dataSource={scannedProducts}
          rowSelection={{
            selectedRowKeys: selectedProducts,
            onChange: setSelectedProducts,
            getCheckboxProps: (record) => ({ disabled: record.configured || !record.shopConfigured }),
          }}
          columns={[
            {
              title: "图片",
              dataIndex: "image",
              width: 72,
              render: (value: string) => value
                ? <Avatar shape="square" size={48} src={resolveUrl(value)} />
                : <Avatar shape="square" size={48} icon={<UserOutlined />} />,
            },
            { title: "商品名称", dataIndex: "name", ellipsis: true },
            { title: "商品 ID", dataIndex: "goodsId", width: 140 },
            {
              title: "店铺",
              dataIndex: "shopName",
              width: 170,
              render: (_: string, row) => <span>{row.shopName}<br /><small>{row.shopId}</small></span>,
            },
            { title: "订单数", dataIndex: "orderCount", width: 75 },
            { title: "最近出现", dataIndex: "lastSeenAt", width: 165 },
            {
              title: "状态",
              dataIndex: "configuredAs",
              width: 110,
              render: (value: string, row) => value
                ? <Tag color="green">已配置{value === "trial" ? "试用" : "正式"}</Tag>
                : (row.shopConfigured ? <Tag>未配置</Tag> : <Tag color="orange">店铺未创建</Tag>),
            },
          ]}
        />
      </Modal>

      <Modal
        title={editing ? "编辑店铺" : "创建店铺"}
        open={shopOpen}
        onCancel={() => { setShopOpen(false); setEditing(null); }}
        onOk={() => void saveShop().catch((error: any) => message.error(error?.response?.data?.message || "保存失败"))}
        destroyOnClose
      >
        <Form form={shopForm} layout="vertical">
          <Form.Item name="name" label="店铺名称" rules={[{ required: true }]}><Input placeholder="例如：一号店" /></Form.Item>
          <Form.Item name="shopId" label="闲鱼会员名" rules={[{ required: true }]}><Input placeholder="xy 开头的会员名" /></Form.Item>
          <Form.Item name="trialGoodsId" label="试用商品 ID" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="formalGoodsIds" label="正式商品 ID（每行一个）" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="defaultNickname" label="默认昵称"><Input placeholder="一键生成密钥时使用，可留空用店铺名" /></Form.Item>
          <Form.Item name="defaultAgentId" label="默认分类">
            <Select allowClear placeholder="一键生成时关联分类" options={agents.map((a) => ({ value: a.id, label: a.name }))} />
          </Form.Item>
          <Form.Item name="maxDevices" label="默认设备数"><InputNumber min={1} max={99} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={vault ? `密钥库 · ${vault.name}` : "密钥库"}
        width={760}
        open={Boolean(vault)}
        onClose={() => setVault(null)}
      >
        {vault ? (
          <>
            <Alert
              type="info"
              showIcon
              message="一键生成会用全局默认头像、本店默认昵称/分类/设备数，直接创建试用和正式库存，不必再到密钥管理里复制。"
              style={{ marginBottom: 16 }}
            />
            <Space style={{ marginBottom: 16 }} wrap>
              <Button icon={<KeyOutlined />} type="primary" loading={busy} onClick={() => void generateNow(5, 5)}>
                一键生成
              </Button>
              <Button onClick={() => { genForm.setFieldsValue({ trialCount: 5, formalCount: 5 }); setGenOpen(true); }}>
                自定义数量
              </Button>
              <Button onClick={() => setImportOpen(true)}>批量导入</Button>
            </Space>
            <Space style={{ marginBottom: 16 }} wrap>
              <Card size="small"><Statistic title="试用库存" value={vault.trialStock} /></Card>
              <Card size="small"><Statistic title="正式库存" value={vault.formalStock} /></Card>
              <Card size="small">
                <Space>
                  <Avatar src={resolveUrl(vaultDefaults?.avatar)} icon={<UserOutlined />} />
                  <div>
                    <div>默认昵称：{vaultDefaults?.nickname || vault.name}</div>
                    <div style={{ color: "#999", fontSize: 12 }}>设备数 {vaultDefaults?.maxDevices || vault.maxDevices}</div>
                  </div>
                </Space>
              </Card>
            </Space>
            <Table
              size="small"
              rowKey="id"
              dataSource={vaultKeys}
              pagination={{ pageSize: 12 }}
              columns={[
                { title: "密钥", dataIndex: "keyCode", ellipsis: true },
                {
                  title: "类型",
                  dataIndex: "licenseType",
                  width: 80,
                  render: (v) => <Tag color={v === "trial" ? "blue" : v === "formal" ? "gold" : "default"}>{v === "trial" ? "试用" : v === "formal" ? "正式" : v}</Tag>,
                },
                {
                  title: "状态",
                  dataIndex: "used",
                  width: 80,
                  render: (used, r) => used ? <Tag>已占用</Tag> : r.status === "active" ? <Tag color="green">库存</Tag> : <Tag>{r.status}</Tag>,
                },
                { title: "昵称", dataIndex: "nickname", width: 120, ellipsis: true },
                { title: "创建时间", dataIndex: "createdAt", width: 170 },
              ]}
            />
          </>
        ) : null}
      </Drawer>

      <Modal
        title="按默认信息生成密钥"
        open={genOpen}
        onCancel={() => setGenOpen(false)}
        onOk={() => {
          const values = genForm.getFieldsValue();
          void generateNow(Number(values.trialCount || 0), Number(values.formalCount || 0));
        }}
        confirmLoading={busy}
      >
        <p>将使用全局默认头像、本店默认昵称和分类，直接创建并挂到当前店铺。</p>
        <Form form={genForm} layout="vertical">
          <Form.Item name="trialCount" label="试用数量"><InputNumber min={0} max={200} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="formalCount" label="正式数量"><InputNumber min={0} max={200} style={{ width: "100%" }} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title="批量导入密钥"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void importNow().catch((error: any) => message.error(error?.response?.data?.message || "导入失败"))}
        confirmLoading={busy}
      >
        <Form form={importForm} layout="vertical" initialValues={{ licenseType: "trial" }}>
          <Form.Item name="licenseType" label="类型" rules={[{ required: true }]}>
            <Select options={[{ value: "trial", label: "试用" }, { value: "formal", label: "正式" }]} />
          </Form.Item>
          <Form.Item name="keys" label="密钥（换行或逗号分隔）" rules={[{ required: true, message: "请粘贴密钥" }]}>
            <Input.TextArea rows={8} placeholder={"#YKB-xxxx\n#YKB-yyyy"} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

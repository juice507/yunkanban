import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Alert, Avatar, Button, Card, Input, Modal, Popconfirm, Select, Space, Statistic, Switch, Table, Tag, message } from "antd";
import { AppstoreOutlined, MessageOutlined, ReloadOutlined, ShopOutlined, ShoppingCartOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { api, resolveUrl } from "./api";
import "./YidianWorkspace.css";

type Shop = { id: number; name: string; shopId: string; enabled: boolean; trialStock: number; formalStock: number; trialGoodsId: string; formalGoodsIds: string[]; updatedAt: string };
type Product = { key: string; goodsId: string; shopId: string; shopName: string; name: string; image: string; orderCount: number; lastSeenAt: string; configuredAs: string; shopConfigured: boolean };
type Order = { orderId: string; name: string; image: string; shopId: string; goodsId: string; pay: string; status: number; payTime: string; buyerName: string; quantity: number; sentAt: string };
type ReplyShop = { shopId: string; name: string; display: string };
type AutoReply = { id: number; keys: string; data: string; type: string; status: number; goods_id: string; match: string; reply_type: string; system_message: string; scope: number; nick_ids: string; exclude_goods: string };
type ReplyDraft = { id?: number; replyType: number; keyword: string; match: number; replyText: string; scope: number; shopIds: string[]; goodsIds: string; excludeGoods: string; enabled: boolean };

const emptyReplyDraft = (): ReplyDraft => ({ replyType: 0, keyword: "", match: 1, replyText: "", scope: 0, shopIds: [], goodsIds: "", excludeGoods: "", enabled: true });
const parseList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.map(String) : Object.keys(parsed || {}); }
  catch { return String(value).split(/[\s,;，；]+/).filter(Boolean); }
};

const sections = [
  { key: "shops", label: "店铺", icon: <ShopOutlined /> },
  { key: "products", label: "商品", icon: <AppstoreOutlined /> },
  { key: "orders", label: "订单", icon: <ShoppingCartOutlined /> },
  { key: "replies", label: "自动回复", icon: <MessageOutlined /> },
  { key: "delivery", label: "发货设置", icon: <ThunderboltOutlined /> },
] as const;

export default function YidianWorkspace() {
  const location = useLocation();
  const requestedSection = location.pathname.split("/")[2];
  const section = sections.find((item) => item.key === requestedSection)?.key || "shops";
  const [shops, setShops] = useState<Shop[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<string>("");
  const [productPickerShop, setProductPickerShop] = useState<Shop | null>(null);
  const [selectedFormalIds, setSelectedFormalIds] = useState<string[]>([]);
  const [selectedTrialId, setSelectedTrialId] = useState<string>("");
  const [replies, setReplies] = useState<AutoReply[]>([]);
  const [replyShops, setReplyShops] = useState<ReplyShop[]>([]);
  const [replyCount, setReplyCount] = useState(0);
  const [replyDraft, setReplyDraft] = useState<ReplyDraft | null>(null);
  const [replyProductsLoading, setReplyProductsLoading] = useState(false);
  const refreshReplyProducts = async () => {
    setReplyProductsLoading(true);
    try {
      const { data } = await api.post("/admin/yidian/products/scan");
      setProducts(data.result?.products || []);
    } catch (error: any) { message.error(error?.response?.data?.message || "读取商品失败，请点击刷新商品重试"); }
    finally { setReplyProductsLoading(false); }
  };
  useEffect(() => {
    if (replyDraft?.scope === 1 && !products.length) void refreshReplyProducts();
  }, [Boolean(replyDraft), replyDraft?.scope]);
  const replyProductOptions = useMemo(() => {
    const selected = parseList(replyDraft?.goodsIds);
    const options = new Map<string, { value: string; label: string; product?: Product }>();
    for (const product of products) {
      if (replyDraft?.shopIds.length && !replyDraft.shopIds.includes(product.shopId) && !selected.includes(product.goodsId)) continue;
      if (!options.has(product.goodsId)) options.set(product.goodsId, {
        value: product.goodsId,
        label: `${product.name} · ${product.shopName} · ${product.goodsId}`,
        product,
      });
    }
    for (const id of selected) {
      if (!options.has(id)) options.set(id, { value: id, label: `已绑定商品 · ${id}` });
    }
    return [...options.values()];
  }, [products, replyDraft?.goodsIds, replyDraft?.shopIds]);

  const loadShops = async () => {
    const { data } = await api.get("/admin/yidian");
    setShops(data.shops || []);
  };
  const loadProducts = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/admin/yidian/products/scan");
      setProducts(data.result?.products || []);
    } catch (error: any) { message.error(error?.response?.data?.message || "读取商品失败"); }
    finally { setLoading(false); }
  };
  const loadOrders = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/yidian/orders", { params: { status, keyword, limit: 50 } });
      setOrders(data.result?.rows || []);
    } catch (error: any) { message.error(error?.response?.data?.message || "读取订单失败"); }
    finally { setLoading(false); }
  };
  const loadReplies = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/yidian/replies", { params: { keyword, limit: 100 } });
      setReplies(data.result?.list || []);
      setReplyShops(data.result?.shops || []);
      setReplyCount(Number(data.result?.count || 0));
    } catch (error: any) { message.error(error?.response?.data?.message || "读取自动回复失败"); }
    finally { setLoading(false); }
  };
  const openReplyEditor = async (row?: AutoReply) => {
    if (!row) { setReplyDraft(emptyReplyDraft()); return; }
    setLoading(true);
    try {
      const { data } = await api.get(`/admin/yidian/replies/${row.id}`);
      const info = data.result?.info || {};
      setReplyDraft({
        id: row.id,
        replyType: Number(info.reply_type ?? row.reply_type ?? 0),
        keyword: String(info.keyword || row.keys || ""),
        match: Number(info.match ?? row.match ?? 1),
        replyText: String(info.reply_txt || row.data || ""),
        scope: Number(info.scope ?? row.scope ?? 0),
        shopIds: parseList(info.nick_ids ?? row.nick_ids),
        goodsIds: (info.recommend_list || parseList(row.goods_id).map((goods_id: string) => ({ goods_id }))).map((item: any) => String(item.goods_id)).join("\n"),
        excludeGoods: parseList(info.exclude_list ?? row.exclude_goods).join("\n"),
        enabled: Number(info.is_show ?? row.status ?? 1) === 1,
      });
    } catch (error: any) { message.error(error?.response?.data?.message || "读取规则失败"); }
    finally { setLoading(false); }
  };
  const saveReply = async () => {
    if (!replyDraft) return;
    if (replyDraft.replyType === 0 && !replyDraft.keyword.trim()) return message.warning("请输入关键词");
    if (!replyDraft.replyText.trim()) return message.warning("请输入回复内容");
    setLoading(true);
    try {
      await api.post("/admin/yidian/replies", { ...replyDraft, type: 1 });
      message.success(replyDraft.id ? "自动回复已更新" : "自动回复已添加");
      setReplyDraft(null);
      await loadReplies();
    } catch (error: any) { message.error(error?.response?.data?.message || "保存失败"); }
    finally { setLoading(false); }
  };
  const toggleReply = async (row: AutoReply, enabled: boolean) => {
    try {
      await api.put(`/admin/yidian/replies/${row.id}/status`, { enabled });
      message.success(enabled ? "已开启自动回复" : "已关闭自动回复");
      await loadReplies();
    } catch (error: any) { message.error(error?.response?.data?.message || "更新失败"); }
  };
  const removeReply = async (row: AutoReply) => {
    try {
      await api.delete(`/admin/yidian/replies/${row.id}`);
      message.success("已删除");
      await loadReplies();
    } catch (error: any) { message.error(error?.response?.data?.message || "删除失败"); }
  };
  const toggleDelivery = async (shop: Shop, enabled: boolean) => {
    try {
      await api.put(`/admin/yidian/shops/${shop.id}/enabled`, { enabled });
      message.success(enabled ? `已开启「${shop.name}」自动发货` : `已关闭「${shop.name}」自动发货`);
      await loadShops();
    } catch (error: any) { message.error(error?.response?.data?.message || "更新失败"); }
  };
  const openProductPicker = async (shop: Shop) => {
    let rows = products;
    if (!rows.length) {
      setLoading(true);
      try {
        const { data } = await api.post("/admin/yidian/products/scan");
        rows = data.result?.products || [];
        setProducts(rows);
      } catch (error: any) {
        message.error(error?.response?.data?.message || "读取商品失败");
        return;
      } finally { setLoading(false); }
    }
    setSelectedFormalIds(shop.formalGoodsIds || []);
    setSelectedTrialId(shop.trialGoodsId || "");
    setProductPickerShop(shop);
  };
  const saveProductSelection = async () => {
    if (!productPickerShop) return;
    if (!selectedTrialId) return message.warning("请选择一个试用商品");
    setLoading(true);
    try {
      await api.put(`/admin/yidian/shops/${productPickerShop.id}/products`, { trialGoodsId: selectedTrialId, formalGoodsIds: selectedFormalIds });
      message.success("自动发货商品已保存");
      setProductPickerShop(null);
      await loadShops();
    } catch (error: any) { message.error(error?.response?.data?.message || "保存失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadShops(); }, []);
  useEffect(() => {
    if (section === "products" && !products.length) void loadProducts();
    if (section === "orders" && !orders.length) void loadOrders();
    if (section === "replies" && !replies.length) void loadReplies();
    if (section === "replies" && !products.length) void refreshReplyProducts();
  }, [section]);

  const visibleProducts = useMemo(() => products.filter((item) => !keyword || `${item.name}${item.goodsId}${item.shopName}`.toLowerCase().includes(keyword.toLowerCase())), [products, keyword]);
  const title = sections.find((item) => item.key === section)?.label || "店铺";

  return (
    <div className="yd-workspace">
      <main className="yd-main">
        <div className="yd-page-title"><div><h2>{title}管理</h2><p>闲鱼店铺、商品、订单与自动发货统一管理</p></div><Tag color="blue">易店助手已连接</Tag></div>

        {section !== "delivery" ? <Card className="yd-filter-card" bordered={false}>
          <Space wrap size={14}>
            {section === "orders" ? <Select value={status} onChange={setStatus} style={{ width: 180 }} options={[{ value: "", label: "全部订单状态" }, { value: "1", label: "待发货" }, { value: "2", label: "已发货" }]} /> : null}
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} allowClear placeholder={section === "shops" ? "搜索店铺名称或会员名" : section === "products" ? "搜索商品名称或 ID" : section === "replies" ? "搜索关键词或回复内容" : "搜索订单或商品"} style={{ width: 300 }} />
            <Button type="primary" onClick={() => section === "products" ? void loadProducts() : section === "orders" ? void loadOrders() : section === "replies" ? void loadReplies() : void loadShops()}>查询</Button>
            <Button icon={<ReloadOutlined />} onClick={() => section === "products" ? void loadProducts() : section === "orders" ? void loadOrders() : section === "replies" ? void loadReplies() : void loadShops()}>刷新</Button>
          </Space>
        </Card> : null}

        {section === "shops" ? <Card className="yd-list-card" bordered={false} title="全部店铺" extra={<span>共 {shops.length} 家</span>}>
          <Table rowKey="id" loading={loading} pagination={false} dataSource={shops.filter((s) => !keyword || `${s.name}${s.shopId}`.toLowerCase().includes(keyword.toLowerCase()))} columns={[
            { title: "ID", dataIndex: "id", width: 70 },
            { title: "头像", width: 80, render: (_, row) => <Avatar size={46} style={{ background: "#e8f1ff", color: "#1677ff" }}>{row.name.slice(0, 1)}</Avatar> },
            { title: "店铺昵称", dataIndex: "name", render: (value) => <span className="yd-shop-name">{value}<Tag color="purple">鱼小铺</Tag></span> },
            { title: "会员名", dataIndex: "shopId" },
            { title: "账号状态", render: () => <Tag color="success">正常</Tag> },
            { title: "授权状态", render: () => <Tag color="green">在线</Tag> },
            { title: "自动发货", render: (_, row) => <Switch checked={row.enabled} checkedChildren="开启" unCheckedChildren="关闭" disabled /> },
            { title: "试用库存", dataIndex: "trialStock" },
            { title: "正式库存", dataIndex: "formalStock" },
          ]} />
        </Card> : null}

        {section === "products" ? <Card className="yd-list-card" bordered={false} title="商品列表" extra={<Button type="primary" icon={<ReloadOutlined />} onClick={() => void loadProducts()}>扫描商品</Button>}>
          <Table rowKey="key" loading={loading} dataSource={visibleProducts} pagination={{ pageSize: 15 }} columns={[
            { title: "商品图片", width: 90, render: (_, row) => <Avatar shape="square" size={56} src={row.image ? resolveUrl(row.image) : undefined}>{row.name.slice(0, 1)}</Avatar> },
            { title: "商品名称", dataIndex: "name", ellipsis: true },
            { title: "商品 ID", dataIndex: "goodsId", width: 150 },
            { title: "所属店铺", dataIndex: "shopName", width: 180 },
            { title: "订单数", dataIndex: "orderCount", width: 90 },
            { title: "最近订单", dataIndex: "lastSeenAt", width: 180 },
            { title: "发货配置", width: 120, render: (_, row) => row.configuredAs ? <Tag color="success">{row.configuredAs === "trial" ? "试用商品" : "正式商品"}</Tag> : <Tag color="warning">未配置</Tag> },
          ]} />
        </Card> : null}

        {section === "orders" ? <Card className="yd-list-card" bordered={false} title="订单列表" extra={<span>当前显示 {orders.length} 条</span>}>
          <Table rowKey="orderId" loading={loading} dataSource={orders} pagination={{ pageSize: 15 }} columns={[
            { title: "商品", width: 320, render: (_, row) => <div className="yd-product-cell"><Avatar shape="square" size={50} src={row.image ? resolveUrl(row.image) : undefined} /><div><strong>{row.name || row.goodsId}</strong><small>{row.goodsId}</small></div></div> },
            { title: "订单号", dataIndex: "orderId", ellipsis: true },
            { title: "店铺", dataIndex: "shopId", width: 160 },
            { title: "金额", dataIndex: "pay", width: 90, render: (v) => `¥${v || "0"}` },
            { title: "数量", dataIndex: "quantity", width: 70 },
            { title: "状态", width: 100, render: (_, row) => row.status === 1 ? <Tag color="warning">待发货</Tag> : <Tag color="success">已处理</Tag> },
            { title: "付款时间", dataIndex: "payTime", width: 180 },
          ]} />
        </Card> : null}

        {section === "replies" ? <Card className="yd-list-card" bordered={false} title="自动回复规则" extra={<Space><span>共 {replyCount} 条</span><Button type="primary" icon={<MessageOutlined />} onClick={() => void openReplyEditor()}>添加自动回复</Button></Space>}>
          <Alert type="info" showIcon message="规则保存后会直接同步到易店助手；请确保对应鱼店已在易店助手中开启自动回复。" style={{ marginBottom: 18 }} />
          <Table rowKey="id" loading={loading} dataSource={replies} pagination={{ pageSize: 20 }} scroll={{ x: 1250 }} columns={[
            { title: "ID", dataIndex: "id", width: 80 },
            { title: "关键词", dataIndex: "keys", width: 150, render: (value, row) => <Tag color="blue">{Number(row.reply_type) === 1 ? "首次回复" : value || "系统消息"}</Tag> },
            { title: "类型", width: 90, render: (_, row) => Number(row.reply_type) === 1 ? "首次" : Number(row.reply_type) === 2 ? "系统" : "关键词" },
            { title: "触发规则", width: 100, render: (_, row) => Number(row.match) === 2 ? "精确匹配" : "包含" },
            { title: "绑定商品", width: 300, render: (_, row) => { const ids = parseList(row.goods_id); const shopIds = parseList(row.nick_ids); return ids.length ? <Space direction="vertical" style={{ width: "100%" }}>{ids.map((id) => {
              const product = products.find((item) => item.goodsId === id && (!shopIds.length || shopIds.includes(item.shopId))) || products.find((item) => item.goodsId === id);
              return <div key={id} className="yd-product-cell"><Avatar shape="square" size={42} src={product?.image ? resolveUrl(product.image) : undefined}>{product?.name?.slice(0, 1) || "商"}</Avatar><div title={product?.name || id}><strong>{product?.name || (replyProductsLoading ? "正在读取商品…" : "未获取到商品名称")}</strong><small>{product?.shopName ? `${product.shopName} · ` : ""}{id}</small></div></div>;
            })}</Space> : <span className="yd-empty">全部商品</span>; } },
            { title: "指定店铺", width: 180, render: (_, row) => { const ids = parseList(row.nick_ids); return ids.length ? ids.map((id) => <Tag color="gold" key={id}>{id}</Tag>) : <span className="yd-empty">全部店铺</span>; } },
            { title: "回复内容", dataIndex: "data", ellipsis: true, width: 280 },
            { title: "状态", width: 100, fixed: "right", render: (_, row) => <Switch checked={Number(row.status) === 1} checkedChildren="开启" unCheckedChildren="关闭" onChange={(checked) => void toggleReply(row, checked)} /> },
            { title: "操作", width: 130, fixed: "right", render: (_, row) => <Space><a onClick={() => void openReplyEditor(row)}>编辑</a><Popconfirm title="确定删除这条自动回复？" onConfirm={() => void removeReply(row)}><a style={{ color: "#ff4d4f" }}>删除</a></Popconfirm></Space> },
          ]} />
        </Card> : null}

        {section === "delivery" ? <div className="yd-delivery">
          <div className="yd-stats"><Card><Statistic title="店铺数量" value={shops.length} /></Card><Card><Statistic title="自动发货已开启" value={shops.filter((s) => s.enabled).length} /></Card><Card><Statistic title="试用密钥库存" value={shops.reduce((n, s) => n + s.trialStock, 0)} /></Card><Card><Statistic title="正式密钥库存" value={shops.reduce((n, s) => n + s.formalStock, 0)} /></Card></div>
          <Card className="yd-list-card" bordered={false} title="店铺自动发货" extra={<Button icon={<ReloadOutlined />} onClick={() => void loadShops()}>刷新库存</Button>}>
            <Alert type="info" showIcon message="每个店铺单独设置。点击“选择自动发货商品”，可通过多选决定哪些商品参与自动发货。" style={{ marginBottom: 18 }} />
            <Table rowKey="id" pagination={false} dataSource={shops} scroll={{ x: 1100 }} columns={[
              { title: "店铺名称", dataIndex: "name", width: 190, render: (value, row) => <div><strong>{value}</strong><small className="yd-member-id">{row.shopId}</small></div> },
              { title: "自动发货", width: 120, render: (_, row) => <Switch checked={row.enabled} checkedChildren="开启" unCheckedChildren="关闭" onChange={(checked) => void toggleDelivery(row, checked)} /> },
              { title: "试用库存", dataIndex: "trialStock", width: 110, render: (value) => <Tag color={Number(value) > 0 ? "success" : "error"}>{value}</Tag> },
              { title: "正式库存", dataIndex: "formalStock", width: 110, render: (value) => <Tag color={Number(value) > 0 ? "success" : "error"}>{value}</Tag> },
              { title: "试用商品", width: 150, render: (_, row) => <span>{row.trialGoodsId || "未选择"}</span> },
              { title: "正式商品", render: (_, row) => row.formalGoodsIds?.length ? <Space wrap size={[4, 4]}>{row.formalGoodsIds.map((id) => <Tag key={id}>{id}</Tag>)}</Space> : <span className="yd-empty">尚未选择</span> },
              { title: "操作", width: 190, fixed: "right", render: (_, row) => <Button type="primary" onClick={() => void openProductPicker(row)}>选择自动发货商品</Button> },
            ]} />
          </Card>
        </div> : null}
      </main>
      <Modal title={productPickerShop ? `选择自动发货商品 · ${productPickerShop.name}` : "选择自动发货商品"} open={Boolean(productPickerShop)} width={920} okText="保存选择" cancelText="取消" confirmLoading={loading} onOk={() => void saveProductSelection()} onCancel={() => setProductPickerShop(null)}>
        <Alert type="warning" showIcon message="试用商品只能选 1 个；正式商品可以勾选多个。取消勾选并保存后，该商品将不再参与自动发货。" style={{ marginBottom: 16 }} />
        <div className="yd-picker-row"><span>试用商品：</span><Select value={selectedTrialId || undefined} onChange={setSelectedTrialId} placeholder="选择一个试用商品" showSearch optionFilterProp="label" style={{ width: 520 }} options={products.filter((item) => item.shopId === productPickerShop?.shopId).map((item) => ({ value: item.goodsId, label: `${item.name}（${item.goodsId}）` }))} /></div>
        <div className="yd-picker-label">正式商品（可多选）</div>
        <Table<Product> size="small" rowKey="goodsId" pagination={{ pageSize: 8 }} dataSource={products.filter((item) => item.shopId === productPickerShop?.shopId && item.goodsId !== selectedTrialId)} rowSelection={{ selectedRowKeys: selectedFormalIds, onChange: (keys) => setSelectedFormalIds(keys.map(String)) }} columns={[
          { title: "图片", width: 76, render: (_, row) => <Avatar shape="square" size={46} src={row.image ? resolveUrl(row.image) : undefined}>{row.name.slice(0, 1)}</Avatar> },
          { title: "商品名称", dataIndex: "name", ellipsis: true },
          { title: "商品 ID", dataIndex: "goodsId", width: 150 },
          { title: "历史订单", dataIndex: "orderCount", width: 100 },
          { title: "最近出现", dataIndex: "lastSeenAt", width: 180 },
        ]} />
      </Modal>
      <Modal title={replyDraft?.id ? "编辑自动回复" : "添加自动回复"} open={Boolean(replyDraft)} width={720} okText="保存规则" cancelText="取消" confirmLoading={loading} onOk={() => void saveReply()} onCancel={() => setReplyDraft(null)}>
        {replyDraft ? <div className="yd-reply-form">
          <div className="yd-picker-row"><span>回复类型：</span><Select value={replyDraft.replyType} onChange={(value) => setReplyDraft({ ...replyDraft, replyType: value, keyword: value === 1 ? "首次回复" : "" })} style={{ width: 260 }} options={[{ value: 0, label: "关键词回复" }, { value: 1, label: "首次回复" }]} /></div>
          {replyDraft.replyType === 0 ? <><div className="yd-picker-label">关键词（多个关键词用 | 分隔）</div><Input value={replyDraft.keyword} onChange={(event) => setReplyDraft({ ...replyDraft, keyword: event.target.value })} placeholder="例如：价格|怎么用|有教程吗" /></> : null}
          {replyDraft.replyType === 0 ? <div className="yd-picker-row"><span>匹配方式：</span><Select value={replyDraft.match} onChange={(value) => setReplyDraft({ ...replyDraft, match: value })} style={{ width: 260 }} options={[{ value: 1, label: "包含关键词" }, { value: 2, label: "完全一致" }]} /></div> : null}
          <div className="yd-picker-label">回复内容</div><Input.TextArea rows={5} maxLength={500} showCount value={replyDraft.replyText} onChange={(event) => setReplyDraft({ ...replyDraft, replyText: event.target.value })} placeholder="输入发给买家的文字" />
          <div className="yd-picker-row"><span>适用范围：</span><Select value={replyDraft.scope} onChange={(value) => setReplyDraft({ ...replyDraft, scope: value })} style={{ width: 260 }} options={[{ value: 0, label: "全部店铺和商品" }, { value: 1, label: "指定店铺 / 商品" }]} /></div>
          {replyDraft.scope === 1 ? <>
            <div className="yd-picker-label">指定店铺（可多选）</div><Select mode="multiple" value={replyDraft.shopIds} onChange={(value) => setReplyDraft({ ...replyDraft, shopIds: value })} placeholder="选择店铺" style={{ width: "100%" }} options={replyShops.map((shop) => ({ value: shop.shopId, label: shop.display || `${shop.name} (${shop.shopId})` }))} />
            <div className="yd-picker-label"><Space>绑定商品（可多选）<Button size="small" icon={<ReloadOutlined />} loading={replyProductsLoading} onClick={() => void refreshReplyProducts()}>刷新商品</Button></Space></div>
            <Select
              mode="multiple"
              showSearch
              allowClear
              maxTagCount="responsive"
              loading={replyProductsLoading}
              value={parseList(replyDraft.goodsIds)}
              onChange={(ids: string[]) => setReplyDraft({ ...replyDraft, goodsIds: ids.join("\n") })}
              optionFilterProp="label"
              placeholder="搜索商品名称、店铺或 ID，点击勾选多个商品"
              style={{ width: "100%" }}
              options={replyProductOptions}
              tagRender={({ value, label, closable, onClose }) => {
                const product = products.find((item) => item.goodsId === String(value));
                return <Tag closable={closable} onClose={onClose} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%", margin: 3 }}><Avatar shape="square" size={24} src={product?.image ? resolveUrl(product.image) : undefined}>{product?.name?.slice(0, 1) || "商"}</Avatar><span style={{ maxWidth: 330, overflow: "hidden", textOverflow: "ellipsis" }} title={String(label)}>{product?.name || label}</span></Tag>;
              }}
              notFoundContent={replyProductsLoading ? "正在加载商品…" : "没有匹配商品，可刷新商品或调整店铺筛选"}
              optionRender={(option) => {
                const product = option.data.product;
                return product ? <div className="yd-product-cell"><Avatar shape="square" size={40} src={product.image ? resolveUrl(product.image) : undefined}>{product.name.slice(0, 1)}</Avatar><div><strong>{product.name}</strong><small>{product.shopName} · {product.goodsId}</small></div></div> : <span>{option.label}</span>;
              }}
            />
            <div style={{ color: "#94a3b8", margin: "8px 0 16px" }}>已选择 {parseList(replyDraft.goodsIds).length} 个商品。选择店铺后按店铺筛选；已有绑定会保留。商品来自订单历史，尚无订单的新品可能暂未显示。</div>
          </> : null}
          <div className="yd-picker-label">排除商品 ID（可选）</div><Input.TextArea rows={2} value={replyDraft.excludeGoods} onChange={(event) => setReplyDraft({ ...replyDraft, excludeGoods: event.target.value })} placeholder="匹配到规则后，这些商品不触发回复" />
          <div className="yd-picker-row"><span>启用规则：</span><Switch checked={replyDraft.enabled} onChange={(checked) => setReplyDraft({ ...replyDraft, enabled: checked })} /></div>
        </div> : null}
      </Modal>
    </div>
  );
}

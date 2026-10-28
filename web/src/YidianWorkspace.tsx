import { useEffect, useMemo, useState } from "react";
import { Alert, Avatar, Button, Card, Input, Modal, Select, Space, Statistic, Switch, Table, Tag, message } from "antd";
import { AppstoreOutlined, ReloadOutlined, ShopOutlined, ShoppingCartOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { api, resolveUrl } from "./api";
import "./YidianWorkspace.css";

type Shop = { id: number; name: string; shopId: string; enabled: boolean; trialStock: number; formalStock: number; trialGoodsId: string; formalGoodsIds: string[]; updatedAt: string };
type Product = { key: string; goodsId: string; shopId: string; shopName: string; name: string; image: string; orderCount: number; lastSeenAt: string; configuredAs: string; shopConfigured: boolean };
type Order = { orderId: string; name: string; image: string; shopId: string; goodsId: string; pay: string; status: number; payTime: string; buyerName: string; quantity: number; sentAt: string };

const sections = [
  { key: "shops", label: "店铺", icon: <ShopOutlined /> },
  { key: "products", label: "商品", icon: <AppstoreOutlined /> },
  { key: "orders", label: "订单", icon: <ShoppingCartOutlined /> },
  { key: "delivery", label: "发货设置", icon: <ThunderboltOutlined /> },
] as const;

export default function YidianWorkspace() {
  const [section, setSection] = useState<(typeof sections)[number]["key"]>("shops");
  const [shops, setShops] = useState<Shop[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<string>("");
  const [productPickerShop, setProductPickerShop] = useState<Shop | null>(null);
  const [selectedFormalIds, setSelectedFormalIds] = useState<string[]>([]);
  const [selectedTrialId, setSelectedTrialId] = useState<string>("");

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
  }, [section]);

  const visibleProducts = useMemo(() => products.filter((item) => !keyword || `${item.name}${item.goodsId}${item.shopName}`.toLowerCase().includes(keyword.toLowerCase())), [products, keyword]);
  const title = sections.find((item) => item.key === section)?.label || "店铺";

  return (
    <div className="yd-workspace">
      <aside className="yd-subnav">
        <div className="yd-subnav-title">易店助手</div>
        {sections.map((item) => <button key={item.key} className={section === item.key ? "active" : ""} onClick={() => { setKeyword(""); setSection(item.key); }}>{item.icon}<span>{item.label}</span></button>)}
      </aside>
      <main className="yd-main">
        <div className="yd-page-title"><div><h2>{title}管理</h2><p>闲鱼店铺、商品、订单与自动发货统一管理</p></div><Tag color="blue">易店助手已连接</Tag></div>

        {section !== "delivery" ? <Card className="yd-filter-card" bordered={false}>
          <Space wrap size={14}>
            {section === "orders" ? <Select value={status} onChange={setStatus} style={{ width: 180 }} options={[{ value: "", label: "全部订单状态" }, { value: "1", label: "待发货" }, { value: "2", label: "已发货" }]} /> : null}
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} allowClear placeholder={section === "shops" ? "搜索店铺名称或会员名" : section === "products" ? "搜索商品名称或 ID" : "搜索订单或商品"} style={{ width: 300 }} />
            <Button type="primary" onClick={() => section === "products" ? void loadProducts() : section === "orders" ? void loadOrders() : void loadShops()}>查询</Button>
            <Button icon={<ReloadOutlined />} onClick={() => section === "products" ? void loadProducts() : section === "orders" ? void loadOrders() : void loadShops()}>刷新</Button>
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
    </div>
  );
}

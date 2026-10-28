import { useEffect, useRef, useState } from "react";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns, ActionType } from "@ant-design/pro-components";
import { Button, Tag, Modal, Form, Input, message, Popconfirm, Typography, Space, Select } from "antd";
import { PlusOutlined, StarFilled, ThunderboltOutlined } from "@ant-design/icons";
import {
  fetchCards,
  createCard,
  mintToken,
  refreshCard,
  updateCard,
  deleteCard,
  deleteToken,
  pullTokenCookie,
  pullCardCookie,
  fetchSettings,
  updateSettings,
  type CardItem,
  type TokenSub,
} from "./api";

function fmtExpiry(v: string) {
  if (!v) return "";
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
}
function mask(v: string, head = 6, tail = 4) {
  if (!v || v.length <= head + tail) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

export default function CardsPage() {
  const actionRef = useRef<ActionType | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CardItem | null>(null);
  const [defaultCardId, setDefaultCardId] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const loadDefault = async () => {
    const res = await fetchSettings();
    if (res.success) setDefaultCardId(res.data.defaultCardId);
  };
  useEffect(() => {
    loadDefault();
  }, []);

  const setAsDefault = async (id: number | null) => {
    await updateSettings({ defaultCardId: id });
    setDefaultCardId(id);
    message.success(id ? "已设为默认卡密" : "已取消默认");
  };

  const doMint = async (card: CardItem) => {
    setBusy(card.id);
    try {
      const res = await mintToken(card.id);
      if (res.success) message.success("已生成一个新 Token");
      else message.error(res.message || "生成失败");
      actionRef.current?.reload();
    } finally {
      setBusy(null);
    }
  };

  // 展开行: 显示这张卡密下的 token 明细 + 名额
  const expandedRowRender = (card: CardItem) => {
    const cols: ProColumns<TokenSub>[] = [
      { title: "#", dataIndex: "id", width: 60 },
      {
        title: "Token",
        dataIndex: "token",
        render: (_, t) => (
          <Typography.Text copyable={{ text: t.token }} style={{ fontFamily: "monospace" }}>
            {mask(t.token, 8, 4)}
          </Typography.Text>
        ),
      },
      {
        title: "Cookie",
        dataIndex: "hasCookie",
        width: 220,
        render: (_, t) =>
          t.hasCookie ? (
            <Space direction="vertical" size={0}>
              <Tag color="green">已保存 {t.cookieCount} 条</Tag>
              <span style={{ color: "#888", fontSize: 12 }}>
                {t.cookieNick || "—"} · x-token {t.cookieXtokenExp || "?"}
              </span>
              <span style={{ color: "#888", fontSize: 12 }}>拉取 {t.cookiePulledAt || "—"}</span>
            </Space>
          ) : (
            <Tag>未拉取</Tag>
          ),
      },
      {
        title: "关联设备",
        dataIndex: "deviceCount",
        width: 90,
        render: (_, t) => `${t.deviceCount} 台`,
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 80,
        render: (_, t) => <Tag color={t.status === "active" ? "green" : "default"}>{t.status === "active" ? "正常" : "停用"}</Tag>,
      },
      {
        title: "操作",
        width: 140,
        render: (_, t) => (
          <Space>
            <a
              onClick={async () => {
                setBusy(t.id);
                try {
                  const res = await pullTokenCookie(t.id);
                  if (res.success) message.success("Cookie 已保存");
                  else message.error(res.message || "拉取失败");
                  actionRef.current?.reload();
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === t.id ? "拉取中…" : t.hasCookie ? "刷新Cookie" : "拉取Cookie"}
            </a>
            <Popconfirm
              title="删除后占用它的设备下次激活会重新分配，确定？"
              onConfirm={async () => {
                await deleteToken(t.id);
                message.success("已删除该 token");
                actionRef.current?.reload();
              }}
            >
              <a style={{ color: "red" }}>删除</a>
            </Popconfirm>
          </Space>
        ),
      },
    ];
    return (
      <ProTable<TokenSub>
        rowKey="id"
        columns={cols}
        dataSource={card.tokens}
        search={false}
        options={false}
        pagination={false}
        size="small"
      />
    );
  };

  const columns: ProColumns<CardItem>[] = [
    {
      title: "备注/来源",
      dataIndex: "label",
      render: (_, r) => (
        <Space>
          {r.id === defaultCardId && (
            <Tag color="gold" icon={<StarFilled />}>
              默认
            </Tag>
          )}
          <span>{r.label || <span style={{ color: "#999" }}>(未命名)</span>}</span>
        </Space>
      ),
    },
    {
      title: "第三方卡密",
      dataIndex: "providerCode",
      render: (_, r) => (
        <Typography.Text copyable={{ text: r.providerCode }} style={{ fontFamily: "monospace" }}>
          {mask(r.providerCode)}
        </Typography.Text>
      ),
    },
    {
      title: "Token数",
      dataIndex: "tokenCount",
      width: 90,
      render: (_, r) => <Tag color="blue">{r.tokenCount}</Tag>,
    },
    {
      title: "Cookie",
      dataIndex: "cookieReady",
      width: 130,
      render: (_, r) => (
        <Tag color={r.cookieReady > 0 ? "green" : "orange"}>
          {r.cookieReady} / {r.tokenCount} 已存
        </Tag>
      ),
    },
    {
      title: "关联设备",
      dataIndex: "usedDevices",
      width: 100,
      render: (_, r) => `${r.usedDevices} 台`,
    },
    { title: "产品", dataIndex: "product", width: 90 },
    { title: "第三方到期", dataIndex: "expiryDate", width: 110, render: (_, r) => fmtExpiry(r.expiryDate) || "—" },
    {
      title: "被引用",
      dataIndex: "assignedCount",
      width: 100,
      render: (_, r) => <Tag color={r.assignedCount ? "blue" : "default"}>{r.assignedCount} 个密钥</Tag>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 80,
      render: (_, r) => <Tag color={r.status === "active" ? "green" : "default"}>{r.status === "active" ? "正常" : "停用"}</Tag>,
    },
    {
      title: "操作",
      valueType: "option",
      width: 320,
      render: (_, r) => [
        <a
          key="pull"
          onClick={async () => {
            setBusy(r.id);
            try {
              const res = await pullCardCookie(r.id);
              if (res.success) message.success(res.message || "Cookie 已保存");
              else message.error(res.message || "拉取失败");
              actionRef.current?.reload();
            } finally {
              setBusy(null);
            }
          }}
          style={{ pointerEvents: busy === r.id ? "none" : "auto", opacity: busy === r.id ? 0.5 : 1 }}
        >
          {busy === r.id ? "拉取中…" : "拉取Cookie"}
        </a>,
        <a
          key="mint"
          onClick={() => doMint(r)}
          style={{ pointerEvents: busy === r.id ? "none" : "auto", opacity: busy === r.id ? 0.5 : 1 }}
        >
          生成Token
        </a>,
        <a
          key="refresh"
          onClick={async () => {
            const res = await refreshCard(r.id);
            if (res.success) message.success("已刷新");
            else message.error(res.message || "刷新失败");
            actionRef.current?.reload();
          }}
        >
          刷新
        </a>,
        <a
          key="edit"
          onClick={() => {
            setEditing(r);
            editForm.setFieldsValue({ label: r.label, note: r.note, status: r.status });
          }}
        >
          编辑
        </a>,
        r.id === defaultCardId ? (
          <a key="undefault" onClick={() => setAsDefault(null)}>
            取消默认
          </a>
        ) : (
          <a key="default" onClick={() => setAsDefault(r.id)}>
            设为默认
          </a>
        ),
        <Popconfirm
          key="del"
          title="删除整张卡密(含其所有token)，引用它的密钥将变为未分配，确定？"
          onConfirm={async () => {
            await deleteCard(r.id);
            message.success("已删除");
            loadDefault();
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
      <ProTable<CardItem>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        search={false}
        pagination={false}
        options={{ reload: true, density: false, setting: false }}
        scroll={{ x: 1300 }}
        headerTitle="卡密池（Token 下保存金十 Cookie，新插件直接注入，旧插件仍用 Token）"
        expandable={{ expandedRowRender }}
        request={async () => {
          const res = await fetchCards();
          return { data: res.data || [], success: res.success };
        }}
        toolBarRender={() => [
          <Button
            key="add"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setCreateOpen(true);
            }}
          >
            添加卡密
          </Button>,
        ]}
      />

      <Modal
        title="添加第三方卡密"
        open={createOpen}
        confirmLoading={creating}
        okText="解析并入池"
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          setCreating(true);
          try {
            const res = await createCard(v);
            if (res.success) {
              message.success("已入池（已自动生成第 1 个 Token）");
              setCreateOpen(false);
              actionRef.current?.reload();
            } else {
              message.error(res.message || "解析失败");
            }
          } finally {
            setCreating(false);
          }
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="providerCode"
            label="第三方卡密/订单号"
            rules={[{ required: true, message: "请粘贴第三方卡密" }]}
            tooltip="入池后会自动生成第 1 个 Token 并拉取 Cookie"
          >
            <Input placeholder="如 4NVap-fGiY1-zEgza-mJtiK" />
          </Form.Item>
          <Form.Item name="label" label="备注/来源">
            <Input placeholder="例如：主号-A" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑卡密"
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={async () => {
          const v = await editForm.validateFields();
          if (!editing) return;
          await updateCard(editing.id, v);
          message.success("已保存");
          setEditing(null);
          actionRef.current?.reload();
        }}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="label" label="备注/来源">
            <Input />
          </Form.Item>
          <Form.Item name="status" label="状态" tooltip="停用后，分配到它的密钥激活将拿不到登录态">
            <Select
              options={[
                { value: "active", label: "正常" },
                { value: "disabled", label: "停用" },
              ]}
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <div style={{ marginTop: 12, color: "#999", fontSize: 12 }}>
        <ThunderboltOutlined /> Cookie 存在对应 Token 上。新版金十助手只从本后台拿 Cookie 注入，不再每台设备去打第三方；旧版插件不受影响，仍用 Token。点「拉取Cookie」可手动刷新登录态。
      </div>
    </div>
  );
}

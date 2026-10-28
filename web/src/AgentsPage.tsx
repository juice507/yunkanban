import { useRef, useState } from "react";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns, ActionType } from "@ant-design/pro-components";
import { Button, Modal, Form, Input, InputNumber, message, Popconfirm, Progress, Switch, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { fetchAgents, createAgent, updateAgent, deleteAgent, type AgentItem } from "./api";

export default function AgentsPage() {
  const actionRef = useRef<ActionType | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AgentItem | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const columns: ProColumns<AgentItem>[] = [
    {
      title: "名字",
      dataIndex: "name",
      width: 200,
      render: (_, r) => (
        <span>
          {r.name}
          {r.isTest && <Tag color="orange" style={{ marginLeft: 8 }}>测试分类</Tag>}
        </span>
      ),
    },
    {
      title: "客户服务数量",
      dataIndex: "capacity",
      search: false,
      width: 220,
      render: (_, r) => {
        const cap = r.capacity || 0;
        const used = r.used || 0;
        const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
        return (
          <div>
            <div>
              {used} / {cap > 0 ? cap : "不限"}
            </div>
            {cap > 0 && (
              <Progress
                percent={pct}
                size="small"
                status={used >= cap ? "exception" : "active"}
                showInfo={false}
              />
            )}
          </div>
        );
      },
    },
    {
      title: "备注",
      dataIndex: "note",
      search: false,
      ellipsis: true,
      render: (v) => v || <span style={{ color: "#999" }}>—</span>,
    },
    { title: "创建时间", dataIndex: "createdAt", search: false, width: 170 },
    {
      title: "操作",
      valueType: "option",
      width: 140,
      render: (_, r) => [
        <a
          key="edit"
          onClick={() => {
            setEditing(r);
            editForm.setFieldsValue({ name: r.name, capacity: r.capacity, note: r.note, isTest: r.isTest });
          }}
        >
          编辑
        </a>,
        <Popconfirm
          key="del"
          title="删除后，该分类下的密钥会变成未关联，确定？"
          onConfirm={async () => {
            await deleteAgent(r.id);
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
      <ProTable<AgentItem>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        search={false}
        request={async () => {
          const res = await fetchAgents();
          return { data: res.data || [], success: res.success, total: (res.data || []).length };
        }}
        toolBarRender={() => [
          <Button
            key="create"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setCreateOpen(true);
            }}
          >
            创建分类
          </Button>,
        ]}
      />

      <Modal
        title="创建分类"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          try {
            const res = await createAgent(v);
            if (res.success) {
              message.success("已创建");
              setCreateOpen(false);
              form.resetFields();
              actionRef.current?.reload();
            } else {
              message.error(res.message || "创建失败");
            }
          } catch (e: any) {
            message.error(e?.response?.data?.message || e.message || "创建失败");
          }
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ capacity: 10, isTest: false }}>
          <Form.Item name="name" label="名字" rules={[{ required: true, message: "请填写分类名字" }]}>
            <Input placeholder="例如：一区 / 测试" />
          </Form.Item>
          <Form.Item
            name="capacity"
            label="客户服务数量"
            tooltip="该分类最多可关联多少把密钥"
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={9999} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="isTest" label="测试分类" valuePropName="checked" tooltip="开启后，该分类下的密钥不计入激活总数、设备数等统计">
            <Switch checkedChildren="是" unCheckedChildren="否" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑分类"
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={async () => {
          if (!editing) return;
          const v = await editForm.validateFields();
          try {
            const res = await updateAgent(editing.id, v);
            if (res.success) {
              message.success("已保存");
              setEditing(null);
              actionRef.current?.reload();
            } else {
              message.error(res.message || "保存失败");
            }
          } catch (e: any) {
            message.error(e?.response?.data?.message || e.message || "保存失败");
          }
        }}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="名字" rules={[{ required: true, message: "请填写分类名字" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="capacity" label="客户服务数量" rules={[{ required: true }]}>
            <InputNumber min={1} max={9999} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="isTest" label="测试分类" valuePropName="checked" tooltip="开启后，该分类下的密钥不计入激活总数、设备数等统计">
            <Switch checkedChildren="是" unCheckedChildren="否" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

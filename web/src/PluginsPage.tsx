import { useEffect, useRef, useState } from "react";
import {
  Button,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  message,
  Typography,
  Upload,
  Collapse,
  Table,
  Space,
  Switch,
  Popconfirm,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, CopyOutlined, InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  fetchPlugins,
  uploadPlugin,
  updatePlugin,
  pluginDownloadUrl,
  fetchPluginReleases,
  savePluginRelease,
  pushPluginRelease,
  withdrawPluginRelease,
  type PluginRelease,
  type PluginFile,
  type PluginPlatform,
} from "./api";

const PLATFORMS: { value: PluginPlatform; label: string; color: string }[] = [
  { value: "pc", label: "电脑", color: "blue" },
  { value: "android", label: "安卓", color: "green" },
  { value: "ios", label: "苹果", color: "purple" },
  { value: "other", label: "其他", color: "default" },
];

function platformMeta(v: string) {
  return PLATFORMS.find((p) => p.value === v) || PLATFORMS[3];
}

// 从名称中提取版本号。每个版本一个折叠栏，未标版本的历史记录单独放最后。
function versionOf(p: PluginFile) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/i.exec(p.name || p.originalName || "");
  return match ? `v${match[1]}.${match[2]}.${match[3]}` : "未标版本";
}

function compareVersionsDesc(left: string, right: string) {
  if (left === "未标版本") return 1;
  if (right === "未标版本") return -1;
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return rightParts[index] - leftParts[index];
    }
  }
  return 0;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success("下载链接已复制，发给客户即可");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    message.success("下载链接已复制");
  }
}

export default function PluginsPage() {
  const [data, setData] = useState<PluginFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<PluginFile | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const activeKeys = useRef<string[] | null>(null);
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const [rels, setRels] = useState<Record<number, PluginRelease>>({});
  const [usage, setUsage] = useState<{ version: string; platform: string; c: number }[]>([]);
  const [relEditing, setRelEditing] = useState<PluginFile | null>(null);
  const [relForm] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const [res, rr] = await Promise.all([fetchPlugins(), fetchPluginReleases()]);
      const list = res.data || [];
      setData(list);
      const m: Record<number, PluginRelease> = {};
      for (const r of rr.data || []) m[r.plugin_id] = r;
      setRels(m);
      setUsage(rr.versionUsage || []);
      // 首次加载默认全部折叠, 按产品名点开对应一组
      if (activeKeys.current === null) {
        activeKeys.current = [];
        setOpenKeys([]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const columns: ColumnsType<PluginFile> = [
    {
      title: "名称",
      dataIndex: "name",
      render: (_, r) => r.name || <span style={{ color: "#999" }}>(未命名)</span>,
    },
    {
      title: "平台",
      dataIndex: "platform",
      width: 90,
      render: (_, r) => {
        const m = platformMeta(r.platform);
        return <Tag color={m.color}>{m.label}</Tag>;
      },
    },
    {
      title: "推送状态",
      key: "release",
      width: 150,
      render: (_, r) => {
        const rel = rels[r.id];
        if (!rel) return <span style={{ color: "#bbb" }}>旧版 · 不参与推送</span>;
        const tag = rel.status === "pushed" ? <Tag color="green">已推送</Tag> : rel.status === "withdrawn" ? <Tag>已撤回</Tag> : <Tag color="orange">草稿</Tag>;
        return <span>{tag}v{rel.version}{rel.force ? <Tag color="red" style={{ marginLeft: 4 }}>强制</Tag> : null}</span>;
      },
    },
    { title: "下载次数", dataIndex: "downloadCount", width: 90 },
    {
      title: "下载链接",
      dataIndex: "slug",
      width: 300,
      render: (_, r) => {
        const url = pluginDownloadUrl(r);
        return (
          <Typography.Text style={{ fontFamily: "monospace", fontSize: 12 }} ellipsis={{ tooltip: url }}>
            {url}
          </Typography.Text>
        );
      },
    },
    {
      title: "操作",
      key: "option",
      width: 320,
      render: (_, r) => (
        <Space size="middle">
          <a onClick={() => copy(pluginDownloadUrl(r))}>
            <CopyOutlined /> 复制链接
          </a>
          <a href={pluginDownloadUrl(r)} target="_blank" rel="noreferrer">
            下载
          </a>
          {rels[r.id] && rels[r.id].status !== "pushed" && (
            <Popconfirm title={`推送 v${rels[r.id].version}？`} description="推送后这个平台的新插件(1.2.0+)用户打开插件就会看到「一键更新」"
              onConfirm={async () => { const x = await pushPluginRelease(r.id); x.success ? message.success("已推送") : message.error(x.message || "推送失败"); load(); }}>
              <a style={{ color: "#16a36a", fontWeight: 600 }}>推送</a>
            </Popconfirm>
          )}
          {rels[r.id] && rels[r.id].status === "pushed" && (
            <Popconfirm title="撤回这个版本？" description="撤回后不再提示更新，回到上一个已推送版本"
              onConfirm={async () => { await withdrawPluginRelease(r.id); message.success("已撤回"); load(); }}>
              <a style={{ color: "#e5484d" }}>撤回</a>
            </Popconfirm>
          )}
          <a onClick={() => { setRelEditing(r); relForm.setFieldsValue({ version: rels[r.id]?.version || (versionOf(r) !== "未标版本" ? versionOf(r).slice(1) : ""), changelog: rels[r.id]?.changelog || "", force: !!rels[r.id]?.force }); }}>
            版本设置
          </a>
          <a
            onClick={() => {
              setEditing(r);
              editForm.setFieldsValue({ name: r.name, platform: r.platform, note: r.note });
            }}
          >
            编辑
          </a>
        </Space>
      ),
    },
  ];

  // 按版本分组，最新版在最上面；同一版本内按电脑、安卓、苹果排列。
  const groupMap = new Map<string, PluginFile[]>();
  for (const p of data) {
    const g = versionOf(p);
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g)!.push(p);
  }
  const groupNames = Array.from(groupMap.keys()).sort(compareVersionsDesc);
  const platformOrder: Record<string, number> = { pc: 0, android: 1, ios: 2, other: 3 };

  const collapseItems = groupNames.map((g, groupIndex) => {
    const rows = [...groupMap.get(g)!].sort(
      (left, right) => (platformOrder[left.platform] ?? 9) - (platformOrder[right.platform] ?? 9)
    );
    return {
      key: g,
      label: (
        <span>
          <b>版本 {g}</b>
          {groupIndex === 0 && g !== "未标版本" && <Tag color="blue" style={{ marginLeft: 8 }}>最新</Tag>}
          <Tag style={{ marginLeft: 8 }}>{rows.length} 个安装包</Tag>
        </span>
      ),
      children: (
        <Table<PluginFile>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1150 }}
        />
      ),
    };
  });

  const doUpload = async () => {
    const v = await form.validateFields();
    if (!file) {
      message.error("请先选择插件文件");
      return;
    }
    setUploading(true);
    try {
      const res = await uploadPlugin({ file, name: v.name, platform: v.platform, note: v.note });
      if (res.success && res.data && v.version) {
        const sr = await savePluginRelease(res.data.id, { version: v.version, changelog: v.changelog, force: !!v.force });
        if (!sr.success) message.warning(sr.message || "版本信息未保存");
      }
      if (res.success) {
        message.success(v.version ? "上传成功（草稿，点「推送」后客户才会看到更新）" : "上传成功");
        setUploadOpen(false);
        setFile(null);
        form.resetFields();
        load();
      } else {
        message.error(res.message || "上传失败");
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>插件库（按版本折叠，最新版在最上面）</h3>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setFile(null);
              setUploadOpen(true);
            }}
          >
            上传插件
          </Button>
        </Space>
      </div>

      {collapseItems.length === 0 ? (
        <div style={{ color: "#999", padding: "40px 0", textAlign: "center" }}>
          {loading ? "加载中…" : "还没有插件，点右上角「上传插件」添加。"}
        </div>
      ) : (
        <Collapse
          items={collapseItems}
          activeKey={openKeys}
          onChange={(keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            activeKeys.current = arr as string[];
            setOpenKeys(arr as string[]);
          }}
        />
      )}

      <Modal
        title="上传插件"
        open={uploadOpen}
        confirmLoading={uploading}
        okText="上传"
        onCancel={() => {
          setUploadOpen(false);
          setFile(null);
        }}
        onOk={doUpload}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ platform: "pc" }}>
          <Form.Item label="插件文件" required tooltip="支持 zip / xpi / crx，最大 50MB">
            <Upload.Dragger
              beforeUpload={(f) => {
                setFile(f);
                if (!form.getFieldValue("name")) {
                  form.setFieldValue("name", f.name.replace(/\.[^.]+$/, ""));
                }
                return false;
              }}
              maxCount={1}
              accept=".zip,.xpi,.crx"
              fileList={file ? [{ uid: "1", name: file.name } as any] : []}
              onRemove={() => setFile(null)}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处</p>
              <p className="ant-upload-hint">仅限 zip / xpi / crx</p>
            </Upload.Dragger>
          </Form.Item>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "给插件起个名字" }]}
            tooltip="名称用「产品名 · 平台」格式可自动折叠分组，例如：会员库 · 电脑Chrome安装包"
          >
            <Input placeholder="例如：会员库 · 苹果一键安装" />
          </Form.Item>
          <Form.Item name="platform" label="平台">
            <Select options={PLATFORMS.map((p) => ({ value: p.value, label: p.label }))} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="version" label="版本号（新插件 1.2.0+ 填写后才能推送）" rules={[{ pattern: /^\d+\.\d+\.\d+$/, message: "格式如 1.2.0" }]}>
            <Input placeholder="例如 1.2.1；旧插件留空" />
          </Form.Item>
          <Form.Item name="changelog" label="更新说明（客户在一键更新提示里看到）">
            <Input.TextArea rows={2} placeholder="例如：修复行情指标偶尔掉登录" />
          </Form.Item>
          <Form.Item name="force" label="强制更新" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`版本设置：${relEditing?.name || ""}`}
        open={!!relEditing}
        onCancel={() => setRelEditing(null)}
        onOk={async () => {
          const v = await relForm.validateFields();
          if (!relEditing) return;
          const r = await savePluginRelease(relEditing.id, v);
          if (!r.success) return message.error(r.message || "保存失败");
          message.success("已保存，点「推送」后生效");
          setRelEditing(null);
          load();
        }}
        destroyOnClose
      >
        <Form form={relForm} layout="vertical">
          <Form.Item name="version" label="版本号" rules={[{ required: true, pattern: /^\d+\.\d+\.\d+$/, message: "格式如 1.2.0" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="changelog" label="更新说明">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="force" label="强制更新（不更新就不能继续用）" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑插件"
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={async () => {
          const v = await editForm.validateFields();
          if (!editing) return;
          await updatePlugin(editing.id, v);
          message.success("已保存");
          setEditing(null);
          load();
        }}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "给插件起个名字" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="platform" label="平台">
            <Select options={PLATFORMS.map((p) => ({ value: p.value, label: p.label }))} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <div style={{ marginTop: 12, color: "#666", fontSize: 12, lineHeight: 1.9 }}>
        <div>推送流程：上传新插件并填版本号（草稿）→ 点「推送」→ 该平台 1.2.0+ 插件用户打开插件即看到「一键更新」。旧插件 1.1.x 不受影响。</div>
        <div>统一下载链接（自动识别电脑/安卓/苹果，跳到已推送的最新版）：<Typography.Text copyable code>{location.origin + "/dl/latest"}</Typography.Text></div>
        <div>近 7 天各版本活跃设备：{usage.length ? usage.map((u) => <Tag key={u.version + u.platform}>{u.version} · {platformMeta(u.platform).label} {u.c}</Tag>) : "暂无新版插件上报"}</div>
      </div>
      <div style={{ marginTop: 12, color: "#999", fontSize: 12 }}>
        苹果一键安装：上传 .xpi 文件、平台选「苹果」，把链接发给客户，用 Orion 浏览器打开链接即可弹出安装提示（点「无论如何继续」）。
      </div>
    </div>
  );
}

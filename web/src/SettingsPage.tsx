import { useEffect, useState } from "react";
import { Card, Form, Input, InputNumber, Button, Avatar, message, Upload, Select, Divider, Switch, DatePicker, Space, Tabs, TimePicker } from "antd";
import { UserOutlined, UploadOutlined } from "@ant-design/icons";
import type { UploadProps } from "antd";
import dayjs from "dayjs";
import {
  fetchSettings,
  updateSettings,
  sendTestMail,
  sendTestFeishu,
  sendTestDingtalk,
  sendDailyReport,
  testMarsCode,
  switchMarsCode,
  uploadAvatar,
  resolveUrl,
  fetchCards,
  clearToken,
  type CardItem,
} from "./api";

export default function SettingsPage() {
  const [form] = Form.useForm();
  const [mailForm] = Form.useForm();
  const [feishuForm] = Form.useForm();
  const [dingForm] = Form.useForm();
  const [marsForm] = Form.useForm();
  const [pwdForm] = Form.useForm();
  const avatarPreview = Form.useWatch("defaultAvatar", form);
  const [loading, setLoading] = useState(false);
  const [mailSaving, setMailSaving] = useState(false);
  const [mailTesting, setMailTesting] = useState(false);
  const [feishuSaving, setFeishuSaving] = useState(false);
  const [feishuTesting, setFeishuTesting] = useState(false);
  const [dingSaving, setDingSaving] = useState(false);
  const [dingTesting, setDingTesting] = useState(false);
  const [reportSending, setReportSending] = useState(false);
  const [reportImg, setReportImg] = useState("");
  const [marsTesting, setMarsTesting] = useState(false);
  const [marsSwitching, setMarsSwitching] = useState(false);
  const [marsResult, setMarsResult] = useState<{ code: string; site: string; expiryDate: string; xtokenExp: string; cookieCount: number } | null>(null);
  const [mailPassSet, setMailPassSet] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tokens, setTokens] = useState<CardItem[]>([]);

  useEffect(() => {
    fetchSettings().then((res) => {
      if (!res.success) return;
      form.setFieldsValue({
        defaultAvatar: res.data.defaultAvatar,
        defaultCardId: res.data.defaultCardId ?? undefined,
        vipExpiryEnabled: res.data.vipExpiryEnabled,
        vipExpiryDate: res.data.vipExpiryDate ? dayjs(res.data.vipExpiryDate) : undefined,
      });
      mailForm.setFieldsValue({
        mailEnabled: res.data.mailEnabled,
        mailHost: res.data.mailHost,
        mailPort: res.data.mailPort || 465,
        mailUser: res.data.mailUser,
        mailTo: res.data.mailTo,
      });
      setMailPassSet(!!res.data.mailPassSet);
      feishuForm.setFieldsValue({
        feishuEnabled: res.data.feishuEnabled,
        feishuWebhook: res.data.feishuWebhook,
      });
      dingForm.setFieldsValue({
        dingtalkEnabled: res.data.dingtalkEnabled,
        dingtalkWebhook: res.data.dingtalkWebhook,
        dingtalkSecret: res.data.dingtalkSecret,
        notifyActivation: res.data.notifyActivation,
        notifyMars: res.data.notifyMars,
        notifyYidian: res.data.notifyYidian,
        reportEnabled: res.data.reportEnabled,
        reportTime: res.data.reportTime ? dayjs(res.data.reportTime, "HH:mm") : dayjs("22:00", "HH:mm"),
      });
      marsForm.setFieldsValue({ marsCode: "" });
    });
    fetchCards().then((res) => {
      if (res.success) setTokens(res.data);
    });
  }, [form, mailForm, feishuForm, dingForm, marsForm]);

  const saveMail = async () => {
    const v = await mailForm.validateFields();
    setMailSaving(true);
    try {
      const res = await updateSettings({
        mailEnabled: !!v.mailEnabled,
        mailHost: v.mailHost ?? "",
        mailPort: v.mailPort || 465,
        mailUser: v.mailUser ?? "",
        mailPass: v.mailPass || "",
        mailTo: v.mailTo ?? "",
      });
      if (res.success) {
        message.success("已保存");
        mailForm.setFieldValue("mailPass", "");
        setMailPassSet(!!res.data?.mailPassSet);
      } else {
        message.error(res.message || "保存失败");
      }
    } finally {
      setMailSaving(false);
    }
  };

  const saveFeishu = async () => {
    const v = await feishuForm.validateFields();
    setFeishuSaving(true);
    try {
      const res = await updateSettings({ feishuEnabled: !!v.feishuEnabled, feishuWebhook: v.feishuWebhook ?? "" });
      if (res.success) message.success("已保存");
      else message.error(res.message || "保存失败");
    } finally {
      setFeishuSaving(false);
    }
  };

  const saveDing = async () => {
    const v = await dingForm.validateFields();
    setDingSaving(true);
    try {
      const res = await updateSettings({
        dingtalkEnabled: !!v.dingtalkEnabled,
        dingtalkWebhook: v.dingtalkWebhook ?? "",
        dingtalkSecret: v.dingtalkSecret ?? "",
        notifyActivation: !!v.notifyActivation,
        notifyMars: !!v.notifyMars,
        notifyYidian: !!v.notifyYidian,
        reportEnabled: !!v.reportEnabled,
        reportTime: v.reportTime ? dayjs(v.reportTime).format("HH:mm") : "22:00",
      });
      if (res.success) message.success("已保存");
      else message.error(res.message || "保存失败");
      return res.success;
    } finally {
      setDingSaving(false);
    }
  };

  const tokenOptions = tokens.map((c) => ({
    value: c.id,
    label: `${c.label || c.providerCode}${c.status !== "active" ? "（停用）" : ""} · Cookie ${c.cookieReady}/${c.tokenCount}`,
  }));

  const handleUpload: UploadProps["customRequest"] = async (options) => {
    const { file, onSuccess, onError } = options;
    setUploading(true);
    try {
      const res = await uploadAvatar(file as File);
      if (res.success) {
        form.setFieldsValue({ defaultAvatar: res.url });
        message.success("上传成功");
        onSuccess?.(res);
      } else {
        throw new Error(res.message || "上传失败");
      }
    } catch (err: any) {
      message.error(err.message || "上传失败");
      onError?.(err);
    } finally {
      setUploading(false);
    }
  };

  const notifyTab = (
    <>
      <Card title="钉钉机器人" size="small">
        <Form form={dingForm} layout="vertical" initialValues={{ notifyActivation: true, notifyMars: true, notifyYidian: true }}>
          <Form.Item name="dingtalkEnabled" label="启用钉钉提醒" valuePropName="checked" tooltip="开启后所有提醒走钉钉；没启用时退回飞书">
            <Switch />
          </Form.Item>
          <Form.Item name="dingtalkWebhook" label="Webhook 地址" rules={[{ required: true, message: "填 Webhook" }]}>
            <Input placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
          </Form.Item>
          <Form.Item name="dingtalkSecret" label="签名密钥（加签）" rules={[{ required: true, message: "填签名密钥" }]} tooltip="机器人安全设置选「加签」时给的 SEC 开头密钥">
            <Input.Password placeholder="SEC..." />
          </Form.Item>
          <Divider style={{ margin: "12px 0" }}>提醒类型（可单独开关）</Divider>
          <Space size="large" wrap>
            <Form.Item name="notifyActivation" label="新客户激活" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
            <Form.Item name="notifyMars" label="登录态异常/恢复" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
            <Form.Item name="notifyYidian" label="易店发货" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
          </Space>
          <Divider style={{ margin: "12px 0" }}>每日日报</Divider>
          <Space wrap align="end">
            <Form.Item name="reportEnabled" label="定时发送" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
            <Form.Item name="reportTime" label="发送时间" style={{ marginBottom: 0 }}>
              <TimePicker format="HH:mm" minuteStep={5} allowClear={false} style={{ width: 110 }} />
            </Form.Item>
          </Space>
          <div style={{ marginTop: 16 }}>
            <Space wrap>
              <Button type="primary" loading={dingSaving} onClick={saveDing}>保存</Button>
              <Button
                loading={dingTesting}
                onClick={async () => {
                  setDingTesting(true);
                  try {
                    if (await saveDing()) {
                      const res = await sendTestDingtalk();
                      if (res.success) message.success("测试消息已发出，去钉钉群看看");
                      else message.error(res.message || "发送失败");
                    }
                  } finally {
                    setDingTesting(false);
                  }
                }}
              >保存并发测试消息</Button>
              <Button
                loading={reportSending}
                onClick={async () => {
                  setReportSending(true);
                  try {
                    const res = await sendDailyReport();
                    if (res.success) message.success("日报已发送到钉钉");
                    else message.error(res.message || "发送失败");
                  } finally {
                    setReportSending(false);
                  }
                }}
              >立即发送今日日报</Button>
              <Button onClick={() => setReportImg(`/k9m4x7q2/api/admin/report/preview?t=${Date.now()}`)}>预览日报</Button>
            </Space>
          </div>
          {reportImg && (
            <div style={{ marginTop: 12 }}>
              <img src={reportImg} style={{ maxWidth: "100%", border: "1px solid #eee", borderRadius: 8 }} alt="日报预览" />
            </div>
          )}
        </Form>
      </Card>
      <Card title="邮箱提醒" size="small" style={{ marginTop: 16 }}>
        <Form form={mailForm} layout="vertical" initialValues={{ mailPort: 465 }}>
          <Form.Item name="mailEnabled" label="有人激活就发邮件提醒我" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Space wrap>
            <Form.Item name="mailHost" label="SMTP 服务器" style={{ marginBottom: 8 }}><Input style={{ width: 220 }} placeholder="smtp.qq.com" /></Form.Item>
            <Form.Item name="mailPort" label="端口" style={{ marginBottom: 8 }}><InputNumber min={1} max={65535} style={{ width: 100 }} /></Form.Item>
            <Form.Item name="mailUser" label="发件邮箱" style={{ marginBottom: 8 }}><Input style={{ width: 220 }} /></Form.Item>
          </Space>
          <Space wrap>
            <Form.Item name="mailPass" label={`授权码${mailPassSet ? "（已保存，留空不改）" : ""}`} style={{ marginBottom: 8 }}>
              <Input.Password style={{ width: 220 }} placeholder={mailPassSet ? "留空则保持不变" : "粘贴邮箱授权码"} />
            </Form.Item>
            <Form.Item name="mailTo" label="收件邮箱（留空发给自己）" style={{ marginBottom: 8 }}><Input style={{ width: 220 }} /></Form.Item>
          </Space>
          <Space>
            <Button type="primary" loading={mailSaving} onClick={saveMail}>保存</Button>
            <Button
              loading={mailTesting}
              onClick={async () => {
                setMailTesting(true);
                try {
                  await saveMail();
                  const res = await sendTestMail();
                  if (res.success) message.success("测试邮件已发出");
                  else message.error(res.message || "发送失败");
                } finally {
                  setMailTesting(false);
                }
              }}
            >保存并发测试邮件</Button>
          </Space>
        </Form>
      </Card>
      <Card title="飞书提醒（备用，启用钉钉后不会用到）" size="small" style={{ marginTop: 16 }}>
        <Form form={feishuForm} layout="vertical">
          <Form.Item name="feishuEnabled" label="启用飞书" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch />
          </Form.Item>
          <Form.Item name="feishuWebhook" label="Webhook 地址" style={{ marginBottom: 8 }}>
            <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
          </Form.Item>
          <Space>
            <Button type="primary" loading={feishuSaving} onClick={saveFeishu}>保存</Button>
            <Button
              loading={feishuTesting}
              onClick={async () => {
                setFeishuTesting(true);
                try {
                  await saveFeishu();
                  const res = await sendTestFeishu();
                  if (res.success) message.success("测试消息已发出");
                  else message.error(res.message || "发送失败");
                } finally {
                  setFeishuTesting(false);
                }
              }}
            >保存并发测试消息</Button>
          </Space>
        </Form>
      </Card>
    </>
  );

  const basicTab = (
    <Card size="small">
      <Form form={form} layout="vertical">
        <Form.Item name="defaultCardId" label="默认卡密" tooltip="密钥没有单独分配卡密时，激活就用这张默认卡密">
          <Select allowClear placeholder="请选择默认卡密" options={tokenOptions} showSearch optionFilterProp="label" />
        </Form.Item>
        <Divider style={{ margin: "12px 0" }}>兜底头像</Divider>
        <Form.Item label="预览" style={{ marginBottom: 8 }}>
          <Avatar size={56} src={resolveUrl(avatarPreview) || undefined} icon={<UserOutlined />} />
        </Form.Item>
        <Form.Item name="defaultAvatar" label="默认兜底头像" tooltip="设备没单独设置头像时展示这个；留空则不替换">
          <Input placeholder="https://... 或 /uploads/..." />
        </Form.Item>
        <Form.Item label="或上传图片">
          <Upload accept="image/*" maxCount={1} showUploadList={false} customRequest={handleUpload}>
            <Button icon={<UploadOutlined />} loading={uploading}>{uploading ? "上传中..." : "选择文件"}</Button>
          </Upload>
        </Form.Item>
        <Divider style={{ margin: "12px 0" }}>VIP 展示</Divider>
        <Form.Item name="vipExpiryEnabled" label="统一展示 VIP 到期日" valuePropName="checked" tooltip="页面上 VIP 的到期日统一显示为设置的日期（纯展示，不影响真实授权）">
          <Switch />
        </Form.Item>
        <Form.Item name="vipExpiryDate" label="展示的到期日">
          <DatePicker style={{ width: 220 }} placeholder="选择要展示的到期日" />
        </Form.Item>
        <Button
          type="primary"
          loading={loading}
          onClick={async () => {
            const values = await form.validateFields();
            setLoading(true);
            try {
              await updateSettings({
                defaultAvatar: values.defaultAvatar ?? "",
                defaultCardId: values.defaultCardId ?? null,
                vipExpiryEnabled: !!values.vipExpiryEnabled,
                vipExpiryDate: values.vipExpiryDate ? dayjs(values.vipExpiryDate).format("YYYY-MM-DD") : "",
              });
              message.success("已保存");
            } finally {
              setLoading(false);
            }
          }}
        >保存</Button>
      </Form>
    </Card>
  );

  const marsTab = (
    <Card size="small" title="Mars 上游密钥切换">
      <div style={{ color: "#666", marginBottom: 12, fontSize: 13 }}>
        输入新的 Mars 密钥后先测试。测试成功后才允许切换，失败不影响当前使用的密钥。
      </div>
      <Form form={marsForm} layout="vertical">
        <Form.Item name="marsCode" label="Mars 密钥" rules={[{ required: true, message: "请输入 Mars 密钥" }]}>
          <Input.Password placeholder="输入新的 Mars 密钥" />
        </Form.Item>
        <Space wrap>
          <Button loading={marsTesting} onClick={async () => {
            const { marsCode } = await marsForm.validateFields();
            setMarsTesting(true);
            setMarsResult(null);
            try {
              const res = await testMarsCode(marsCode);
              if (res.success && res.data) { setMarsResult(res.data); message.success(res.message || "测试成功"); }
              else message.error(res.message || "测试失败");
            } finally { setMarsTesting(false); }
          }}>测试新密钥</Button>
          <Button type="primary" loading={marsSwitching} disabled={!marsResult} onClick={async () => {
            const { marsCode } = await marsForm.validateFields();
            setMarsSwitching(true);
            try {
              const res = await switchMarsCode(marsCode);
              if (res.success) { message.success(res.message || "已立即切换"); setMarsResult(null); marsForm.resetFields(); }
              else message.error(res.message || "切换失败");
            } finally { setMarsSwitching(false); }
          }}>立即切换</Button>
        </Space>
        {marsResult && <div style={{ marginTop: 12, padding: 12, background: "#f6ffed", border: "1px solid #b7eb8f" }}>测试通过：站点 {marsResult.site || "-"}；到期 {marsResult.expiryDate || "-"}；x-token 到期 {marsResult.xtokenExp || "-"}；Cookie {marsResult.cookieCount} 个。现在可以点击「立即切换」。</div>}
      </Form>
    </Card>
  );

  const securityTab = (
    <Card size="small" title="修改管理员密码">
      <Form form={pwdForm} layout="vertical">
        <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 4, message: "至少 4 位" }]}>
          <Input.Password placeholder="输入新密码" />
        </Form.Item>
        <Button
          danger
          onClick={async () => {
            const { newPassword } = await pwdForm.validateFields();
            await updateSettings({ newPassword });
            message.success("密码已修改，请重新登录");
            clearToken();
            setTimeout(() => location.reload(), 800);
          }}
        >修改密码</Button>
      </Form>
    </Card>
  );

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <h3 style={{ marginTop: 0 }}>全局设置</h3>
      <Tabs
        defaultActiveKey="notify"
        items={[
          { key: "notify", label: "通知与日报", children: notifyTab },
          { key: "basic", label: "基本", children: basicTab },
          { key: "mars", label: "上游密钥", children: marsTab },
          { key: "security", label: "安全", children: securityTab },
        ]}
      />
    </div>
  );
}

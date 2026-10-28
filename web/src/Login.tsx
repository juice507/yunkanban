import { useState } from "react";
import { Card, Form, Input, Button, message } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { login } from "./api";

export default function Login({ onOk }: { onOk: () => void }) {
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const submit = async () => {
    const { password } = await form.validateFields();
    setLoading(true);
    try {
      const res = await login(password);
      if (res.success) {
        message.success("登录成功");
        onOk();
      } else {
        message.error(res.message || "密码错误");
      }
    } catch (e: any) {
      message.error(e?.message || "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f0f2f5",
      }}
    >
      <Card title="密钥分发后台 · 登录" style={{ width: 360 }}>
        <Form form={form} onFinish={submit}>
          <Form.Item name="password" rules={[{ required: true, message: "请输入管理员密码" }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="管理员密码"
              size="large"
              onPressEnter={submit}
              autoFocus
            />
          </Form.Item>
          <Button type="primary" size="large" block loading={loading} onClick={submit}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}

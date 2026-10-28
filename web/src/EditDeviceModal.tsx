import { useEffect, useState } from "react";
import { Modal, Form, Input, Avatar, message, Upload, Button } from "antd";
import { UserOutlined, UploadOutlined } from "@ant-design/icons";
import type { UploadProps } from "antd";
import type { DeviceItem } from "./api";
import { uploadAvatar, resolveUrl } from "./api";

export default function EditDeviceModal({
  device,
  onClose,
  onSaved,
  onSubmit,
}: {
  device: DeviceItem | null;
  onClose: () => void;
  onSaved: () => void;
  onSubmit: (
    id: number,
    payload: { nickname?: string; avatar?: string; deviceLabel?: string }
  ) => Promise<any>;
}) {
  const [form] = Form.useForm();
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (device) {
      form.setFieldsValue({
        nickname: device.nickname,
        avatar: device.avatar,
        deviceLabel: device.deviceLabel,
      });
    }
  }, [device]);

  const avatarPreview = Form.useWatch("avatar", form);

  const handleUpload: UploadProps["customRequest"] = async (options) => {
    const { file, onSuccess, onError } = options;
    setUploading(true);
    try {
      const res = await uploadAvatar(file as File);
      if (res.success) {
        form.setFieldsValue({ avatar: res.url }); // 存相对路径
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

  return (
    <Modal
      title="编辑设备展示信息"
      open={!!device}
      onCancel={onClose}
      onOk={async () => {
        const values = await form.validateFields();
        if (!device) return;
        await onSubmit(device.id, values);
        message.success("已保存");
        onSaved();
      }}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item label="预览">
          <Avatar size={64} src={resolveUrl(avatarPreview) || undefined} icon={<UserOutlined />} />
        </Form.Item>
        <Form.Item name="nickname" label="展示昵称" tooltip="留空则保持账号原始昵称">
          <Input placeholder="例如：张三" />
        </Form.Item>
        <Form.Item name="avatar" label="头像图片URL" tooltip="留空则使用全局默认头像">
          <Input placeholder="https://... 或 /uploads/..." />
        </Form.Item>
        <Form.Item label="或上传图片">
          <Upload
            accept="image/*"
            maxCount={1}
            showUploadList={false}
            customRequest={handleUpload}
          >
            <Button icon={<UploadOutlined />} loading={uploading}>
              {uploading ? "上传中..." : "选择文件"}
            </Button>
          </Upload>
          <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>
            支持 jpg/png/gif/webp/svg，最大 2MB
          </div>
        </Form.Item>
        <Form.Item name="deviceLabel" label="设备备注">
          <Input placeholder="例如：老王的笔记本" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

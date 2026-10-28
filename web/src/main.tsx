import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// React 19 兼容补丁: 让 antd 的静态 message / notification / Modal.confirm 正常弹出
import "@ant-design/v5-patch-for-react-19";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "antd/dist/reset.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN}>
      <App />
    </ConfigProvider>
  </StrictMode>
);

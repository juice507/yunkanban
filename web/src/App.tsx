import { useState } from "react";
import { HashRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { Layout, Menu, Button } from "antd";
import { KeyOutlined, FileTextOutlined, SettingOutlined, ThunderboltOutlined, LogoutOutlined, AppstoreOutlined, TagsOutlined, DashboardOutlined, ProfileOutlined } from "@ant-design/icons";
import DashboardPage from "./DashboardPage";
import ActivityLogPage from "./ActivityLogPage";
import KeysPage from "./KeysPage";
import LogsPage from "./LogsPage";
import SettingsPage from "./SettingsPage";
import CardsPage from "./CardsPage";
import PluginsPage from "./PluginsPage";
import AgentsPage from "./AgentsPage";
import Login from "./Login";
import YidianWorkspace from "./YidianWorkspace";
import { getToken, logout } from "./api";

const { Sider, Content } = Layout;

const NAV = [
  { key: "/dashboard", icon: <DashboardOutlined />, label: "使用看板" },
  { key: "/", icon: <KeyOutlined />, label: "密钥管理" },
  { key: "/agents", icon: <TagsOutlined />, label: "分类" },
  { key: "/tokens", icon: <ThunderboltOutlined />, label: "卡密池" },
  { key: "/plugins", icon: <AppstoreOutlined />, label: "插件库" },
  { key: "/activity", icon: <ProfileOutlined />, label: "日志中心" },
  { key: "/logs", icon: <FileTextOutlined />, label: "旧登录日志" },
  { key: "/yidian", icon: <ThunderboltOutlined />, label: "易店助手发货" },
  { key: "/settings", icon: <SettingOutlined />, label: "全局设置" },
];

function SideNav({ collapsed }: { collapsed: boolean }) {
  const location = useLocation();
  const items = NAV.map((n) => ({ key: n.key, icon: n.icon, label: <Link to={n.key}>{n.label}</Link> }));
  return (
    <Sider theme="dark" collapsible collapsed={collapsed} trigger={null} width={200} style={{ position: "sticky", top: 0, height: "100vh" }}>
      <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: collapsed ? 14 : 16, letterSpacing: 1 }}>
        {collapsed ? "云" : "云看板后台"}
      </div>
      <Menu theme="dark" mode="inline" selectedKeys={[location.pathname]} items={items} />
      <div style={{ position: "absolute", bottom: 0, width: "100%", padding: 12 }}>
        <Button block type="text" icon={<LogoutOutlined />} style={{ color: "#cfd8e3" }} onClick={logout}>
          {collapsed ? "" : "退出登录"}
        </Button>
      </div>
    </Sider>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [collapsed, setCollapsed] = useState(false);

  if (!authed) return <Login onOk={() => setAuthed(true)} />;

  return (
    <HashRouter>
      <Layout style={{ minHeight: "100vh" }}>
        <SideNav collapsed={collapsed} />
        <Layout>
          <div style={{ height: 48, display: "flex", alignItems: "center", padding: "0 16px", background: "#fff", borderBottom: "1px solid #f0f0f0" }}>
            <Button type="text" onClick={() => setCollapsed((c) => !c)} style={{ fontSize: 16 }}>
              ☰
            </Button>
          </div>
          <Content style={{ overflow: "auto" }}>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/activity" element={<ActivityLogPage />} />
              <Route path="/" element={<KeysPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/tokens" element={<CardsPage />} />
              <Route path="/plugins" element={<PluginsPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/yidian" element={<YidianWorkspace />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
    </HashRouter>
  );
}

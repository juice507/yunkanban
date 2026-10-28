import { useEffect, useState, useRef } from "react";
import { Drawer, Table, Tag, Button, Popconfirm, message, Space, Input, Alert } from "antd";
import type { DeviceItem } from "./api";
import {
  fetchDevices,
  kickDevice,
  deleteDevice,
  updateDevice,
} from "./api";

import { api } from './api';
type Metadata = {id:number;model?:string;modelSource?:string;modelConfidence?:string;deviceType?:string;os?:string;osVersion?:string;browser?:string;browserVersion?:string;appVersion?:string};
type EventRow = {id:number;created_at:string;type:string;outcome:string;reason:string;metadata:Record<string,string>};
export default function DeviceDrawer({
  keyId,
  keyName,
  open,
  onClose,
}: {
  keyId: number | null;
  keyName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [list, setList] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingLabel, setEditingLabel] = useState<Record<number, string>>({});

  const [metadata,setMetadata]=useState<Metadata[]>([]);
  const [events,setEvents]=useState<EventRow[]>([]);
  const [page,setPage]=useState(1);
  const [total,setTotal]=useState(0);
  const [started,setStarted]=useState('');
  const [error,setError]=useState('');
  const [group,setGroup]=useState('usage');
  const [dateFrom,setDateFrom]=useState('');
  const [dateTo,setDateTo]=useState('');
  const [dates,setDates]=useState<{from?:string;to?:string}>({});
  const requestEpoch=useRef(0);
  const loadEvents=async(p=1,g=group,range=dates)=>{if(!keyId)return;const epoch=++requestEpoch.current;setPage(p);try{const {data}=await api.get(`/admin/keys/${keyId}/telemetry`,{params:{limit:20,offset:(p-1)*20,group:g,...range}});if(epoch!==requestEpoch.current)return;setMetadata(data.devices);setEvents(data.items);setTotal(data.total);setStarted(data.startedAt);setError('');}catch{if(epoch!==requestEpoch.current)return;setError('记录读取失败，请刷新');setEvents([]);setMetadata([]);setTotal(0);}};
  const applyDates=()=>{if(dateFrom&&dateTo&&dateFrom>dateTo){setError('开始日期不能晚于结束日期');return;}const range={...(dateFrom?{from:dateFrom+' 00:00:00'}:{}),...(dateTo?{to:dateTo+' 23:59:59'}:{})};setDates(range);loadEvents(1,group,range);};
  const load = async () => {
    if (!keyId) return;
    setLoading(true);
    try {
      const res = await fetchDevices(keyId);
      if (res.success) setList(res.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    ++requestEpoch.current;setList([]);setMetadata([]);setEvents([]);setError('');setPage(1);setTotal(0);setStarted('');setDates({});setDateFrom('');setDateTo('');
    if (open && keyId) {load();loadEvents(1,group,{});}
    return ()=>{++requestEpoch.current;};
  }, [open, keyId]);

  return (
    <Drawer title={`设备管理 - ${keyName}`} width={720} open={open} onClose={onClose}>
      <Alert
        type="info"
        showIcon
        message="昵称和头像现在跟订阅码走（同一订阅码下所有设备统一），在密钥列表的「编辑」里设置。这里只管理设备名额。"
        style={{ marginBottom: 16 }}
      />
      <Table
        rowKey="id"
        scroll={{x:1000}}
        loading={loading}
        dataSource={list}
        pagination={false}
        columns={[
          {
            title: "设备备注",
            dataIndex: "deviceLabel",
            render: (v, r) => (
              <Space>
                <Input
                  size="small"
                  defaultValue={v}
                  style={{ width: 140 }}
                  onChange={(e) => setEditingLabel((m) => ({ ...m, [r.id]: e.target.value }))}
                  onBlur={async () => {
                    if (editingLabel[r.id] != null && editingLabel[r.id] !== v) {
                      await updateDevice(r.id, { deviceLabel: editingLabel[r.id] });
                      message.success("备注已保存");
                    }
                  }}
                />
              </Space>
            ),
          },
          {title:'类型 / 型号 / 来源',render:(_,r)=>{const d=metadata.find(x=>x.id===r.id);return <div>{d?.deviceType||'unknown'} · {d?.model||'型号未知'}<br/><small>{d?.modelSource||'unknown'} · {d?.modelConfidence||'unknown'}<br/>{d?.os} {d?.osVersion} · {d?.browser} {d?.browserVersion}{d?.appVersion&&` · 插件 ${d.appVersion}`}</small></div>;}},
          { title: "设备ID", dataIndex: "deviceId", ellipsis: true },
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (v) =>
              v === "active" ? <Tag color="green">占用名额</Tag> : <Tag color="default">已踢出</Tag>,
          },
          { title: "首次登录", dataIndex: "firstLoginAt", width: 160 },
          { title: "最近活跃", dataIndex: "lastSeenAt", width: 160 },
          {
            title: "操作",
            width: 150,
            render: (_, r) => (
              <Space>
                {r.status === "active" && (
                  <Popconfirm
                    title="踢下线后该设备名额会释放，可供其他设备登录"
                    onConfirm={async () => {
                      await kickDevice(r.id);
                      message.success("已踢下线");
                      load();
                    }}
                  >
                    <Button size="small" danger>
                      踢下线
                    </Button>
                  </Popconfirm>
                )}
                <Popconfirm
                  title="彻底删除该设备记录？"
                  onConfirm={async () => {
                    await deleteDevice(r.id);
                    message.success("已删除");
                    load();
                  }}
                >
                  <Button size="small" danger type="text">
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <h4>使用/操作记录</h4>
      <p>上海时间（秒）；采集开始 {started||'未知'}；保留90天，最多10万条。记录实际校验请求，不代表持续在线；历史型号未知不补造。上报型号未独立验证。</p>
      <Space><Button onClick={()=>{setGroup('usage');loadEvents(1,'usage');}}>使用记录</Button><Button onClick={()=>{setGroup('operation');loadEvents(1,'operation');}}>操作记录</Button><Button onClick={()=>loadEvents(page)}>刷新</Button></Space>
      <div style={{display:'flex',flexWrap:'wrap',gap:8,margin:'12px 0'}}><label>开始日期（上海）<Input type="date" aria-label="开始日期" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} /></label><label>结束日期（上海）<Input type="date" aria-label="结束日期" value={dateTo} onChange={e=>setDateTo(e.target.value)} /></label><Button onClick={applyDates}>应用日期</Button><Button onClick={()=>{setDateFrom('');setDateTo('');setDates({});loadEvents(1,group,{});}}>清除日期</Button></div>
      {error&&<Alert type="error" message={error}/>}
      <Table<EventRow> rowKey="id" dataSource={events} scroll={{x:650}} pagination={{current:page,pageSize:20,total,onChange:p=>loadEvents(p)}} columns={[{title:'时间',dataIndex:'created_at'},{title:'事件',dataIndex:'type'},{title:'结果',render:(_,r)=>`${r.outcome} · ${r.reason}`},{title:'设备 / 操作详情',render:(_,r)=>Object.entries(r.metadata).map(([k,v])=><div key={k}>{k}: {v}</div>)}]}/>
    </Drawer>
  );
}

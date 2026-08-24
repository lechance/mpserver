const express = require('express')
const fs = require('fs')
const path = require('path')
const config = require('../config')
const resultStore = require('../result-store')
const { adminAuth } = require('../admin-auth')
const { refreshAccessToken } = require('../access-token')
const { getDb, save } = require('../db')

const router = express.Router()

router.use(adminAuth)

router.get('/api/stats', (req, res) => {
  const stats = resultStore.listStats()
  let imageCount = 0, imageTotalSize = 0
  try {
    if (fs.existsSync(config.uploadDir)) {
      for (const name of fs.readdirSync(config.uploadDir)) {
        try {
          const st = fs.statSync(path.join(config.uploadDir, name))
          if (st.isFile()) { imageCount++; imageTotalSize += st.size }
        } catch {}
      }
    }
  } catch {}
  res.json({
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    nodeVersion: process.version,
    config: {
      appid: config.appid ? '****' + config.appid.slice(-4) : '未设置',
      appsecret: config.appsecret ? '已设置' : '未设置',
      publicBaseUrl: config.publicBaseUrl || '未设置',
      wxMsgToken: config.wxMsgToken ? '已设置' : '未设置',
      wxMsgEncodingAESKey: config.wxMsgEncodingAESKey ? '已设置' : '未设置',
      secCheckScene: config.secCheckScene,
      debug: config.debug,
    },
    checks: stats,
    images: { count: imageCount, totalSize: imageTotalSize },
    suggestions: getSuggestionCount(),
  })
})

/** 建议总数 */
function getSuggestionCount() {
  try {
    const stmt = getDb().prepare('SELECT COUNT(*) AS n FROM suggestions')
    stmt.step()
    const n = stmt.getAsObject().n || 0
    stmt.free()
    return n
  } catch {
    return 0
  }
}

router.get('/api/checks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const records = resultStore.list(limit).map(r => ({
    trace_id: r.traceId,
    status: r.status,
    safe: r.safe,
    code: r.code,
    filename: r.filename,
    createdAt: r.createdAt,
  }))
  res.json(records)
})

router.get('/api/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const logs = resultStore.getAuditLog(limit).map(l => ({
    id: l.id,
    event: l.event,
    trace_id: l.traceId,
    detail: l.detail,
    createdAt: l.createdAt,
  }))
  res.json(logs)
})

router.get('/api/images', (req, res) => {
  const files = []
  try {
    if (fs.existsSync(config.uploadDir)) {
      for (const name of fs.readdirSync(config.uploadDir)) {
        try {
          const st = fs.statSync(path.join(config.uploadDir, name))
          if (st.isFile()) files.push({ name, size: st.size, mtime: st.mtimeMs })
        } catch {}
      }
    }
  } catch {}
  files.sort((a, b) => b.mtime - a.mtime)
  res.json(files)
})

router.get('/api/suggestions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const db = getDb()
  const items = []
  const stmt = db.prepare('SELECT id, type, tool_id, tool_name, content, created_at FROM suggestions ORDER BY created_at DESC LIMIT ?')
  stmt.bind([limit])
  while (stmt.step()) {
    const r = stmt.getAsObject()
    items.push({
      id: r.id,
      type: r.type,
      toolId: r.tool_id,
      toolName: r.tool_name,
      content: r.content,
      createdAt: r.created_at,
    })
  }
  stmt.free()
  res.json(items)
})

router.post('/api/suggestion-delete', (req, res) => {
  const id = Number(req.body && req.body.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ code: 400, message: 'id 无效' })
  }
  const db = getDb()
  db.run('DELETE FROM suggestions WHERE id = ?', [id])
  const count = db.getRowsModified()
  save()
  res.json({ code: 0, message: `已删除 ${count} 条建议` })
})

router.post('/api/clear-store', (req, res) => {
  const count = resultStore.clear()
  res.json({ code: 0, message: `已清空 ${count} 条记录` })
})

router.post('/api/prune-images', (req, res) => {
  let removed = 0
  try {
    if (fs.existsSync(config.uploadDir)) {
      for (const name of fs.readdirSync(config.uploadDir)) {
        try {
          const file = path.join(config.uploadDir, name)
          const st = fs.statSync(file)
          if (st.isFile() && Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) {
            fs.unlinkSync(file)
            removed++
          }
        } catch {}
      }
    }
  } catch {}
  res.json({ code: 0, message: `已清理 ${removed} 个过期文件` })
})

router.post('/api/delete-images', (req, res) => {
  const names = Array.isArray(req.body && req.body.filenames) ? req.body.filenames : []
  if (!names.length) {
    return res.status(400).json({ code: 400, message: 'filenames 不能为空' })
  }
  if (names.length > 500) {
    return res.status(413).json({ code: 413, message: '单次删除数量过多' })
  }
  let deleted = 0
  let failed = 0
  for (const name of names) {
    // 仅允许纯文件名（服务端生成的 UUID.ext），阻断路径穿越
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(name) || name.includes('..')) {
      failed++
      continue
    }
    try {
      const file = path.join(config.uploadDir, name)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fs.unlinkSync(file)
        deleted++
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }
  const parts = [`已删除 ${deleted} 个文件`]
  if (failed > 0) parts.push(`${failed} 个失败`)
  res.json({ code: 0, deleted, failed, message: parts.join('，') })
})

router.post('/api/refresh-token', async (req, res) => {
  try {
    await refreshAccessToken()
    res.json({ code: 0, message: 'Token 已刷新' })
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message })
  }
})

router.get('/', (req, res) => {
  res.type('html').send(DASHBOARD_HTML)
})

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>治点工具箱 - 内容安全监控</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:#f0f2f5;color:#333;min-height:100vh}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}
.login-box{background:#fff;padding:40px;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:360px;text-align:center}
.login-box h2{margin-bottom:24px;color:#333;font-size:20px}
.login-box input{width:100%;padding:12px 16px;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;margin-bottom:16px;outline:none;transition:border .3s}
.login-box input:focus{border-color:#667eea}
.login-box button{width:100%;padding:12px;background:#667eea;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer;transition:opacity .3s}
.login-box button:hover{opacity:.85}
.login-box .err{color:#ff4d4f;font-size:13px;margin-bottom:12px;display:none}
.layout{display:flex;min-height:100vh}
.sidebar{width:220px;background:#001529;color:#fff;padding:20px 0;flex-shrink:0;position:fixed;height:100vh;overflow-y:auto}
.sidebar .logo{padding:0 20px 20px;font-size:18px;font-weight:700;border-bottom:1px solid #0d2137}
.sidebar .logo small{display:block;font-size:12px;color:#8c8c8c;font-weight:400;margin-top:4px}
.sidebar nav{padding:12px 0}
.sidebar nav a{display:flex;align-items:center;padding:10px 20px;color:#ffffffa6;text-decoration:none;font-size:14px;transition:all .2s}
.sidebar nav a:hover,.sidebar nav a.active{background:#1890ff;color:#fff}
.sidebar nav a .icon{margin-right:10px;font-size:16px}
.sidebar .logout{position:absolute;bottom:20px;left:20px;right:20px;padding:10px;background:#ff4d4f;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px}
.main{margin-left:220px;flex:1;padding:24px;overflow-y:auto}
.page{display:none}.page.active{display:block}
.page h2{font-size:20px;margin-bottom:20px;color:#1a1a1a}
.stat-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.stat-card{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.stat-card .label{font-size:13px;color:#8c8c8c;margin-bottom:8px}
.stat-card .value{font-size:28px;font-weight:700;color:#1a1a1a}
.stat-card .value.green{color:#52c41a}.stat-card .value.red{color:#ff4d4f}.stat-card .value.blue{color:#1890ff}
.table-wrap{background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden}
.table-wrap .toolbar{padding:16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #f0f0f0}
.table-wrap .toolbar h3{font-size:15px}
.table-wrap .toolbar button{padding:6px 16px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;transition:all .2s}
.table-wrap .toolbar button:hover{border-color:#667eea;color:#667eea}
.table-wrap .toolbar button.btn-danger{border-color:#ffccc7;color:#ff4d4f;background:#fff2f0}
.table-wrap .toolbar button.btn-danger:hover{border-color:#ff4d4f;background:#ff4d4f;color:#fff}
table img-check{width:16px;height:16px;cursor:pointer}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 16px;text-align:left;border-bottom:1px solid #f0f0f0;font-size:13px}
th{background:#fafafa;font-weight:600;color:#595959}
tr:hover{background:#f5f5f5}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500}
.badge.pass{background:#f6ffed;color:#52c41a;border:1px solid #b7eb8f}
.badge.risky{background:#fff2f0;color:#ff4d4f;border:1px solid #ffccc7}
.badge.pending{background:#e6f7ff;color:#1890ff;border:1px solid #91d5ff}
.thumb{width:48px;height:48px;border-radius:6px;object-fit:cover;background:#f0f0f0;cursor:pointer}
.empty{text-align:center;padding:60px;color:#8c8c8c}
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.78);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{position:relative;width:92vw;height:92vh;display:flex;align-items:center;justify-content:center;overflow:hidden}
.modal img{display:block;max-width:100%;max-height:100%;cursor:grab;user-select:none;-webkit-user-drag:none;will-change:transform}
.modal img.dragging{cursor:grabbing}
.modal .close{position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.15);color:#fff;border:none;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:11}
.modal .close:hover{background:rgba(255,255,255,.3)}
.zoom-bar{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:4px;align-items:center;background:rgba(0,0,0,.65);border-radius:10px;padding:4px 8px;z-index:11}
.zoom-bar button{min-width:34px;height:34px;padding:0 8px;background:transparent;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer}
.zoom-bar button:hover{background:rgba(255,255,255,.2)}
.zoom-bar .zlevel{color:#fff;font-size:13px;min-width:52px;text-align:center}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:2000;opacity:0;transition:opacity .3s}
.toast.show{opacity:1}.toast.success{background:#52c41a}.toast.error{background:#ff4d4f}.toast.info{background:#1890ff}
@media(max-width:768px){.sidebar{width:60px}.sidebar .logo small,.sidebar nav a span{display:none}.sidebar nav a{justify-content:center;padding:12px}.sidebar .logo{font-size:14px;padding:0 0 12px;text-align:center}.main{margin-left:60px}}
</style>
</head>
<body>
<div class="login-wrap" id="loginWrap">
  <div class="login-box">
    <h2>治点工具箱 - 管理面板</h2>
    <div class="err" id="loginErr"></div>
    <input id="tokenInput" type="password" placeholder="请输入管理令牌" autofocus>
    <button onclick="doLogin()">登录</button>
  </div>
</div>
<div class="layout" id="appWrap" style="display:none">
  <div class="sidebar">
    <div class="logo">治点工具箱<small>内容安全监控</small></div>
    <nav>
      <a href="#" data-page="dashboard" class="active"><span class="icon">&#9632;</span><span>概览</span></a>
      <a href="#" data-page="checks"><span class="icon">&#9654;</span><span>检测记录</span></a>
      <a href="#" data-page="images"><span class="icon">&#9733;</span><span>图片管理</span></a>
      <a href="#" data-page="suggestions"><span class="icon">&#9998;</span><span>用户建议</span></a>
      <a href="#" data-page="audit"><span class="icon">&#9783;</span><span>审计日志</span></a>
    </nav>
    <button class="logout" onclick="doLogout()">退出登录</button>
  </div>
  <div class="main">
    <div class="page active" id="page-dashboard">
      <h2>系统概览</h2>
      <div class="stat-cards" id="statCards"></div>
    </div>
    <div class="page" id="page-checks">
      <div class="table-wrap">
        <div class="toolbar"><h3>最近检测记录</h3><button onclick="loadChecks()">刷新</button></div>
        <table><thead><tr><th>预览</th><th>状态</th><th>trace_id</th><th>时间</th></tr></thead><tbody id="checksBody"></tbody></table>
      </div>
    </div>
    <div class="page" id="page-images">
      <div class="table-wrap">
        <div class="toolbar"><h3>已存储图片</h3><div><button onclick="deleteSelectedImages()" class="btn-danger" style="margin-right:8px">删除选中</button><button onclick="loadImages()">刷新</button></div></div>
        <table><thead><tr><th style="width:40px"><input type="checkbox" id="imgCheckAll" onchange="toggleAllImg(this)"></th><th>预览</th><th>文件名</th><th>大小</th><th>修改时间</th></tr></thead><tbody id="imagesBody"></tbody></table>
      </div>
    </div>
    <div class="page" id="page-audit">
      <div class="table-wrap">
        <div class="toolbar"><h3>审计日志</h3><button onclick="loadAudit()">刷新</button></div>
        <table><thead><tr><th>时间</th><th>事件</th><th>trace_id</th><th>详情</th></tr></thead><tbody id="auditBody"></tbody></table>
      </div>
    </div>
    <div class="page" id="page-suggestions">
      <div class="table-wrap">
        <div class="toolbar"><h3>工具建议（来自小程序「工具建议」页）</h3><button onclick="loadSuggestions()">刷新</button></div>
        <table><thead><tr><th>类型</th><th>相关工具</th><th>内容</th><th>时间</th><th>操作</th></tr></thead><tbody id="suggestionsBody"></tbody></table>
      </div>
    </div>
  </div>
</div>
<div class="modal-overlay" id="imgModal">
  <div class="modal">
    <button class="close" onclick="closeImg()">&times;</button>
    <img id="modalImg" draggable="false" alt="">
    <div class="zoom-bar">
      <button onclick="zoomBy(-1)" title="缩小">&minus;</button>
      <span class="zlevel" id="zoomLevel">100%</span>
      <button onclick="zoomBy(1)" title="放大">+</button>
      <button onclick="resetZoom()" title="重置" style="font-size:12px">1:1</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
let TOKEN=sessionStorage.getItem('admin_token')||''
const BASE='/admin/api'
const hdr=()=>({'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
function toast(msg,type='info'){const el=document.getElementById('toast');el.textContent=msg;el.className='toast show '+type;setTimeout(()=>el.classList.remove('show'),3000)}
function showLogin(){document.getElementById('loginWrap').style.display='flex';document.getElementById('appWrap').style.display='none'}
function showApp(){document.getElementById('loginWrap').style.display='none';document.getElementById('appWrap').style.display='flex'}
function doLogin(){const t=document.getElementById('tokenInput').value.trim();if(!t)return;TOKEN=t;fetch(BASE+'/stats',{headers:hdr()}).then(r=>{if(!r.ok)throw new Error();return r.json()}).then(()=>{sessionStorage.setItem('admin_token',TOKEN);showApp();init()}).catch(()=>{document.getElementById('loginErr').textContent='令牌无效';document.getElementById('loginErr').style.display='block'})}
function doLogout(){TOKEN='';sessionStorage.removeItem('admin_token');showLogin()}
async function api(path,method='GET'){const r=await fetch(BASE+path,{method,headers:hdr()});if(r.status===401){doLogout();return null}return r.json()}
function fmtSize(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB'}
function fmtTime(ts){const d=new Date(ts);const now=Date.now();const diff=(now-ts)/1000;if(diff<60)return Math.floor(diff)+'秒前';if(diff<3600)return Math.floor(diff/60)+'分钟前';if(diff<86400)return Math.floor(diff/3600)+'小时前';return d.toLocaleDateString('zh-CN')}
async function loadStats(){const d=await api('/stats');if(!d)return;document.getElementById('statCards').innerHTML=\`
  <div class="stat-card"><div class="label">系统运行</div><div class="value blue">\${Math.floor(d.uptime/3600)}h \${Math.floor((d.uptime%3600)/60)}m</div></div>
  <div class="stat-card"><div class="label">内存使用</div><div class="value">\${d.memory}MB</div></div>
  <div class="stat-card"><div class="label">Node 版本</div><div class="value">\${d.nodeVersion}</div></div>
  <div class="stat-card"><div class="label">今日检测</div><div class="value">\${d.checks.total}</div></div>
  <div class="stat-card"><div class="label">通过</div><div class="value green">\${d.checks.pass}</div></div>
  <div class="stat-card"><div class="label">违规</div><div class="value red">\${d.checks.risky}</div></div>
  <div class="stat-card"><div class="label">进行中</div><div class="value blue">\${d.checks.pending}</div></div>
  <div class="stat-card"><div class="label">用户建议</div><div class="value">\${d.suggestions!=null?d.suggestions:'-'}</div></div>
  <div class="stat-card"><div class="label">图片存储</div><div class="value">\${d.images.count} 个 / \${fmtSize(d.images.totalSize)}</div></div>
\`}
async function loadChecks(){const d=await api('/checks?limit=50');if(!d)return;const tb=document.getElementById('checksBody');if(!d.length){tb.innerHTML='<tr><td colspan="4" class="empty">暂无记录</td></tr>';return}tb.innerHTML=d.map(r=>{
  const s=r.safe===true?'pass':r.status==='pending'?'pending':'risky';
  const l=r.safe===true?'通过':r.status==='pending'?'进行中':'违规';
  const img=r.filename?'/media/'+r.filename:'';
  return '<tr>'+(img?'<td><img class="thumb" src="'+img+'" onclick="showImg(\\''+img+'\\')"></td>':'<td></td>')+
  '<td><span class="badge '+s+'">'+l+'</span></td>'+
  '<td style="font-family:monospace;font-size:12px">'+r.trace_id+'</td>'+
  '<td>'+fmtTime(r.createdAt)+'</td></tr>'}).join('')}
async function loadImages(){const d=await api('/images');if(!d)return;const tb=document.getElementById('imagesBody');if(!d.length){tb.innerHTML='<tr><td colspan="5" class="empty">暂无图片</td></tr>';return}document.getElementById('imgCheckAll').checked=false;tb.innerHTML=d.map(f=>{
  return '<tr><td><input type="checkbox" class="img-check" data-name="'+esc(f.name)+'"></td>'+
  '<td><img class="thumb" src="/media/'+f.name+'" onclick="showImg(\\''+'/media/'+f.name+'\\')"></td>'+
  '<td style="font-family:monospace;font-size:12px">'+f.name+'</td>'+
  '<td>'+fmtSize(f.size)+'</td>'+
  '<td>'+fmtTime(f.mtime)+'</td></tr>'}).join('')}
function toggleAllImg(el){document.querySelectorAll('.img-check').forEach(cb=>{cb.checked=el.checked})}
function getSelectedImages(){return Array.from(document.querySelectorAll('.img-check:checked')).map(cb=>cb.dataset.name)}
async function deleteSelectedImages(){const names=getSelectedImages();if(!names.length){toast('请先勾选要删除的图片','info');return}if(!confirm('确定删除选中的 '+names.length+' 张图片？'))return;const r=await fetch(BASE+'/delete-images',{method:'POST',headers:hdr(),body:JSON.stringify({filenames:names})});const d=await r.json().catch(()=>null);if(d&&d.code===0){toast(d.message,'success');loadImages()}else{toast((d&&d.message)||'删除失败','error')}}
const modalImg=document.getElementById('modalImg'),imgModal=document.getElementById('imgModal')
let zScale=1,zX=0,zY=0
function applyZoom(){modalImg.style.transform='translate('+zX+'px,'+zY+'px) scale('+zScale+')';document.getElementById('zoomLevel').textContent=Math.round(zScale*100)+'%'}
function resetZoom(){zScale=1;zX=0;zY=0;applyZoom()}
function zoomBy(dir){const next=dir>0?zScale*1.25:zScale/1.25;zScale=Math.min(Math.max(next,.2),8);applyZoom()}
function showImg(src){resetZoom();modalImg.src=src;imgModal.classList.add('show')}
function closeImg(){imgModal.classList.remove('show');setTimeout(()=>{modalImg.src=''},200)}
imgModal.addEventListener('wheel',e=>{e.preventDefault();zoomBy(e.deltaY<0?1:-1)},{passive:false})
let drag=null
function dragStart(x,y){drag={x,y};modalImg.classList.add('dragging')}
function dragMove(x,y){if(!drag)return;zX+=x-drag.x;zY+=y-drag.y;drag={x,y};applyZoom()}
function dragEnd(){drag=null;modalImg.classList.remove('dragging')}
modalImg.addEventListener('mousedown',e=>{e.preventDefault();dragStart(e.clientX,e.clientY)})
window.addEventListener('mousemove',e=>dragMove(e.clientX,e.clientY))
window.addEventListener('mouseup',dragEnd)
modalImg.addEventListener('dblclick',()=>{zScale>1?resetZoom():(zScale=2.5,applyZoom())})
modalImg.addEventListener('touchstart',e=>{if(e.touches.length===1){const t=e.touches[0];dragStart(t.clientX,t.clientY)}},{passive:true})
modalImg.addEventListener('touchmove',e=>{if(e.touches.length===1){const t=e.touches[0];dragMove(t.clientX,t.clientY)}},{passive:true})
modalImg.addEventListener('touchend',dragEnd)
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&imgModal.classList.contains('show'))closeImg()})
imgModal.addEventListener('click',e=>{if(e.target===imgModal)closeImg()})
async function pruneImages(){const d=await api('/prune-images','POST');if(d)toast(d.message,'success');loadImages()}
async function loadAudit(){const d=await api('/audit?limit=50');if(!d)return;const tb=document.getElementById('auditBody');if(!d.length){tb.innerHTML='<tr><td colspan="4" class="empty">暂无日志</td></tr>';return}tb.innerHTML=d.map(l=>{
  const evtMap={callback_pass:'推送-通过',callback_risky:'推送-违规',callback_error:'推送-异常',ignored_event:'忽略事件'}
  return '<tr><td>'+fmtTime(l.createdAt)+'</td>'+
  '<td><span class="badge '+(l.event.includes('pass')?'pass':l.event.includes('risky')?'risky':'pending')+'">'+(evtMap[l.event]||l.event)+'</span></td>'+
  '<td style="font-family:monospace;font-size:12px">'+(l.trace_id||'-')+'</td>'+
  '<td>'+(l.detail||'-')+'</td></tr>'}).join('')}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
async function loadSuggestions(){const d=await api('/suggestions?limit=100');if(!d)return;const tb=document.getElementById('suggestionsBody');if(!d.length){tb.innerHTML='<tr><td colspan="5" class="empty">暂无建议</td></tr>';return}tb.innerHTML=d.map(s=>{
  const t=s.type==='new'?'<span class="badge pass">新工具诉求</span>':'<span class="badge pending">现有工具建议</span>'
  return '<tr><td>'+t+'</td>'+
  '<td>'+esc(s.toolName||'-')+'</td>'+
  '<td style="max-width:420px;white-space:pre-wrap;word-break:break-word">'+esc(s.content)+'</td>'+
  '<td>'+fmtTime(s.createdAt)+'</td>'+
  '<td><button onclick="deleteSuggestion('+Number(s.id)+')">删除</button></td></tr>'}).join('')}
async function deleteSuggestion(id){if(!confirm('确定删除该条建议？'))return;const r=await fetch(BASE+'/suggestion-delete',{method:'POST',headers:hdr(),body:JSON.stringify({id})});const d=await r.json().catch(()=>null);if(d&&d.code===0){toast(d.message,'success');loadSuggestions()}else{toast((d&&d.message)||'删除失败','error')}}
document.querySelectorAll('.sidebar nav a').forEach(a=>{a.onclick=e=>{e.preventDefault();document.querySelectorAll('.sidebar nav a').forEach(x=>x.classList.remove('active'));a.classList.add('active');document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById('page-'+a.dataset.page).classList.add('active');if(a.dataset.page==='checks')loadChecks();if(a.dataset.page==='images')loadImages();if(a.dataset.page==='suggestions')loadSuggestions();if(a.dataset.page==='audit')loadAudit()}});
function init(){loadStats();setInterval(loadStats,5000)}
if(TOKEN){fetch(BASE+'/stats',{headers:hdr()}).then(r=>{if(r.ok){showApp();init()}else doLogout()}).catch(()=>doLogout())}
document.getElementById('tokenInput').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
</script>
</body>
</html>`

module.exports = router
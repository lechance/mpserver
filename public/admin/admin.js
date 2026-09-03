/* =========================================================
   治点工具箱 · 管理后台
   所有动态内容一律通过 DOM 构建器写入（textContent / createTextNode），
   禁止 innerHTML 拼接，从结构上杜绝 XSS。
   ========================================================= */
;(function () {
  'use strict'

  /* ===================== 常量 ===================== */
  const BASE = '/admin/api'
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const PAGE_SIZE = 20

  const SCOPE_LABELS = {
    _global: '🌐 全局数据',
    _profile: '👤 用户资料',
    _sync: '☁️ 同步配置',
  }

  const EVENT_LABELS = {
    callback_pass: '推送-通过',
    callback_risky: '推送-违规',
    callback_error: '推送-异常',
    ignored_event: '忽略事件',
    admin_login: '后台登录',
    admin_login_fail: '登录失败',
    admin_logout: '后台登出',
    app_config_change: '配置变更',
  }

  const ICONS = {
    layers: { p: ['M12 2L2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'] },
    check: { p: ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4L12 14.01l-3-3'] },
    shield: { p: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M12 8v4', 'M12 16h.01'] },
    clock: { p: ['M12 6v6l4 2'], c: [[12, 12, 9]] },
    inbox: { p: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'] },
    image: { p: ['M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 21'] },
    alert: { p: ['M12 8v4', 'M12 16h.01'], c: [[12, 12, 9]] },
    info: { p: ['M12 16v-4', 'M12 8h.01'], c: [[12, 12, 9]] },
    triangle: { p: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'] },
    x: { p: ['M18 6L6 18', 'M6 6l12 12'] },
    search: { p: ['M20 20l-4.35-4.35'], c: [[11, 11, 7]] },
    copy: { p: ['M9 9h10v12H9z', 'M5 15H3V3h12v2'] },
    database: { p: ['M3 5c0 1.66 4 3 9 3s9-1.34 9-3', 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3', 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5'] },
    eye: { p: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'], c: [[12, 12, 3]] },
  }

  let TOOLS_CATALOG = []
  const TOOL_MAP = Object.create(null)

  /* ===================== DOM 构建器 ===================== */

  /**
   * 创建元素。children 可以是节点、字符串、数组或 null（忽略）。
   * 字符串一律走 createTextNode，绝不解析为 HTML。
   */
  function el(tag, props) {
    const node = document.createElement(tag)
    if (props) {
      Object.keys(props).forEach(key => {
        const value = props[key]
        if (value == null || value === false) return
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = String(value)
        else if (key === 'dataset') Object.assign(node.dataset, value)
        else if (key === 'hidden') node.hidden = !!value
        else if (key === 'disabled' || key === 'checked') node[value === true ? 'setAttribute' : 'removeAttribute'](key, '')
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value)
        } else node.setAttribute(key, value === true ? '' : String(value))
      })
    }
    for (let i = 2; i < arguments.length; i++) appendChild(node, arguments[i])
    return node
  }

  function appendChild(node, child) {
    if (child == null || child === false) return
    if (Array.isArray(child)) {
      child.forEach(item => appendChild(node, item))
    } else if (child instanceof Node) {
      node.appendChild(child)
    } else {
      node.appendChild(document.createTextNode(String(child)))
    }
  }

  /** 清空并以新子节点填充 */
  function fill(node) {
    node.textContent = ''
    for (let i = 1; i < arguments.length; i++) appendChild(node, arguments[i])
    return node
  }

  function icon(name, className) {
    const def = ICONS[name] || {}
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    if (className) svg.setAttribute('class', className)
    ;(def.c || []).forEach(item => {
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', item[0])
      c.setAttribute('cy', item[1])
      c.setAttribute('r', item[2])
      svg.appendChild(c)
    })
    ;(def.p || []).forEach(d => {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('d', d)
      svg.appendChild(p)
    })
    return svg
  }

  const $ = id => document.getElementById(id)

  /* ===================== 格式化 ===================== */
  function fmtSize(bytes) {
    if (!bytes) return '0 B'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  function fmtDateTime(ts) {
    const d = new Date(ts)
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  function fmtRelative(ts) {
    const diff = (Date.now() - ts) / 1000
    if (diff < 0) return fmtDateTime(ts) // 客户端时钟偏移导致的“未来时间”
    if (diff < 60) return Math.floor(diff) + ' 秒前'
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前'
    return fmtDateTime(ts)
  }

  /** 相对时间 + 悬浮显示绝对时间 */
  function timeCell(ts) {
    return el('span', { class: 'cell-muted', title: fmtDateTime(ts), text: fmtRelative(ts) })
  }

  function fmtDuration(seconds) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`
  }

  function badge(text, tone) {
    return el('span', { class: 'badge badge--' + (tone || 'neutral') }, text)
  }

  /* ===================== 通知 ===================== */
  const TOAST_ICONS = { success: 'check', error: 'alert', warning: 'triangle', info: 'info' }

  function toast(message, type, duration) {
    const stack = $('toastStack')
    const node = el('div', { class: 'toast toast--' + (type || 'info') },
      icon(TOAST_ICONS[type] || 'info'),
      el('span', { class: 'toast__body', text: message }),
      el('button', {
        class: 'toast__close',
        type: 'button',
        'aria-label': '关闭通知',
        onclick: () => dismiss(node),
      }, icon('x')))

    const timer = setTimeout(() => dismiss(node), duration || 3600)
    node.addEventListener('mouseenter', () => clearTimeout(timer))
    stack.appendChild(node)

    // 最多同时保留 4 条
    while (stack.children.length > 4) dismiss(stack.firstElementChild)
  }

  function dismiss(node) {
    if (!node || node.classList.contains('is-leaving')) return
    node.classList.add('is-leaving')
    // 优先用 transitionend 触发移除（视觉退场一结束就移除），setTimeout 兜底
    // 保证即使 transition 被全局 prefers-reduced-motion 禁用、或事件未派发，
    // 节点也一定会被真正移除，不会卡在 DOM 里。
    let done = false
    const remove = () => {
      if (done) return
      done = true
      node.remove()
    }
    node.addEventListener('transitionend', remove, { once: true })
    setTimeout(remove, 320)
  }

  /* ===================== 弹窗基础设施 ===================== */
  let openCount = 0
  let lastFocused = null

  function focusables(root) {
    const all = Array.from(root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
    ))
    const visible = all.filter(node => node.getClientRects().length > 0)
    // 无布局引擎的环境（如测试用的 jsdom）下退化为全量，保证焦点仍可用
    return visible.length ? visible : all
  }

  function openModal(node) {
    if (!node.hidden) return
    if (openCount === 0) {
      lastFocused = document.activeElement
      document.body.style.overflow = 'hidden'
    }
    openCount++
    node.hidden = false
    const first = focusables(node)[0]
    if (first) first.focus()
    else node.focus()
  }

  function closeModal(node) {
    if (node.hidden) return
    node.hidden = true
    openCount = Math.max(0, openCount - 1)
    if (openCount === 0) {
      document.body.style.overflow = ''
      if (lastFocused && lastFocused.focus) lastFocused.focus()
      lastFocused = null
    }
  }

  // 统一的 Tab 焦点约束 + ESC 关闭
  document.addEventListener('keydown', event => {
    const open = document.querySelector('.modal:not([hidden]), .lightbox:not([hidden])')
    if (!open) return

    if (event.key === 'Escape') {
      event.preventDefault()
      closeModal(open)
      return
    }
    if (event.key !== 'Tab') return

    const items = focusables(open)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  document.addEventListener('click', event => {
    const closer = event.target.closest('[data-close]')
    if (closer) {
      closeModal($(closer.dataset.close))
      return
    }
    // 点击遮罩关闭（target 必须是遮罩本身，面板内的点击不算）
    if (event.target.classList && event.target.classList.contains('modal')) {
      closeModal(event.target)
    }
  })

  /* ===================== 确认弹窗（替代原生 confirm） ===================== */
  let pendingConfirm = null

  function settleConfirm(result) {
    if (!pendingConfirm) return
    const resolve = pendingConfirm
    pendingConfirm = null
    closeModal($('confirmModal'))
    resolve(result)
  }

  /** 返回 Promise<boolean>；danger 为 false 时确认按钮用主色 */
  function confirmDialog(options) {
    const opts = options || {}
    $('confirmTitle').textContent = opts.title || '确认操作'
    $('confirmMessage').textContent = opts.message || ''

    const ok = $('confirmOk')
    ok.textContent = opts.confirmText || '确定'
    ok.className = 'btn ' + (opts.danger === false ? 'btn--primary' : 'btn--danger')

    openModal($('confirmModal'))
    return new Promise(resolve => { pendingConfirm = resolve })
  }

  $('confirmOk').addEventListener('click', () => settleConfirm(true))
  $('confirmCancel').addEventListener('click', () => settleConfirm(false))

  /* ===================== 网络 ===================== */
  const JSON_HEADERS = { 'Content-Type': 'application/json' }

  async function request(path, options) {
    const res = await fetch(BASE + path, Object.assign({ headers: JSON_HEADERS }, options))
    if (res.status === 401) {
      await logout(true)
      return null
    }
    return res.json().catch(() => null)
  }

  const apiGet = path => request(path)

  async function apiPost(path, body) {
    return request(path, { method: 'POST', body: JSON.stringify(body) })
  }

  /** 写操作统一处理：成功提示并回调，失败提示服务端 message */
  async function mutate(path, body, successMessage, onSuccess) {
    const data = await apiPost(path, body)
    if (data && data.code === 0) {
      if (successMessage !== false) toast(data.message || successMessage || '操作成功', 'success')
      if (onSuccess) onSuccess(data)
      return true
    }
    if (data) toast(data.message || '操作失败', 'error')
    return false
  }

  /* ===================== 表格控制器 ===================== */
  /**
   * 负责：排序 → 分页 → 渲染 → 空态 / 加载态。
   * columns[i] 与 thead 中的第 i 个 th 对应。
   */
  function createTable(config) {
    const table = config.table
    const tbody = config.tbody
    const columns = config.columns
    const heads = Array.from(table.tHead.rows[0].children)

    let rows = []
    let page = 1
    let sortIndex = -1
    let sortDir = 1
    let loading = false

    columns.forEach((column, index) => {
      const th = heads[index]
      if (!th || !column.sort) return

      th.classList.add('is-sortable')
      th.tabIndex = 0
      th.setAttribute('role', 'button')
      th.setAttribute('aria-sort', 'none')
      th.appendChild(el('span', { class: 'sort-arrow', 'aria-hidden': 'true' }))

      const toggle = () => {
        sortDir = sortIndex === index ? -sortDir : 1
        sortIndex = index
        heads.forEach((head, i) => {
          if (!columns[i].sort) return
          head.setAttribute('aria-sort', i === index ? (sortDir === 1 ? 'ascending' : 'descending') : 'none')
        })
        render()
      }
      th.addEventListener('click', toggle)
      th.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggle()
        }
      })
    })

    function emptyRow() {
      const config2 = config.empty || {}
      return el('tr', null, el('td', { colspan: columns.length },
        el('div', { class: 'empty' },
          el('span', { class: 'empty__icon' }, icon(config2.icon || 'inbox')),
          el('p', { class: 'empty__title', text: config2.title || '暂无数据' }),
          config2.desc ? el('p', { class: 'empty__desc', text: config2.desc }) : null)))
    }

    function render() {
      if (loading) {
        fill(tbody, el('tr', { class: 'loading-row' },
          el('td', { colspan: columns.length }, el('span', { class: 'spinner' }), '加载中…')))
        return
      }

      const list = rows.slice()
      if (sortIndex >= 0) {
        const accessor = columns[sortIndex].sort
        list.sort((a, b) => {
          const va = accessor(a)
          const vb = accessor(b)
          if (va < vb) return -sortDir
          if (va > vb) return sortDir
          return 0
        })
      }

      let pageRows = list
      if (config.pageSize) {
        const totalPages = Math.max(1, Math.ceil(list.length / config.pageSize))
        if (page > totalPages) page = totalPages
        if (page < 1) page = 1
        const start = (page - 1) * config.pageSize
        pageRows = list.slice(start, start + config.pageSize)
      }

      tbody.textContent = ''
      if (!pageRows.length) {
        tbody.appendChild(emptyRow())
      } else {
        pageRows.forEach(row => {
          const tr = el('tr')
          if (config.rowClass) {
            const cls = config.rowClass(row)
            if (cls) tr.className = cls
          }
          columns.forEach(column => {
            const td = el('td', column.tdClass ? { class: column.tdClass } : null)
            appendChild(td, column.cell(row))
            tr.appendChild(td)
          })
          tbody.appendChild(tr)
        })
      }

      if (config.paginationEl) {
        const size = config.pageSize || Math.max(1, list.length)
        renderPagination(
          config.paginationEl,
          page,
          Math.max(1, Math.ceil(list.length / size)),
          list.length,
          next => { page = next; render() }
        )
      }
      if (config.onRender) config.onRender({ rows: list, pageRows })
    }

    return {
      setRows(next, resetPage) {
        rows = Array.isArray(next) ? next : []
        loading = false
        if (resetPage) page = 1
        render()
      },
      setLoading(state) {
        loading = state
        render()
      },
      render,
    }
  }

  function renderPagination(container, current, totalPages, totalItems, onPage) {
    container.textContent = ''
    if (totalPages <= 1) {
      container.hidden = true
      return
    }
    container.hidden = false

    const addButton = (label, target, options) => {
      const opts = options || {}
      container.appendChild(el('button', {
        class: 'pagination__btn' + (opts.active ? ' is-active' : ''),
        type: 'button',
        disabled: !!opts.disabled,
        'aria-label': opts.label,
        'aria-current': opts.active ? 'page' : null,
        text: label,
        onclick: () => onPage(target),
      }))
    }

    addButton('«', current - 1, { disabled: current <= 1, label: '上一页' })
    pageRange(current, totalPages).forEach(item => {
      if (item === '…') container.appendChild(el('span', { class: 'pagination__gap', text: '…' }))
      else addButton(String(item), item, { active: item === current, label: '第 ' + item + ' 页' })
    })
    addButton('»', current + 1, { disabled: current >= totalPages, label: '下一页' })
    container.appendChild(el('span', { class: 'pagination__info', text: `共 ${totalItems} 项` }))
  }

  function pageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
    const pages = [1]
    if (current > 3) pages.push('…')
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i)
    if (current < total - 2) pages.push('…')
    pages.push(total)
    return pages
  }

  /* ===================== 图片查看器 ===================== */
  const lightbox = $('lightbox')
  const lightboxImg = $('lightboxImg')
  let scale = 1
  let offsetX = 0
  let offsetY = 0
  let drag = null

  function applyZoom() {
    lightboxImg.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
    $('zoomLevel').textContent = Math.round(scale * 100) + '%'
  }

  function resetZoom() {
    scale = 1
    offsetX = 0
    offsetY = 0
    applyZoom()
  }

  function zoomBy(direction) {
    const next = direction > 0 ? scale * 1.25 : scale / 1.25
    scale = Math.min(Math.max(next, 0.2), 8)
    applyZoom()
  }

  function showImage(src, alt) {
    resetZoom()
    lightboxImg.src = src
    lightboxImg.alt = alt || '图片预览'
    openModal(lightbox)
  }

  $('lightboxClose').addEventListener('click', () => closeModal(lightbox))
  $('zoomIn').addEventListener('click', () => zoomBy(1))
  $('zoomOut').addEventListener('click', () => zoomBy(-1))
  $('zoomReset').addEventListener('click', resetZoom)

  lightbox.addEventListener('click', event => {
    if (event.target === lightbox || event.target === $('lightboxStage')) closeModal(lightbox)
  })
  lightbox.addEventListener('wheel', event => {
    event.preventDefault()
    zoomBy(event.deltaY < 0 ? 1 : -1)
  }, { passive: false })

  lightboxImg.addEventListener('mousedown', event => {
    event.preventDefault()
    drag = { x: event.clientX, y: event.clientY }
    lightboxImg.classList.add('is-dragging')
  })
  window.addEventListener('mousemove', event => {
    if (!drag) return
    offsetX += event.clientX - drag.x
    offsetY += event.clientY - drag.y
    drag = { x: event.clientX, y: event.clientY }
    applyZoom()
  })
  window.addEventListener('mouseup', () => {
    drag = null
    lightboxImg.classList.remove('is-dragging')
  })
  lightboxImg.addEventListener('dblclick', () => {
    if (scale > 1) resetZoom()
    else { scale = 2.5; applyZoom() }
  })
  lightboxImg.addEventListener('touchstart', event => {
    if (event.touches.length === 1) {
      const touch = event.touches[0]
      drag = { x: touch.clientX, y: touch.clientY }
    }
  }, { passive: true })
  lightboxImg.addEventListener('touchmove', event => {
    if (drag && event.touches.length === 1) {
      const touch = event.touches[0]
      offsetX += touch.clientX - drag.x
      offsetY += touch.clientY - drag.y
      drag = { x: touch.clientX, y: touch.clientY }
      applyZoom()
    }
  }, { passive: true })
  lightboxImg.addEventListener('touchend', () => { drag = null })

  /* ===================== 数据详情弹窗 ===================== */
  const dataModal = $('dataModal')
  let dataModalRaw = ''

  function showDataModal(scope, dataType, raw, updatedAt) {
    const parsed = parseData(raw)
    dataModalRaw = typeof raw === 'string' ? raw : JSON.stringify(raw)
    $('dataModalScope').textContent = scopeLabel(scope)
    $('dataModalTitle').textContent = dataType
    $('dataModalTime').textContent = fmtDateTime(updatedAt)
    fill($('dataModalBody'), renderFormatted(scope, dataType, parsed))
    openModal(dataModal)
  }

  $('dataModalCopy').addEventListener('click', () => copyText(dataModalRaw))

  /* ---- 数据格式化渲染（全部返回 DOM 节点） ---- */
  function parseData(data) {
    if (data == null) return null
    if (typeof data === 'object') return data
    try { return JSON.parse(data) } catch { return String(data) }
  }

  function toolName(id) {
    const tool = TOOL_MAP[id]
    return tool ? (tool.icon ? tool.icon + ' ' + tool.name : tool.name) : null
  }

  function toolNameShort(id) {
    const tool = TOOL_MAP[id]
    return tool ? tool.name : id
  }

  function scopeLabel(scope) {
    return SCOPE_LABELS[scope] || toolName(scope) || scope
  }

  function renderFormatted(scope, dataType, parsed) {
    if (parsed == null) return el('div', { class: 'fmt-empty', text: '空' })
    if (typeof parsed === 'string') return el('div', { class: 'fmt-plain', text: parsed })

    if (Array.isArray(parsed)) {
      if (!parsed.length) return el('div', { class: 'fmt-empty', text: '空数组' })
      if (scope === '_global' && dataType === 'favorites') {
        return chipList(parsed.map(id => toolNameShort(id)))
      }
      if (scope === '_global' && dataType === 'search_history') {
        return chipList(parsed.map(String))
      }
      if (scope === '_global' && dataType === 'records') {
        return renderRecords(parsed)
      }
      const shown = parsed.slice(0, 50)
      const cards = el('div', { class: 'fmt-cards' },
        shown.map((item, index) => renderValue(item, `第 ${index + 1} 条`)))
      if (parsed.length > 50) {
        cards.appendChild(el('p', { class: 'fmt-note', text: `还有 ${parsed.length - 50} 条未显示` }))
      }
      return cards
    }

    if (typeof parsed === 'object') return renderObject(parsed)
    return el('div', { class: 'fmt-plain', text: String(parsed) })
  }

  function chipList(items) {
    if (!items.length) return el('div', { class: 'fmt-empty', text: '空' })
    return el('div', { class: 'fmt-chips' }, items.map(text => el('span', { class: 'fmt-chip', text })))
  }

  function renderValue(value, label) {
    if (value == null) {
      return el('div', { class: 'fmt-card' },
        el('div', { class: 'fmt-label', text: label }),
        el('div', { class: 'fmt-empty', text: 'null' }))
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value)
      return el('div', { class: 'fmt-card' },
        el('div', { class: 'fmt-label', text: label }),
        el('div', { class: 'fmt-plain', text: text.length > 200 ? text.slice(0, 200) + '…' : text }))
    }
    if (Array.isArray(value)) {
      if (!value.length) {
        return el('div', { class: 'fmt-card' },
          el('div', { class: 'fmt-label', text: label }),
          el('div', { class: 'fmt-empty', text: '空' }))
      }
      if (value.length <= 10 && value.every(item => typeof item === 'string')) {
        return el('div', { class: 'fmt-card' },
          el('div', { class: 'fmt-label', text: label }),
          chipList(value.map(String)))
      }
      return el('div', { class: 'fmt-card' },
        el('div', { class: 'fmt-label', text: `${label}（共 ${value.length} 项）` }),
        renderFormatted(null, null, value))
    }
    if (typeof value === 'object') {
      return el('div', { class: 'fmt-card' },
        el('div', { class: 'fmt-label', text: label }),
        renderObject(value))
    }
    return el('div', { class: 'fmt-card' },
      el('div', { class: 'fmt-label', text: label }),
      el('div', { class: 'fmt-plain', text: String(value) }))
  }

  function renderObject(obj) {
    const keys = Object.keys(obj)
    if (!keys.length) return el('div', { class: 'fmt-empty', text: '空对象' })

    const wrap = document.createDocumentFragment()
    keys.forEach(key => {
      const value = obj[key]
      if (key === 'enabledToolIds' && Array.isArray(value)) {
        wrap.appendChild(el('div', { class: 'fmt-section' },
          el('div', { class: 'fmt-label', text: key }),
          chipList(value.map(id => toolNameShort(id)))))
        return
      }
      if (key === 'favorites' && Array.isArray(value)) {
        wrap.appendChild(el('div', { class: 'fmt-section' },
          el('div', { class: 'fmt-label', text: '收藏工具' }),
          chipList(value.map(id => toolNameShort(id)))))
        return
      }
      const label = key === 'toolId' && typeof value === 'string'
        ? 'toolId: ' + (toolName(value) || value)
        : key
      if (value != null && typeof value === 'object') {
        wrap.appendChild(el('div', { class: 'fmt-section' },
          el('div', { class: 'fmt-label', text: label }),
          renderValue(value, '')))
      } else {
        wrap.appendChild(el('dl', { class: 'fmt-kv' },
          el('dt', { text: label }),
          el('dd', { text: value == null ? '空' : String(value).slice(0, 200) })))
      }
    })
    return wrap
  }

  function renderRecords(records) {
    const shown = records.length > 20 ? records.slice(0, 20) : records
    const list = el('div', { class: 'fmt-cards' }, shown.map(record => {
      const name = record.toolName || (record.toolId ? toolNameShort(record.toolId) : '未知')
      const time = record.timestamp ? fmtRelative(record.timestamp) : ''
      return el('div', { class: 'fmt-card' },
        el('div', { class: 'fmt-card__head' },
          el('span', { class: 'fmt-card__name', text: name }),
          time ? el('span', { class: 'fmt-card__time', text: time }) : null))
    }))
    if (records.length > 20) {
      list.appendChild(el('p', { class: 'fmt-note', text: `还有 ${records.length - 20} 条未显示` }))
    }
    return list
  }

  /** 表格里的一行摘要文本 */
  function summarize(scope, dataType, parsed) {
    if (parsed == null) return '空'
    if (typeof parsed === 'string') return parsed.length > 60 ? parsed.slice(0, 60) + '…' : parsed

    if (Array.isArray(parsed)) {
      if (!parsed.length) return '空数组'
      if (scope === '_global' && dataType === 'favorites') {
        const names = parsed.map(id => toolNameShort(id))
        return `收藏 ${parsed.length} 个：${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}`
      }
      if (scope === '_global' && dataType === 'search_history') {
        return `搜索历史 ${parsed.length} 条：${parsed.slice(0, 3).join('、')}${parsed.length > 3 ? '…' : ''}`
      }
      if (scope === '_global' && dataType === 'records') {
        const first = parsed[0]
        const name = first && (first.toolName || (first.toolId ? toolNameShort(first.toolId) : '未知'))
        return `${parsed.length} 条使用记录 · 最近：${name || '未知'}`
      }
      return `共 ${parsed.length} 项`
    }

    if (typeof parsed === 'object') {
      const keys = Object.keys(parsed)
      if (!keys.length) return '空对象'
      if (scope === '_sync' && dataType === 'config' && Array.isArray(parsed.enabledToolIds)) {
        const names = parsed.enabledToolIds.map(id => toolNameShort(id))
        return `已启用 ${names.length} 个工具：${names.slice(0, 4).join('、')}${names.length > 4 ? '…' : ''}`
      }
      if (keys.length <= 3) {
        return keys.map(key => `${key}: ${String(parsed[key]).slice(0, 20)}`).join(' · ')
      }
      return `${keys.length} 个字段：${keys.slice(0, 3).join('、')}…`
    }
    return String(parsed).slice(0, 60)
  }

  /* ===================== 复制 ===================== */
  function copyText(text) {
    const value = String(text == null ? '' : text)
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(
        () => toast('已复制', 'success'),
        () => legacyCopy(value)
      )
    } else {
      legacyCopy(value)
    }
  }

  function legacyCopy(value) {
    const area = el('textarea', { style: { position: 'fixed', opacity: '0' } })
    area.value = value
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
      toast('已复制', 'success')
    } catch {
      toast('复制失败，请手动选择', 'error')
    }
    area.remove()
  }

  function copyButton(value, label) {
    return el('button', {
      class: 'btn btn--ghost btn--icon btn--sm',
      type: 'button',
      title: '复制',
      'aria-label': '复制 ' + (label || ''),
      onclick: event => {
        event.stopPropagation()
        copyText(value)
      },
    }, icon('copy'))
  }

  /* ===================== 概览 ===================== */
  function statCard(options) {
    return el('div', { class: 'stat-card' + (options.tone ? ' stat-card--' + options.tone : '') },
      el('div', { class: 'stat-card__label' },
        el('span', { class: 'stat-card__icon' }, icon(options.icon)),
        el('span', { text: options.label })),
      el('div', { class: 'stat-card__value' }, options.value,
        options.unit ? el('small', { text: ' ' + options.unit }) : null))
  }

  function stateValue(text) {
    return el('span', { class: 'cell-mono', text })
  }

  function setState(text, isSet) {
    return isSet
      ? el('span', { class: 'badge badge--pass' }, el('span', { class: 'dot' }), '已设置')
      : el('span', { class: 'badge badge--risky' }, el('span', { class: 'dot' }), '未设置')
  }

  let lastStats = null

  async function loadStats() {
    const data = await apiGet('/stats')
    if (!data) return
    lastStats = data
    $('lastUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN')

    if (currentPage !== 'dashboard') return

    const checks = data.checks || {}
    fill($('statGrid'),
      statCard({ label: '累计检测', icon: 'layers', value: checks.total || 0, unit: '次' }),
      statCard({ label: '通过', icon: 'check', tone: 'success', value: checks.pass || 0, unit: '次' }),
      statCard({ label: '违规', icon: 'shield', tone: 'danger', value: checks.risky || 0, unit: '次' }),
      statCard({ label: '进行中', icon: 'clock', tone: 'accent', value: checks.pending || 0, unit: '次' }),
      statCard({ label: '用户建议', icon: 'inbox', value: data.suggestions != null ? data.suggestions : '—', unit: '条' }),
      statCard({ label: '图片存储', icon: 'image', value: (data.images && data.images.count) || 0, unit: '张 / ' + fmtSize(data.images ? data.images.totalSize : 0) }))

    const cfg = data.config || {}
    fill($('envList'),
      el('dt', { text: '运行时长' }), el('dd', { text: fmtDuration(data.uptime || 0) }),
      el('dt', { text: '内存占用' }), el('dd', { text: (data.memory || 0) + ' MB' }),
      el('dt', { text: 'Node 版本' }), el('dd', null, stateValue(data.nodeVersion || '—')),
      el('dt', { text: 'AppID' }), el('dd', null, stateValue(cfg.appid || '未设置')),
      el('dt', { text: 'AppSecret' }), el('dd', null, setState('', cfg.appsecret === '已设置')),
      el('dt', { text: '回调地址' }), el('dd', null, stateValue(cfg.publicBaseUrl || '未设置')),
      el('dt', { text: '消息 Token' }), el('dd', null, setState('', cfg.wxMsgToken === '已设置')),
      el('dt', { text: 'EncodingAESKey' }), el('dd', null, setState('', cfg.wxMsgEncodingAESKey === '已设置')),
      el('dt', { text: '检测场景' }), el('dd', null, stateValue(String(cfg.secCheckScene != null ? cfg.secCheckScene : '—'))),
      el('dt', { text: '调试模式' }), el('dd', null, cfg.debug ? badge('已开启', 'warning') : badge('关闭', 'neutral')))
  }

  /* ---- 功能开关 ---- */
  async function loadAppConfig() {
    const data = await apiGet('/app-config')
    if (!data) return null
    const flags = data.flags || {}
    renderFlags(flags)
    return flags
  }

  function renderFlags(flags) {
    fill($('featureFlags'), switchRow({
      id: 'flagCouponsTab',
      title: '卡券 TAB',
      desc: '控制小程序底部「卡券」标签页的显示，关闭后客户端不再展示入口。',
      checked: flags.coupons_tab !== '0',
      onChange: (checked, revert) => saveFlag('coupons_tab', checked ? '1' : '0', revert),
    }))
  }

  function switchRow(options) {
    const input = el('input', {
      type: 'checkbox',
      id: options.id,
      checked: options.checked,
      disabled: options.disabled,
      onchange: () => options.onChange(input.checked, () => { input.checked = !input.checked }),
    })
    return el('div', { class: 'toolbar-inline' },
      el('div', null,
        el('label', { class: 'field__label', for: options.id, text: options.title }),
        el('p', { class: 'card__desc', text: options.desc })),
      el('div', { class: 'toolbar-inline__spacer' }),
      el('span', { class: 'switch' }, input,
        el('span', { class: 'switch__track' }),
        el('span', { class: 'switch__knob' })))
  }

  async function saveFlag(key, value, revert) {
    const ok = await mutate('/app-config', { key, value }, false)
    if (ok) toast('已更新', 'success')
    else revert()
  }

  /* ===================== 检测记录 ===================== */
  const checksTable = createTable({
    table: $('checksTable'),
    tbody: $('checksBody'),
    columns: [
      {
        tdClass: 'col-thumb',
        cell: row => row.filename
          ? el('img', {
              class: 'thumb',
              src: '/media/' + row.filename,
              alt: '检测图片',
              loading: 'lazy',
              onclick: () => showImage('/media/' + row.filename, row.filename),
            })
          : el('span', { class: 'thumb thumb--empty', text: '—' }),
      },
      {
        sort: row => row.status === 'pending' ? 1 : 0,
        cell: row => {
          if (row.safe === true) return badge('通过', 'pass')
          if (row.status === 'pending') return badge('进行中', 'pending')
          return badge('违规', 'risky')
        },
      },
      {
        cell: row => el('span', { class: 'cell-mono' }, row.trace_id, copyButton(row.trace_id, 'trace_id')),
      },
      { sort: row => row.createdAt, cell: row => timeCell(row.createdAt) },
    ],
    empty: { icon: 'shield', title: '暂无检测记录', desc: '小程序提交图片后会出现在这里' },
  })

  async function loadChecks() {
    checksTable.setLoading(true)
    const data = await apiGet('/checks?limit=50')
    if (!data) { checksTable.setLoading(false); return }
    checksTable.setRows(data, true)
  }

  /* ===================== 图片管理 ===================== */
  const selectedImages = new Set()

  const imagesTable = createTable({
    table: $('imagesTable'),
    tbody: $('imagesBody'),
    columns: [
      {
        tdClass: 'col-check',
        cell: file => el('input', {
          class: 'checkbox',
          type: 'checkbox',
          checked: selectedImages.has(file.name),
          'aria-label': '选择图片 ' + file.name,
          onchange: event => {
            if (event.target.checked) selectedImages.add(file.name)
            else selectedImages.delete(file.name)
            syncImageSelection()
          },
        }),
      },
      {
        tdClass: 'col-thumb',
        cell: file => el('img', {
          class: 'thumb',
          src: '/media/' + file.name,
          alt: file.name,
          loading: 'lazy',
          onclick: () => showImage('/media/' + file.name, file.name),
        }),
      },
      {
        sort: file => file.name,
        cell: file => el('span', { class: 'cell-mono' }, file.name, copyButton(file.name, file.name)),
      },
      { sort: file => file.size, cell: file => fmtSize(file.size) },
      { sort: file => file.mtime, cell: file => timeCell(file.mtime) },
    ],
    empty: { icon: 'image', title: '暂无图片', desc: '检测期间上传的图片会临时落盘，可在此手动清理' },
    onRender: ({ pageRows }) => {
      const all = $('imageCheckAll')
      all.checked = pageRows.length > 0 && pageRows.every(file => selectedImages.has(file.name))
      all.indeterminate = !all.checked && pageRows.some(file => selectedImages.has(file.name))
      syncImageSelection()
    },
  })

  function syncImageSelection() {
    const button = $('deleteImagesBtn')
    const label = button.querySelector('.btn__label')
    const count = selectedImages.size
    button.disabled = count === 0
    label.textContent = count ? `删除选中 (${count})` : '删除选中'
  }

  async function loadImages() {
    imagesTable.setLoading(true)
    const data = await apiGet('/images')
    if (!data) { imagesTable.setLoading(false); return }
    imagesTable.setRows(data, true)
  }

  $('imageCheckAll').addEventListener('change', event => {
    // 直接作用于当前渲染出的行，天然兼容排序状态
    document.querySelectorAll('#imagesBody .checkbox').forEach(box => {
      if (box.checked !== event.target.checked) {
        box.checked = event.target.checked
        box.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    imagesTable.render()
  })

  /* ===================== 审计日志 ===================== */
  const auditTable = createTable({
    table: $('auditTable'),
    tbody: $('auditBody'),
    columns: [
      { sort: row => row.createdAt, cell: row => timeCell(row.createdAt) },
      {
        sort: row => row.event,
        cell: row => {
          const tone = /pass/.test(row.event) ? 'pass'
            : /risky|error|fail/.test(row.event) ? 'risky'
              : /config|login|logout/.test(row.event) ? 'neutral' : 'pending'
          return badge(EVENT_LABELS[row.event] || row.event, tone)
        },
      },
      {
        cell: row => row.trace_id
          ? el('span', { class: 'cell-mono' }, row.trace_id, copyButton(row.trace_id, 'trace_id'))
          : el('span', { class: 'cell-muted', text: '—' }),
      },
      { cell: row => el('span', { class: 'cell-wrap' }, row.detail || '—') },
    ],
    empty: { icon: 'database', title: '暂无日志', desc: '后台操作与推送事件会记录在这里' },
  })

  async function loadAudit() {
    auditTable.setLoading(true)
    const data = await apiGet('/audit?limit=50')
    if (!data) { auditTable.setLoading(false); return }
    auditTable.setRows(data, true)
  }

  /* ===================== 用户建议 ===================== */
  const suggestionsTable = createTable({
    table: $('suggestionsTable'),
    tbody: $('suggestionsBody'),
    columns: [
      {
        sort: row => row.type,
        cell: row => row.type === 'new'
          ? badge('新工具诉求', 'pass')
          : badge('现有工具建议', 'pending'),
      },
      { cell: row => el('span', { class: 'cell-muted', text: row.toolName || '—' }) },
      { cell: row => el('span', { class: 'cell-wrap', text: row.content }) },
      { sort: row => row.createdAt, cell: row => timeCell(row.createdAt) },
      {
        tdClass: 'col-actions',
        cell: row => el('button', {
          class: 'btn btn--danger-soft btn--sm',
          type: 'button',
          text: '删除',
          onclick: () => deleteSuggestion(row.id),
        }),
      },
    ],
    empty: { icon: 'inbox', title: '暂无建议', desc: '用户在小程序「工具建议」页提交后会汇总到这里' },
  })

  async function loadSuggestions() {
    suggestionsTable.setLoading(true)
    const data = await apiGet('/suggestions?limit=100')
    if (!data) { suggestionsTable.setLoading(false); return }
    suggestionsTable.setRows(data, true)
  }

  async function deleteSuggestion(id) {
    const ok = await confirmDialog({
      title: '删除建议',
      message: '删除后不可恢复，确定要删除这条用户建议吗？',
      confirmText: '删除',
    })
    if (!ok) return
    await mutate('/suggestion-delete', { id }, false, () => {
      toast('已删除', 'success')
      loadSuggestions()
    })
  }

  /* ===================== 同步数据 ===================== */
  let syncUsers = []
  let syncUserQuery = ''
  const selectedSyncUsers = new Set()

  const syncUsersTable = createTable({
    table: $('syncUsersTable'),
    tbody: $('syncUsersBody'),
    pageSize: PAGE_SIZE,
    paginationEl: $('syncUsersPagination'),
    columns: [
      {
        tdClass: 'col-check',
        cell: user => el('input', {
          class: 'checkbox sync-user-cb',
          type: 'checkbox',
          checked: selectedSyncUsers.has(user.openid),
          'aria-label': '选择用户 ' + user.openid,
          onchange: event => {
            if (event.target.checked) selectedSyncUsers.add(user.openid)
            else selectedSyncUsers.delete(user.openid)
            syncUsersTable.render()
          },
        }),
      },
      {
        cell: user => el('span', { class: 'cell-mono cell-clip', title: user.openid, text: user.openid },
          copyButton(user.openid, 'openid')),
      },
      { sort: user => user.entryCount, cell: user => String(user.entryCount) },
      { sort: user => user.latestAt, cell: user => timeCell(user.latestAt) },
      {
        tdClass: 'col-actions',
        cell: user => el('span', { class: 'cell-actions' },
          el('button', {
            class: 'btn btn--subtle btn--sm',
            type: 'button',
            text: '查看',
            onclick: () => openSyncDetail(user.openid),
          }),
          el('button', {
            class: 'btn btn--danger-soft btn--sm',
            type: 'button',
            text: '清空',
            onclick: () => deleteAllForUser(user.openid),
          })),
      },
    ],
    empty: { icon: 'database', title: '暂无同步数据', desc: '用户在小程序开启同步后会出现在这里' },
    onRender: ({ pageRows }) => {
      const all = $('syncUserCheckAll')
      all.checked = pageRows.length > 0 && pageRows.every(user => selectedSyncUsers.has(user.openid))
      all.indeterminate = !all.checked && pageRows.some(user => selectedSyncUsers.has(user.openid))

      const bar = $('syncUsersBulkBar')
      bar.hidden = selectedSyncUsers.size === 0
      $('syncUsersBulkCount').textContent = `已选择 ${selectedSyncUsers.size} 个用户`
    },
  })

  async function loadSyncUsers() {
    syncUsersTable.setLoading(true)
    const data = await apiGet('/sync-users')
    if (!data) { syncUsersTable.setLoading(false); return }
    syncUsers = data
    selectedSyncUsers.clear()
    syncUserQuery = ''
    $('syncUserSearch').value = ''
    applySyncUserFilter()
  }

  function applySyncUserFilter() {
    const query = syncUserQuery.trim().toLowerCase()
    const filtered = query
      ? syncUsers.filter(user => user.openid.toLowerCase().includes(query))
      : syncUsers
    syncUsersTable.setRows(filtered, true)
  }

  $('syncUserSearch').addEventListener('input', event => {
    syncUserQuery = event.target.value
    applySyncUserFilter()
  })

  $('syncUserCheckAll').addEventListener('change', event => {
    document.querySelectorAll('.sync-user-cb').forEach(box => {
      if (box.checked !== event.target.checked) {
        box.checked = event.target.checked
        box.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    syncUsersTable.render()
  })

  $('syncUsersClearSel').addEventListener('click', () => {
    selectedSyncUsers.clear()
    syncUsersTable.render()
  })

  $('syncUsersBulkDelete').addEventListener('click', async () => {
    const count = selectedSyncUsers.size
    if (!count) return
    const ok = await confirmDialog({
      title: '删除用户数据',
      message: `将删除 ${count} 个用户的全部同步数据，此操作不可撤销。`,
      confirmText: '删除',
    })
    if (!ok) return
    await deleteUsersData(Array.from(selectedSyncUsers))
    selectedSyncUsers.clear()
    loadSyncUsers()
  })

  async function deleteAllForUser(openid) {
    const ok = await confirmDialog({
      title: '清空用户数据',
      message: `将删除用户 ${openid.slice(0, 12)}… 的全部同步数据，此操作不可撤销。`,
      confirmText: '删除',
    })
    if (!ok) return
    await deleteUsersData([openid])
    if (syncDetailOpenid) loadSyncDetail()
    else loadSyncUsers()
  }

  async function deleteUsersData(openids) {
    let deleted = 0
    let failed = 0
    for (const openid of openids) {
      const data = await apiGet('/sync-data?openid=' + encodeURIComponent(openid))
      if (!data || !data.items) continue
      for (const item of data.items) {
        const res = await apiPost('/sync-delete', {
          openid,
          scope: item.scope,
          data_type: item.dataType,
        })
        if (res && res.code === 0) deleted += res.deleted || 0
        else failed++
      }
    }
    toast(`已删除 ${deleted} 条记录${failed ? `，${failed} 条失败` : ''}`, deleted > 0 ? 'success' : 'error')
  }

  /* ---- 用户数据详情 ---- */
  let syncDetailOpenid = ''
  let syncEntries = []
  let syncEntryQuery = ''
  const selectedSyncEntries = new Set()

  const syncDetailTable = createTable({
    table: $('syncDetailTable'),
    tbody: $('syncDetailBody'),
    columns: [
      {
        tdClass: 'col-check',
        cell: item => el('input', {
          class: 'checkbox sync-entry-cb',
          type: 'checkbox',
          checked: selectedSyncEntries.has(entryKey(item)),
          'aria-label': '选择数据 ' + item.dataType,
          onchange: event => {
            const key = entryKey(item)
            if (event.target.checked) selectedSyncEntries.add(key)
            else selectedSyncEntries.delete(key)
            syncDetailTable.render()
          },
        }),
      },
      {
        sort: item => item.scope,
        cell: item => el('span', { class: 'badge badge--neutral', title: item.scope, text: scopeLabel(item.scope) }),
      },
      { sort: item => item.dataType, cell: item => el('span', { class: 'cell-mono', text: item.dataType }) },
      {
        cell: item => {
          const parsed = parseData(item.data)
          const raw = typeof item.data === 'string' ? item.data : JSON.stringify(item.data)
          return el('button', {
            class: 'btn btn--ghost btn--sm cell-clip data-preview',
            type: 'button',
            title: '点击查看完整数据',
            text: summarize(item.scope, item.dataType, parsed),
            onclick: () => showDataModal(item.scope, item.dataType, raw, item.updatedAt),
          })
        },
      },
      { sort: item => item.updatedAt, cell: item => timeCell(item.updatedAt) },
      {
        tdClass: 'col-actions',
        cell: item => el('button', {
          class: 'btn btn--danger-soft btn--sm',
          type: 'button',
          text: '删除',
          onclick: () => deleteSyncEntry(item),
        }),
      },
    ],
    empty: { icon: 'database', title: '该用户暂无数据', desc: '换一个用户试试，或等待客户端同步' },
    onRender: ({ pageRows }) => {
      const all = $('syncEntryCheckAll')
      all.checked = pageRows.length > 0 && pageRows.every(item => selectedSyncEntries.has(entryKey(item)))
      all.indeterminate = !all.checked && pageRows.some(item => selectedSyncEntries.has(entryKey(item)))

      const bar = $('syncDetailBulkBar')
      bar.hidden = selectedSyncEntries.size === 0
      $('syncDetailBulkCount').textContent = `已选择 ${selectedSyncEntries.size} 条数据`
    },
  })

  function entryKey(item) {
    return item.scope + '|' + item.dataType
  }

  async function openSyncDetail(openid) {
    syncDetailOpenid = openid
    $('syncUsersView').hidden = true
    $('syncDetailView').hidden = false
    $('syncDetailTitle').textContent = '用户数据'
    $('syncDetailSubtitle').textContent = openid
    await loadSyncDetail()
  }

  async function loadSyncDetail() {
    if (!syncDetailOpenid) return
    syncDetailTable.setLoading(true)
    const data = await apiGet('/sync-data?openid=' + encodeURIComponent(syncDetailOpenid))
    if (!data) { syncDetailTable.setLoading(false); return }
    syncEntries = data.items || []
    selectedSyncEntries.clear()
    syncEntryQuery = ''
    $('syncDetailSearch').value = ''
    applySyncEntryFilter()
  }

  function applySyncEntryFilter() {
    const query = syncEntryQuery.trim().toLowerCase()
    const filtered = query
      ? syncEntries.filter(item =>
          item.scope.toLowerCase().includes(query) || item.dataType.toLowerCase().includes(query))
      : syncEntries
    syncDetailTable.setRows(filtered, true)
  }

  $('syncDetailSearch').addEventListener('input', event => {
    syncEntryQuery = event.target.value
    applySyncEntryFilter()
  })

  $('syncDetailBack').addEventListener('click', backToSyncUsers)

  function backToSyncUsers() {
    syncDetailOpenid = ''
    syncEntries = []
    selectedSyncEntries.clear()
    $('syncDetailView').hidden = true
    $('syncUsersView').hidden = false
  }

  $('syncDetailRefresh').addEventListener('click', loadSyncDetail)

  $('syncEntryCheckAll').addEventListener('change', event => {
    document.querySelectorAll('.sync-entry-cb').forEach(box => {
      if (box.checked !== event.target.checked) {
        box.checked = event.target.checked
        box.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    syncDetailTable.render()
  })

  $('syncEntriesClearSel').addEventListener('click', () => {
    selectedSyncEntries.clear()
    syncDetailTable.render()
  })

  $('syncEntriesBulkDelete').addEventListener('click', async () => {
    const keys = Array.from(selectedSyncEntries)
    if (!keys.length) return
    const ok = await confirmDialog({
      title: '批量删除',
      message: `将删除选中的 ${keys.length} 条数据，此操作不可撤销。`,
      confirmText: '删除',
    })
    if (!ok) return
    let deleted = 0
    for (const key of keys) {
      const parts = key.split('|')
      const res = await apiPost('/sync-delete', {
        openid: syncDetailOpenid,
        scope: parts[0],
        data_type: parts.slice(1).join('|'),
      })
      if (res && res.code === 0) deleted += res.deleted || 0
    }
    toast(`已删除 ${deleted} 条记录`, 'success')
    selectedSyncEntries.clear()
    loadSyncDetail()
  })

  async function deleteSyncEntry(item) {
    const ok = await confirmDialog({
      title: '删除数据',
      message: `确定删除 ${item.scope}/${item.dataType} 吗？此操作不可撤销。`,
      confirmText: '删除',
    })
    if (!ok) return
    await mutate('/sync-delete', {
      openid: syncDetailOpenid,
      scope: item.scope,
      data_type: item.dataType,
    }, false, () => {
      toast('已删除', 'success')
      loadSyncDetail()
    })
  }

  /* ===================== 工具广告 / 工具管理 ===================== */
  function renderToolPicker(options) {
    const { container, activeIds, inputPrefix, hintText, onSave } = options
    container.textContent = ''

    if (!TOOLS_CATALOG.length) {
      const area = el('textarea', {
        class: 'input',
        id: inputPrefix + 'Input',
        rows: 4,
        placeholder: 'wooden-fish\nct-scan\nlottery',
        style: { height: 'auto', padding: '10px 12px', fontFamily: 'var(--mono)', resize: 'vertical' },
      })
      area.value = activeIds.join('\n')
      container.appendChild(el('div', null,
        el('p', { class: 'fmt-note', text: '工具目录未同步，请在 lifetools 运行 node scripts/export-tools-catalog.mjs 后即可使用勾选模式。' }),
        area,
        el('div', { class: 'toolbar-inline', style: { marginTop: '12px', paddingBottom: 0, borderBottom: 0, marginBottom: 0 } },
          el('button', {
            class: 'btn btn--primary btn--sm',
            type: 'button',
            text: '保存',
            onclick: () => {
              const ids = area.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
              const invalid = ids.filter(id => !/^[a-z0-9-]{1,64}$/.test(id))
              if (invalid.length) {
                toast('无效 id：' + invalid.slice(0, 3).join(', ') + (invalid.length > 3 ? ' …' : ''), 'error')
                return
              }
              onSave(ids)
            },
          }),
          el('span', { class: 'toolbar-inline__hint', text: hintText(activeIds.length) }))))
      return
    }

    const checkboxClass = inputPrefix + '-cb'
    const hint = el('span', { class: 'toolbar-inline__hint' })

    container.appendChild(el('div', { class: 'toolbar-inline' },
      el('button', {
        class: 'btn btn--subtle btn--sm',
        type: 'button',
        text: '全选',
        onclick: () => setAll(true),
      }),
      el('button', {
        class: 'btn btn--subtle btn--sm',
        type: 'button',
        text: '清空',
        onclick: () => setAll(false),
      }),
      el('div', { class: 'toolbar-inline__spacer' }),
      hint,
      el('button', {
        class: 'btn btn--primary btn--sm',
        type: 'button',
        text: '保存',
        onclick: () => {
          const ids = []
          document.querySelectorAll('.' + checkboxClass + ':checked').forEach(box => ids.push(box.value))
          onSave(ids)
        },
      })))

    TOOLS_CATALOG.forEach(category => {
      const grid = el('div', { class: 'tool-grid' })
      category.tools.forEach(tool => {
        const input = el('input', {
          type: 'checkbox',
          class: checkboxClass,
          value: tool.id,
          checked: activeIds.includes(tool.id),
          onchange: () => {
            input.closest('.tool-chip').classList.toggle('is-checked', input.checked)
            updateHint()
          },
        })
        const chip = el('label', { class: 'tool-chip' + (activeIds.includes(tool.id) ? ' is-checked' : '') },
          input,
          tool.icon ? el('span', { class: 'tool-chip__icon', text: tool.icon }) : null,
          el('span', { class: 'tool-chip__name', title: tool.id, text: tool.name }))
        grid.appendChild(chip)
      })

      container.appendChild(el('div', { class: 'tool-group' },
        el('div', { class: 'tool-group__head' },
          el('span', { class: 'tool-group__name', text: category.name }),
          el('span', { class: 'tool-group__count', text: category.tools.length + ' 个' })),
        grid))
    })

    const unknown = activeIds.filter(id => !TOOL_MAP[id])
    if (unknown.length) {
      container.appendChild(el('p', { class: 'unknown-ids' },
        '以下 id 不在当前工具目录中，保存时会被保留但无法勾选：' + unknown.join('、')))
    }

    function setAll(state) {
      document.querySelectorAll('.' + checkboxClass).forEach(box => {
        box.checked = state
        box.closest('.tool-chip').classList.toggle('is-checked', state)
      })
      updateHint()
    }

    function updateHint() {
      const count = document.querySelectorAll('.' + checkboxClass + ':checked').length
      hint.textContent = hintText(count)
    }
    updateHint()
  }

  async function loadAdTools() {
    const data = await apiGet('/app-config')
    if (!data) return
    let ids = []
    try {
      ids = JSON.parse((data.flags && data.flags.ad_tools) || '[]')
      if (!Array.isArray(ids)) ids = []
    } catch { ids = [] }

    renderToolPicker({
      container: $('adsBody'),
      activeIds: ids,
      inputPrefix: 'adTool',
      hintText: count => `已选择 ${count} 个工具`,
      onSave: async selected => {
        await mutate('/app-config', { key: 'ad_tools', value: JSON.stringify(selected) }, false, data => {
          toast(data && data.message ? data.message : `已保存 ${selected.length} 个工具`, 'success')
        })
      },
    })
  }

  async function loadTools() {
    const data = await apiGet('/app-config')
    if (!data) return
    let ids = []
    try {
      ids = JSON.parse((data.flags && data.flags.hidden_tools) || '[]')
      if (!Array.isArray(ids)) ids = []
    } catch { ids = [] }

    renderToolPicker({
      container: $('toolsBody'),
      activeIds: ids,
      inputPrefix: 'hiddenTool',
      hintText: count => `已隐藏 ${count} 个工具`,
      onSave: async selected => {
        await mutate('/app-config', { key: 'hidden_tools', value: JSON.stringify(selected) }, false, data => {
          toast(data && data.message ? data.message : `已保存，隐藏 ${selected.length} 个工具`, 'success')
        })
      },
    })
  }

  /* ===================== 路由与导航 ===================== */
  const PAGE_LOADERS = {
    dashboard: () => { loadStats(); loadAppConfig() },
    checks: loadChecks,
    images: loadImages,
    audit: loadAudit,
    suggestions: loadSuggestions,
    syncdata: () => { backToSyncUsers(); loadSyncUsers() },
    ads: loadAdTools,
    tools: loadTools,
  }

  let currentPage = 'dashboard'

  function go(page) {
    const link = document.querySelector(`.navlink[data-page="${page}"]`)
    if (!link) return
    currentPage = page

    document.querySelectorAll('.navlink').forEach(item => {
      const active = item === link
      item.classList.toggle('is-active', active)
      if (active) item.setAttribute('aria-current', 'page')
      else item.removeAttribute('aria-current')
    })
    document.querySelectorAll('.page').forEach(section => {
      section.hidden = section.dataset.page !== page
    })

    $('pageTitle').textContent = link.dataset.title
    $('pageSubtitle').textContent = link.dataset.subtitle
    document.title = `${link.dataset.title} · 治点工具箱管理后台`

    const loader = PAGE_LOADERS[page]
    if (loader) loader()
  }

  document.querySelectorAll('.navlink').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault()
      go(link.dataset.page)
    })
  })

  /* ---- 刷新 ---- */
  $('refreshBtn').addEventListener('click', () => {
    const loader = PAGE_LOADERS[currentPage]
    if (loader) loader()
    toast('已刷新', 'info', 1600)
  })
  document.querySelectorAll('[data-refresh]').forEach(button => {
    button.addEventListener('click', () => {
      const loader = PAGE_LOADERS[button.dataset.refresh]
      if (loader) loader()
    })
  })

  /* ===================== 危险操作 ===================== */
  $('clearChecksBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空检测记录',
      message: '将删除全部内容安全检测记录（含图片引用），此操作不可撤销。',
      confirmText: '清空',
    })
    if (!ok) return
    await mutate('/clear-store', {}, false, data => {
      toast(data && data.message ? data.message : '已清空', 'success')
      loadChecks()
      loadStats()
    })
  })

  $('pruneImagesBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清理过期图片',
      message: '将删除 24 小时前上传的图片文件，正在检测中的图片不受影响。',
      confirmText: '清理',
    })
    if (!ok) return
    await mutate('/prune-images', {}, false, data => {
      toast(data && data.message ? data.message : '已清理', 'success')
      loadImages()
      loadStats()
    })
  })

  $('deleteImagesBtn').addEventListener('click', async () => {
    const names = Array.from(selectedImages)
    if (!names.length) return
    const ok = await confirmDialog({
      title: '删除图片',
      message: `将删除选中的 ${names.length} 张图片，此操作不可撤销。`,
      confirmText: '删除',
    })
    if (!ok) return
    await mutate('/delete-images', { filenames: names }, false, data => {
      toast(data && data.message ? data.message : '已删除', 'success')
      selectedImages.clear()
      loadImages()
      loadStats()
    })
  })

  $('refreshTokenBtn').addEventListener('click', async event => {
    const button = event.currentTarget
    button.classList.add('is-loading')
    const data = await apiPost('/refresh-token', {})
    button.classList.remove('is-loading')
    if (data && data.code === 0) toast(data.message || 'Token 已刷新', 'success')
    else toast((data && data.message) || '刷新失败', 'error')
  })

  $('reloadConfigBtn').addEventListener('click', () => {
    loadAppConfig()
    toast('配置已重新加载', 'info', 1600)
  })

  /* ===================== 主题 ===================== */
  function syncTheme() {
    const dark = document.documentElement.dataset.theme === 'dark'
    $('themeToggleLabel').textContent = dark ? '浅色模式' : '深色模式'
    $('themeToggle').setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式')
  }

  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('admin-theme', next) } catch {}
    syncTheme()
  })

  /* ===================== 登录 / 登出 ===================== */
  function showLogin() {
    $('loginView').hidden = false
    $('appView').hidden = true
    $('tokenInput').value = ''
    $('tokenInput').focus()
  }

  function showApp() {
    $('loginView').hidden = true
    $('appView').hidden = false
  }

  async function logout(silent) {
    try {
      await fetch(BASE + '/logout', { method: 'POST', headers: JSON_HEADERS })
    } catch {}
    showLogin()
    if (!silent) toast('已退出登录', 'info')
  }

  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault()
    const token = $('tokenInput').value.trim()
    if (!token) {
      $('tokenInput').focus()
      return
    }

    const error = $('loginError')
    error.hidden = true
    const button = $('loginBtn')
    button.classList.add('is-loading')
    button.lastElementChild.textContent = '登录中…'

    let data = null
    try {
      const res = await fetch(BASE + '/login', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ token }),
      })
      data = await res.json().catch(() => null)
      if (res.ok) {
        button.classList.remove('is-loading')
        button.lastElementChild.textContent = '登 录'
        showApp()
        await start()
        return
      }
    } catch {
      data = null
    }

    button.classList.remove('is-loading')
    button.lastElementChild.textContent = '登 录'
    error.textContent = (data && data.message) || '登录失败，请检查网络后重试'
    error.hidden = false
    $('tokenInput').select()
  })

  $('logoutBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '退出登录',
      message: '确定要退出管理后台吗？',
      confirmText: '退出',
      danger: false,
    })
    if (ok) logout(false)
  })

  /* ===================== 启动 ===================== */
  async function loadCatalog() {
    const data = await apiGet('/tools-catalog')
    if (!Array.isArray(data)) return
    TOOLS_CATALOG = data
    TOOL_MAP.length = 0
    Object.keys(TOOL_MAP).forEach(key => delete TOOL_MAP[key])
    data.forEach(category => {
      (category.tools || []).forEach(tool => { TOOL_MAP[tool.id] = tool })
    })
  }

  async function start() {
    syncTheme()
    await loadCatalog()
    go('dashboard')
    setInterval(() => {
      if (document.visibilityState === 'visible') loadStats()
    }, 5000)
  }

  async function bootstrap() {
    try {
      const res = await fetch(BASE + '/stats', { headers: JSON_HEADERS })
      if (res.ok) {
        showApp()
        await start()
      } else {
        showLogin()
      }
    } catch {
      showLogin()
    }
  }

  syncTheme()
  bootstrap()
})()

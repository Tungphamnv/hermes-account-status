// Account Status — compact quota table for pooled ChatGPT accounts + Claude.
import { Button, EmptyState, ErrorState, GlyphSpinner, ScrollArea, StatusDot, Tip, cn, host, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useRef } from 'react'

const ID = 'account-status'
let REST = null
const KEY = [ID, 'status']
const fetchStatus = force => REST(force ? '/status?force=true' : '/status')
const useStatus = () => useQuery({ queryKey: KEY, queryFn: () => fetchStatus(false), refetchInterval: 60_000, staleTime: 30_000 })

const PROV = { 'openai-codex': 'GPT', anthropic: 'Claude', gemini: 'Gemini' }
const ORDER = { 'openai-codex': 0, anthropic: 1 }

function fmtReset(iso) {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'đã reset'
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4)
  return h >= 24 ? `reset sau ${Math.floor(h / 24)}d ${h % 24}h` : `reset sau ${h}h ${m}m`
}

function statusOf(a) {
  if (a.status === 'exhausted') return { tone: 'bad', text: `Hết quota${a.error_code ? ' (' + a.error_code + ')' : ''}` }
  const worst = Math.max(0, ...a.windows.map(w => w.used_percent || 0))
  if (worst >= 90) return { tone: 'warn', text: 'Sắp hết' }
  if (a.usage_error) return { tone: 'warn', text: 'Không đọc được quota' }
  return { tone: 'good', text: 'Sẵn sàng' }
}

const sorted = data => [...(data?.accounts || [])].filter(a => a.provider in ORDER)
  .sort((x, y) => ORDER[x.provider] - ORDER[y.provider] || x.index - y.index)
const win = (a, l) => a.windows.find(w => w.label === l)
const short = a => (a.email ? a.email.split('@')[0] : a.label)

function Pct({ w }) {
  if (!w) return jsx('span', { className: 'w-10 text-right text-(--ui-text-quaternary)', children: '—' })
  const p = Math.round(w.used_percent || 0)
  const color = p >= 90 ? 'var(--ui-danger, #e5484d)' : p >= 70 ? 'var(--ui-warning, #f5a623)' : undefined
  return jsx(Tip, { label: fmtReset(w.reset_at), children: jsx('span', { className: 'w-10 text-right tabular-nums', style: { color }, children: p + '%' }) })
}

function Table({ data, dense }) {
  const accts = sorted(data)
  if (!accts.length) return jsx(EmptyState, { title: 'Chưa có tài khoản nào' })
  const row = 'flex items-center gap-2 rounded px-1 ' + (dense ? 'py-0.5' : 'py-1.5')
  return jsxs('div', { className: cn('flex flex-col', dense ? 'text-[0.6875rem]' : 'text-xs'), children: [
    jsxs('div', { className: row + ' text-(--ui-text-quaternary)', children: [
      jsx('span', { className: 'w-1.5' }), jsx('span', { className: 'flex-1', children: 'Tài khoản' }),
      jsx('span', { className: 'w-10 text-right', children: '5h' }), jsx('span', { className: 'w-10 text-right', children: 'Tuần' })
    ] }),
    ...accts.map(a => {
      const st = statusOf(a)
      return jsxs('div', { className: row + ' hover:bg-(--chrome-action-hover)', children: [
        jsx(Tip, { label: st.text + (a.usage_error ? ' — ' + a.usage_error : ''), children: jsx(StatusDot, { tone: st.tone }) }),
        jsxs('span', { className: cn('flex-1 truncate', a.current ? 'font-medium text-foreground' : 'text-(--ui-text-secondary)'), title: `${a.email || a.label}${a.plan ? ' · ' + String(a.plan).toUpperCase() : ''}`, children: [
          jsx('span', { className: 'text-(--ui-text-quaternary)', children: PROV[a.provider] + ' · ' }), short(a), a.current ? ' ●' : ''
        ] }),
        jsx(Pct, { w: win(a, 'Session') }),
        jsx(Pct, { w: win(a, 'Weekly') })
      ] }, a.provider + a.id)
    })
  ] })
}

function MiniPane() {
  const q = useStatus()
  if (q.isLoading) return jsx('div', { className: 'p-2 text-xs text-(--ui-text-quaternary)', children: '…' })
  if (q.error) return jsx('div', { className: 'p-2 text-xs text-(--ui-text-quaternary)', children: 'Không tải được quota' })
  return jsxs('div', { className: 'h-full overflow-auto px-2 py-1', children: [
    jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => host.navigate('/accounts'), children: 'Thêm tài khoản · Ưu tiên' }),
    jsx(Table, { data: q.data, dense: true })
  ] })
}

// Never render arbitrary server/IPC error text: it may contain credentials.
function managementError(error, path) {
  const text = String(error?.message || '')
  const candidate = Number(error?.statusCode || error?.status || text.match(/(?:^|\bHTTP\s+|\bstatus\s+)([45]\d\d)\b/i)?.[1] || text.match(/\b([45]\d\d):/)?.[1])
  const status = candidate >= 400 && candidate <= 599 ? candidate : null
  const hints = {
    400: 'Yêu cầu không hợp lệ. Làm mới tài khoản rồi thử lại.',
    401: 'Phiên kết nối hết hạn. Kết nối lại gateway.',
    403: 'Gateway từ chối quyền quản lý tài khoản.',
    404: text.includes('Not Found')
      ? 'Gateway đang chạy chưa có API quản lý. Cần khởi động lại gateway/backend khi không còn tác vụ; chỉ mở lại Desktop không đủ.'
      : 'Không tìm thấy API hoặc tài khoản. Làm mới; nếu còn lỗi, kiểm tra gateway/backend.',
    409: 'Đang đăng nhập hoặc tài khoản đã thay đổi. Hoàn tất cửa sổ đăng nhập rồi làm mới.',
    422: 'Dữ liệu yêu cầu không đúng hợp đồng API. Làm mới plugin rồi thử lại.',
    501: 'Mở cửa sổ đăng nhập hiện chỉ hỗ trợ gateway Windows.',
    503: 'Gateway không mở được cửa sổ đăng nhập. Kiểm tra backend trên máy chạy gateway.'
  }
  return `${path} · ${status ? 'HTTP ' + status : 'Lỗi kết nối'} — ${hints[status] || (status ? 'Lỗi gateway/backend. Kiểm tra nhật ký backend; không gửi thông tin đăng nhập vào chat.' : 'Không kết nối được gateway hoặc đã hết thời gian chờ. Kiểm tra kết nối rồi thử lại.')}`
}

function Management({ data }) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const lock = useRef(false)
  const qc = useQueryClient()
  const act = async (path, work) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setMessage('')
    try { await work() }
    catch (error) { setMessage(managementError(error, path)) }
    finally { lock.current = false; setBusy(false) }
  }
  const add = provider => act('/accounts/add', async () => {
    await REST('/accounts/add', { method: 'POST', body: { provider } })
    setMessage('Đã mở cửa sổ đăng nhập riêng. Hoàn tất trong trình duyệt; Claude yêu cầu dán mã trực tiếp vào cửa sổ đó, không vào chat. Sau đó bấm Làm mới.')
    setAdding(false)
  })
  const move = (a, direction) => act('/priority', async () => {
    await REST('/priority', { method: 'POST', body: { provider: a.provider, credential_id: a.id, direction } })
    qc.setQueryData(KEY, await fetchStatus(true))
    setMessage('Đã lưu ưu tiên vào credential pool. Hermes có thể giữ tài khoản đang chạy cho đến lần chọn tiếp theo.')
  })
  const accounts = sorted(data)
  return jsxs('section', { className: 'flex flex-col gap-2 text-xs', children: [
    jsx(Button, { size: 'sm', variant: 'outline', onClick: () => setAdding(v => !v), disabled: busy, children: 'Thêm tài khoản' }),
    adding && jsxs('div', { className: 'flex flex-col gap-2', children: [
      jsx('p', { children: 'Chọn nhà cung cấp. Đăng nhập tài khoản KHÁC trong trình duyệt; cùng tài khoản không tăng quota và có thể vô hiệu phiên cũ.' }),
      jsxs('div', { className: 'flex gap-2', children: [
        jsx(Button, { size: 'sm', disabled: busy, onClick: () => void add('openai-codex'), children: 'GPT · ChatGPT OAuth' }),
        jsx(Button, { size: 'sm', disabled: busy, onClick: () => void add('anthropic'), children: 'Claude · Pro/Max OAuth' })
      ] })
    ] }),
    jsx('p', { className: 'text-(--ui-text-tertiary)', children: 'Ưu tiên trong CÙNG nhà cung cấp (trên trước). Fill-first chuyển tài khoản khi hết quota; chiến lược pool khác có thể chọn khác. GPT → Claude là model fallback riêng, không được cấu hình ở đây. Claude Code bên ngoài pool chỉ hiển thị quota.' }),
    ...accounts.filter(a => a.id !== 'claude-oauth').map(a => {
      const siblings = accounts.filter(b => b.provider === a.provider && b.id !== 'claude-oauth')
      const i = siblings.findIndex(b => b.id === a.id)
      return jsxs('div', { className: 'flex items-center gap-2', children: [
        jsx('span', { className: 'flex-1 truncate', children: `${PROV[a.provider]} #${i + 1} · ${short(a) || a.id}` }),
        jsx(Button, { size: 'sm', variant: 'ghost', disabled: busy || i === 0, 'aria-label': `Tăng ưu tiên ${a.label || a.id}`, onClick: () => void move(a, 'up'), children: '↑' }),
        jsx(Button, { size: 'sm', variant: 'ghost', disabled: busy || i === siblings.length - 1, 'aria-label': `Giảm ưu tiên ${a.label || a.id}`, onClick: () => void move(a, 'down'), children: '↓' })
      ] }, a.provider + a.id)
    }),
    message && jsx('p', { role: 'status', children: message })
  ] })
}

function Page() {
  const q = useStatus()
  const qc = useQueryClient()
  const refresh = async () => { qc.setQueryData(KEY, await fetchStatus(true)) }
  if (q.isLoading) return jsx('div', { className: 'flex h-full items-center justify-center', children: jsx(GlyphSpinner, {}) })
  if (q.error) return jsx(ErrorState, { title: 'Không tải được', description: String(q.error?.message || q.error) + ' — thoát hẳn Hermes rồi mở lại.' })
  return jsx(ScrollArea, { className: 'h-full', children: jsxs('div', { className: 'flex max-w-md flex-col gap-2 p-3', children: [
    jsx(Management, { data: q.data }),
    jsx(Table, { data: q.data }),
    jsxs('div', { className: 'flex items-center justify-between px-1 text-[0.6875rem] text-(--ui-text-quaternary)', children: [
      jsx('span', { children: '● đang dùng · rê chuột xem giờ reset' }),
      jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => void refresh(), children: 'Làm mới' })
    ] })
  ] }) })
}

function Chip() {
  const q = useStatus()
  const accts = sorted(q.data)
  const cur = accts.find(a => a.current && a.provider === 'openai-codex')
  const cl = accts.find(a => a.provider === 'anthropic')
  const p = a => { const w = a && win(a, 'Weekly'); return w ? Math.round(w.used_percent) + '%' : '—' }
  const label = q.data ? `GPT ${p(cur)} · Claude ${p(cl)}` : 'Quota …'
  return jsx(Tip, { label: 'Quota tuần (tài khoản đang dùng)', children: jsx('button', {
    type: 'button', onClick: () => host.navigate('/accounts'),
    className: 'inline-flex h-full items-center px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
    children: label
  }) })
}

export default {
  id: ID,
  name: 'Account Status',
  register(ctx) {
    REST = (p, o) => ctx.rest(p, o)
    ctx.register({ id: 'mini', area: 'panes', title: 'Quota', render: () => jsx(MiniPane, {}),
      data: { placement: 'left', dock: { pane: 'sessions', pos: 'bottom' }, height: '120px' } })
    ctx.register({ id: 'page', area: 'routes', data: { path: '/accounts' }, render: () => jsx(Page, {}) })
    ctx.register({ id: 'nav', area: 'sidebar.nav', data: { path: '/accounts', label: 'Accounts', codicon: 'account' } })
    ctx.register({ id: 'chip', area: 'statusBar.right', render: () => jsx(Chip, {}) })
  }
}

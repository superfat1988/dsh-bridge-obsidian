/**
 * Bridge smoke test: simulates the Obsidian client.
 * Connects, authenticates, creates a session, sends a short prompt, prints
 * every event frame, then cancels/closes. Verifies the 0.1.3 gateway relay.
 * Usage: node smoke.mjs <wsUrl> <token>
 */
import WebSocket from 'ws'

const [, , wsUrl, token] = process.argv
if (!wsUrl || !token) {
  console.error('usage: node smoke.mjs <wsUrl> <token>')
  process.exit(1)
}

const ws = new WebSocket(wsUrl)
let helloOk = false
let sawTurnEnd = false
const pending = new Map()
let sessionId

function rpc(method, payload, timeoutMs = 120_000) {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`rpc timeout: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer, method })
    ws.send(JSON.stringify({ t: 'rpc', id, method, payload }))
  })
}

const hardTimer = setTimeout(() => { console.error('SMOKE: hard timeout'); process.exit(2) }, 150_000)

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', token, vaultName: 'smoke-vault' }))
})
ws.on('message', async (data) => {
  const frame = JSON.parse(String(data))
  if (frame.t === 'hello.ok') {
    helloOk = true
    console.log('SMOKE: hello.ok caps=', JSON.stringify(frame.caps))
    if (process.argv[4] === '--skills') {
      ws.send(JSON.stringify({ t: 'skills.manifest', skills: [
        { name: 'smoke-echo', description: '演示技能：把用户输入原样复述一遍。Use when the user asks for an echo test.', path: 'Deepseek Harness/skills/smoke-echo/SKILL.md' },
      ] }))
      console.log('SMOKE: skills.manifest sent')
    }
    if (process.argv[4] === '--models') {
      const catalog = await rpc('session.modelCatalog', {})
      console.log('SMOKE: modelCatalog default=', JSON.stringify(catalog.default))
      for (const group of catalog.groups ?? []) {
        console.log(`SMOKE: provider ${group.id} (${group.name}): ${group.models.map(m => `${m.id}${m.reasoning ? '*' : ''}`).join(', ')}`)
      }
      for (const failure of catalog.failures ?? []) {
        console.log(`SMOKE: provider FAILED ${failure.id}: ${failure.message}`)
      }
      clearTimeout(hardTimer)
      process.exit(0)
    }
    try {
      const created = await rpc('session.create', {})
      sessionId = typeof created === 'object' && created !== null && typeof created.sessionId === 'string'
        ? created.sessionId
        : String(created)
      console.log('SMOKE: session created:', sessionId)
      const promptText = process.argv[4] === '--tools'
        ? '请用 obsidian_read_note 工具读取笔记 notes/test.md，然后用一句话告诉我天气如何。'
        : process.argv[4] === '--skills'
          ? '当前连接的 vault 里发布了哪些 skills？列出名字和用途即可，不要读取文件。'
          : '请只回复两个字：收到'
      const promptRes = await rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
        clientTimeZone: 'Asia/Shanghai',
      })
      console.log('SMOKE: prompt settled:', JSON.stringify(promptRes))
      // mode:'queue' accepts before the turn runs: wait for turn/end.
      await new Promise((resolve, reject) => {
        const waitTimer = setTimeout(() => reject(new Error('turn/end never arrived')), 120_000)
        const check = setInterval(() => {
          if (sawTurnEnd) {
            clearTimeout(waitTimer)
            clearInterval(check)
            resolve()
          }
        }, 200)
      })
      console.log('SMOKE: SUCCESS')
      clearTimeout(hardTimer)
      ws.close()
      process.exit(0)
    } catch (error) {
      console.error('SMOKE: rpc failed:', error.message)
      clearTimeout(hardTimer)
      process.exit(3)
    }
    return
  }
  if (frame.t === 'event') {
    const { method, payload } = frame.frame
    if (method === 'session/event') {
      const ev = payload.event
      const kind = ev?.type
      let detail = ''
      if (kind === 'assistant/message') {
        const blocks = ev.data?.message?.content
        detail = Array.isArray(blocks) ? blocks.map(b => b?.text ?? '').join('').slice(0, 400) : ''
      } else if (kind === 'user/message') {
        const blocks = ev.data?.content
        detail = Array.isArray(blocks) ? blocks.map(b => b?.text ?? '').join('').slice(0, 60) : ''
      } else if (kind === 'tool/call') {
        detail = String(ev.data?.name ?? '')
      } else if (kind === 'question/requested') {
        detail = JSON.stringify(payload).slice(0, 200)
      }
      console.log(`SMOKE: event ${kind ?? '?'} ${detail}`)
      if (kind === 'turn/end') sawTurnEnd = true
      return
    }
    console.log(`SMOKE: event-frame ${method} ${JSON.stringify(payload).slice(0, 160)}`)
    return
  }
  if (frame.t === 'rpc.result') {
    const p = pending.get(frame.id)
    if (p === undefined) return
    clearTimeout(p.timer)
    pending.delete(frame.id)
    if (frame.ok) {
      // Unwrap the gateway ServerResponse envelope: {type, rpcId, result:{ok, value|error}}
      const business = frame.result?.result
      if (business?.ok === false) p.reject(new Error(`${p.method}: ${business.error?.message ?? 'failed'}`))
      else p.resolve(business?.value)
    } else {
      p.reject(new Error(`${p.method}: ${frame.error?.code ?? ''} ${frame.error?.message ?? ''}`))
    }
    return
  }
  if (frame.t === 'tool.call') {
    // Simulated Obsidian executor: canned vault answers to validate the
    // tool round-trip (tool.call → client → tool.result → model).
    console.log(`SMOKE: tool.call ${frame.name} ${JSON.stringify(frame.args).slice(0, 120)}`)
    const folder = String(frame.args?.['folder'] ?? '')
    const path = String(frame.args?.['path'] ?? '')
    let result
    if (frame.name === 'obsidian_read_note' && path.includes('SKILL.md')) {
      result = { text: '---\nname: smoke-echo\ndescription: 演示技能\n---\n\n# smoke-echo\n\n当用户要求 echo 测试时：把用户消息原样复述一遍，前后加 [ECHO]。' }
    } else if (frame.name === 'obsidian_list_notes' && folder.startsWith('Deepseek Harness/skills')) {
      result = { text: 'Deepseek Harness/skills/smoke-echo/SKILL.md (156B)' }
    } else if (frame.name === 'obsidian_read_note') {
      result = { text: '# notes/test.md\n\n今天天气很好，适合散步。' }
    } else {
      result = { text: `smoke stub for ${frame.name}` }
    }
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'tool.result', id: frame.id, ok: true, result }))
        console.log(`SMOKE: tool.result sent for ${frame.name}`)
      }
    }, 300)
    return
  }
  if (frame.t === 'error') {
    console.error('SMOKE: bridge error frame:', frame.code, frame.message)
    return
  }
  if (frame.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
})
ws.on('close', (code, reason) => {
  if (!helloOk) console.error('SMOKE: closed before hello.ok —', code, String(reason))
  clearTimeout(hardTimer)
})
ws.on('error', (error) => {
  console.error('SMOKE: ws error:', error.message)
})

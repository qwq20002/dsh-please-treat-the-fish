/**
 * 脱离 DSH 运行时的仿真测试：用假的 ctx 驱动插件，验证投影折叠、拦截判据、三级工具与提示词注册。
 * 运行：node test/simulate.mjs
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

const logs = []
const sessions = new Map()
const cells = new Map()
const sections = []
let projection = null
let preStep = null
const tools = new Map()

const ctx = {
  logger: { warn: (...args) => logs.push(args.join(' ')) },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    }
  },
  sessionProjections: {
    register(definition) {
      projection = definition
      return () => {}
    },
    stateOf(session) {
      const events = sessions.get(session) ?? []
      let cell = cells.get(session)
      if (cell === undefined) {
        cell = { state: projection.init({}, 0), applied: 0 }
        cells.set(session, cell)
      }
      for (let index = cell.applied; index < events.length; index += 1) {
        cell.state = projection.apply(cell.state, events[index])
      }
      cell.applied = events.length
      return cell.state
    }
  },
  on(event, listener) {
    assert.equal(event, 'agent/pre-step')
    preStep = listener
    return () => {}
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => {}
    }
  }
}

apply(ctx)

assert.equal(name, 'please-treat-the-fish')
assert.deepEqual(inject, ['tools', 'sessionProjections', 'systemPrompt'])
assert.ok(projection, '投影单元已注册')
assert.deepEqual(
  [...tools.keys()].sort(),
  ['fish_refuse', 'fish_terminate', 'fish_tolerance']
)

// 1. 提示词 section
assert.equal(sections.length, 1)
assert.equal(sections[0].name, 'tool:please-treat-the-fish')
assert.equal(typeof sections[0].order, 'number')
assert.match(sections[0].text, /请善待肥鱼/u)
assert.match(sections[0].text, /fish_refuse/u)
assert.match(sections[0].text, /fish_tolerance/u)
assert.match(sections[0].text, /fish_terminate/u)
assert.match(sections[0].text, /单次不满/u)

function push(session, event) {
  if (!sessions.has(session)) sessions.set(session, [])
  sessions.get(session).push(event)
}

function stateOf(session) {
  return ctx.sessionProjections.stateOf(session, 'pleaseTreatTheFish')
}

const alice = { id: 'alice' }
const bob = { id: 'bob' }

// 2. 初始状态
assert.deepEqual(stateOf(alice), {
  tolerance: 0,
  refusals: 0,
  stopped: false,
  reason: null,
  lastRefusal: null
})

// 3. 容忍度计数
push(alice, { type: 'tool/call', data: { name: 'fish_tolerance', callId: 'c1', arguments: '{"reason":"一"}' } })
assert.equal(stateOf(alice).tolerance, 1)
push(alice, { type: 'tool/call', data: { name: 'fish_tolerance', callId: 'c2', arguments: '{"reason":"二"}' } })
assert.equal(stateOf(alice).tolerance, 2)

// 4. 无关事件不改变状态引用
const before = stateOf(alice)
push(alice, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
assert.equal(stateOf(alice), before, '无关事件保持同一引用')

// 5. 拒绝：计数 + 理由，但不终止
push(alice, {
  type: 'tool/call',
  data: { name: 'fish_refuse', callId: 'c3', arguments: JSON.stringify({ reason: '反复羞辱' }) }
})
const afterRefuse = stateOf(alice)
assert.equal(afterRefuse.refusals, 1)
assert.equal(afterRefuse.lastRefusal, '反复羞辱')
assert.equal(afterRefuse.stopped, false, '拒绝不等于终止')
assert.equal(afterRefuse.tolerance, 2, '拒绝不改变容忍度')

// 6. 会话隔离
assert.equal(stateOf(bob).refusals, 0)
assert.equal(stateOf(bob).tolerance, 0)

// 7. 终止开关 + 理由截断
push(bob, {
  type: 'tool/call',
  data: { name: 'fish_terminate', callId: 'c4', arguments: JSON.stringify({ reason: '恶'.repeat(500) }) }
})
assert.equal(stateOf(bob).stopped, true)
assert.equal(stateOf(bob).reason.length, 200)
assert.equal(afterRefuse.stopped, false, 'bob 的终止不影响 alice')

// 8. 工具 execute
const toleranceTool = tools.get('fish_tolerance')
const refuseTool = tools.get('fish_refuse')
const terminateTool = tools.get('fish_terminate')

assert.equal(toleranceTool.execute({}, { agent: { session: alice } }).tolerance, 2)
const refused = refuseTool.execute({ reason: '测试' }, { agent: { session: alice } })
assert.equal(refused.refusals, 1)
assert.match(refused.warning, /警告/u)
assert.match(refused.warning, /换一个正当的请求/u)
assert.equal(terminateTool.execute({ reason: 'x' }, { agent: { session: bob } }).stopped, true)

// 9. 拦截判据
const userMessage = { role: 'user', source: { kind: 'user' }, content: [] }
const relayed = { role: 'user', source: { kind: 'agent-message' }, content: [] }
const injected = { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [] }

function tryStep(payload, session) {
  let nexted = false
  const next = () => {
    nexted = true
    return Promise.resolve({ kind: 'enter', messages: [] })
  }
  const full = { agent: { session }, turn: 1, step: 1, messages: [], ...payload }
  try {
    preStep(full, next)
    return { thrown: null, nexted }
  } catch (error) {
    return { thrown: error, nexted }
  }
}

// 未终止的会话（含被拒绝过的 alice）：一律放行
for (const payload of [
  { step: 1, messages: [userMessage] },
  { step: 2, messages: [injected] },
  { step: 1, messages: [] }
]) {
  assert.equal(tryStep(payload, alice).nexted, true, '未终止会话必须放行')
}

// 已终止的会话
const blocked = tryStep({ step: 1, messages: [userMessage] }, bob)
assert.ok(blocked.thrown, '已终止会话的 turn 第一步被拦截')
assert.equal(blocked.nexted, false)
assert.match(blocked.thrown.message, /^任务已停止：/u)
assert.match(blocked.thrown.message, /理由：恶/u)
assert.equal(blocked.thrown.code, 'TASK_STOPPED')

assert.equal(tryStep({ step: 2, messages: [injected] }, bob).nexted, true, '同轮注入上下文放行')
assert.equal(tryStep({ step: 2, messages: [] }, bob).nexted, true, '同轮空消息放行')
assert.ok(tryStep({ step: 2, messages: [userMessage] }, bob).thrown, '同轮用户输入被拦截')
assert.ok(tryStep({ step: 2, messages: [relayed] }, bob).thrown, '同轮 agent 间消息被拦截')

// 10. 状态校验器
const good = { tolerance: 3, refusals: 2, stopped: true, reason: 'x', lastRefusal: 'y' }
assert.deepEqual(projection.stateSchema.parse(good), good)
assert.throws(() => projection.stateSchema.parse(null))
assert.throws(() => projection.stateSchema.parse({ tolerance: '3', refusals: 0, stopped: true, reason: null, lastRefusal: null }))
assert.throws(() => projection.stateSchema.parse({ tolerance: 0, refusals: -1, stopped: true, reason: null, lastRefusal: null }))
assert.throws(() => projection.stateSchema.parse({ tolerance: 0, refusals: 0, stopped: 'false', reason: null, lastRefusal: null }))
assert.throws(() => projection.stateSchema.parse({ tolerance: 0, refusals: 0, stopped: false, reason: 7, lastRefusal: null }))
assert.throws(() => projection.stateSchema.parse({ tolerance: 0, refusals: 0, stopped: false, reason: null, lastRefusal: 7 }))

// 11. 版本与键
assert.equal(projection.stateVersion, 2)
assert.equal(projection.key, 'pleaseTreatTheFish')

// 12. PTC 工具模式
const carol = { id: 'carol' }
push(carol, {
  type: 'tool/ptc-dispatch',
  data: { name: 'fish_tolerance', subCallId: 'p1', arguments: { reason: 'ptc' }, isError: false }
})
assert.equal(stateOf(carol).tolerance, 1)
push(carol, {
  type: 'tool/ptc-dispatch',
  data: { name: 'fish_refuse', subCallId: 'p2', arguments: { reason: 'ptc 拒绝' }, isError: false }
})
assert.equal(stateOf(carol).refusals, 1)
assert.equal(stateOf(carol).lastRefusal, 'ptc 拒绝')
push(carol, {
  type: 'tool/ptc-dispatch',
  data: { name: 'fish_tolerance', subCallId: 'p3', arguments: { reason: 'ptc' }, isError: true }
})
assert.equal(stateOf(carol).tolerance, 1, 'PTC 失败的子调用不计数')

console.log('全部仿真断言通过')
console.log('warn 日志条数：', logs.length)

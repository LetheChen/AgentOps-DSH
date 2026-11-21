import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  buildAffairRequest,
  buildFlowDataRequest,
  buildFlowStateRequest,
  filterByScope,
  filterByTime,
  normalizeAffair,
  readAffairRows,
  readAttachmentMetadata,
  readFormFields,
  readFormState,
  readFlowState,
  readScopes,
  readTimeRange,
  resolveOaSubject,
} from '../src/oa-tools.ts'
import { parseOaJson } from '../src/oa-affairs.ts'
import * as oaTools from '../src/oa-tools.ts'
import { CapabilityError } from '../src/errors.ts'
import type { CapabilityRuntime } from '../src/types.ts'

function runtime(config: Record<string, unknown>): CapabilityRuntime {
  return {
    agentPreset: 'oa_assistant',
    capabilityId: 'oa',
    instanceId: 'oa-production',
    name: 'OA',
    config,
    accessPolicy: {},
    secret: 'pa55',
    credentialGeneration: 'gen-1',
  }
}

void test('affairs rows are read from the shapes the platform returns', () => {
  assert.equal(readAffairRows([{ id: 'a' }]).length, 1)
  assert.equal(readAffairRows({ data: [{ id: 'a' }, { id: 'b' }] }).length, 2)
  assert.equal(readAffairRows({ dataList: [{ id: 'a' }] }).length, 1)
  assert.equal(readAffairRows({ data: { data: [{ id: 'a' }] } }).length, 1)
})

void test('an invalid affairs response is not reported as an empty result', () => {
  assert.throws(
    () => readAffairRows({ unrelated: 1 }),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_RESPONSE_INVALID',
  )
  assert.throws(
    () => readAffairRows(undefined),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_RESPONSE_INVALID',
  )
  assert.throws(
    () => readAffairRows({ data: null }),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_RESPONSE_INVALID',
  )
})

void test('an affairs row keeps the fields the tool reports', () => {
  const item = normalizeAffair({
    id: 'affair-1',
    subject: '差旅报销',
    createDate: 1402906375000,
    app: 1,
    objectId: 'OBJ-1',
    state: '3',
    subState: '11',
    completeTime: 1402906775000,
    extraMap: { urllink: 'https://oa.example/affair/1' },
  })
  assert.equal(item.id, 'affair-1')
  assert.equal(item.subject, '差旅报销')
  assert.equal(item.create_date, '2014-06-16 16:12:55')
  assert.equal(item.app, 'collaboration')
  assert.equal(item.object_id, 'OBJ-1')
  assert.equal(item.state, '3')
  assert.equal(item.complete_time, '2014-06-16 16:19:35')
  assert.equal(item.url_link, 'https://oa.example/affair/1')
})

void test('an affairs row without optional fields reports nulls', () => {
  assert.equal(normalizeAffair({ id: 'a' }).complete_time, null)
  assert.equal(normalizeAffair({ id: 'a' }).url_link, null)
})

void test('the query identity comes only from explicit instance fields', () => {
  const subject = resolveOaSubject(runtime({
    member_code: '0001',
    member_id: 'm-1',
    login_name: 'zhangsan',
  }))
  assert.equal(subject.memberCode, '0001')
  assert.equal(subject.memberId, 'm-1')
  assert.equal(subject.loginName, 'zhangsan')
  assert.throws(
    () => resolveOaSubject(runtime({})),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_IDENTITY_UNBOUND',
  )
})

void test('pending and done address a person by member code', () => {
  const subject = { memberCode: '0001', memberId: null, loginName: null }
  assert.equal(buildAffairRequest('pending', subject).path, '/seeyon/rest/affairs/pending/code/0001')
  assert.equal(buildAffairRequest('done', subject).path, '/seeyon/rest/affairs/done/code/0001')
})

void test('only the pending box supports member id without a member code', () => {
  const subject = { memberCode: null, memberId: 'm-1', loginName: null }
  const pending = buildAffairRequest('pending', subject)
  assert.equal(pending.path, '/seeyon/rest/affairs/pending')
  assert.equal(pending.query['memberId'], 'm-1')
  assert.equal(pending.query['apps'], '1')
  assert.throws(
    () => buildAffairRequest('done', subject),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_IDENTITY_UNBOUND',
  )
})

void test('the time range argument is read defensively', () => {
  assert.deepEqual(readTimeRange({ start: '2026-01-01' }), { start: '2026-01-01' })
  assert.deepEqual(readTimeRange({ start: 'a', end: 'b' }), { start: 'a', end: 'b' })
  assert.deepEqual(readTimeRange('nonsense'), {})
  assert.deepEqual(readTimeRange(undefined), {})
})

void test('time and scope filters use normalized fields', () => {
  const items = [
    normalizeAffair({ id: 'a', subject: '差旅报销', createDate: '2026-11-19 10:00:00', app: 'collaboration' }),
    normalizeAffair({ id: 'b', subject: '采购合同', createDate: '2026-11-20 10:00:00', app: 'collaboration' }),
  ]
  assert.deepEqual(filterByTime(items, '2026-11-20', '2026-11-20').map(item => item.id), ['b'])
  assert.deepEqual(filterByScope(items, ['采购']).map(item => item.id), ['b'])
  assert.throws(
    () => filterByTime(items, 'not-a-date'),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_CONFIG_INVALID',
  )
})

void test('the scope argument keeps only its strings', () => {
  assert.deepEqual(readScopes(['差旅报销', '采购合同']), ['差旅报销', '采购合同'])
  assert.deepEqual(readScopes([]), undefined)
  assert.equal(readScopes('nonsense'), undefined)
})

void test('execute scans pages through the REST transport and sends the token subject', async () => {
  const ctx = new Context()
  const registered: unknown[] = []
  const transportRequests: unknown[] = []
  const responses = [
    {
      ok: true,
      status: 200,
      json: [{ id: 'affair-1', subject: '差旅报销', createDate: 1763532000000, app: 1, objectId: 'OBJ-1' }],
      text: '',
      rawText: '',
      contentType: 'application/json',
      token: null,
    },
    { ok: true, status: 200, json: [], text: '', contentType: 'application/json', token: null },
  ]
  const oaRuntime = runtime({ member_code: '0001', login_name: 'zhangsan' })

  await ctx.plugin({
    name: 'capability-host',
    inject: [],
    apply: (c) => {
      c.reflect.provide('tools', { register: (tool: unknown) => { registered.push(tool) } })
      c.reflect.provide('capabilityRuntime', { resolve: () => oaRuntime })
      c.reflect.provide('capabilityRest', {
        transport: {
          request: async (...request: unknown[]) => {
            transportRequests.push(request)
            return responses.shift()
          },
        },
      })
    },
  })

  await ctx.plugin(oaTools, { agentPreset: 'oa_assistant' })
  const tool = registered[0] as {
    name: string
    execute: (args: Record<string, unknown>) => Promise<{
      ok: boolean
      items: readonly { id: string }[]
      note: string
      box: string
      scanned_pages: number
    }>
  }
  assert.equal(tool.name, 'oa_affair_query')

  const result = await tool.execute({ box: 'pending', page_size: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.box, 'pending')
  assert.equal(result.items.length, 1)
  assert.equal(result.scanned_pages, 2)
  assert.equal(transportRequests.length, 2)
  const firstRequest = transportRequests[0] as [CapabilityRuntime, Record<string, unknown>]
  assert.equal(firstRequest[1]['path'], '/seeyon/rest/affairs/pending/code/0001')
  assert.deepEqual(firstRequest[1]['subject'], { memberCode: '0001', loginName: 'zhangsan' })
  assert.match(result.note, /OA 不返回总数/)
})

void test('execute fails when the vendor returns a non-JSON success page', async () => {
  const ctx = new Context()
  const registered: unknown[] = []
  const oaRuntime = runtime({ member_code: '0001' })
  await ctx.plugin({
    name: 'capability-host',
    inject: [],
    apply: (c) => {
      c.reflect.provide('tools', { register: (tool: unknown) => { registered.push(tool) } })
      c.reflect.provide('capabilityRuntime', { resolve: () => oaRuntime })
      c.reflect.provide('capabilityRest', {
        transport: {
          request: async () => ({
            ok: true,
            status: 200,
            json: undefined,
            text: '<html>error</html>',
            rawText: '<html>error</html>',
            contentType: 'text/html',
            token: null,
          }),
        },
      })
    },
  })
  await ctx.plugin(oaTools, { agentPreset: 'oa_assistant' })
  const tool = registered[0] as { execute: (args: Record<string, unknown>) => Promise<{ ok: boolean; note: string }> }
  const result = await tool.execute({ box: 'pending' })
  assert.equal(result.ok, false)
  assert.match(result.note, /响应不是 JSON/)
  assert.match(result.note, /text\/html/)
})


void test('oversized vendor ids remain strings', () => {
  const payload = parseOaJson('{"objectId": -1143255087202087800, "id": 123}')
  assert.deepEqual(payload, { objectId: '-1143255087202087800', id: 123 })
})

void test('flow state reads the plain-text integer and keeps wording discipline', () => {
  const state = readFlowState('0\n')
  assert.equal(state.flow_state, 0)
  assert.equal(state.state_label, '已完成（已归档）')
  assert.match(state.state_caveat, /不等于审批通过/)
  assert.throws(
    () => readFlowState('<html>error</html>'),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_RESPONSE_INVALID',
  )
})

void test('form state maps vendor completion fields without inventing timestamps', () => {
  const form = readFormState({ ApproveDate: 1795099829000, FinishedFlag: true, State: 2 })
  const rowData = readFormState({ RowData: { approve_date: 1795099829000, finishedflag: 0, state: 1 } })
  assert.equal(form?.approve_date, '2026-11-19 22:50:29')
  assert.equal(form?.finished_flag, 'true')
  assert.equal(form?.form_state, '2')
  assert.equal(rowData?.approve_date, '2026-11-19 22:50:29')
  assert.equal(rowData?.finished_flag, '0')
  assert.equal(rowData?.form_state, '1')
  assert.equal(readFormState(undefined), undefined)
})

void test('flow export fields keep display labels and truncate nested values', () => {
  const fields = readFormFields({
    formContent: { values: [
      { displayName: '报销金额', value: '123.45' },
      { displayName: '报销金额', value: '999.99' },
      { displayName: '事由', value: { nested: true } },
    ] },
  })
  assert.deepEqual(fields, [
    { label: '报销金额', value: '123.45' },
    { label: '事由', value: '{"nested":true}' },
  ])
})

void test('attachment metadata is read without downloading files', () => {
  const attachments = readAttachmentMetadata({
    attachmentList: [
      { id: 'file-1', fileName: 'invoice.pdf', filesuffix: '.PDF' },
      { id: 'file-2', name: 'trip.xlsx' },
      { name: 'missing-id.pdf' },
    ],
  })
  assert.deepEqual(attachments, [
    { file_id: 'file-1', name: 'invoice.pdf', suffix: 'pdf' },
    { file_id: 'file-2', name: 'trip.xlsx', suffix: 'xlsx' },
  ])
})

void test('detail routes address objectId exactly', () => {
  assert.equal(buildFlowStateRequest('  OBJ-1  '), '/seeyon/rest/flow/state/OBJ-1')
  assert.deepEqual(buildFlowDataRequest('OBJ-1'), {
    path: '/seeyon/rest/flow/data/OBJ-1',
    query: { exportType: '0', exportFormat: 'json' },
  })
  assert.throws(
    () => buildFlowStateRequest('   '),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_IDENTITY_UNBOUND',
  )
})

void test('detail tool returns state, form facts, and export metadata', async () => {
  const ctx = new Context()
  const registered: unknown[] = []
  const requests: unknown[] = []
  const oaRuntime = runtime({ member_code: '0001', login_name: 'zhangsan' })
  await ctx.plugin({
    name: 'capability-host',
    inject: [],
    apply: (c) => {
      c.reflect.provide('tools', { register: (tool: unknown) => { registered.push(tool) } })
      c.reflect.provide('capabilityRuntime', { resolve: () => oaRuntime })
      c.reflect.provide('capabilityRest', {
        transport: {
          request: async (_runtime: unknown, request: Record<string, unknown>) => {
            requests.push(request)
            const path = String(request['path'])
            if (path.startsWith('/seeyon/rest/flow/state/')) {
              return { ok: true, status: 200, json: undefined, text: '3\n', contentType: 'text/plain', token: null }
            }
            if (path.startsWith('/seeyon/rest/form/getformdata/')) {
              return {
                ok: true, status: 200, json: { ApproveDate: 1795099829000, FinishedFlag: true, State: 2 },
                text: '', contentType: 'application/json', token: null,
              }
            }
            return {
              ok: true, status: 200,
              json: parseOaJson('{"formContent":{"values":[{"displayName":"报销金额","value":"123.45"}]},"attachmentList":[{"id":"file-1","fileName":"invoice.pdf"}]}'),
              text: '', contentType: 'application/json', token: null,
            }
          },
        },
      })
    },
  })
  await ctx.plugin(oaTools, { agentPreset: 'oa_assistant' })
  const tool = registered.find(entry => (entry as { name?: string }).name === 'oa_affair_detail') as {
    name: string
    execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  assert.equal(tool.name, 'oa_affair_detail')
  const result = await tool.execute({ object_id: ' OBJ-1 ', detail_level: 'full' })
  assert.equal(result['ok'], true)
  assert.equal(result['flow_state'], 3)
  assert.equal(result['approve_date'], '2026-11-19 22:50:29')
  assert.deepEqual(result['fields'], [{ label: '报销金额', value: '123.45' }])
  assert.deepEqual(result['attachments'], [{ file_id: 'file-1', name: 'invoice.pdf', suffix: 'pdf' }])
  assert.equal(requests.length, 3)
})

void test('detail tool fails when state is a vendor HTML page', async () => {
  const ctx = new Context()
  const registered: unknown[] = []
  const oaRuntime = runtime({ member_code: '0001' })
  await ctx.plugin({
    name: 'capability-host',
    inject: [],
    apply: (c) => {
      c.reflect.provide('tools', { register: (tool: unknown) => { registered.push(tool) } })
      c.reflect.provide('capabilityRuntime', { resolve: () => oaRuntime })
      c.reflect.provide('capabilityRest', {
        transport: {
          request: async () => ({
            ok: true, status: 200, json: undefined, text: '<html>error</html>',
            contentType: 'text/html', token: null,
          }),
        },
      })
    },
  })
  await ctx.plugin(oaTools, { agentPreset: 'oa_assistant' })
  const tool = registered.find(entry => (entry as { name?: string }).name === 'oa_affair_detail') as {
    execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  const result = await tool.execute({ object_id: 'OBJ-1' })
  assert.equal(result['ok'], false)
  assert.match(String(result['note']), /non-integer body|HTML|异常|响应不是 JSON/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { NO_AUTH, parseAuthSpec, readJsonPath, resolveParamSource } from '../src/auth.ts'
import { CapabilityError } from '../src/errors.ts'
import { BUILTIN_CAPABILITIES } from '../src/catalog.ts'
import { validateInstanceConfig } from '../src/validation.ts'

const SEEYON_AUTH = {
  type: 'token-endpoint',
  token_url: '/seeyon/rest/token',
  token_method: 'POST',
  token_params_in: 'json',
  token_params: { userName: 'config.username', password: 'secret', loginName: 'config.login_name' },
  token_path: 'id',
  identity_path: 'bindingUser',
  default_ttl_seconds: 900,
  token_invalid_values: ['-1'],
  transport: 'header',
  token_name: 'token',
}

void test('a missing auth block means no token is sent', () => {
  assert.equal(parseAuthSpec(undefined).type, 'none')
  assert.equal(parseAuthSpec(null).type, 'none')
  assert.equal(parseAuthSpec({ type: 'none' }).type, 'none')
  assert.deepEqual(parseAuthSpec(undefined), NO_AUTH)
})

void test('an auth block parses into a vendor-neutral token declaration', () => {
  const spec = parseAuthSpec(SEEYON_AUTH)
  assert.equal(spec.type, 'token-endpoint')
  assert.equal(spec.tokenUrl, '/seeyon/rest/token')
  assert.equal(spec.tokenMethod, 'POST')
  assert.equal(spec.tokenParamsIn, 'json')
  assert.equal(spec.tokenPath, 'id')
  assert.equal(spec.identityPath, 'bindingUser')
  assert.equal(spec.defaultTtlSeconds, 900)
  assert.equal(spec.transport, 'header')
  assert.equal(spec.tokenName, 'token')
  assert.deepEqual(spec.invalidTokenValues, ['-1'])
  assert.equal(spec.requestHeaders['accept'], 'application/json')
})

void test('an auth block may be written as a JSON string', () => {
  const spec = parseAuthSpec(JSON.stringify(SEEYON_AUTH))
  assert.equal(spec.tokenPath, 'id')
  assert.equal(spec.tokenName, 'token')
})

void test('an invalid auth block is rejected with a stable code', () => {
  assert.throws(() => parseAuthSpec({ type: 'token-endpoint' }), (error: unknown) =>
    error instanceof CapabilityError && error.code === 'CAPABILITY_AUTH_INVALID')
  assert.throws(() => parseAuthSpec({ ...SEEYON_AUTH, transport: 'cookie' }), (error: unknown) =>
    error instanceof CapabilityError && error.code === 'CAPABILITY_AUTH_INVALID')
  assert.throws(() => parseAuthSpec('{ not json'), (error: unknown) =>
    error instanceof CapabilityError && error.code === 'CAPABILITY_AUTH_INVALID')
})

void test('token parameter sources read the secret, config, subject, or a literal', () => {
  const config = { username: 'rest', login_name: 'zhangsan' }
  assert.equal(resolveParamSource('secret', 'pa55', config), 'pa55')
  assert.equal(resolveParamSource('config.username', 'pa55', config), 'rest')
  assert.equal(resolveParamSource('subject.memberCode', 'pa55', config, { memberCode: '0001' }), '0001')
  assert.equal(resolveParamSource('literal:fixed', 'pa55', config), 'fixed')
})

void test('a token parameter source that resolves to nothing fails loudly', () => {
  assert.throws(() => resolveParamSource('secret', null, {}), (error: unknown) =>
    error instanceof CapabilityError && error.code === 'CREDENTIAL_UNAVAILABLE')
  assert.throws(() => resolveParamSource('config.missing', 'pa55', {}), (error: unknown) =>
    error instanceof CapabilityError && error.code === 'CAPABILITY_CONFIG_INVALID')
  assert.throws(() => resolveParamSource('nonsense', 'pa55', {}), (error: unknown) =>
    error instanceof CapabilityError && error.code === 'CAPABILITY_AUTH_INVALID')
})

void test('a dotted path reads a nested response field', () => {
  const payload = { id: 'token-1', bindingUser: 'zhangsan', data: { access_token: 'nested' } }
  assert.equal(readJsonPath(payload, 'id'), 'token-1')
  assert.equal(readJsonPath(payload, 'data.access_token'), 'nested')
  assert.equal(readJsonPath(payload, 'missing.deep'), undefined)
})

void test('token parameters may mix body credentials and query binding fields', () => {
  const spec = parseAuthSpec({
    ...SEEYON_AUTH,
    token_params: {
      userName: 'config.username',
      password: 'secret',
      loginName: { source: 'subject.loginName', in: 'query' },
    },
  })
  assert.deepEqual(spec.tokenParams['userName'], { source: 'config.username', in: 'json' })
  assert.deepEqual(spec.tokenParams['loginName'], { source: 'subject.loginName', in: 'query' })
})

void test('token parameters reject mixed json and form bodies', () => {
  assert.throws(
    () => parseAuthSpec({
      ...SEEYON_AUTH,
      token_params: {
        userName: { source: 'config.username', in: 'json' },
        password: { source: 'secret', in: 'form' },
      },
    }),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_AUTH_INVALID',
  )
})

void test('OA configuration requires a token endpoint and an addressable subject', () => {
  const oa = BUILTIN_CAPABILITIES.find(capability => capability.capabilityId === 'oa')
  assert.ok(oa)
  assert.throws(
    () => validateInstanceConfig(oa, {
      base_url: 'https://oa.example.com',
      username: 'rest',
      member_code: '0001',
    }),
    /认证配置 JSON 必填/,
  )
  assert.throws(
    () => validateInstanceConfig(oa, {
      base_url: 'https://oa.example.com',
      username: 'rest',
      login_name: 'zhangsan',
      member_code: '0001',
      auth: { ...SEEYON_AUTH, token_invalid_values: [] },
    }),
    /必须包含 -1/,
  )
  const normalized = validateInstanceConfig(oa, {
    base_url: 'https://oa.example.com/',
    username: 'rest',
    login_name: 'zhangsan',
    member_code: '0001',
    auth: SEEYON_AUTH,
  })
  assert.equal(normalized.base_url, 'https://oa.example.com')
  assert.equal(normalized.member_code, '0001')
})

void test('Feishu docs configuration keeps the app secret out of plaintext config', () => {
  const feishuDocs = BUILTIN_CAPABILITIES.find(capability => capability.capabilityId === 'feishu-docs')
  assert.ok(feishuDocs)
  assert.equal(feishuDocs.configSchema.some(field => field.key === 'app_secret'), false)
  assert.equal(feishuDocs.configSchema.find(field => field.key === 'secret')?.label, 'App Secret')

  assert.throws(
    () => validateInstanceConfig(feishuDocs, { app_id: 'cli_test', base_url: 'http://open.feishu.cn' }),
    /https:\/\//,
  )
  assert.throws(
    () => validateInstanceConfig(feishuDocs, { app_id: 'cli_test', base_url: 'https://example.com' }),
    /open\.feishu\.cn/,
  )
  const normalized = validateInstanceConfig(feishuDocs, {
    app_id: 'cli_test',
    app_secret: 'plaintext-must-not-persist',
    base_url: 'https://open.larksuite.com/',
  })
  assert.equal(normalized.app_id, 'cli_test')
  assert.equal(normalized.base_url, 'https://open.larksuite.com')
  assert.equal(normalized.app_secret, undefined)
})

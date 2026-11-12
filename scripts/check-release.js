// Pure release-boundary checks: no packaged output, private saves or provider access.
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const { createRequire } = require('module')
const assert = require('./lib/bounded-assert')
const { inParallel } = require('./lib/check-pool')
const release = require('./lib/draft-release')

const sha = 'a'.repeat(40)
const context = (changes = {}) => ({ repository: 'rubybrowncoat/Aurora-Electrons', event: 'workflow_dispatch', ref: 'refs/heads/signpath-preparation', sha, runId: '101', attempt: '1', workflow: '.github/workflows/portable.yml', workflowSha: sha, version: '3.2.2', mode: 'unsigned', reviewedSha: sha, reviewedRef: 'refs/heads/signpath-preparation', reviewedVersion: '3.2.2', refProtected: true, ...changes })
const config = { reviewedSha: sha, reviewedRef: 'refs/heads/signpath-preparation', reviewedVersion: '3.2.2', organization: 'organization', project: 'aurora', policy: 'release', innerConfig: 'inner-app', portableConfig: 'portable', subject: 'CN=Expected Publisher', manualApproval: 'true', environment: 'production-signing' }
const owner = (changes = {}) => ({ ...release.plan(context()).owner, state: 'complete', assets: ['aurora-electrons-3.2.2-unsigned.exe', 'aurora-electrons-3.2.2-unsigned.build.json', 'aurora-electrons-3.2.2-unsigned.SHA256SUMS.txt'], ...changes })
const draft = (marker = owner(), changes = {}) => ({ id: 7, tag_name: 'latest-build', draft: true, body: release.body(marker), assets: marker.assets.map((name, i) => ({ id: i + 1, name })), ...changes })

const boundaries = (api) => {
  assert.equal(api.plan(context()).destination, 'latest-build')
  assert.equal(api.plan(context({ event: 'push', ref: 'refs/heads/signpath-preparation', mode: 'production' })).mode, 'unsigned', 'bootstrap push cannot activate signing')
  assert.equal(api.plan(context({ event: 'push', ref: 'refs/tags/v3.2.2' })).destination, 'v3.2.2')
  assert.throws(() => api.plan(context({ event: 'pull_request' })), /event/)
  assert.throws(() => api.plan(context({ repository: 'foreign/repository' })), /owner/)
  assert.throws(() => api.plan(context({ workflow: 'foreign.yml' })), /owner/)
  assert.throws(() => api.plan(context({ workflowSha: 'b'.repeat(40) })), /revision/)
  assert.throws(() => api.plan(context({ event: 'push', ref: 'refs/heads/master' })), /ref/)
  assert.throws(() => api.plan(context({ ref: 'refs/tags/v3.2.1' })), /version/)
  assert.throws(() => api.plan(context({ mode: 'production' }), {}), /configuration/)
  for (const field of Object.keys(config)) assert.throws(() => api.plan(context({ mode: 'production' }), { ...config, [field]: '' }), /configuration/)
  assert.throws(() => api.plan(context({ mode: 'production' }), { ...config, reviewedSha: 'b'.repeat(40) }), /reviewed/)
  assert.throws(() => api.plan(context({ mode: 'production' }), { ...config, manualApproval: 'false' }), /approval/)
  assert.throws(() => api.plan(context({ mode: 'production', refProtected: false }), config), /protected/)
  assert.throws(() => api.plan(context({ mode: 'production', reviewedSha: 'b'.repeat(40) }), config), /reviewed/)
  assert.throws(() => api.plan(context({ mode: 'production', ref: 'refs/heads/foreign' }), config), /reviewed/)
  assert.equal(api.plan(context({ mode: 'production' }), config).mode, 'production')
  const environment = { name: 'production-signing', deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }, protection_rules: [{ type: 'required_reviewers', reviewers: [{ reviewer: { login: 'independent-approver' } }], prevent_self_review: true }] }
  const protectedSource = { ref: 'refs/heads/signpath-preparation', refProtected: true }
  assert.doesNotThrow(() => api.signingEnvironment(environment, protectedSource, 200))
  assert.throws(() => api.signingEnvironment(null, protectedSource, 404), /HTTP 404/)
  assert.throws(() => api.signingEnvironment(null, protectedSource, 403), /HTTP 403.*council/)
  assert.throws(() => api.signingEnvironment(null, protectedSource), /environment/)
  assert.throws(() => api.signingEnvironment({ ...environment, name: 'unprotected' }, protectedSource), /environment/)
  assert.throws(() => api.signingEnvironment({ ...environment, protection_rules: [] }, protectedSource), /reviewers/)
  assert.throws(() => api.signingEnvironment({ ...environment, protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }] }, protectedSource), /reviewers/)
  assert.throws(() => api.signingEnvironment({ ...environment, deployment_branch_policy: null }, protectedSource), /protected/)
  assert.throws(() => api.signingEnvironment({ ...environment, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }, protectedSource), /protected/)
  assert.throws(() => api.signingEnvironment(environment, { ...protectedSource, refProtected: false }), /unprotected/)
  const protectedCalls = { upload: 0, provider: 0, staging: 0 }
  const protectedGate = (token) => { api.signingToken(token); protectedCalls.upload++; protectedCalls.provider++; protectedCalls.staging++ }
  for (const token of [undefined, null, '', ' \t\r\n']) assert.throws(() => protectedGate(token), /protected environment/)
  assert.deepEqual(protectedCalls, { upload: 0, provider: 0, staging: 0 }, 'an empty protected token cannot advance signing work')
  assert.doesNotThrow(() => api.signingToken('local-decision-control-only'))
  const next = api.plan(context({ runId: '102' }))
  assert.doesNotThrow(() => api.claim(draft(), next))
  assert.throws(() => api.claim(draft(owner(), { draft: false }), next), /published/)
  assert.throws(() => api.claim(draft(owner({ workflow: 'foreign.yml' })), next), /foreign/)
  assert.throws(() => api.claim(draft(owner({ runId: '103' })), next), /newer/)
  assert.throws(() => api.claim(draft(owner({ runId: '102', attempt: '2' })), next), /attempt/)
  assert.throws(() => api.claim(draft(owner(), { body: 'unowned release' }), next), /unowned/)
  assert.throws(() => api.claim(draft(owner(), { assets: [{ id: 1, name: 'foreign.exe' }] }), next), /foreign asset/)
  const claimed = api.claim(draft(), next)
  assert.doesNotThrow(() => api.recheck(draft(claimed), next))
  assert.throws(() => api.recheck(draft(owner({ runId: '103' })), next), /ownership/)
  assert.throws(() => api.recheck(draft({ ...claimed, sha: 'b'.repeat(40) }), next), /ownership/)
  assert.throws(() => api.recheck(draft({ ...claimed, workflow: 'foreign.yml' }), next), /ownership/)
  assert.throws(() => api.recheck(draft(claimed, { draft: false }), next), /published/)
  const files = next.assetNames.map((name, i) => ({ name, size: i + 1, sha256: 'c'.repeat(64) }))
  assert.doesNotThrow(() => api.completeSet(files, next))
  assert.throws(() => api.completeSet(files.slice(1), next), /complete/)
  assert.throws(() => api.completeSet([...files, files[0]], next), /complete/)
  assert.throws(() => api.completeSet(files.map((f) => ({ ...f, size: 0 })), next), /size/)
  assert.throws(() => api.completeSet(files.map((f) => ({ ...f, sha256: 'invalid' })), next), /hash/)
  const report = { passed: true, sourceSha: sha, runId: '102', attempt: '1', version: '3.2.2', mode: 'unsigned', metadata: { inner: { Status: 'NotSigned' }, wrapper: { Status: 'NotSigned' } } }
  assert.doesNotThrow(() => api.verifiedOutput(report, next))
  assert.throws(() => api.verifiedOutput({ ...report, runId: '101' }, next), /identity/)
  assert.throws(() => api.verifiedOutput({ ...report, passed: false }, next), /status/)
  const production = api.plan(context({ mode: 'production', runId: '102' }), config)
  assert.throws(() => api.verifiedOutput({ ...report, mode: 'production' }, production), /stages/)
  const signed = { ...report, mode: 'production', inner: { sha256: 'd'.repeat(64) }, wrapper: { sha256: 'e'.repeat(64) }, signatures: Object.fromEntries([['inner', 'Aurora Electrons.exe', 'd'], ['wrapper', 'aurora-electrons-3.2.2.exe', 'e']].map(([stage, name, hex]) => [stage, { Status: 'Valid', TimestampPresent: true, Subject: config.subject, Product: 'Aurora Electrons', Version: '3.2.2', FileName: name, SHA256: hex.repeat(64) }])) }
  assert.doesNotThrow(() => api.verifiedOutput(signed, production))
  for (const status of ['Rejected', 'Pending', 'Failed', 'TimedOut']) {
    assert.throws(() => api.verifiedOutput({ ...signed, signatures: { ...signed.signatures, wrapper: { ...signed.signatures.wrapper, Status: status } } }, production), /stages/)
  }
  assert.throws(() => api.verifiedOutput({ ...signed, signatures: { ...signed.signatures, inner: { ...signed.signatures.inner, TimestampPresent: false } } }, production), /stages/)
}

const lifecycle = async () => {
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const previous = owner({ sha: 'b'.repeat(40), version: '3.2.1', mode: 'production', assets: ['aurora-electrons-3.2.1-signed.exe', 'aurora-electrons-3.2.1-signed.build.json', 'aurora-electrons-3.2.1-signed.SHA256SUMS.txt'] })
  const original = draft(previous, { name: 'latest-build — verified signed Windows build', target_commitish: previous.sha, html_url: 'https://example.invalid/draft/7' })
  const next = release.plan(context({ runId: '102' }))
  const source = fs.readFileSync(path.join(__dirname, 'lib/draft-release.js'), 'utf8')
  const fixture = (options = {}) => {
    const current = clone(original)
    let deletes = 0
    const mutations = []
    if (options.foreign) current.assets.push({ id: 99, name: 'foreign.exe' })
    const fetch = async (url, { method = 'GET', body } = {}) => {
      const route = new URL(url).pathname.replace('/repos/rubybrowncoat/Aurora-Electrons', '')
      const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => clone(value), text: async () => 'injected transport failure' })
      if (method === 'GET' && route === '/releases') return response([current])
      if (method === 'GET' && route === '/releases/7') return response(current)
      if (method === 'DELETE' && route.startsWith('/releases/assets/')) {
        deletes++
        if (options.failDelete === deletes) return response(null, 500)
        const id = Number(route.split('/').pop())
        assert.ok(current.assets.some((asset) => asset.id === id), 'deleting only an attached asset')
        current.assets = current.assets.filter((asset) => asset.id !== id)
        if (options.takeover && deletes === 1) current.body = release.body({ ...previous, runId: '103' })
      } else if (method === 'PATCH' && route === '/releases/7') {
        if (options.failPatch) return response(null, 500)
        Object.assign(current, JSON.parse(body))
      } else {
        throw new Error(`Unexpected local release request: ${method} ${route}`)
      }
      mutations.push({ method, draft: clone(current) })
      return response(current, method === 'DELETE' ? 204 : 200)
    }
    const env = { GITHUB_REPOSITORY: next.owner.repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: next.owner.ref, GITHUB_SHA: next.owner.sha, GITHUB_RUN_ID: next.owner.runId, GITHUB_RUN_ATTEMPT: next.owner.attempt, GITHUB_WORKFLOW_REF: `${next.owner.repository}/${next.owner.workflow}@${next.owner.ref}`, GITHUB_WORKFLOW_SHA: next.owner.sha, RELEASE_MODE: 'unsigned', GH_TOKEN: 'local-transport-control-only' }
    const sandbox = { module: { exports: {} }, exports: {}, require: createRequire(path.join(__dirname, 'lib/draft-release.js')), __dirname: path.join(__dirname, 'lib'), console: { log: () => {} }, process: { env }, Buffer, URL, fetch }
    vm.runInNewContext(source, sandbox, { filename: 'draft-release-lifecycle.js' })
    return { api: sandbox.module.exports, mutations, get current() { return current } }
  }
  const assertPrevious = (current) => {
    assert.equal(current.body, original.body, 'remaining old downloads retain their exact old source/run provenance')
    assert.equal(current.name, original.name)
    assert.equal(current.target_commitish, original.target_commitish)
  }
  const assertPending = (current) => {
    assert.equal(current.assets.length, 0, 'a failed build or approval wait cannot expose old downloads under the new claim')
    assert.equal(current.target_commitish, next.owner.sha)
    const marker = release.marker(current)
    for (const [key, value] of Object.entries(next.owner)) assert.equal(marker[key], value, `new pending ${key}`)
    assert.equal(marker.state, 'claimed')
    assert.deepEqual(marker.assets, next.assetNames, 'old signed/version asset names are not carried into the new unsigned claim')
  }
  const success = fixture()
  await success.api.prepare()
  assert.deepEqual(success.mutations.map((item) => item.method), ['DELETE', 'DELETE', 'DELETE', 'PATCH'])
  success.mutations.slice(0, 3).forEach(({ draft: current }, i) => { assertPrevious(current); assert.equal(current.assets.length, 2 - i) })
  assertPending(success.current)

  const partial = fixture({ failDelete: 2 })
  await assert.rejects(partial.api.prepare(), /GitHub DELETE/)
  assertPrevious(partial.current)
  assert.deepEqual(partial.current.assets.map((asset) => asset.name), previous.assets.slice(1))
  assert.equal(partial.mutations.length, 1, 'a failed deletion stops before the new claim')
  await partial.api.prepare()
  assertPending(partial.current)

  const failedClaim = fixture({ failPatch: true })
  await assert.rejects(failedClaim.api.prepare(), /GitHub PATCH/)
  assertPrevious(failedClaim.current)
  assert.equal(failedClaim.current.assets.length, 0, 'a failed claim never leaves previous downloads labelled as the new run')

  const takeover = fixture({ takeover: true })
  await assert.rejects(takeover.api.prepare(), /ownership changed/)
  assert.equal(takeover.mutations.length, 1, 'an intervening owner stops all further deletion and claiming')
  assert.equal(takeover.current.assets.length, 2)
  assert.equal(release.marker(takeover.current).runId, '103')

  const foreign = fixture({ foreign: true })
  await assert.rejects(foreign.api.prepare(), /foreign asset/)
  assert.equal(foreign.mutations.length, 0, 'foreign assets are never removed or relabelled')
}

boundaries(release)
const source = fs.readFileSync(path.join(__dirname, 'lib/draft-release.js'), 'utf8')
const mutants = [
  ['published draft acceptance', 'if (draft) {\n    if (!draft.draft)', 'if (draft) {\n    if (false)'],
  ['older run overwrite', 'BigInt(previous.runId) > BigInt(next.owner.runId)', 'false'],
  ['foreign asset acceptance', '!allowed.has(asset.name)', 'false'],
]
lifecycle().then(() => inParallel(mutants, async ([name, from, to]) => {
  assert.equal(source.split(from).length, 2, `unique mutant: ${name}`)
  const sandbox = { module: { exports: {} }, exports: {}, require, __dirname: path.join(__dirname, 'lib'), console, process, Buffer, URL }
  vm.runInNewContext(source.replace(from, to), sandbox, { filename: 'draft-release-mutant.js' })
  assert.throws(() => boundaries(sandbox.module.exports), undefined, `boundary detects ${name}`)
  return name
}, 1)).then((results) => {
  const failure = results.find((result) => result instanceof Error)
  if (failure) throw failure
  console.log(`release decisions: all boundaries and asset lifecycle controls pass; ${results.length} meaningful mutants rejected`)
}).catch((error) => { console.error(error); process.exitCode = 1 })

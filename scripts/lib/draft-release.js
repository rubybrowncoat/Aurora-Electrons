const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const WORKFLOW = '.github/workflows/portable.yml'
const REPOSITORY = 'rubybrowncoat/Aurora-Electrons'
const fail = (message) => { throw new Error(message) }
const required = (value, description) => typeof value === 'string' && value.trim() ? value.trim() : fail(`Missing ${description}`)
const integer = (value) => /^\d+$/.test(String(value)) && BigInt(value) > 0n
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

const plan = (context, config = {}) => {
  const { repository, event, ref, sha, runId, attempt, workflow, version } = context
  if (repository !== REPOSITORY || workflow !== WORKFLOW) fail('Unexpected repository/workflow owner')
  if (!/^[a-f0-9]{40}$/.test(sha) || !integer(runId) || !integer(attempt)) fail('Invalid revision/run/attempt')
  if (context.workflowSha !== sha) fail('Workflow revision must equal the exact source revision')
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Invalid package version')
  if (!['push', 'workflow_dispatch'].includes(event)) fail('Unsupported event')
  const tag = ref === `refs/tags/v${version}`
  if (ref.startsWith('refs/tags/') && !tag) fail('Tag must match package version')
  if (!tag && !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref)) fail('Invalid source ref')
  if (event === 'push' && !tag && ref !== 'refs/heads/signpath-preparation') fail('Unsupported push ref')
  const mode = event === 'push' && !tag ? 'unsigned' : (context.mode || 'unsigned')
  if (!['unsigned', 'production'].includes(mode)) fail('Unknown signing mode')
  if (mode === 'production') {
    const fields = ['reviewedSha', 'reviewedRef', 'reviewedVersion', 'organization', 'project', 'policy', 'innerConfig', 'portableConfig', 'subject', 'manualApproval', 'environment']
    fields.forEach((field) => required(config[field], `production configuration: ${field}`))
    if (event !== 'workflow_dispatch') fail('Production signing requires explicit manual dispatch')
    if (context.refProtected !== true) fail('Production source ref must be protected')
    if (config.reviewedSha !== sha || config.reviewedRef !== ref || config.reviewedVersion !== version) fail('Source is not the reviewed SHA/ref/version')
    if (context.reviewedSha !== sha || context.reviewedRef !== ref || context.reviewedVersion !== version) fail('Dispatch must name the reviewed SHA/ref/version')
    if (config.environment !== 'production-signing') fail('Unexpected protected environment')
    if (config.manualApproval !== 'true') fail('Provider manual approval must be configured')
    if (config.innerConfig === config.portableConfig) fail('Distinct inner/portable configurations required')
  }
  const label = mode === 'production' ? 'signed' : 'unsigned'
  const stem = `aurora-electrons-${version}-${label}`
  return { mode, version, expectedSubject: config.subject, destination: tag ? `v${version}` : 'latest-build', assetNames: [`${stem}.exe`, `${stem}.build.json`, `${stem}.SHA256SUMS.txt`], owner: { repository, workflow, sha, ref, runId: String(runId), attempt: String(attempt), version, mode } }
}

const body = (owner, files = []) => `${owner.state === 'complete' ? (owner.mode === 'production' ? 'Verified production-signed' : 'UNSIGNED — no project code signature') : 'Build pending — assets are not a completed or verified release'} Windows portable build.\n\nSource: ${owner.sha}\nRun: https://github.com/${owner.repository}/actions/runs/${owner.runId}/attempts/${owner.attempt}\nState: ${owner.state}\n\n${files.map((file) => `${file.name}: ${file.size} bytes; SHA-256 ${file.sha256}`).join('\n')}\n\n<!-- aurora-portable:${JSON.stringify(owner)} -->\n`
const marker = (draft) => {
  const matches = [...(draft.body || '').matchAll(/<!-- aurora-portable:(.*?) -->/g)]
  if (matches.length !== 1) fail('Refusing unowned draft destination')
  let value
  try { value = JSON.parse(matches[0][1]) } catch { fail('Invalid draft owner marker') }
  if (!value || !integer(value.runId) || !integer(value.attempt) || !Array.isArray(value.assets) || value.assets.some((name) => typeof name !== 'string' || !/^aurora-electrons-\d+\.\d+\.\d+-(unsigned|signed)\.(exe|build\.json|SHA256SUMS\.txt)$/.test(name))) fail('Invalid draft ownership/assets')
  return value
}
const ownedAssets = (draft, owner) => {
  const allowed = new Set(owner.assets)
  if ((draft.assets || []).some((asset) => !allowed.has(asset.name))) fail('Refusing foreign asset in draft')
}
const claim = (draft, next) => {
  if (draft) {
    if (!draft.draft) fail('Refusing published release')
    if (draft.tag_name !== next.destination) fail('Wrong release destination')
    const previous = marker(draft)
    if (previous.repository !== next.owner.repository || previous.workflow !== next.owner.workflow) fail('Refusing foreign workflow destination')
    if (BigInt(previous.runId) > BigInt(next.owner.runId)) fail('Refusing overwrite of newer run')
    if (previous.runId === next.owner.runId && BigInt(previous.attempt) > BigInt(next.owner.attempt)) fail('Refusing stale attempt')
    if (previous.runId === next.owner.runId && (previous.sha !== next.owner.sha || previous.ref !== next.owner.ref || previous.mode !== next.owner.mode || previous.version !== next.owner.version)) fail('Run ownership mismatch')
    ownedAssets(draft, previous)
  }
  return { ...next.owner, state: 'claimed', assets: [...next.assetNames] }
}
const recheck = (draft, next) => {
  if (!draft.draft) fail('Refusing published release')
  const current = marker(draft)
  if (draft.tag_name !== next.destination || Object.keys(next.owner).some((key) => current[key] !== next.owner[key])) fail('Draft ownership changed since claim')
  if (current.state !== 'claimed') fail('Draft is not claimed for this upload')
  ownedAssets(draft, current)
  return current
}
const completeSet = (files, next) => {
  if (files.length !== next.assetNames.length || new Set(files.map((file) => file.name)).size !== files.length || next.assetNames.some((name) => !files.some((file) => file.name === name))) fail('Expected complete per-run asset set')
  files.forEach((file) => {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) fail('Invalid asset size')
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) fail('Invalid asset hash')
  })
}
const verifiedOutput = (report, next) => {
  if (!report || report.sourceSha !== next.owner.sha || report.runId !== next.owner.runId || report.attempt !== next.owner.attempt || report.version !== next.version || report.mode !== next.mode || report.passed !== true) fail('Package verification identity/status mismatch')
  if (next.mode === 'production') {
    for (const [stage, name] of [['inner', 'Aurora Electrons.exe'], ['wrapper', `aurora-electrons-${next.version}.exe`]]) {
      if (!/^[a-f0-9]{64}$/.test(report[stage]?.sha256)) fail('Both signing stages require a content hash')
      const signature = report.signatures?.[stage]
      if (!signature || signature.Status !== 'Valid' || signature.TimestampPresent !== true || signature.Subject !== next.expectedSubject || signature.Product !== 'Aurora Electrons' || signature.Version !== next.version || signature.FileName !== name || signature.SHA256 !== report[stage]?.sha256) fail('Both completed, trusted, timestamped signing stages are required; no unsigned fallback')
    }
  } else if (report.metadata?.inner?.Status !== 'NotSigned' || report.metadata?.wrapper?.Status !== 'NotSigned') fail('Unsigned route must remain explicitly unsigned')
}

const signingEnvironment = (environment, context, status = 200) => {
  if (status !== 200) fail(`Production environment metadata HTTP ${status}${status === 403 ? '; return this permission discrepancy to the council' : ''}`)
  if (!environment || environment.name !== 'production-signing' || !environment.protection_rules?.some((rule) => rule.type === 'required_reviewers' && rule.reviewers?.length > 0 && rule.prevent_self_review === true)) fail('Existing production-signing environment requires independent required reviewers (prevent self review)')
  if (environment.deployment_branch_policy?.protected_branches !== true || environment.deployment_branch_policy?.custom_branch_policies !== false) fail('Production environment must allow only protected source branches/tags')
  if (!context?.refProtected || !/^refs\/(heads|tags)\/.+/.test(context.ref || '')) fail('Production environment does not admit an unprotected/incompatible ref')
}
const signingToken = (token) => {
  if (typeof token !== 'string' || !token.trim()) fail('Missing protected environment SIGNPATH_API_TOKEN; signing is stopped')
}

const fromEnvironment = () => plan({ repository: process.env.GITHUB_REPOSITORY, event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, workflow: process.env.GITHUB_WORKFLOW_REF?.split('@')[0] === `${REPOSITORY}/${WORKFLOW}` ? WORKFLOW : '', workflowSha: process.env.GITHUB_WORKFLOW_SHA, version: require('../../package.json').version, mode: process.env.RELEASE_MODE || 'unsigned', reviewedSha: process.env.INPUT_REVIEWED_SHA, reviewedRef: process.env.INPUT_REVIEWED_REF, reviewedVersion: process.env.INPUT_REVIEWED_VERSION, refProtected: process.env.GITHUB_REF_PROTECTED === 'true' }, {
  reviewedSha: process.env.SIGNPATH_REVIEWED_SHA, reviewedRef: process.env.SIGNPATH_REVIEWED_REF, reviewedVersion: process.env.SIGNPATH_REVIEWED_VERSION, organization: process.env.SIGNPATH_ORGANIZATION_ID, project: process.env.SIGNPATH_PROJECT_SLUG, policy: process.env.SIGNPATH_SIGNING_POLICY_SLUG, innerConfig: process.env.SIGNPATH_INNER_CONFIG_SLUG, portableConfig: process.env.SIGNPATH_PORTABLE_CONFIG_SLUG, subject: process.env.SIGNPATH_EXPECTED_SUBJECT, manualApproval: process.env.SIGNPATH_MANUAL_APPROVAL, environment: process.env.SIGNPATH_ENVIRONMENT,
})
const api = async (route, { method = 'GET', data, bytes, accept = 'application/vnd.github+json', onStatus } = {}) => {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${route}`, { method, headers: { Authorization: `Bearer ${required(process.env.GH_TOKEN, 'GitHub token')}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : bytes })
  if (onStatus) onStatus(response.status)
  if (response.status === 404 && method === 'GET') return null
  if (!response.ok) fail(`GitHub ${method} ${route}: ${response.status} ${await response.text()}`)
  if (response.status === 204) return null
  return accept === 'application/octet-stream' ? Buffer.from(await response.arrayBuffer()) : response.json()
}
const getDraft = async (destination) => {
  // GitHub's tag endpoint can omit drafts; enumerate authenticated releases instead.
  for (let page = 1; ; page++) {
    const releases = await api(`/releases?per_page=100&page=${page}`)
    const found = releases.find((release) => release.tag_name === destination)
    if (found) return api(`/releases/${found.id}`)
    if (releases.length < 100) return null
  }
}
const preflight = async () => {
  let next
  const failures = []
  try { next = fromEnvironment() } catch (error) { failures.push(error.message) }
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.RELEASE_MODE === 'production') {
    if (process.env.SIGNPATH_ENVIRONMENT === 'production-signing') {
      let status
      try {
        const environment = await api('/environments/production-signing', { onStatus: (value) => { status = value; console.log(`Production environment metadata HTTP ${value}`) } })
        signingEnvironment(environment, { ref: process.env.GITHUB_REF, refProtected: process.env.GITHUB_REF_PROTECTED === 'true' }, status)
      } catch (error) {
        failures.push(status === 403 ? `Production environment metadata HTTP 403; return this permission discrepancy to the council. ${error.message}` : error.message)
      }
    } else {
      console.log('Production environment metadata not queried: valid configured environment name is unavailable')
    }
  }
  if (failures.length) fail(failures.join('\n'))
  return next
}
const prepare = async () => {
  const next = await preflight()
  const existing = await getDraft(next.destination)
  const owner = claim(existing, next)
  if (existing) {
    const recheckPrevious = async () => {
      const current = await api(`/releases/${existing.id}`)
      if (!current || current.body !== existing.body) fail('Draft ownership changed before claim')
      claim(current, next)
      return current
    }
    // Keep the previous provenance visible until every previous download has gone.
    for (const asset of existing.assets) {
      const current = await recheckPrevious()
      if (!current.assets.some((item) => item.id === asset.id && item.name === asset.name)) fail('Previous asset changed before cleanup')
      await api(`/releases/assets/${asset.id}`, { method: 'DELETE' })
    }
    const current = await recheckPrevious()
    if (current.assets.length) fail('Previous assets remain before claim')
  }
  const data = { tag_name: next.destination, target_commitish: next.owner.sha, name: `${next.destination} — pending ${next.mode} Windows build`, body: body(owner), draft: true, prerelease: next.destination === 'latest-build' }
  const release = await api(existing ? `/releases/${existing.id}` : '/releases', { method: existing ? 'PATCH' : 'POST', data })
  recheck(await api(`/releases/${release.id}`), next)
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `mode=${next.mode}\nversion=${next.version}\nrelease_id=${release.id}\ndestination=${next.destination}\n`)
  console.log(`Claimed draft ${release.html_url} for ${next.owner.sha} run ${next.owner.runId}/${next.owner.attempt}`)
}
const publishAssets = async (directory) => {
  const next = fromEnvironment()
  const dir = path.resolve(directory)
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'package-smoke.json'), 'utf8'))
  verifiedOutput(report, next)
  const wrapper = path.resolve('build', `aurora-electrons-${next.version}.exe`)
  if (hash(fs.readFileSync(wrapper)) !== report.wrapper.sha256) fail('Wrapper changed after package verification')
  const evidence = { ...next.owner, package: report, wrapper: { name: next.assetNames[0], size: fs.statSync(wrapper).size, sha256: report.wrapper.sha256 } }
  const exe = path.join(dir, next.assetNames[0])
  fs.copyFileSync(wrapper, exe)
  fs.writeFileSync(path.join(dir, next.assetNames[1]), `${JSON.stringify(evidence, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, next.assetNames[2]), [next.assetNames[0], next.assetNames[1]].map((name) => `${hash(fs.readFileSync(path.join(dir, name)))}  ${name}`).join('\n') + '\n')
  const files = next.assetNames.map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size, sha256: hash(fs.readFileSync(path.join(dir, name))) }))
  completeSet(files, next)
  const draft = await getDraft(next.destination)
  if (!draft) fail('Claimed draft disappeared')
  const owner = recheck(draft, next)
  for (const asset of draft.assets) {
    recheck(await api(`/releases/${draft.id}`), next)
    if (!owner.assets.includes(asset.name)) fail('Refusing unowned asset cleanup')
    await api(`/releases/assets/${asset.id}`, { method: 'DELETE' })
  }
  for (const file of files) {
    recheck(await api(`/releases/${draft.id}`), next)
    const upload = draft.upload_url.replace(/\{.*$/, '') + `?name=${encodeURIComponent(file.name)}`
    const response = await fetch(upload, { method: 'POST', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }, body: fs.readFileSync(path.join(dir, file.name)) })
    if (!response.ok) fail(`Asset upload failed: ${response.status} ${await response.text()}`)
    const stored = await response.json()
    if (stored.name !== file.name || stored.size !== file.size) fail('Uploaded asset name/size mismatch')
    const downloaded = await api(`/releases/assets/${stored.id}`, { accept: 'application/octet-stream' })
    if (!downloaded || hash(downloaded) !== file.sha256) fail('Downloaded draft asset hash mismatch')
  }
  const finalDraft = await api(`/releases/${draft.id}`)
  recheck(finalDraft, next)
  if (finalDraft.assets.length !== files.length || files.some((file) => !finalDraft.assets.some((asset) => asset.name === file.name && asset.size === file.size))) fail('Remote complete asset set mismatch')
  await api(`/releases/${draft.id}`, { method: 'PATCH', data: { name: `${next.destination} — ${next.mode === 'production' ? 'verified signed' : 'UNSIGNED'} Windows build`, body: body({ ...next.owner, state: 'complete', assets: next.assetNames }, files), draft: true } })
  console.log(`Staged complete ${next.mode} set: ${finalDraft.html_url}`)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${next.mode} draft\n${finalDraft.html_url}\n\n${files.map((file) => `- ${file.name}: ${file.size} bytes, SHA-256 \`${file.sha256}\``).join('\n')}\n`)
}

const cleanupArtifact = async (id, name) => {
  if (!/^\d+$/.test(id || '') || !name) fail('Exact temporary artifact ID/name required')
  const artifact = await api(`/actions/artifacts/${id}`)
  if (!artifact || artifact.name !== name || String(artifact.workflow_run?.id) !== process.env.GITHUB_RUN_ID || artifact.workflow_run?.head_sha !== process.env.GITHUB_SHA) fail('Refusing foreign temporary artifact cleanup')
  await api(`/actions/artifacts/${id}`, { method: 'DELETE' })
  console.log(`Deleted safely consumed workflow artifact ${id} (${name})`)
}

module.exports = { plan, body, marker, claim, recheck, completeSet, verifiedOutput, signingEnvironment, signingToken, prepare }
if (require.main === module) {
  const [command, directory, name] = process.argv.slice(2)
  const work = command === 'prepare' ? prepare() : command === 'publish' && directory ? publishAssets(directory) : command === 'cleanup-artifact' ? cleanupArtifact(directory, name) : Promise.reject(new Error('usage: node scripts/lib/draft-release.js prepare | publish <evidence-directory> | cleanup-artifact <id> <name>'))
  work.catch((error) => { console.error(error.message); process.exitCode = 1 })
}

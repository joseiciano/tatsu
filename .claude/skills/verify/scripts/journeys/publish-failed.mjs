// Chain item whose pull request fails: over WS, add the remote-backed sandbox
// repo (REMOTE_REPO, origin = the local bare REMOTE_BARE), start a
// `smoke-chain` chain with one item titled "Ship fail-pr widget" (the GitHub
// stub answers 422 for a head containing fail-pr), wait for the child run to
// pause publish-failed; then in the browser: the NEEDS YOU row reads
// "Pull request failed" with the stub error, Retry publish re-runs the
// publish (a second PR request, paused again), Cancel run clears the row.
// Removes the remote-backed repo again so later journeys see one repo.
//
// Usage: node journeys/publish-failed.mjs <state.env>
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import { readState, withApp } from '../browser.mjs'

const TIMEOUT = 60_000
const STARTING = 'Tatsu is still starting; try again'
const stateFile = process.argv[2]
const env = readState(stateFile)
const token = env.URL.split('token=')[1]

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}?token=${encodeURIComponent(token)}`)
  const pending = new Map()
  const listeners = new Set()
  let nextId = 1
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString())
    if (frame.t === 'res') {
      const waiter = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.ok) waiter?.resolve(frame.value)
      else waiter?.reject(new Error(JSON.stringify(frame.error)))
    } else if (frame.t === 'state') {
      for (const listener of listeners) listener(frame.event)
    }
  })
  const request = (name, ...args) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++)
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ t: 'req', id, name, args }))
    })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, request, listeners, opened }
}

async function poll(label, check) {
  const deadline = Date.now() + TIMEOUT
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function pullPosts(branch) {
  return readFileSync(env.GITHUB_STUB_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === 'POST' && entry.path === '/repos/acme/widgets/pulls' && entry.body?.head === branch)
}

const isPublishPaused = (record) => record?.status === 'paused' && record.pausedReason === 'publish-failed'

await withApp(stateFile, 'publish-failed', async ({ page, shot, log }) => {
  const client = connect()
  await client.opened
  let worktrees = []
  client.listeners.add((event) => {
    if (event.type === 'worktrees/listChanged') worktrees = event.payload
  })
  const added = await client.request('repo:addAtPath', env.REMOTE_REPO)
  if (added?.kind !== 'added') throw new Error(`repo:addAtPath ${JSON.stringify(added)}`)
  try {
    await drive(client, added.repoRoot, page, shot, log)
  } finally {
    if ((await client.request('repo:remove', added.repoRoot)) === true) {
      await poll('the remote-backed repo to leave the sidebar', async () =>
        worktrees.some((wt) => wt.repoRoot === added.repoRoot) ? undefined : true
      )
      log(`removed ${added.repoRoot} from repoRoots`)
    }
    client.ws.close()
  }
})

async function drive(client, repoRoot, page, shot, log) {
  let runId
  client.listeners.add((event) => {
    if (event.type === 'workflows/chainChildRunLinked') runId ??= event.payload.runId
  })
  const chainId = await poll('startChain', async () => {
    const response = await client.request('workflows:startChain', {
      defId: 'personal:smoke-chain',
      repoRoot,
      mode: 'independent',
      items: [{ title: 'Ship fail-pr widget', value: 'fail' }],
      inputs: {},
      draftPrs: true
    })
    if (typeof response?.chainId === 'string') return response.chainId
    if (response?.error !== STARTING) throw new Error(`startChain refused: ${JSON.stringify(response)}`)
    return undefined
  })
  log(`chain ${chainId} started on ${repoRoot}`)
  await poll('the child run link', async () => runId)
  const paused = await poll('publish-failed', async () => {
    const record = await client.request('workflows:getRun', runId)
    return isPublishPaused(record) ? record : undefined
  })
  const branch = paused.chain.item.branch
  log(`run ${runId} paused publish-failed: ${JSON.stringify(paused.publishError)}; ${pullPosts(branch).length} PR request(s) for ${branch}`)

  const worktreeName = paused.worktreePath.split('/').pop()
  const where = `smoke-chain on ${worktreeName}`
  const needsYou = page.getByRole('region', { name: /^NEEDS YOU/ })
  const row = needsYou.getByRole('listitem').filter({ hasText: worktreeName })
  await row.getByText('Pull request failed').waitFor({ timeout: TIMEOUT })
  await row.getByText(`stub refused pull request for ${branch}`).waitFor({ timeout: TIMEOUT })
  const retry = row.getByRole('button', { name: `Retry publish: ${where}`, exact: true })
  const cancel = row.getByRole('button', { name: `Cancel run: ${where}`, exact: true })
  await retry.waitFor()
  await cancel.waitFor()
  const labels = await row.getByRole('button').allTextContents()
  if (labels.join('|') !== 'Retry publish|Cancel run') throw new Error(`row buttons ${JSON.stringify(labels)}`)
  log(`NEEDS YOU row: ${JSON.stringify(await row.textContent())}`)
  await row.scrollIntoViewIfNeeded()
  await shot('needs-you-publish-failed')

  await retry.click()
  await poll('the retried publish to fail again', async () => {
    const record = await client.request('workflows:getRun', runId)
    return isPublishPaused(record) && pullPosts(branch).length === 2 ? record : undefined
  })
  await row.getByText('Pull request failed').waitFor({ timeout: TIMEOUT })
  log(`Retry publish re-ran the publish: ${pullPosts(branch).length} PR requests for ${branch}, paused publish-failed again`)
  await shot('after-retry-publish')

  await cancel.click()
  await row.waitFor({ state: 'detached', timeout: TIMEOUT })
  const cancelled = await client.request('workflows:getRun', runId)
  if (cancelled?.status !== 'cancelled') throw new Error(`run ${runId} ended ${cancelled?.status}`)
  log(`Cancel run cleared the row; run ${runId} cancelled`)
  await shot('after-cancel')
}

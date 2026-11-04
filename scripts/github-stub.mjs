#!/usr/bin/env node
import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const MAX_BODY_BYTES = 1024 * 1024

const { values: args } = parseArgs({
  options: {
    seed: { type: 'string' },
    log: { type: 'string' },
    port: { type: 'string', default: '0' }
  }
})

const seed = args.seed ? JSON.parse(readFileSync(args.seed, 'utf-8')) : {}
const failPulls = seed.failPulls === true
const issues = Array.isArray(seed.issues) ? seed.issues : []
const pulls = new Map()
let nextNumber = Number.isSafeInteger(seed.nextNumber) ? seed.nextNumber : 1

function now() {
  return new Date().toISOString()
}

function pullRecord(owner, repo, number, fields) {
  const fullName = `${owner}/${repo}`
  return {
    number,
    state: 'open',
    title: fields.title ?? '',
    body: fields.body ?? '',
    draft: fields.draft === true,
    html_url: `https://github.com/${fullName}/pull/${number}`,
    user: { login: 'stub-user', avatar_url: '' },
    author_association: 'OWNER',
    head: { ref: fields.head ?? '', sha: fields.headSha ?? '', repo: { full_name: fullName } },
    base: { ref: fields.base ?? 'main', repo: { full_name: fullName } },
    updated_at: fields.updated_at ?? now()
  }
}

for (const pr of Array.isArray(seed.pulls) ? seed.pulls : []) {
  const [owner, repo] = String(pr.repo ?? 'acme/widgets').split('/')
  const number = Number.isSafeInteger(pr.number) ? pr.number : nextNumber
  pulls.set(`${owner}/${repo}#${number}`, pullRecord(owner, repo, number, pr))
  if (number >= nextNumber) nextNumber = number + 1
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function validationFailed(res, message) {
  send(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message }] })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function record(method, path, body) {
  if (!args.log) return
  appendFileSync(args.log, JSON.stringify({ method, path, body }) + '\n')
}

function handle(method, pathname, query, body, res) {
  if (method === 'GET' && pathname === '/user') return send(res, 200, { login: 'stub-user' })

  if (method === 'POST' && pathname === '/graphql') {
    return send(res, 200, {
      data: { repository: { defaultBranchRef: { name: 'main' }, milestones: { totalCount: 0 } } }
    })
  }

  if (method === 'GET' && pathname === '/search/issues') {
    return send(res, 200, { total_count: issues.length, incomplete_results: false, items: issues })
  }

  const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/)
  if (!repoMatch) return send(res, 404, { message: 'Not Found' })
  const owner = decodeURIComponent(repoMatch[1])
  const repo = decodeURIComponent(repoMatch[2])
  const rest = repoMatch[3] ?? ''

  if (method === 'GET' && rest === '') {
    return send(res, 200, {
      name: repo,
      full_name: `${owner}/${repo}`,
      owner: { login: owner },
      fork: false,
      default_branch: 'main'
    })
  }

  const issueMatch = rest.match(/^\/issues\/(\d+)$/)
  if (method === 'GET' && issueMatch) {
    const issue = issues.find((i) => i.number === Number(issueMatch[1]))
    if (!issue) return send(res, 404, { message: 'Not Found' })
    return send(res, 200, { author_association: 'OWNER', ...issue })
  }

  if (rest === '/pulls') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open'
      const list = [...pulls.values()].filter(
        (pr) => pr.base.repo.full_name === `${owner}/${repo}` && (state === 'all' || pr.state === state)
      )
      return send(res, 200, list)
    }
    if (method === 'POST') {
      if (!body || typeof body.head !== 'string' || typeof body.base !== 'string') {
        return validationFailed(res, 'head and base are required')
      }
      if (failPulls || body.head.includes('fail-pr')) {
        return validationFailed(res, `stub refused pull request for ${body.head}`)
      }
      const number = nextNumber++
      const pr = pullRecord(owner, repo, number, body)
      pulls.set(`${owner}/${repo}#${number}`, pr)
      return send(res, 201, pr)
    }
  }

  const pullMatch = rest.match(/^\/pulls\/(\d+)$/)
  if (pullMatch) {
    const key = `${owner}/${repo}#${Number(pullMatch[1])}`
    const pr = pulls.get(key)
    if (!pr) return send(res, 404, { message: 'Not Found' })
    if (method === 'GET') return send(res, 200, pr)
    if (method === 'PATCH') {
      if (failPulls) return validationFailed(res, `stub refused update for #${pr.number}`)
      const updated = {
        ...pr,
        ...(typeof body?.base === 'string' ? { base: { ...pr.base, ref: body.base } } : {}),
        ...(typeof body?.title === 'string' ? { title: body.title } : {}),
        ...(typeof body?.body === 'string' ? { body: body.body } : {}),
        updated_at: now()
      }
      pulls.set(key, updated)
      return send(res, 200, updated)
    }
  }

  return send(res, 404, { message: 'Not Found' })
}

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET'
  const path = req.url ?? '/'
  let text
  try {
    text = await readBody(req)
  } catch {
    return send(res, 413, { message: 'Payload Too Large' })
  }
  const body = parseJson(text)
  record(method, path, body)
  const url = new URL(path, 'http://127.0.0.1')
  try {
    handle(method, url.pathname, url.searchParams, body, res)
  } catch (err) {
    send(res, 500, { message: err instanceof Error ? err.message : 'stub error' })
  }
})

function shutdown() {
  server.closeAllConnections()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(Number(args.port), '127.0.0.1', () => {
  const { port } = server.address()
  process.stdout.write(`http://127.0.0.1:${port}\n`)
})

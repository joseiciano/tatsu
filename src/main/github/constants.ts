export const PR_FRAGMENT = `fragment PR on PullRequest {
  number title state isDraft url mergedAt mergeable additions deletions
  baseRefName
  baseRepository { defaultBranchRef { name } }
  headRefOid
  headRepository { nameWithOwner }
  mergeCommit { oid }
  author { login avatarUrl }
  milestone { title url state }
  assignees(first: 10) { nodes { login avatarUrl } }
  labels(first: 20) { nodes { name color description } }
  mergeQueueEntry { position estimatedTimeToMerge }
  closingIssuesReferences(first: 10) { nodes { number title state url } }
  reviews(last: 100) {
    nodes { author { login avatarUrl } state body submittedAt url }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion detailsUrl permalink startedAt title summary
              }
              ... on StatusContext {
                context state description targetUrl createdAt
              }
            }
          }
        }
      }
    }
  }
}`
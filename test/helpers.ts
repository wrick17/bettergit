import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSampleWorkspace } from '../scripts/create-sample-workspace'

// Each suite gets its own copy, so tests can change repos without affecting each other.
export async function freshSample(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'bettergit-sample-'))
  await createSampleWorkspace(root, { bulk: 0, largeCommits: 0 })
  return root
}

export function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true })
}

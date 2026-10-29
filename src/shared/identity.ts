export interface CommitIdentity {
  name: string
  email: string
  // Git cannot construct an author yet. Name and email then contain the configured defaults for editing.
  error: string | null
}

export type IdentityScope = 'local' | 'global'

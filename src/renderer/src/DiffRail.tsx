import type { ReactNode } from 'react'
import type { FoldHold } from './fold'
import { Icon } from './Icons'

// The rail stays outside the scrolling diff, so its control never scrolls out of reach.
export function DiffRail({ fold, label, children }: { fold: FoldHold<HTMLDivElement>; label: string; children: ReactNode }) {
  return (
    <div ref={fold.pane} {...fold.paneHandlers} className={`diff-rail${fold.folded ? ' folded' : ''}${fold.held ? ' held' : ''}`}>
      {fold.folded && (
        <button ref={fold.strip} type="button" className="fold-strip" aria-label="Show code diff" aria-expanded={!fold.collapsed} onClick={fold.activate}>
          <Icon name="chevron" />
          <span className="fold-label">{label}</span>
        </button>
      )}
      {children}
    </div>
  )
}

import { Icon, type IconName } from './Icons'

// A pane with nothing to show: a soft badge with an icon, a short title, and one muted line.
export function EmptyState({ icon, title, hint, compact }: { icon: IconName; title: string; hint?: string; compact?: boolean }) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      <span className="empty-badge"><Icon name={icon} /></span>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  )
}

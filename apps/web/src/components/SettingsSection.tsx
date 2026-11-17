import type { ReactNode } from 'react'

import { SCOPE_BADGE, type SettingsScope } from '../lib/settings-summary'

export function ScopeBadge({ scope }: { scope: SettingsScope }) {
  const badge = SCOPE_BADGE[scope]
  return <span className={`settings-scope settings-scope-${scope}`} title={badge.title}>{badge.label}</span>
}

/** One block of the settings page: title, what it does, and where the setting lives. */
export function SettingsSection({ id, titleId, title, subtitle, scope, children }: {
  id: string
  titleId: string
  title: ReactNode
  subtitle?: ReactNode
  scope: SettingsScope
  children?: ReactNode
}) {
  return <section id={id} className="settings-card" aria-labelledby={titleId}>
    <div className="settings-card-head">
      <div className="min-w-0">
        <h3 id={titleId} className="section-title">{title}</h3>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      <ScopeBadge scope={scope} />
    </div>
    {children}
  </section>
}

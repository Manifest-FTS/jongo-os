import type { ReactNode } from 'react';

/** Presentational only: no server imports, no state. The host page decides which methods exist and which message to show. */
export type CraftLoginNotice = {
  /** Stable machine code, written to `data-login-error`. Pass only codes the host already knows. */
  code: string;
  message: string;
  /** `locked` is the rate-limit state: same alert, clock icon and a title. */
  kind?: 'error' | 'locked';
};

export type CraftLoginUnavailable = { title: string; children: ReactNode };

export type CraftLoginCardProps = {
  /** Shown as "Edit {siteName}". Without it the line reads "Edit your site's content". */
  siteName?: string;
  /** Show the primary "Sign in with Jongo" button. */
  jongo?: boolean;
  /** Show the shared-password form. Collapsed behind a disclosure when `jongo` is also on. */
  password?: boolean;
  /** Where the Jongo button posts. */
  startAction?: string;
  /** Server action or URL for the password form. */
  passwordAction?: string | ((formData: FormData) => void | Promise<void>);
  notice?: CraftLoginNotice;
  /** Open the emergency disclosure on first paint (for example after a rejected password). */
  emergencyOpen?: boolean;
  /** Replaces the sign-in methods with an explanation. */
  unavailable?: CraftLoginUnavailable;
  /** Small label above the title, for developer-facing hints. */
  eyebrow?: string;
  /** Extra help above the password field when it is the only method. */
  passwordHelp?: string;
  logoSrc?: string;
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="jongo-login-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const alertIcon = <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5" /><path d="M12 16.2v.01" /></Icon>;
const clockIcon = <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
const infoIcon = <Icon><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.8v.01" /></Icon>;
const shieldIcon = <Icon><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /><path d="M9 12l2.2 2.2L15.5 10" /></Icon>;

export function CraftLoginCard({
  siteName, jongo = false, password = false, startAction = '/craft/auth/start', passwordAction,
  notice, emergencyOpen = false, unavailable, eyebrow, passwordHelp, logoSrc = '/assets/jongo/logomark.svg'
}: CraftLoginCardProps) {
  const both = jongo && password;
  const name = siteName?.trim();
  const passwordForm = password && (
    <form className="jongo-login-form" action={passwordAction} noValidate data-login-method="password">
      {both && <p className="jongo-login-help">Shared password, for when Jongo sign-in cannot be used.</p>}
      {!both && passwordHelp && <p className="jongo-login-help">{passwordHelp}</p>}
      <div className="jongo-login-field">
        <label htmlFor="craft-password">Jongo Craft password</label>
        <input id="craft-password" name="password" type="password" autoComplete="current-password" required maxLength={256} autoFocus={(!both || emergencyOpen) && !unavailable} />
      </div>
      <button className={both ? 'jongo-login-secondary' : 'jongo-login-primary'} type="submit">{both ? 'Use emergency access' : 'Sign in'}</button>
    </form>
  );

  return (
    <div className="jongo-studio jongo-login">
      <main id="jongo-login-main" className="jongo-login-main" aria-labelledby="jongo-login-title" tabIndex={-1}>
        <div className="jongo-login-card">
          <p className="jongo-login-brand"><img src={logoSrc} alt="" width={28} height={28} /><span>Jongo Craft</span></p>
          {eyebrow && <p className="jongo-login-eyebrow">{eyebrow}</p>}
          <h1 id="jongo-login-title" className="jongo-login-title">Sign in to Jongo Craft</h1>
          <p className="jongo-login-context">{name ? `Edit ${name}` : 'Edit your site\u2019s content'}</p>

          {unavailable ? (
            <div className="jongo-login-alert jongo-login-alert--info" role="alert" data-login-disabled="true">
              {infoIcon}
              <div>
                <h2 className="jongo-login-alert-title">{unavailable.title}</h2>
                <div className="jongo-login-alert-body">{unavailable.children}</div>
              </div>
            </div>
          ) : (
            <>
              {notice && (
                <div className={`jongo-login-alert jongo-login-alert--${notice.kind === 'locked' ? 'locked' : 'error'}`} role="alert" data-login-error={notice.code}>
                  {notice.kind === 'locked' ? clockIcon : alertIcon}
                  <div>
                    {notice.kind === 'locked' && <p className="jongo-login-alert-title">Too many attempts</p>}
                    <p className="jongo-login-alert-body">{notice.message}</p>
                  </div>
                </div>
              )}
              {jongo && (
                <form className="jongo-login-form" method="post" action={startAction} data-login-method="jongo">
                  <button className="jongo-login-primary" type="submit" data-sso-button="true" autoFocus={!emergencyOpen}>
                    {shieldIcon}<span>Sign in with Jongo</span>
                  </button>
                  <p className="jongo-login-reassure">You will confirm on jongo.app. Your Jongo password is never shared with this site.</p>
                </form>
              )}
              {both ? (
                <details className="jongo-login-emergency" open={emergencyOpen}>
                  <summary className="jongo-login-summary">Use emergency access</summary>
                  {passwordForm}
                </details>
              ) : passwordForm}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

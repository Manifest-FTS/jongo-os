"use client";

/**
 * Desktop (browser) notifications for new Jongo notifications.
 *
 * Deliberately NOT a service worker + Web Push subscription: that needs a
 * VAPID key pair, a subscription stored per device, and delivery that works
 * while the tab is closed. What is built here fires while the tab is open
 * (foreground or backgrounded), which covers the ask -- an OS-level popup
 * when something new comes in while you're working -- without
 * that infrastructure. If notifications need to reach a closed tab, that is a
 * separate, larger feature.
 */

const NOTIFICATIONS_ENABLED_KEY = "jongo:notifications:desktopEnabled";
const PROMPT_DISMISSED_KEY = "jongo:notifications:promptDismissedAt";

export type DesktopNotificationSupport = "unsupported" | "default" | "granted" | "denied";

export function getPermission(): DesktopNotificationSupport {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestPermission(): Promise<DesktopNotificationSupport> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return getPermission();
  }
}

export function areDesktopNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== "false";
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, String(enabled));
}

/** No-op unless permission has already been granted; never prompts on its own. */
export function showDesktopNotification(title: string, body: string): void {
  if (getPermission() !== "granted" || !areDesktopNotificationsEnabled()) return;
  try {
    // eslint-disable-next-line no-new
    new Notification(title, {
      body,
      icon: "/assets/images/jongo-logo-color.png",
      tag: "jongo-notification"
    });
  } catch {
    // Some platforms (older iOS Safari) expose the constructor but throw; ignore.
  }
}

/** "Not now" hides the prompt for the rest of this browser session only. */
export function dismissPromptForSession(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(PROMPT_DISMISSED_KEY, String(Date.now()));
}

export function isPromptDismissedThisSession(): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(PROMPT_DISMISSED_KEY) !== null;
}

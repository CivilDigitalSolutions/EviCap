/** Settings and live state in chrome.storage.local (SPEC §5.2, F12). */

export interface Settings {
  autoCaptureDefault: boolean;
  autoCaptureThrottleSec: number;
  autoCaptureMaxMhtmlMb: number;
  defaultScreenshotMode: 'visible' | 'full' | 'region';
  /** Global denylist: never logged (F1). */
  denylist: string[];
  timestamping: { enabled: boolean; chainHeadIntervalMin: number };
  mirrorReminderDismissed: boolean;
  onboardingDone: boolean;
}

export interface LiveState {
  activeCaseId: string | null;
  recording: boolean;
}

/** Pre-filled with common banking, health and email domains; the user can edit it. */
export const DEFAULT_DENYLIST = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'icloud.com',
  'paypal.com',
  'barclays.co.uk',
  'hsbc.co.uk',
  'lloydsbank.co.uk',
  'natwest.com',
  'santander.co.uk',
  'nationwide.co.uk',
  'monzo.com',
  'starlingbank.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'nhs.uk',
  'nhsapp.service.nhs.uk',
  'mychart.com',
];

export const DEFAULT_SETTINGS: Settings = {
  autoCaptureDefault: true,
  autoCaptureThrottleSec: 5,
  autoCaptureMaxMhtmlMb: 50,
  defaultScreenshotMode: 'visible',
  denylist: DEFAULT_DENYLIST,
  timestamping: { enabled: false, chainHeadIntervalMin: 15 },
  mirrorReminderDismissed: false,
  onboardingDone: false,
};

const DEFAULT_STATE: LiveState = { activeCaseId: null, recording: false };

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getState(): Promise<LiveState> {
  const { state } = await chrome.storage.local.get('state');
  return { ...DEFAULT_STATE, ...(state as Partial<LiveState> | undefined) };
}

export async function saveState(patch: Partial<LiveState>): Promise<LiveState> {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ state: next });
  return next;
}

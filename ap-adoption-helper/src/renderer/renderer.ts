// Renderer for the single-screen setup flow. Classic script (no modules); shared types come
// from src/shared/types.d.ts, and the setup-code helpers from account-code.js, which
// index.html loads first.
//
// Two paths through the app:
//   self-serve  idle -> scanning -> results -> code -> setup -> claiming -> done
//   fallback    idle -> scanning -> results -> code -> adopting -> success
// The fallback is the app's original behaviour, byte for byte: send set-inform and let an
// admin finish. It exists for people without a code and for venues whose internet is down.
//
// All user-facing strings live in COPY / ERROR_COPY / ADOPTION_ERROR_COPY rather than inline,
// so translating this is a data swap. Venue staff here read German, French and Italian.
(() => {
  const api = window.heidifi;

  type Step =
    | 'idle'
    | 'scanning'
    | 'results'
    | 'code'
    | 'known'
    | 'setup'
    | 'claiming'
    | 'done'
    | 'adopting'
    | 'success'
    | 'error';

  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el as T;
  };

  const panels: Record<Step, HTMLElement> = {
    idle: $('panel-idle'),
    scanning: $('panel-scanning'),
    results: $('panel-results'),
    code: $('panel-code'),
    known: $('panel-known'),
    setup: $('panel-setup'),
    claiming: $('panel-claiming'),
    done: $('panel-done'),
    adopting: $('panel-adopting'),
    success: $('panel-success'),
    error: $('panel-error'),
  };

  const deviceList = $('device-list');
  const resultsTitle = $('results-title');
  const offlineWarning = $('offline-warning');
  const btnScan = $<HTMLButtonElement>('btn-scan');
  const btnAdopt = $<HTMLButtonElement>('btn-adopt');
  const btnRescan = $<HTMLButtonElement>('btn-rescan');
  const btnAgain = $<HTMLButtonElement>('btn-again');
  const errorTitle = $('error-title');
  const errorMessage = $('error-message');
  const btnErrorPrimary = $<HTMLButtonElement>('btn-error-primary');
  const btnErrorSecondary = $<HTMLButtonElement>('btn-error-secondary');
  const successNote = $('success-note');

  const inputCode = $<HTMLInputElement>('input-code');
  const codeError = $('code-error');
  const btnCodeContinue = $<HTMLButtonElement>('btn-code-continue');
  const btnNoCode = $<HTMLButtonElement>('btn-no-code');
  const noCodeBody = $('no-code-body');
  const btnSendAnyway = $<HTMLButtonElement>('btn-send-anyway');
  const btnCodeBack = $<HTMLButtonElement>('btn-code-back');

  const knownIconOk = $('known-icon-ok');
  const knownIconBad = $('known-icon-bad');
  const knownTitle = $('known-title');
  const knownMessage = $('known-message');
  const btnKnownDashboard = $<HTMLButtonElement>('btn-known-dashboard');
  const btnKnownAgain = $<HTMLButtonElement>('btn-known-again');
  const btnKnownRetry = $<HTMLButtonElement>('btn-known-retry');

  const setupChip = $('setup-chip');
  const venueField = $('venue-field');
  const venueList = $('venue-list');
  const venueSingle = $('venue-single');
  const inputApName = $<HTMLInputElement>('input-ap-name');
  const ssidLocked = $('ssid-locked');
  const ssidLockedText = $('ssid-locked-text');
  const btnSsidUnlock = $<HTMLButtonElement>('btn-ssid-unlock');
  const ssidWarning = $('ssid-warning');
  const ssidWarningText = $('ssid-warning-text');
  const ssidField = $('ssid-field');
  const inputSsid = $<HTMLInputElement>('input-ssid');
  const setupError = $('setup-error');
  const btnSetupSubmit = $<HTMLButtonElement>('btn-setup-submit');
  const btnSetupBack = $<HTMLButtonElement>('btn-setup-back');

  const checklist = $('checklist');
  const claimingDetail = $('claiming-detail');
  const claimingSlow = $('claiming-slow');
  const doneMessage = $('done-message');
  const btnDoneDashboard = $<HTMLButtonElement>('btn-done-dashboard');
  const btnDoneAgain = $<HTMLButtonElement>('btn-done-again');

  const inputUrl = $<HTMLInputElement>('input-url');
  const inputApi = $<HTMLInputElement>('input-api');
  const inputPassword = $<HTMLInputElement>('input-password');
  const btnSave = $<HTMLButtonElement>('btn-save');
  const saveStatus = $('save-status');
  const preflightChip = $('preflight-chip');
  const deviceRaw = $('device-raw');
  const logEl = $('log');
  const btnCopyLog = $<HTMLButtonElement>('btn-copy-log');
  const advanced = $<HTMLDetailsElement>('advanced');
  const homeLink = $('home-link');

  // ── State ───────────────────────────────────────────────────────────────────

  let devices: DiscoveredDevice[] = [];
  let selectedMac: string | null = null;
  let homeUrl = 'https://heidifi.ai/';
  let dashboardUrl = 'https://heidifi.ai/';
  let supportEmail = 'hello@swissopenai.com';

  // Held in memory only, never persisted: settings.json is plaintext, and the log buffer
  // gets emailed to support by the "Copy log" button.
  let accountCode: string | null = null;
  let venues: AdoptionVenue[] = [];
  let selectedVenueId: string | null = null;
  let venueDetail: AdoptionVenueDetail | null = null;
  let precheck = new Map<string, AdoptionPrecheckDevice>();
  let ssidUnlocked = false;
  let apiReachable = true;

  let claim: AdoptionClaim | null = null;
  let lastStatus: AdoptionStatus | AdoptionClaim | null = null;
  let pollTimer: number | null = null;
  let claimStartedAt = 0;
  let pollFailures = 0;
  let wifiFailStreak = 0;
  let keepWaitingCount = 0;

  const SLOW_NOTICE_MS = 90_000;
  /** Venue WiFi drops constantly; one failed poll means nothing. */
  const MAX_POLL_FAILURES = 5;
  /** "Keep waiting" presses before we stop pretending watching helps — see runAction. */
  const KEEP_WAITING_MAX = 2;

  const COPY = {
    resultsOne: 'We found your access point',
    resultsMany: 'Select your access point',
    resultsPartial: 'Still looking — found so far:',
    scanEmptyTitle: 'We couldn’t find an access point',
    scanEmptyMessage:
      'Check that it has power and is plugged into the same network as this computer, then ' +
      'wait about a minute after plugging it in and scan again.',
    alreadyHereTitle: 'This access point is already in HeidiFi',
    otherAccountTitle: 'This access point belongs to another account',
    otherAccountMessage:
      'It’s already registered to a different HeidiFi account, so we can’t add it here. If ' +
      'you bought it second-hand or moved it from another site, email {support} and we’ll ' +
      'release it.',
    setupTitle: 'Set up your access point',
    ssidLocked: '{venue} already broadcasts “{ssid}”. Your new access point will join it.',
    ssidWarning:
      'Changing this renames the WiFi for the whole location. Guests connected right now ' +
      'will be dropped and will have to find and join the new network.',
    doneMessage:
      '{ap} is connected and broadcasting “{ssid}” at {venue}. It can take another minute ' +
      'or two for the network name to show up on phones.',
    doneNoWifi:
      '{ap} is connected at {venue}. Your WiFi network is still switching on — give it a ' +
      'couple of minutes, then check your dashboard.',
  };

  const CODE_PROBLEM_COPY: Record<string, string> = {
    // By far the most common failure: someone read O for Q, or 0 for a letter, off a screen.
    confusable:
      'Check for a mix-up — codes never use the letters I, L or O, or the numbers 0 or 1.',
    bad_char: 'That code contains a character we don’t use. Check it and try again.',
    too_long: 'That’s too long — a setup code is 8 letters and numbers.',
    too_short: 'That’s too short — a setup code is 8 letters and numbers.',
    empty: 'Enter the setup code from your HeidiFi dashboard.',
  };

  function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '');
  }

  /** Canonical MAC, matching the server's canonMac — the precheck keys on it. */
  function canon(mac: string): string {
    return String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  }

  function show(step: Step): void {
    for (const [name, panel] of Object.entries(panels)) {
      panel.classList.toggle('hidden', name !== step);
    }
    // Move focus to the new panel's heading. Without this, keyboard and screen-reader focus
    // stays on a button that is now display:none and the app becomes unnavigable.
    const heading = panels[step].querySelector<HTMLElement>('h1, h2');
    heading?.focus();
  }

  // ── Device list ─────────────────────────────────────────────────────────────

  function friendlyName(device: DiscoveredDevice): string {
    return device.model || device.hostname || 'UniFi access point';
  }

  /** Devices already set up here can't be claimed again — say so instead of letting them try. */
  function deviceBadge(device: DiscoveredDevice): string | null {
    const state = precheck.get(canon(device.mac))?.state;
    if (state === 'already_registered_here') return 'Already set up';
    if (state === 'registered_elsewhere') return 'Another account';
    return null;
  }

  function renderDevices(): void {
    deviceList.textContent = '';
    for (const device of devices) {
      const badge = deviceBadge(device);
      const card = document.createElement('button');
      card.type = 'button';
      card.className =
        'device-card' + (device.mac === selectedMac ? ' selected' : '') + (badge ? ' muted' : '');

      const model = document.createElement('span');
      model.className = 'device-model';
      model.textContent = friendlyName(device) + (badge ? ` — ${badge}` : '');

      const meta = document.createElement('span');
      meta.className = 'device-meta';
      meta.textContent =
        (device.hostname && device.hostname !== friendlyName(device) ? `${device.hostname} · ` : '') +
        device.ip;

      const mac = document.createElement('span');
      mac.className = 'device-mac';
      mac.textContent = `MAC ${device.mac}${device.firmware ? ` · ${device.firmware}` : ''}`;

      card.append(model, meta, mac);
      card.addEventListener('click', () => {
        selectedMac = device.mac;
        renderDevices();
      });
      deviceList.appendChild(card);
    }
    btnAdopt.disabled = !selectedMac;
    resultsTitle.textContent = devices.length === 1 ? COPY.resultsOne : COPY.resultsMany;
    const selected = devices.find((d) => d.mac === selectedMac);
    deviceRaw.textContent = selected ? JSON.stringify(selected, null, 2) : 'No device selected.';
  }

  async function startScan(): Promise<void> {
    devices = [];
    selectedMac = null;
    precheck = new Map();
    renderDevices();
    show('scanning');

    const [found, reach] = await Promise.all([
      api.scan().catch(() => [] as DiscoveredDevice[]),
      api.preflight().catch(() => null),
    ]);
    devices = found;

    // Surfaced up front rather than at the end: with no internet nothing in the self-serve
    // path can work, and finding that out after typing a code is a worse experience.
    apiReachable = reach === null || reach.reachable;
    offlineWarning.classList.toggle('hidden', apiReachable);

    if (devices.length === 0) {
      showError(COPY.scanEmptyTitle, COPY.scanEmptyMessage, 'retry-scan');
      return;
    }
    if (devices.length === 1) selectedMac = devices[0].mac;

    // If we already have a code (second access point of the visit), annotate immediately.
    if (accountCode) await refreshPrecheck();
    renderDevices();
    show('results');
  }

  // ── Setup code ──────────────────────────────────────────────────────────────

  function syncCodeInput(): void {
    const caretAtEnd = inputCode.selectionStart === inputCode.value.length;
    const formatted = formatAccountCode(inputCode.value);
    if (formatted !== inputCode.value) {
      inputCode.value = formatted;
      if (caretAtEnd) inputCode.setSelectionRange(formatted.length, formatted.length);
    }
    const check = checkAccountCode(inputCode.value);
    btnCodeContinue.disabled = !check.ok;

    // Only nag about a confusable character once the field is long enough that it is
    // clearly a mistake and not just mid-typing.
    const worthWarning = check.problem === 'confusable' || check.problem === 'bad_char';
    if (worthWarning && check.value.length >= 4) {
      setCodeError(CODE_PROBLEM_COPY[check.problem as string]);
    } else {
      setCodeError(null);
    }
  }

  function setCodeError(message: string | null): void {
    codeError.textContent = message ?? '';
    codeError.classList.toggle('hidden', !message);
  }

  async function submitCode(): Promise<void> {
    const check = checkAccountCode(inputCode.value);
    if (!check.ok) {
      setCodeError(CODE_PROBLEM_COPY[check.problem as string] ?? CODE_PROBLEM_COPY.empty);
      return;
    }

    btnCodeContinue.disabled = true;
    btnCodeContinue.textContent = 'Checking…';
    const res = await api.adoptionSession({ code: check.value });
    btnCodeContinue.textContent = 'Continue';
    btnCodeContinue.disabled = false;

    if (!res.ok) {
      // Keep the person on this screen for anything they can fix by retyping; send the rest
      // to the error panel, which has room for an explanation and a way out.
      if (res.code === 'BAD_CODE' || res.code === 'RATE_LIMITED') {
        setCodeError(ADOPTION_ERROR_COPY[res.code].message);
        return;
      }
      showAdoptionError(res);
      return;
    }

    accountCode = check.value;
    venues = res.data.venues;
    if (venues.length === 0) {
      showAdoptionError({ ok: false, code: 'NO_VENUES' });
      return;
    }

    await refreshPrecheck();

    // Short-circuit before anything is changed: if this device is already ours, or someone
    // else's, there is nothing to set up.
    const state = precheck.get(canon(selectedMac || ''))?.state;
    if (state === 'already_registered_here' || state === 'registered_elsewhere') {
      showKnown(state);
      return;
    }

    selectedVenueId = venues.length === 1 ? venues[0].id : selectedVenueId;
    await enterSetup();
  }

  async function refreshPrecheck(): Promise<void> {
    if (!accountCode || devices.length === 0) return;
    const res = await api.adoptionPrecheck({
      code: accountCode,
      macs: devices.map((d) => d.mac),
    });
    // Non-fatal by design: precheck is an optimisation and the claim re-checks server-side,
    // so a blip here must not stop someone starting an install.
    if (!res.ok) return;
    precheck = new Map(res.data.devices.map((d) => [canon(d.mac), d]));
    renderDevices();
  }

  function showKnown(state: AdoptionPrecheckState): void {
    const info = precheck.get(canon(selectedMac || ''));
    const here = state === 'already_registered_here';

    knownIconOk.classList.toggle('hidden', !here);
    knownIconBad.classList.toggle('hidden', here);
    btnKnownDashboard.classList.toggle('hidden', !here);
    btnKnownRetry.classList.toggle('hidden', !here);

    if (here) {
      knownTitle.textContent = COPY.alreadyHereTitle;
      const name = info?.apName || 'This access point';
      const venue = info?.venueName ? ` for ${info.venueName}` : '';
      knownMessage.textContent = `${name} is already set up${venue}. There’s nothing more to do here.`;
    } else {
      knownTitle.textContent = COPY.otherAccountTitle;
      knownMessage.textContent = fill(COPY.otherAccountMessage, { support: supportEmail });
    }
    show('known');
  }

  // ── Location + WiFi ─────────────────────────────────────────────────────────

  async function enterSetup(): Promise<void> {
    setupError.classList.add('hidden');
    ssidUnlocked = false;

    const single = venues.length === 1;
    venueField.classList.toggle('hidden', single);
    venueSingle.classList.toggle('hidden', !single);
    if (single) {
      selectedVenueId = venues[0].id;
      venueSingle.textContent = `This will be added to ${venues[0].name}.`;
    }
    renderVenues();

    const device = devices.find((d) => d.mac === selectedMac);
    setupChip.classList.toggle('hidden', precheck.get(canon(selectedMac || ''))?.state !== 'pending');
    setupChip.textContent = 'Your access point is already talking to HeidiFi — this will be quick.';
    $('setup-title').textContent = device
      ? `Set up your ${friendlyName(device)}`
      : COPY.setupTitle;

    show('setup');
    if (selectedVenueId) await loadVenueDetail(selectedVenueId);
  }

  function renderVenues(): void {
    venueList.textContent = '';
    for (const venue of venues) {
      const label = document.createElement('label');
      label.className = 'venue-card' + (venue.id === selectedVenueId ? ' selected' : '');

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'venue';
      radio.value = venue.id;
      radio.checked = venue.id === selectedVenueId;
      radio.addEventListener('change', () => {
        selectedVenueId = venue.id;
        ssidUnlocked = false;
        renderVenues();
        void loadVenueDetail(venue.id);
      });

      const name = document.createElement('span');
      name.className = 'venue-name';
      name.textContent = venue.name;

      label.append(radio, name);
      venueList.appendChild(label);
    }
  }

  async function loadVenueDetail(venueId: string): Promise<void> {
    if (!accountCode) return;
    const res = await api.adoptionVenue({ code: accountCode, venueId });
    if (!res.ok) {
      showAdoptionError(res);
      return;
    }
    venueDetail = res.data;

    inputApName.value =
      venueDetail.apCount === 0 ? 'Main access point' : `Access point ${venueDetail.apCount + 1}`;

    renderSsidField();
  }

  /**
   * The WiFi name is read-only until explicitly unlocked. On a venue's second access point
   * this field is a trap, not a decision — editing it renames the live network and drops
   * every connected guest. On the first one it is the whole point.
   */
  function renderSsidField(): void {
    const existing = venueDetail?.wifiSsid || '';
    const locked = Boolean(existing) && !ssidUnlocked;

    ssidLocked.classList.toggle('hidden', !locked);
    ssidField.classList.toggle('hidden', locked);
    ssidWarning.classList.toggle('hidden', !(existing && ssidUnlocked));

    if (existing) {
      ssidLockedText.textContent = fill(COPY.ssidLocked, {
        venue: venueDetail?.name || 'This location',
        ssid: existing,
      });
      ssidWarningText.textContent = COPY.ssidWarning;
      inputSsid.value = existing;
    } else {
      inputSsid.value = inputSsid.value || '';
    }
  }

  async function submitSetup(): Promise<void> {
    if (!accountCode || !selectedVenueId || !selectedMac) return;
    const device = devices.find((d) => d.mac === selectedMac);
    if (!device) return;

    const existing = venueDetail?.wifiSsid || '';
    const ssid = existing && !ssidUnlocked ? existing : inputSsid.value.trim();
    if (!ssid) {
      setupError.textContent = 'Enter a name for your WiFi network.';
      setupError.classList.remove('hidden');
      inputSsid.focus();
      return;
    }
    setupError.classList.add('hidden');

    // Step 1 of the checklist is the set-inform, which has to happen before the claim: the
    // server only accepts a claim for a device it can actually see on the controller.
    show('claiming');
    claimStartedAt = Date.now();
    pollFailures = 0;
    wifiFailStreak = 0;
    keepWaitingCount = 0;
    lastStatus = null;
    claimingSlow.classList.add('hidden');
    setChecklist(1, 'Telling your access point where to find HeidiFi.');

    const sent = await api.adopt({ ip: device.ip }).catch(
      (err: unknown): AdoptResult => ({ ok: false, code: 'UNEXPECTED_OUTPUT', raw: String(err) }),
    );
    if (!sent.ok) {
      // The set-inform exists to point a factory device at our controller. A device the
      // precheck already saw on the controller doesn't need it — and often can't take it:
      // once adopted, the controller replaces the factory ubnt/ubnt SSH credentials, so
      // this step failing is EXPECTED there. Aborting here stranded exactly the people
      // re-running the helper at an already-adopted access point. The claim's own
      // proof-of-possession (the device must be visible on our controller) still holds.
      const known = precheck.get(canon(device.mac))?.state;
      const onController = known === 'already_registered_here' || known === 'adopted_unregistered';
      if (!onController) {
        const copy = ERROR_COPY[sent.code] ?? ERROR_COPY.UNEXPECTED_OUTPUT;
        showError(copy.title, copy.message, 'retry-scan');
        return;
      }
    }

    setChecklist(2, 'Registering it with HeidiFi.');
    const res = await api.adoptionClaim({
      code: accountCode,
      mac: device.mac,
      venueId: selectedVenueId,
      ssid,
      apName: inputApName.value.trim() || undefined,
      model: device.model,
      firmware: device.firmware,
      confirmRename: Boolean(existing) && ssidUnlocked && ssid !== existing,
    });

    if (!res.ok) {
      // The device may simply not have checked in yet — that is a wait, not a failure.
      if (res.code === 'DEVICE_NOT_READY') {
        showError(
          'Your access point hasn’t checked in yet',
          'It’s still starting up. Wait about a minute, then try again — it stays plugged in.',
          'retry-setup',
        );
        return;
      }
      showAdoptionError(res);
      return;
    }

    claim = res.data;
    lastStatus = res.data;
    if (!applyProgress(res.data)) return;
    schedulePoll(res.data.retryAfterSeconds);
  }

  // ── Progress ────────────────────────────────────────────────────────────────

  function setChecklist(active: number, detail: string): void {
    for (const row of Array.from(checklist.children) as HTMLElement[]) {
      const step = Number(row.dataset.step);
      row.classList.toggle('done', step < active);
      row.classList.toggle('active', step === active);
    }
    claimingDetail.textContent = detail;
  }

  /**
   * Feed one status response through the progress model (progress.js, loaded before this
   * script) and act on it. Returns false when the flow reached a terminal screen — done or
   * an error — so callers know not to schedule another poll.
   */
  function applyProgress(s: AdoptionStatus | AdoptionClaim): boolean {
    if (s.phase === 'connected' && s.reason === 'wifi_apply_failed') wifiFailStreak += 1;
    else wifiFailStreak = 0;

    const action = progressModel(s, wifiFailStreak);
    if (action.kind === 'done') {
      // Let the last dot actually turn green before the panel swaps — the checklist
      // otherwise ends on a spinner even when everything worked.
      setChecklist(5, 'Your WiFi network is on.');
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => showDone(true), 800);
      return false;
    }
    if (action.kind === 'error') {
      showAdoptionError({ ok: false, code: action.code });
      return false;
    }
    setChecklist(action.step, action.detail);
    return true;
  }

  function schedulePoll(seconds: number): void {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => void poll(), Math.max(1, seconds) * 1000);
  }

  async function poll(): Promise<void> {
    if (!accountCode || !selectedMac) {
      // Should be unreachable — both are set before the first poll — but returning silently
      // here would leave the claiming screen spinning with no timer. Fail loudly instead.
      showAdoptionError({ ok: false, code: 'SERVER_ERROR' });
      return;
    }
    const elapsed = Date.now() - claimStartedAt;
    // A first-boot firmware upgrade gets a longer leash than the normal three minutes —
    // interrupting one with "taking longer than usual" invites the power-cycle that bricks it.
    if (elapsed > pollDeadlineMs(lastStatus?.reason)) {
      showAdoptionError({ ok: false, code: 'CLAIM_TIMEOUT' });
      return;
    }
    if (elapsed > SLOW_NOTICE_MS) claimingSlow.classList.remove('hidden');

    const res = await api.adoptionStatus({ code: accountCode, mac: selectedMac });
    if (!res.ok) {
      // A slow or briefly unreachable server during provisioning is NOT a failure — the
      // access point is already registered and adopting. Keep waiting and let the overall
      // deadline decide, which lands on "this is taking longer than usual" rather than
      // "something went wrong at our end". Only a genuinely unexpected reply counts toward
      // giving up early.
      const transient = res.code === 'OFFLINE' || res.code === 'TIMEOUT' || res.code === 'RATE_LIMITED';
      if (!transient && ++pollFailures >= MAX_POLL_FAILURES) {
        showAdoptionError(res);
        return;
      }
      // A rate-limited poll says how long to back off; retrying sooner just re-triggers it.
      const wait = res.code === 'RATE_LIMITED' ? res.retryAfterSeconds ?? 5 : transient ? 5 : 3;
      schedulePoll(wait);
      return;
    }

    pollFailures = 0;
    lastStatus = res.data;
    if (!applyProgress(res.data)) return;
    schedulePoll(res.data.retryAfterSeconds);
  }

  function showDone(wifiOn: boolean): void {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    const c = claim;
    // wifiOn comes from the status that finished the flow, not from the claim response —
    // the claim almost always predates the WiFi apply, so its own flag is stale by now.
    doneMessage.textContent = c
      ? fill(wifiOn ? COPY.doneMessage : COPY.doneNoWifi, {
          ap: c.apName,
          ssid: c.ssid,
          venue: c.venueName,
        })
      : '';
    // The venue count is now stale — a second access point at this venue is not the first.
    if (venueDetail) venueDetail.apCount += 1;
    show('done');
  }

  // ── Errors ──────────────────────────────────────────────────────────────────

  const ERROR_COPY: Record<AdoptErrorCode, { title: string; message: string }> = {
    AUTH_FAILED: {
      title: 'This access point may have been set up before',
      message:
        'Please factory-reset it: hold the reset button for about 10 seconds until the light ' +
        'flashes, let it restart, then scan again.',
    },
    UNREACHABLE: {
      title: 'We couldn’t connect to the access point',
      message:
        'It may still be starting up. Wait about a minute and try again, and check that it ' +
        'has power and is on the same network as this computer.',
    },
    TIMEOUT: {
      title: 'The connection timed out',
      message: 'The access point did not respond in time. Check that it still has power and try again.',
    },
    COMMAND_NOT_FOUND: {
      title: 'The access point didn’t accept the request',
      message:
        'This device uses unsupported firmware. Open Advanced, copy the log, and send it to ' +
        'your administrator.',
    },
    UNEXPECTED_OUTPUT: {
      title: 'Something didn’t go as expected',
      message:
        'The access point gave an unexpected reply. Open Advanced, copy the log, and send it ' +
        'to your administrator.',
    },
    INVALID_URL: {
      title: 'The controller address looks wrong',
      message: 'Open Advanced and check the controller inform URL, or clear it to use the default.',
    },
  };

  type ErrorAction = 'retry-scan' | 'retry-code' | 'retry-setup' | 'dashboard' | 'keep-waiting';

  const ADOPTION_ERROR_COPY: Record<
    AdoptionErrorCode,
    { title: string; message: string; primary: ErrorAction; secondary?: ErrorAction }
  > = {
    OFFLINE: {
      title: 'This computer can’t reach HeidiFi',
      message:
        'Check that this computer is connected to the internet, then try again. If you’re on ' +
        'a guest network with its own sign-in page, join the main network first.',
      primary: 'retry-setup',
    },
    TIMEOUT: {
      title: 'HeidiFi didn’t answer in time',
      message: 'The connection timed out. Check this computer’s internet connection and try again.',
      primary: 'retry-setup',
    },
    INSECURE_ENDPOINT: {
      title: 'This app isn’t set up safely',
      message:
        'The HeidiFi address under Advanced isn’t secure — it has to start with https://. ' +
        'Don’t enter your code until your administrator has fixed it.',
      primary: 'retry-scan',
    },
    BAD_CODE: {
      title: 'We don’t recognise that code',
      message:
        'Check the code on your HeidiFi dashboard. It’s 8 letters and numbers, and never ' +
        'contains the letters I, L or O, or the numbers 0 or 1.',
      primary: 'retry-code',
    },
    RATE_LIMITED: {
      title: 'Too many attempts',
      message: 'For security we’ve paused code checks for a minute. Wait, then try again.',
      primary: 'retry-code',
    },
    NO_VENUES: {
      title: 'Add a location first',
      message:
        'This HeidiFi account doesn’t have a location yet. Add one on your dashboard — it ' +
        'only takes a minute — then come back here and run this again.',
      primary: 'dashboard',
      secondary: 'retry-code',
    },
    VENUE_GONE: {
      title: 'That location has been removed',
      message: 'The location you picked no longer exists in HeidiFi. Pick another one.',
      primary: 'retry-code',
    },
    DEVICE_NOT_READY: {
      title: 'Your access point hasn’t checked in yet',
      message: 'It’s still starting up. Leave it plugged in, wait about a minute, and try again.',
      primary: 'retry-setup',
    },
    MAC_CONFLICT: {
      title: 'This access point is already registered',
      message:
        'Another HeidiFi account has already claimed this access point. Email {support} with ' +
        'the MAC address from Advanced and we’ll release it.',
      primary: 'retry-scan',
    },
    SSID_INVALID: {
      title: 'That WiFi name won’t work',
      message:
        'The WiFi name has to be between 1 and 32 characters, and emoji and unusual symbols ' +
        'don’t show up on every phone.',
      primary: 'retry-setup',
    },
    SSID_NEEDS_CONFIRM: {
      title: 'This location already has a WiFi name',
      message:
        'To rename it you have to confirm first. Go back, choose "Change the name", and try again.',
      primary: 'retry-setup',
    },
    PLAN_LIMIT: {
      title: 'You’ve used all the access points on your plan',
      message:
        'Your HeidiFi plan doesn’t include another access point at this location. Upgrade on ' +
        'your dashboard, then run this again.',
      primary: 'dashboard',
      secondary: 'retry-setup',
    },
    SUBSCRIPTION_LAPSED: {
      title: 'Your HeidiFi subscription needs attention',
      message:
        'We can’t add access points until billing is up to date. Sort that out on your ' +
        'dashboard, then come back here.',
      primary: 'dashboard',
    },
    DAILY_LIMIT: {
      title: 'That’s a lot of access points today',
      message:
        'This account has set up its daily limit of access points. Try again tomorrow, or ' +
        'email {support} if you’re doing a large installation.',
      primary: 'dashboard',
    },
    UNAVAILABLE: {
      title: 'Setup codes aren’t switched on',
      message:
        'This HeidiFi server isn’t set up for self-service yet. Use "I don’t have a code" to ' +
        'send the request, and our team will finish it for you.',
      primary: 'retry-code',
    },
    VERSION_UNSUPPORTED: {
      title: 'This app is out of date',
      message:
        'Download the latest HeidiFi helper from your dashboard and run setup again. This ' +
        'version can’t finish setup on its own.',
      primary: 'dashboard',
    },
    CLAIM_TIMEOUT: {
      title: 'This is taking longer than usual',
      message:
        'Your access point is registered and still finishing up — nothing has gone wrong. ' +
        'Leave it plugged in; it completes on its own, usually within ten minutes, and your ' +
        'WiFi will appear on your dashboard. A first-time firmware update can take longer.',
      primary: 'keep-waiting',
      secondary: 'dashboard',
    },
    DEVICE_OFFLINE: {
      title: 'We’ve lost contact with your access point',
      message:
        'It stopped answering. Check that it still has power and that its network cable is ' +
        'firmly plugged in — it reconnects on its own once it’s back. If you just moved or ' +
        'restarted it, give it a minute and keep waiting.',
      primary: 'keep-waiting',
      secondary: 'dashboard',
    },
    WIFI_STUCK: {
      title: 'It’s connected, but the WiFi isn’t on yet',
      message:
        'Your access point is set up and registered — only the WiFi network is still ' +
        'switching on, and HeidiFi keeps retrying automatically. Check your dashboard in ' +
        'ten minutes, and email {support} if it still isn’t broadcasting.',
      primary: 'dashboard',
      secondary: 'keep-waiting',
    },
    SERVER_ERROR: {
      title: 'Something went wrong at our end',
      message:
        'Nothing is broken and your access point is untouched. Wait a moment and try again. ' +
        'If it keeps happening, open Advanced, copy the log, and email it to {support}.',
      primary: 'retry-setup',
    },
    BAD_RESPONSE: {
      title: 'We got an unexpected reply',
      message:
        'HeidiFi sent something we couldn’t read. Try again — if it keeps happening, open ' +
        'Advanced, copy the log, and email it to {support}.',
      primary: 'retry-setup',
    },
  };

  const ACTION_LABEL: Record<ErrorAction, string> = {
    'retry-scan': 'Scan again',
    'retry-code': 'Enter the code again',
    'retry-setup': 'Try again',
    dashboard: 'Open my dashboard',
    'keep-waiting': 'Keep waiting',
  };

  function runAction(action: ErrorAction): void {
    switch (action) {
      case 'retry-scan':
        void startScan();
        break;
      case 'retry-code':
        show('code');
        inputCode.focus();
        break;
      case 'retry-setup':
        void enterSetup();
        break;
      case 'dashboard':
        void api.openExternal(dashboardUrl);
        break;
      case 'keep-waiting':
        keepWaitingCount += 1;
        if (keepWaitingCount > KEEP_WAITING_MAX) {
          // Two extensions is close to ten minutes of watching a spinner. From here the
          // server's own 5-minute sweep finishes the job without this app, so the honest
          // move is the "still switching on, check your dashboard" screen — not another
          // round of the person on the ladder staring at a dot.
          showDone(false);
          break;
        }
        claimStartedAt = Date.now();
        pollFailures = 0;
        wifiFailStreak = 0;
        claimingSlow.classList.add('hidden');
        show('claiming');
        schedulePoll(3);
        break;
    }
  }

  function bindAction(button: HTMLButtonElement, action: ErrorAction | null): void {
    button.classList.toggle('hidden', action === null);
    if (!action) return;
    button.textContent = ACTION_LABEL[action];
    button.onclick = () => runAction(action);
  }

  function showError(title: string, message: string, primary: ErrorAction): void {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    errorTitle.textContent = title;
    errorMessage.textContent = message;
    bindAction(btnErrorPrimary, primary);
    bindAction(btnErrorSecondary, null);
    show('error');
  }

  function showAdoptionError(err: AdoptionErr): void {
    const copy = ADOPTION_ERROR_COPY[err.code] ?? ADOPTION_ERROR_COPY.SERVER_ERROR;
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    errorTitle.textContent = copy.title;
    // Prefer the server's own explanation when it sent one — it knows, for example, which
    // WiFi name the location already uses.
    errorMessage.textContent = err.detail || fill(copy.message, { support: supportEmail });
    bindAction(btnErrorPrimary, copy.primary);
    bindAction(btnErrorSecondary, copy.secondary ?? null);
    show('error');
  }

  // ── Fallback path (no code) ─────────────────────────────────────────────────

  /** The app's original behaviour: send set-inform and let an admin finish. */
  async function sendAdoptionOnly(): Promise<void> {
    const selected = devices.find((d) => d.mac === selectedMac);
    if (!selected) return;
    show('adopting');
    const preflightPromise = api.preflight().catch(() => null);
    let result: AdoptResult;
    try {
      result = await api.adopt({ ip: selected.ip });
    } catch (err) {
      result = { ok: false, code: 'UNEXPECTED_OUTPUT', raw: String(err) };
    }
    const reach = await preflightPromise;
    if (result.ok) {
      successNote.classList.toggle('hidden', reach === null || reach.reachable);
      successNote.textContent =
        reach && !reach.reachable
          ? 'Note: this computer could not reach the management server. If the access point ' +
            'doesn’t appear for your administrator, check this site’s internet connection.'
          : '';
      show('success');
    } else {
      const copy = ERROR_COPY[result.code] ?? ERROR_COPY.UNEXPECTED_OUTPUT;
      showError(copy.title, copy.message, 'retry-scan');
    }
  }

  // ── Advanced ────────────────────────────────────────────────────────────────

  function setPreflightChip(result: PreflightResult | null): void {
    if (!result) {
      preflightChip.className = 'chip';
      preflightChip.textContent = 'Management server: check failed';
      return;
    }
    preflightChip.className = 'chip ' + (result.reachable ? 'ok' : 'bad');
    preflightChip.textContent = result.reachable
      ? `Management server reachable (${result.host}:${result.port})`
      : `Management server unreachable (${result.host}:${result.port})`;
  }

  async function refreshPreflight(): Promise<void> {
    preflightChip.className = 'chip';
    preflightChip.textContent = 'Checking management server…';
    setPreflightChip(await api.preflight().catch(() => null));
  }

  function applyConfig(config: EffectiveConfig): void {
    homeUrl = config.homeUrl;
    dashboardUrl = config.dashboardUrl;
    supportEmail = config.supportEmail;
    document.documentElement.style.setProperty('--brand', config.brand.primary);
    document.documentElement.style.setProperty('--surface', config.brand.surface);
    document.documentElement.style.setProperty('--bg', config.brand.background);
    $('app-name').textContent = config.appName;
    inputUrl.value = config.settings.controllerUrl ?? '';
    inputUrl.placeholder = config.informUrl;
    inputApi.value = config.settings.apiBaseUrl ?? '';
    inputApi.placeholder = config.apiBaseUrl;
    inputPassword.value = config.settings.sshPassword ?? '';
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  btnScan.addEventListener('click', () => void startScan());
  btnRescan.addEventListener('click', () => void startScan());
  btnAgain.addEventListener('click', () => void startScan());

  btnAdopt.addEventListener('click', () => {
    // Skip straight to setup on a repeat install — the code is already validated and
    // retyping it every time would be punishment.
    if (accountCode && venues.length > 0) {
      const state = precheck.get(canon(selectedMac || ''))?.state;
      if (state === 'already_registered_here' || state === 'registered_elsewhere') {
        showKnown(state);
        return;
      }
      void enterSetup();
      return;
    }
    setCodeError(null);
    show('code');
    inputCode.focus();
  });

  inputCode.addEventListener('input', syncCodeInput);
  inputCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !btnCodeContinue.disabled) void submitCode();
  });
  btnCodeContinue.addEventListener('click', () => void submitCode());
  btnCodeBack.addEventListener('click', () => show('results'));

  // Reveal, then confirm — so nobody takes the slow path by accident.
  btnNoCode.addEventListener('click', () => {
    noCodeBody.classList.toggle('hidden');
    btnNoCode.classList.toggle('hidden', !noCodeBody.classList.contains('hidden'));
  });
  btnSendAnyway.addEventListener('click', () => void sendAdoptionOnly());

  btnKnownAgain.addEventListener('click', () => void startScan());
  btnKnownDashboard.addEventListener('click', () => void api.openExternal(dashboardUrl));
  // Re-running the claim is idempotent, and a missing WiFi network is the usual reason
  // someone runs the helper at an access point that is already registered.
  btnKnownRetry.addEventListener('click', () => void enterSetup());

  btnSsidUnlock.addEventListener('click', () => {
    ssidUnlocked = true;
    renderSsidField();
    inputSsid.focus();
  });
  btnSetupSubmit.addEventListener('click', () => void submitSetup());
  btnSetupBack.addEventListener('click', () => show('results'));

  btnDoneDashboard.addEventListener('click', () => void api.openExternal(dashboardUrl));
  btnDoneAgain.addEventListener('click', () => void startScan());

  btnSave.addEventListener('click', async () => {
    const config = await api.saveSettings({
      controllerUrl: inputUrl.value,
      sshPassword: inputPassword.value,
      apiBaseUrl: inputApi.value,
    });
    applyConfig(config);
    saveStatus.textContent = 'Saved';
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 2000);
    void refreshPreflight();
  });

  btnCopyLog.addEventListener('click', async () => {
    const lines = await api.getLog();
    await navigator.clipboard.writeText(lines.join('\n'));
    btnCopyLog.textContent = 'Copied';
    setTimeout(() => {
      btnCopyLog.textContent = 'Copy log';
    }, 1500);
  });

  advanced.addEventListener('toggle', () => {
    document.body.classList.toggle('show-mac', advanced.open);
    renderDevices();
  });

  homeLink.addEventListener('click', (event) => {
    event.preventDefault();
    void api.openExternal(homeUrl);
  });

  api.onDevice((device) => {
    // Stream results in while the scan window is still open.
    if (!devices.some((d) => d.mac === device.mac)) {
      devices.push(device);
      if (!panels.scanning.classList.contains('hidden')) {
        if (devices.length === 1) selectedMac = device.mac;
        renderDevices();
        show('results');
        resultsTitle.textContent = COPY.resultsPartial;
      } else {
        renderDevices();
      }
    }
  });

  api.onLog((line) => {
    logEl.textContent += (logEl.textContent ? '\n' : '') + line;
    logEl.scrollTop = logEl.scrollHeight;
  });

  void api
    .getConfig()
    .then((config) => {
      applyConfig(config);
      void refreshPreflight();
    })
    .catch(() => undefined);
})();

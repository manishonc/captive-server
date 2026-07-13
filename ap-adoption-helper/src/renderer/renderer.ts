// Renderer for the single-screen adoption flow. Classic script (no modules);
// talks to the main process only through window.heidifi (see preload).

(() => {
  const api = window.heidifi;

  type Step = 'idle' | 'scanning' | 'results' | 'adopting' | 'success' | 'error';

  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el as T;
  };

  const panels: Record<Step, HTMLElement> = {
    idle: $('panel-idle'),
    scanning: $('panel-scanning'),
    results: $('panel-results'),
    adopting: $('panel-adopting'),
    success: $('panel-success'),
    error: $('panel-error'),
  };

  const deviceList = $('device-list');
  const resultsTitle = $('results-title');
  const btnScan = $<HTMLButtonElement>('btn-scan');
  const btnAdopt = $<HTMLButtonElement>('btn-adopt');
  const btnRescan = $<HTMLButtonElement>('btn-rescan');
  const btnRetry = $<HTMLButtonElement>('btn-retry');
  const btnAgain = $<HTMLButtonElement>('btn-again');
  const errorTitle = $('error-title');
  const errorMessage = $('error-message');
  const successNote = $('success-note');
  const inputUrl = $<HTMLInputElement>('input-url');
  const inputPassword = $<HTMLInputElement>('input-password');
  const btnSave = $<HTMLButtonElement>('btn-save');
  const saveStatus = $('save-status');
  const preflightChip = $('preflight-chip');
  const deviceRaw = $('device-raw');
  const logEl = $('log');
  const btnCopyLog = $<HTMLButtonElement>('btn-copy-log');
  const advanced = $<HTMLDetailsElement>('advanced');
  const homeLink = $<HTMLAnchorElement>('home-link');

  let devices: DiscoveredDevice[] = [];
  let selectedMac: string | null = null;
  let homeUrl = 'https://heidifi.ai/';

  function show(step: Step): void {
    for (const [name, panel] of Object.entries(panels)) {
      panel.classList.toggle('hidden', name !== step);
    }
  }

  function friendlyName(device: DiscoveredDevice): string {
    return device.model || device.hostname || 'UniFi access point';
  }

  function renderDevices(): void {
    deviceList.textContent = '';
    for (const device of devices) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'device-card' + (device.mac === selectedMac ? ' selected' : '');
      const model = document.createElement('span');
      model.className = 'device-model';
      model.textContent = friendlyName(device);
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
    resultsTitle.textContent =
      devices.length === 1 ? 'We found your access point' : 'Select your access point';
    const selected = devices.find((d) => d.mac === selectedMac);
    deviceRaw.textContent = selected
      ? JSON.stringify(selected, null, 2)
      : 'No device selected.';
  }

  async function startScan(): Promise<void> {
    devices = [];
    selectedMac = null;
    show('scanning');
    try {
      devices = await api.scan();
    } catch {
      devices = [];
    }
    if (devices.length === 0) {
      errorTitle.textContent = "We couldn't find an access point";
      errorMessage.textContent =
        "Check that it's powered (the PoE adapter is plugged in) and connected to this " +
        'same network. New access points take about a minute to start up — wait a moment, ' +
        'then try again.';
      show('error');
      return;
    }
    if (devices.length === 1) selectedMac = devices[0].mac;
    renderDevices();
    show('results');
  }

  const ERROR_COPY: Record<AdoptErrorCode, { title: string; message: string }> = {
    AUTH_FAILED: {
      title: 'This access point may have been set up before',
      message:
        'Please factory-reset it: with the device powered on, hold the small reset button ' +
        'for about 10 seconds until the light flashes, wait for it to restart (about a ' +
        'minute), then scan again. If you were given a custom device password, enter it ' +
        'under Advanced.',
    },
    UNREACHABLE: {
      title: "We couldn't connect to the access point",
      message:
        'It may still be starting up. Wait a minute and try again. If it keeps failing, ' +
        'unplug the access point, plug it back in, and scan again once its light is steady.',
    },
    TIMEOUT: {
      title: 'The connection timed out',
      message:
        'The access point did not respond in time. Wait a minute for it to finish starting ' +
        'up, then try again.',
    },
    COMMAND_NOT_FOUND: {
      title: "The access point didn't accept the request",
      message:
        'This device uses unsupported firmware. Open Advanced and copy the log, then send ' +
        'it to your administrator.',
    },
    UNEXPECTED_OUTPUT: {
      title: "Something didn't go as expected",
      message:
        'The access point gave an unexpected reply. Try again — if it keeps failing, open ' +
        'Advanced, copy the log, and send it to your administrator.',
    },
    INVALID_URL: {
      title: 'The controller address looks wrong',
      message:
        'Open Advanced and check the controller inform URL, then save and try again.',
    },
  };

  async function sendAdoption(): Promise<void> {
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
            "doesn't appear for your administrator, check this site's internet connection."
          : '';
      show('success');
    } else {
      const copy = ERROR_COPY[result.code] ?? ERROR_COPY.UNEXPECTED_OUTPUT;
      errorTitle.textContent = copy.title;
      errorMessage.textContent = copy.message;
      show('error');
    }
  }

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
    document.documentElement.style.setProperty('--brand', config.brand.primary);
    document.documentElement.style.setProperty('--surface', config.brand.surface);
    document.documentElement.style.setProperty('--bg', config.brand.background);
    $('app-name').textContent = config.appName;
    inputUrl.value = config.settings.controllerUrl ?? '';
    inputUrl.placeholder = config.informUrl;
    inputPassword.value = config.settings.sshPassword ?? '';
  }

  btnScan.addEventListener('click', startScan);
  btnRescan.addEventListener('click', startScan);
  btnRetry.addEventListener('click', startScan);
  btnAgain.addEventListener('click', startScan);
  btnAdopt.addEventListener('click', sendAdoption);

  btnSave.addEventListener('click', async () => {
    const config = await api.saveSettings({
      controllerUrl: inputUrl.value,
      sshPassword: inputPassword.value,
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
        resultsTitle.textContent = 'Still looking — found so far:';
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

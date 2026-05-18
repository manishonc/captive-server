# UniFi Network Application — What It Is & How It Works

## The Core Difference from Aruba Instant On

With **Aruba Instant On**, Aruba runs the "brain" for you on HPE's cloud. You just log into `portal.instant-on.hpe.com` and everything is managed there — firmware, config, captive portal redirects, RADIUS auth — all Aruba's servers.

**UniFi is the opposite.** There is no Ubiquiti cloud managing your APs. You run the brain yourself. That brain is the **UniFi Network Application** — a Java web app + database that you self-host. Your APs talk to it, you configure everything through it, and it's the thing that actually authorizes or blocks guests.

---

## The Relationship: Controller ↔ AP

```
[UniFi Network Application]  ← running on your Coolify server
        ↕  (persistent TCP connection, "inform" protocol)
    [U6-Pro AP]              ← physical hardware at the venue
```

Every 10–30 seconds the AP "phones home" to the controller at `http://your-server:8080/inform`. This is called the **inform cycle**. Through this channel the controller:
- Pushes config changes to the AP
- Receives stats (connected clients, signal strength, throughput)
- Sends commands — including **"let this guest through"**

When our server calls `/unifi/authorize`, it tells the controller "authorize MAC `aa:bb:cc`", the controller queues that command, and the next time the AP phones in (within seconds) it receives the authorization and opens internet for that device.

This is fundamentally different from Aruba where the browser itself POSTs to `swarm.cgi`. With UniFi the AP never talks directly to our server — everything goes through the controller.

---

## What the Controller Stores

- All AP configuration (SSIDs, passwords, VLANs, radio settings)
- All client history (who connected when, how long, how much data)
- Guest authorizations (which MACs are currently allowed and for how long)
- Your admin accounts
- Alerts and events

Think of it like a router's admin panel, but centralized for all your APs, with a proper API.

---

## Why Self-Host vs Aruba Cloud

| | Aruba Instant On | UniFi (self-hosted) |
|---|---|---|
| Controller location | HPE's cloud | Your Coolify server |
| Controller cost | Free (included) | Your server costs (already paying) |
| Internet dependency | Yes — if HPE cloud is down, portal breaks | No — controller is on your own infra |
| APs phone home to | `portal.instant-on.hpe.com` | `your-server:8080` |
| Guest auth method | Browser POSTs to `swarm.cgi` | Controller API call (server-side) |
| Setup complexity | Simple (cloud managed) | More work (you manage it) |

Ubiquiti does offer a hosted cloud version (UniFi Cloud Console) but it costs money per site. The self-hosted approach is free — which is what we're doing.

---

## The Ports and What They Do

| Port | Protocol | Used by |
|------|----------|---------|
| `8443` | HTTPS | Controller web UI + API (what our server calls to authorize guests) |
| `8080` | HTTP | AP inform channel — APs must reach this from the venue network |
| `3478` | UDP | STUN — helps with NAT traversal for AP discovery |

**The only critical one for production:** port `8080` must be reachable from wherever the physical AP is. Port `8443` is used by our captive-server which is on the same Docker network, so that stays internal.

---

## The One Catch vs Aruba

With Aruba, the AP and HPE portal are already on the internet talking to each other — you just point it at your RADIUS server and portal URL.

With UniFi self-hosted, **you are responsible for the AP reaching your controller**. If the AP is in a restaurant on a regular ISP connection and your controller is on Coolify, the restaurant's router must be able to reach `your-server:8080` from the internet — which is just a standard outbound connection from the AP's side, so it works fine as long as your server's port 8080 is open publicly.

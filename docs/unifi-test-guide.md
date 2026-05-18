# UniFi End-to-End Test Guide (U6-Pro)

Quick checklist to get one AP working from zero to guest internet access.

---

## Step 1 — Deploy the Controller

Set env vars in Coolify **before** deploying (change the passwords):

| Variable | Value |
|----------|-------|
| `UNIFI_MONGO_ROOT_USER` | `root` |
| `UNIFI_MONGO_ROOT_PASS` | `your_strong_root_pass` |
| `UNIFI_MONGO_USER` | `unifi` |
| `UNIFI_MONGO_PASS` | `your_strong_unifi_pass` |

Edit `unifi/init-mongo.js` — change `changeme_unifi` to the same value as `UNIFI_MONGO_PASS`.

Deploy `docker-compose.unifi.yml` in Coolify.

**Verify:** `https://YOUR_SERVER:8443` loads the UniFi setup wizard.

> The MongoDB init script only runs on the very first container start. If you need to re-run it, delete the `unifi_db_data` volume first.

---

## Step 2 — Initial Controller Setup

1. Open `https://YOUR_SERVER:8443` (accept the self-signed cert warning)
2. Choose **Advanced Setup**
3. Select **Unifi OS** → **Skip** Ubiquiti cloud login → use **Local Access** only
4. Create a local admin: username + strong password (this is NOT the API account — this is your personal admin)
5. Skip device adoption for now
6. Finish the wizard

---

## Step 3 — Adopt the U6-Pro

The U6-Pro must be able to reach your server on port 8080.

**Option A — Same LAN as controller (auto-discovery):**
The AP may appear automatically under **Devices**. Click **Adopt**.

**Option B — Different network (most common):**
SSH to the AP and set the inform URL:
```bash
ssh ubnt@<AP_IP>
# default SSH password: ubnt
set-inform http://YOUR_SERVER_IP:8080/inform
```
Then in the controller click **Adopt** when it appears.

**Verify:** AP shows as **Connected** under Devices.

---

## Step 4 — Create the API Admin Account

1. **Settings → Admins → Add Admin**
2. Username: `captive-service`
3. Role: `Limited Admin` with Read/Write on the site
4. Set a password — you'll enter this in the CMS

---

## Step 5 — Create Guest SSID

1. **Settings → WiFi → Create New WiFi**
2. Name: `HeidiFi-Test` (or whatever you want guests to see)
3. Security: **Open** (no password)
4. Enable **Guest Network** toggle (isolates guests from LAN)
5. Save

---

## Step 6 — Configure External Captive Portal

1. **Settings → Guest Control** (or inside the WiFi's **Advanced** settings → **Guest Portal**)
2. Enable **Guest Portal**
3. Authentication: **External Portal Server**
4. Portal Hostname / URL: `p.heidifi.ai`
5. **Pre-Authorization Access** (walled garden) — add:
   - `p.heidifi.ai`
   - `api.heidifi.ai` (if your server is on a different domain)
6. Save

---

## Step 7 — Add the AP in CMS

1. CMS → Captive Portal → your venue → **Access Points** → **Add Access Point**
2. Step 1: Select **UniFi**
3. Step 2: Read guide (you already did this)
4. Step 3 fill in:

| Field | Value |
|-------|-------|
| Name | `U6-Pro Test` |
| MAC Address | AP MAC from controller (Devices → select AP → Details) |
| Venue | your test venue |
| Session Duration | 10 hours |
| Controller URL | `https://YOUR_SERVER_IP:8443` |
| Controller Type | Classic |
| Site | `default` |
| Admin Username | `captive-service` |
| Admin Password | password you set in Step 4 |

5. Click **Add Access Point**

---

## Step 8 — Test as a Guest

1. On your phone, connect to `HeidiFi-Test` SSID
2. A browser should auto-open with the captive portal (or open any `http://` URL)
3. The URL should look like:
   ```
   https://p.heidifi.ai/?ap=XX:XX:XX:XX:XX:XX&id=YY:YY:YY:YY:YY:YY&t=...&url=...&ssid=HeidiFi-Test
   ```
4. Fill in the form and submit
5. You should get internet access

---

## What to Check if Something Breaks

**Portal doesn't load / no redirect:**
- Check walled garden includes `p.heidifi.ai`
- Check the AP is adopted and connected in the controller

**Form submits but no internet:**
- Check server logs: `docker logs server | grep UNIFI`
- Common errors:
  - `UniFi login failed` → wrong credentials in CMS or controller URL wrong
  - `No access point found for apMac` → MAC in CMS doesn't match what UniFi sends (check `ap=` param in browser URL)
  - `connect ECONNREFUSED` → controller URL wrong or port 8443 not reachable from server container

**Test controller reachability from server container:**
```bash
docker exec server wget -qO- --no-check-certificate https://unifi:8443 2>&1 | head -5
# or if using IP:
docker exec server wget -qO- --no-check-certificate https://YOUR_SERVER_IP:8443 2>&1 | head -5
```

**Check guest was authorized in UniFi:**
Controller → Clients → look for your phone's MAC — it should show as **Authorized**.

---

## Portal Not Showing UniFi Flow Yet

> The portal (`portal/server.js`) currently only handles Aruba redirect params. Phase 2 adds the `/unifi-submit` handler and UniFi param detection. Until then you can test the authorization API directly:

```bash
curl -X POST https://api.heidifi.ai/unifi/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "User",
    "email": "test@example.com",
    "clientMac": "YY:YY:YY:YY:YY:YY",
    "apMac": "XX:XX:XX:XX:XX:XX"
  }'
```

Replace `clientMac` with your phone MAC and `apMac` with the AP MAC from Step 7.
A `{ "success": true }` response means the controller was called and your phone should have internet.

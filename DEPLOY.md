# Deploying to a VPS

## Prerequisites

- A VPS (DigitalOcean, Hetzner, Linode, etc.) running Ubuntu 22.04+
- SSH access to the server
- A domain or use `<your-ip>.nip.io` for testing (nip.io resolves to the IP automatically)

## 1. Install Docker & Docker Compose

SSH into your VPS and run:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (so you don't need sudo)
sudo usermod -aG docker $USER

# Log out and back in for group change to take effect
exit
```

SSH back in, then verify:

```bash
docker --version
docker compose version
```

## 2. Copy the project to the VPS

From your local machine:

```bash
scp -r /path/to/captive-free-radius root@YOUR_VPS_IP:~/captive-free-radius
```

Or use git if you have a repo set up:

```bash
ssh root@YOUR_VPS_IP
git clone <your-repo-url> ~/captive-free-radius
```

## 3. Configure environment

```bash
cd ~/captive-free-radius
cp .env.example .env   # if you have one, otherwise create it:
```

Create/edit the `.env` file:

```
PORTAL_DOMAIN=YOUR_VPS_IP.nip.io
RADIUS_SECRET=testing123
```

Replace `YOUR_VPS_IP` with your actual VPS IP address.

## 4. Build and start

```bash
cd ~/captive-free-radius
docker compose up -d --build
```

This starts two containers:
- **portal** — captive portal web server on port 80
- **freeradius** — RADIUS auth server on UDP ports 1812/1813

## 5. Verify it's running

```bash
# Check containers are up
docker compose ps

# Check portal responds
curl http://localhost/health
# Should return: {"status":"ok"}

# Check portal serves the default template
curl http://localhost/
# Should return the guest WiFi HTML page

# Check RADIUS is listening
docker compose logs freeradius
```

## 6. Firewall rules

Make sure these ports are open on your VPS:

| Port | Protocol | Service |
|------|----------|---------|
| 80 | TCP | Captive portal (HTTP) |
| 1812 | UDP | RADIUS authentication |
| 1813 | UDP | RADIUS accounting |
| 22 | TCP | SSH (for your access) |

On Ubuntu with `ufw`:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 1812/udp
sudo ufw allow 1813/udp
sudo ufw allow 22/tcp
sudo ufw enable
```

## 7. Point your Aruba Instant On AP

In the Aruba Instant On portal:
1. Go to your network settings
2. Set the captive portal URL to: `http://YOUR_VPS_IP.nip.io/`
3. Set the RADIUS server to your VPS IP, port 1812, secret `testing123`

## Updating after changes

```bash
cd ~/captive-free-radius
git pull                       # if using git
docker compose up -d --build   # rebuild and restart
```

## Viewing logs

```bash
# All services
docker compose logs -f

# Portal only
docker compose logs -f portal

# FreeRADIUS only
docker compose logs -f freeradius
```

## Stopping everything

```bash
docker compose down
```
compose up -d --build 
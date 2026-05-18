// Runs once on first MongoDB container start to create the UniFi database user.
// Values here must match UNIFI_MONGO_USER / UNIFI_MONGO_PASS env vars in docker-compose.unifi.yml.
// Change BOTH the passwords in this file AND in Coolify env vars together.
db = db.getSiblingDB('admin');
db.createUser({
  user: 'unifi',
  pwd: 'changeme_unifi',
  roles: [
    { role: 'dbOwner', db: 'unifi' },
    { role: 'dbOwner', db: 'unifi_stat' },
    { role: 'dbOwner', db: 'unifi_audit' },
  ],
});

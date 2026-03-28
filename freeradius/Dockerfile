FROM freeradius/freeradius-server:latest-3.2-alpine

COPY clients.conf /etc/raddb/clients.conf
COPY users /etc/raddb/users
COPY mods-available/rest /etc/raddb/mods-available/rest
COPY sites-available/captive-portal /etc/raddb/sites-available/captive-portal

# Enable REST module and captive-portal site; disable default site and unused modules
RUN ln -sf /etc/raddb/mods-available/rest /etc/raddb/mods-enabled/rest \
 && ln -sf /etc/raddb/sites-available/captive-portal /etc/raddb/sites-enabled/captive-portal \
 && rm -f /etc/raddb/sites-enabled/default \
 && rm -f /etc/raddb/sites-enabled/inner-tunnel \
 && rm -f /etc/raddb/mods-enabled/eap

EXPOSE 1812/udp 1813/udp

CMD ["radiusd", "-f", "-X"]
